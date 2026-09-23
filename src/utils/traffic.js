/**
 * 月流量告警共用工具
 * - 规范化：limit(GB) 与阈值百分比，读写两侧唯一入口，避免 "1000"/"1000.0"/1000 之类
 *   字符串/浮点格式差异导致相等判定失真。
 * - getTrafficUsageBytes：与前端 useServerCardData.getTrafficUsageBytes 算法逐一对齐
 *   （total/ul/dl/max，GB = 1024³）。
 */

export const GB = 1024 * 1024 * 1024;

// 规范化 traffic_limit（单位 GB）：有限正数否则 0
export function normalizeTrafficLimitGb(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 规范化阈值百分比：整数并夹取到 0..100
export function normalizePct(value) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

// 按计算类型取当月已用字节
export function getTrafficUsageBytes(rxMonthly, txMonthly, calcType) {
  const rx = parseFloat(rxMonthly) || 0;
  const tx = parseFloat(txMonthly) || 0;
  switch (calcType) {
    case 'dl': return rx;
    case 'ul': return tx;
    case 'max': return Math.max(rx, tx);
    default: return rx + tx; // total
  }
}
