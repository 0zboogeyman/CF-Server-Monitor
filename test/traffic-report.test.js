import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import {
  buildTrafficReportContent,
  calculateTrafficDelta,
  ensureTrafficDailyTable,
  getTrafficReportPeriods,
  recordDailyTraffic
} from '../src/services/notification.js';

const server = { id: 'server-1', name: 'Tokyo' };

function createMiniflare(name) {
  return new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: name }
  });
}

function metrics(rx, tx) {
  return new Map([[server.id, { net_rx_monthly: rx, net_tx_monthly: tx }]]);
}

test('daily traffic storage records a baseline, calculates deltas, and deduplicates the same date', async () => {
  const miniflare = createMiniflare('traffic-report-daily-test');
  try {
    const db = await miniflare.getD1Database('DB');
    await ensureTrafficDailyTable(db);

    const baseline = await recordDailyTraffic(db, [server], metrics(10_000, 20_000), '2026-08-31');
    assert.deepEqual(baseline, { inserted: true, hasMeasuredUsage: false });

    const measured = await recordDailyTraffic(db, [server], metrics(15_000, 28_000), '2026-09-01');
    assert.deepEqual(measured, { inserted: true, hasMeasuredUsage: true });
    const row = await db.prepare('SELECT * FROM traffic_daily WHERE report_date = ?')
      .bind('2026-09-01').first();
    assert.equal(row.rx_bytes, 5_000);
    assert.equal(row.tx_bytes, 8_000);

    const duplicate = await recordDailyTraffic(db, [server], metrics(17_000, 31_000), '2026-09-01');
    assert.deepEqual(duplicate, { inserted: false, hasMeasuredUsage: true });
    const unchanged = await db.prepare('SELECT * FROM traffic_daily WHERE report_date = ?')
      .bind('2026-09-01').first();
    assert.equal(unchanged.rx_bytes, 5_000);
    assert.equal(unchanged.tx_bytes, 8_000);
  } finally {
    await miniflare.dispose();
  }
});

test('traffic delta handles monthly counter resets', () => {
  assert.equal(calculateTrafficDelta(15_000, 10_000), 5_000);
  assert.equal(calculateTrafficDelta(2_048, 50_000), 2_048);
  assert.equal(calculateTrafficDelta(2_048, null), 0);
});

test('traffic report periods include Monday weekly and first-day monthly ranges', () => {
  const mondaySerial = Math.floor(Date.UTC(2026, 8, 7) / 86_400_000);
  assert.deepEqual(getTrafficReportPeriods(mondaySerial, { day: '07' }, {
    daily: true,
    weekly: true,
    monthly: true
  }), [
    { startDate: '2026-09-06', endDate: '2026-09-06', label: '每日' },
    { startDate: '2026-08-31', endDate: '2026-09-06', label: '每周' }
  ]);

  const monthStartSerial = Math.floor(Date.UTC(2026, 9, 1) / 86_400_000);
  assert.deepEqual(getTrafficReportPeriods(monthStartSerial, { day: '01' }, {
    monthly: true
  }), [
    { startDate: '2026-09-01', endDate: '2026-09-30', label: '每月' }
  ]);
});

test('traffic report content formats per-server usage and totals', () => {
  const report = buildTrafficReportContent([server], [{
    server_id: server.id,
    rx_bytes: 5_000,
    tx_bytes: 8_000
  }], '2026-09-01', '2026-09-01', '每日');

  assert.match(report.context.event, /每日流量报告/);
  assert.match(report.msg, /Tokyo/);
  assert.match(report.msg, /↓ 4\.88 KB/);
  assert.match(report.msg, /↑ 7\.81 KB/);
  assert.match(report.msg, /总计/);
});
