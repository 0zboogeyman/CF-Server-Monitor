import { getLatestMetricsForAllServers } from '../database/schema.js';
import { clearServersListCache, getAllServers } from '../utils/cache.js';
import { getExpireReminderDays, getResourceAlertConfig, getTgNotifyMinutes, loadSiteSettings, debug } from '../utils/settings.js';
import { detectBillingCycle, normalizeBillingCycle, renewExpireDateIfNeeded } from '../utils/serverBilling.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const RESOURCE_ALERT_STATE_ACTIVE = 'active';
const RESOURCE_ALERT_STATE_RECOVERED = 'recovered';

function formatLastReportTime(timestamp) {
  if (!timestamp) return '无上报记录';

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '无效时间';

  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function formatBytesPerSecond(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let size = number;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0%';
  return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
}

function formatResourceMetric(metric) {
  const metricLabels = {
    cpu: 'CPU',
    ram: 'RAM',
    netIn: '下行网速',
    netOut: '上行网速',
    netTotal: '总网速'
  };
  const label = metricLabels[metric.metric] || metric.metric;
  const valueLabel = metric.mode === 'average' ? '平均' : '当前';
  const value = metric.triggerValue ?? metric.current;
  if (metric.metric === 'cpu' || metric.metric === 'ram') {
    return `${label} ${valueLabel} ${formatPercent(value)} > ${formatPercent(metric.threshold)}`;
  }
  return `${label} ${valueLabel} ${formatBytesPerSecond(value)} > ${formatBytesPerSecond(metric.threshold)}`;
}

function parseResourceAlertState(row) {
  if (!row || !row.value) return { signature: '', servers: {} };
  try {
    const parsed = JSON.parse(row.value);
    if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
      return {
        signature: String(parsed.signature || ''),
        servers: parsed.servers
      };
    }
  } catch (_) {}
  return { signature: '', servers: {} };
}

function getResourceAlertStateStatus(state) {
  if (!state || typeof state !== 'object') return RESOURCE_ALERT_STATE_ACTIVE;
  return state.status === RESOURCE_ALERT_STATE_RECOVERED
    ? RESOURCE_ALERT_STATE_RECOVERED
    : RESOURCE_ALERT_STATE_ACTIVE;
}

function getResourceAlertStateTimestamp(state, key) {
  if (!state || typeof state !== 'object') return 0;
  const timestamp = Number(state[key] || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function isServerNotificationDisabled(server) {
  const value = server?.offline_notify_disabled;
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        throw e;
      }
    }
  }
  throw new Error('Max retries exceeded');
}


