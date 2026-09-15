import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { checkTrafficReports } from '../src/services/notification.js';

const server = { id: 'server-1', name: 'Tokyo' };

function createMiniflare(name) {
  return new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: name }
  });
}

function settings(overrides = {}) {
  return {
    notification_timezone: 'Asia/Shanghai',
    traffic_report_time: '9',
    traffic_report_daily: 'false',
    traffic_report_weekly: 'false',
    traffic_report_monthly: 'false',
    notification_webhook_enabled: 'true',
    notification_webhook_url: 'https://example.com/webhook',
    ...overrides
  };
}

function metrics(rx, tx) {
  return new Map([[server.id, { net_rx_monthly: rx, net_tx_monthly: tx }]]);
}

async function runReport(db, { now, current, config, notifications }) {
  return checkTrafficReports(db, {
    now,
    settings: config,
    servers: [server],
    latestMetrics: current,
    sendNotification: async (_settings, msg, context) => {
      notifications.push({ msg, context });
      return null;
    }
  });
}

test('traffic report records a baseline, calculates daily deltas, and deduplicates the same day', async () => {
  const miniflare = createMiniflare('traffic-report-daily-test');
  try {
    const db = await miniflare.getD1Database('DB');
    const notifications = [];
    const config = settings({ traffic_report_daily: 'true' });

    const baseline = await runReport(db, {
      now: Date.UTC(2026, 8, 1, 1),
      current: metrics(10_000, 20_000),
      config,
      notifications
    });
    assert.equal(baseline, false);
    assert.equal(notifications.length, 0);

    const reported = await runReport(db, {
      now: Date.UTC(2026, 8, 2, 1),
      current: metrics(15_000, 28_000),
      config,
      notifications
    });
    assert.equal(reported, true);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].context.event, /每日流量报告/);
    assert.match(notifications[0].msg, /Tokyo/);
    assert.match(notifications[0].msg, /↓ 4\.88 KB/);
    assert.match(notifications[0].msg, /↑ 7\.81 KB/);

    const duplicate = await runReport(db, {
      now: Date.UTC(2026, 8, 2, 1, 30),
      current: metrics(17_000, 31_000),
      config,
      notifications
    });
    assert.equal(duplicate, false);
    assert.equal(notifications.length, 1);
  } finally {
    await miniflare.dispose();
  }
});

test('traffic report treats a lower monthly counter as a reset', async () => {
  const miniflare = createMiniflare('traffic-report-reset-test');
  try {
    const db = await miniflare.getD1Database('DB');
    const notifications = [];
    const config = settings({ traffic_report_daily: 'true' });

    await runReport(db, { now: Date.UTC(2026, 8, 1, 1), current: metrics(50_000, 80_000), config, notifications });
    await runReport(db, { now: Date.UTC(2026, 8, 2, 1), current: metrics(2_048, 4_096), config, notifications });

    assert.equal(notifications.length, 1);
    assert.match(notifications[0].msg, /↓ 2\.00 KB/);
    assert.match(notifications[0].msg, /↑ 4\.00 KB/);
  } finally {
    await miniflare.dispose();
  }
});

test('weekly report is emitted on Monday and monthly report on the first day', async () => {
  const miniflare = createMiniflare('traffic-report-period-test');
  try {
    const db = await miniflare.getD1Database('DB');
    const notifications = [];
    const config = settings({
      traffic_report_weekly: 'true',
      traffic_report_monthly: 'true'
    });

    for (let day = 1; day <= 7; day += 1) {
      await runReport(db, {
        now: Date.UTC(2026, 8, day, 1),
        current: metrics(day * 1_024, day * 2_048),
        config,
        notifications
      });
    }
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].context.event, /每周流量报告/);
    assert.match(notifications[0].context.event, /2026-08-31 至 2026-09-06/);

    await runReport(db, {
      now: Date.UTC(2026, 9, 1, 1),
      current: metrics(40_000, 80_000),
      config,
      notifications
    });
    assert.equal(notifications.length, 2);
    assert.match(notifications[1].context.event, /每月流量报告/);
    assert.match(notifications[1].context.event, /2026-09-01 至 2026-09-30/);
  } finally {
    await miniflare.dispose();
  }
});