export async function sendNotification(settings, msg) {
  if(!settings.tg_bot_token) return;
  const title = "💌 Cloudflare Server Monitor";
  if(settings.tg_bot_token.indexOf("onebot:") == 0) {
    // OneBot 协议 (QQ 等)，私聊格式: onebot:http://127.0.0.1:3000/send_private_msg?access_token=xxx
    // 群聊格式: onebot:http://127.0.0.1:3000/send_group_msg?access_token=xxx
    let onebotUrl = settings.tg_bot_token.replace("onebot:", "");
    const targetId = settings.tg_chat_id || '';
    const isGroup = onebotUrl.indexOf("send_group_msg") != -1;
    if (!targetId) {
      return "OneBot 通知失败: 缺少 tg_chat_id（私人: QQ号，群: group:群号）";
    }
    try {
      const endpoint = onebotUrl.trim();
      const body = {
        [isGroup ? 'group_id' : 'user_id']: targetId,
        message: [
          {
            type: 'text',
            data: {
              text: `${title}\n${String(msg || '').replace(/\*/g, '')}\n`
            }
          }
        ]
      };
      await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return "OneBot 通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("open.feishu.cn")) {
    // 飞书机器人 Webhook
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          msg_type: "interactive",
          card: {
            schema: "2.0",
            header: { template: "blue", title: { content: title, tag: "plain_text" } },
            body: { elements: [{ tag: "markdown", content: msg }] }
          }
        })
      });
    } catch (e) {
      return "飞书通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("oapi.dingtalk.com") || settings.tg_bot_token.includes("api.dingtalk.com")) {
    // 钉钉机器人 Webhook
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { title: title, text: msg }
        })
      });
    } catch (e) {
      return "钉钉通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("https://api.day.app/") || settings.tg_bot_token.indexOf("bark:") == 0) {
    let barkUrl = settings.tg_bot_token;
    if(barkUrl.indexOf("bark:") == 0) {
      barkUrl = barkUrl.replace("bark:", "");
    }
    try {
      await fetchWithRetry(barkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          markdown: msg,
          group: "Cloudflare Server Monitor"
        })
      });
    } catch (e) {
      return "Bark通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("https://qyapi.weixin.qq.com")){
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: "text",
          text: {
            content: msg.replace(/\*/g, '')
          }
        })
      });
    } catch (e) {
      return "企业微信通知发送失败: " + e.message;
    }
  // Server 酱（使用 sendkey）
  }else if(settings.tg_bot_token.includes("https://sctapi.ftqq.com/")) {
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          desp: msg
        })
      });
    } catch (e) {
      return "Server酱通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("https://wxpusher.zjiecode.com/api/send/message/SPT_")) {
    const match = settings.tg_bot_token.match(/\/message\/([^/]+)/);
    const spt = match ? match[1] : null;
    if (!spt) return "WxPusher 通知失败: 无法提取 SPT";
    try {
      await fetchWithRetry("https://wxpusher.zjiecode.com/api/send/message/simple-push", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          "content": msg,
          "summary": title,
          "contentType":3,
          "spt": spt,
        })
      });
    } catch (e) {
      return "WxPusher通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("/message?token=")) {
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          message: msg,
          priority: 5,
          extras: {
            "client::display": { "contentType": "text/markdown" }
          }
        })
      });
    } catch (e) {
      return "Gotify通知发送失败: " + e.message;
    }
  }else if(settings.tg_chat_id) {
    // Telegram Bot (最后 fallback，通过 chat_id 判断)
    try {
      await fetchWithRetry(`https://api.telegram.org/bot${settings.tg_bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.tg_chat_id,
          text: msg,
          parse_mode: 'Markdown'
        })
      });
    } catch (e) {
      return "Telegram 通知发送失败: " + e.message;
    }
  }else {
    return "未知的通知方式";
  }
}

export async function checkOfflineNodes(db) {
  const siteSettings = await loadSiteSettings(db);
  const tgNotifyMinutes = getTgNotifyMinutes(siteSettings.tg_notify);

  if (tgNotifyMinutes === 0 || !siteSettings.tg_bot_token) return;

  try {
    const allServers = await getAllServers(db);
    
    const latestMetricsMap = await getLatestMetricsForAllServers(db);
    
    let alertState = {};
    const stateRes = await db.prepare(
      "SELECT value FROM settings WHERE key = 'alert_state'"
    ).first();
    
    if (stateRes) {
      try {
        alertState = JSON.parse(stateRes.value);
      } catch (e) {
        alertState = {};
      }
    }

    const now = Date.now();
    const offlineThreshold = tgNotifyMinutes * 60 * 1000;
    const offlineNodes = [];
    const recoveredNodes = [];

    for (const s of allServers) {
      if (s.offline_notify_disabled === '1') continue;

      const latestMetrics = latestMetricsMap.get(s.id);
      
      let isOffline = true;
      if (latestMetrics) {
        const diff = now - latestMetrics.timestamp;
        isOffline = diff > offlineThreshold;
      }

      if (isOffline && !alertState[s.id]) {
        offlineNodes.push({
          name: s.name,
          lastReportTime: latestMetrics?.timestamp
        });
        alertState[s.id] = true;
      } else if (!isOffline && alertState[s.id]) {
        recoveredNodes.push(s);
        delete alertState[s.id];
      }
    }

    if (offlineNodes.length > 0) {
      const nodeList = offlineNodes
        .map(n => `• ${n.name} - ${formatLastReportTime(n.lastReportTime)}`)
        .join('\n');
      const msg = `⚠️ **节点离线告警** (${offlineNodes.length}个)\n\n${nodeList}`;
      await sendNotification(siteSettings, msg);
    }

    if (recoveredNodes.length > 0) {
      const nodeList = recoveredNodes.map(n => `• ${n.name}`).join('\n');
      const msg = `✅ **节点恢复通知** (${recoveredNodes.length}个)\n\n${nodeList}\n\n**时间:** ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`;
      await sendNotification(siteSettings, msg);
    }

    if (offlineNodes.length > 0 || recoveredNodes.length > 0) {
      await db.prepare(
        'INSERT INTO settings (key, value) VALUES ("alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(JSON.stringify(alertState)).run();
    }
  } catch (e) {
    console.error('离线检测失败:', e);
  }
}

export async function checkResourceAlerts(env) {
  if (!env?.DB || !env?.METRICS_BROADCASTER) return;

  const db = env.DB;
  const siteSettings = await loadSiteSettings(db);
  const resourceConfig = getResourceAlertConfig(siteSettings);

  if (!resourceConfig.enabled || !resourceConfig.hasThresholds || !siteSettings.tg_bot_token) return;

  try {
    const allServers = await getAllServers(db);
    const alertableServers = allServers.filter(server => !isServerNotificationDisabled(server));
    const serverIds = alertableServers.map(server => server.id).filter(Boolean);
    if (serverIds.length === 0) {
      await db.prepare("DELETE FROM settings WHERE key = 'resource_alert_state'").run();
      return;
    }

    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    const response = await stub.fetch('http://internal/evaluate-resource-alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverIds,
        mode: resourceConfig.mode,
        windowMinutes: resourceConfig.windowMinutes,
        thresholds: resourceConfig.thresholds
      })
    });

    if (!response.ok) {
      console.warn('[ResourceAlert] DO evaluate failed:', response.status);
      return;
    }

    const result = await response.json();
    const activeAlerts = Array.isArray(result.alerts) ? result.alerts : [];
    const activeMap = new Map(activeAlerts.map(alert => [alert.serverId, alert]));

    const configSignature = JSON.stringify({
      mode: resourceConfig.mode,
      windowMinutes: resourceConfig.windowMinutes,
      thresholds: resourceConfig.thresholds
    });

    const stateRow = await db.prepare(
      "SELECT value FROM settings WHERE key = 'resource_alert_state'"
    ).first();
    const parsedState = parseResourceAlertState(stateRow);
    let alertState = parsedState.signature === configSignature ? parsedState.servers : {};

    const now = Date.now();
    const cooldownMs = resourceConfig.cooldownMinutes * 60 * 1000;
    const recoveryCooldownMs = resourceConfig.recoveryCooldownMinutes * 60 * 1000;
    const alertNodes = [];
    const recoveredNodes = [];
    let stateChanged = parsedState.signature !== configSignature;

    for (const server of allServers) {
      if (isServerNotificationDisabled(server)) {
        if (alertState[server.id]) {
          delete alertState[server.id];
          stateChanged = true;
        }
        continue;
      }

      const alert = activeMap.get(server.id);
      const currentState = alertState[server.id];
      const currentStatus = currentState
        ? getResourceAlertStateStatus(currentState)
        : '';

      if (alert) {
        const recoveredAt = currentStatus === RESOURCE_ALERT_STATE_RECOVERED
          ? getResourceAlertStateTimestamp(currentState, 'recoveredAt')
          : 0;
        if (recoveredAt > 0 && now - recoveredAt < recoveryCooldownMs) {
          continue;
        }

        const isActiveAlert = currentStatus === RESOURCE_ALERT_STATE_ACTIVE;
        const lastNotifyAt = isActiveAlert
          ? getResourceAlertStateTimestamp(currentState, 'lastNotifyAt')
          : 0;
        const shouldNotify = !currentState || !isActiveAlert || now - lastNotifyAt >= cooldownMs;
        if (shouldNotify) {
          alertNodes.push({ server, alert, repeated: isActiveAlert && !!currentState });
          alertState[server.id] = {
            status: RESOURCE_ALERT_STATE_ACTIVE,
            alertAt: isActiveAlert ? (currentState?.alertAt || now) : now,
            lastNotifyAt: now,
            lastTriggeredAt: now,
            metrics: alert.metrics.map(metric => metric.metric)
          };
          stateChanged = true;
        }
      } else if (currentState) {
        if (currentStatus === RESOURCE_ALERT_STATE_ACTIVE) {
          recoveredNodes.push(server);
          alertState[server.id] = {
            ...currentState,
            status: RESOURCE_ALERT_STATE_RECOVERED,
            recoveredAt: now,
            lastRecoveryNotifyAt: now
          };
          stateChanged = true;
        } else {
          const recoveredAt = getResourceAlertStateTimestamp(currentState, 'recoveredAt');
          if (recoveredAt === 0 || now - recoveredAt >= recoveryCooldownMs) {
            delete alertState[server.id];
            stateChanged = true;
          }
        }
      }
    }

    if (alertNodes.length > 0) {
      const nodeList = alertNodes.map(({ server, alert, repeated }) => {
        const metrics = alert.metrics.map(formatResourceMetric).join('；');
        const repeatText = repeated ? '（再次提醒）' : '';
        const modeText = alert.mode === 'average' ? '平均' : '窗口样本连续';
        const sampleText = Number(alert.sampleCount) > 0 ? `，样本 ${alert.sampleCount} 个` : '';
        return `• ${server.name}${repeatText} - ${modeText} ${alert.windowMinutes} 分钟${sampleText}\n  ${metrics}`;
      }).join('\n');
      const msg = `⚠️ **资源负载告警** (${alertNodes.length}个)\n\n${nodeList}`;
      await sendNotification(siteSettings, msg);
    }

    if (recoveredNodes.length > 0) {
      const nodeList = recoveredNodes.map(server => `• ${server.name}`).join('\n');
      const msg = `✅ **资源负载恢复** (${recoveredNodes.length}个)\n\n${nodeList}\n\n**时间:** ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`;
      await sendNotification(siteSettings, msg);
    }

    if (stateChanged) {
      await db.prepare(
        'INSERT INTO settings (key, value) VALUES ("resource_alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(JSON.stringify({ signature: configSignature, servers: alertState })).run();
    }
  } catch (e) {
    console.error('资源负载告警检测失败:', e);
  }
}

export async function checkExpiringServers(db) {
  const siteSettings = await loadSiteSettings(db);

  try {
    const allServers = await getAllServers(db);
    const now = Date.now();
    const expiringServers = [];
    const reminderDays = getExpireReminderDays(siteSettings.expire_reminder);
    const shouldNotify = reminderDays > 0 && !!siteSettings.tg_bot_token;
    let hasRenewedServers = false;

    for (const s of allServers) {
      if (!s.expire_date) continue;

      const billingCycle = normalizeBillingCycle(detectBillingCycle(s.price) || s.billing_cycle);
      const renewal = renewExpireDateIfNeeded(s.expire_date, billingCycle, s.auto_renewal, now, 1);
      if (renewal.renewed) {
        await db.prepare(
          'UPDATE servers SET expire_date = ?, billing_cycle = ? WHERE id = ?'
        ).bind(renewal.expire_date, billingCycle, s.id).run();
        s.expire_date = renewal.expire_date;
        s.billing_cycle = billingCycle;
        hasRenewedServers = true;
        debug(`[Cron] 服务器 ${s.name} 已自动续费，到期日期更新为 ${s.expire_date}`);
      }

      if (!shouldNotify) continue;

      const expTime = new Date(s.expire_date).getTime();
      if (isNaN(expTime)) continue;

      const diff = expTime - now;
      const days = Math.ceil(diff / (1000 * 3600 * 24));

      debug(`[Cron] 检测到服务器 ${s.name} 到期日期 ${s.expire_date}，剩余天数 ${days} 天`);

      if (days > 0 && days <= reminderDays) {
        expiringServers.push({ name: s.name, expire_date: s.expire_date, days });
      }
    }

    if (hasRenewedServers) {
      clearServersListCache();
    }

    if (expiringServers.length > 0) {
      const serverList = expiringServers.map(s => `• ${s.name} - 剩余${s.days}天 (${s.expire_date})`).join('\n');
      const msg = `⏰ **服务器到期提醒** (${expiringServers.length}个)\n\n${serverList}`;
      debug(`[Cron] 发送到期提醒通知: ${msg}`);
      await sendNotification(siteSettings, msg);
    }
  } catch (e) {
    console.error('到期检测失败:', e);
  }
}
