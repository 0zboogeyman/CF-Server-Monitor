import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrafficReportContent,
  calculateTrafficDelta,
  getDueTrafficReportTypes,
  getTrafficPeriodKeys,
  normalizeTrafficSnapshots,
  updateTrafficSnapshots
} from '../src/services/notification.js';

const timezone = 'Asia/Shanghai';
const server = { id: 'server-1', name: 'Tokyo' };

test('traffic snapshots initialize the three lightweight JSON baselines', () => {
  const now = Date.UTC(2026, 8, 1, 1);
  const result = updateTrafficSnapshots('{}', 10_000, 20_000, now, ['daily', 'weekly', 'monthly']);

  assert.equal(result.changed, true);
  assert.deepEqual(result.usage, {});
  assert.deepEqual(Object.keys(result.snapshots), ['daily', 'weekly', 'monthly']);
  for (const snapshot of Object.values(result.snapshots)) {
    assert.deepEqual(snapshot, {
      time: Math.floor(now / 1000),
      rx_bytes: 10_000,
      tx_bytes: 20_000
    });
  }
});

test('traffic snapshots calculate usage and roll only crossed period boundaries', () => {
  const first = updateTrafficSnapshots('{}', 10_000, 20_000, Date.UTC(2026, 8, 6, 1), ['daily', 'weekly', 'monthly']);
  const monday = updateTrafficSnapshots(first.snapshots, 15_000, 28_000, Date.UTC(2026, 8, 7, 1), ['daily', 'weekly']);

  assert.deepEqual(monday.usage.daily, { rx_bytes: 5_000, tx_bytes: 8_000 });
  assert.deepEqual(monday.usage.weekly, { rx_bytes: 5_000, tx_bytes: 8_000 });
  assert.equal(monday.usage.monthly, undefined);
  assert.equal(monday.snapshots.daily.rx_bytes, 15_000);
  assert.equal(monday.snapshots.weekly.rx_bytes, 15_000);
  assert.equal(monday.snapshots.monthly.rx_bytes, 10_000);
});

test('traffic snapshot period keys honor the configured notification timezone', () => {
  const sundayUtc = Date.UTC(2026, 8, 6, 16, 30);
  assert.deepEqual(getTrafficPeriodKeys(sundayUtc, timezone), {
    daily: '2026-09-07',
    weekly: '2026-09-07',
    monthly: '2026-09'
  });

  assert.deepEqual(getDueTrafficReportTypes(sundayUtc, timezone), ['daily', 'weekly']);

  const monthStart = updateTrafficSnapshots('{}', 1_000, 2_000, Date.UTC(2026, 8, 30, 15), ['monthly']);
  const october = updateTrafficSnapshots(monthStart.snapshots, 3_000, 5_000, Date.UTC(2026, 8, 30, 16), ['monthly']);
  assert.equal(october.snapshots.monthly.rx_bytes, 3_000);
  assert.equal(october.snapshots.monthly.tx_bytes, 5_000);
});

test('traffic snapshot parsing and counter reset handling are backward safe', () => {
  assert.deepEqual(normalizeTrafficSnapshots('invalid json'), {});
  assert.equal(calculateTrafficDelta(15_000, 10_000), 5_000);
  assert.equal(calculateTrafficDelta(2_048, 50_000), 2_048);
  assert.equal(calculateTrafficDelta(2_048, null), 0);
});

test('traffic report content formats per-server usage and totals', () => {
  const report = buildTrafficReportContent([server], [{
    server_id: server.id,
    rx_bytes: 5_000,
    tx_bytes: 8_000
  }], '每日');

  assert.match(report.context.event, /每日流量报告/);
  assert.match(report.msg, /Tokyo/);
  assert.match(report.msg, /↓ 4\.88 KB/);
  assert.match(report.msg, /↑ 7\.81 KB/);
  assert.match(report.msg, /总计/);
});

test('traffic report content explains missing previous-period baselines', () => {
  const labels = [
    ['每日', '暂无上一日数据'],
    ['每周', '暂无上周数据'],
    ['每月', '暂无上月数据']
  ];
  for (const [label, expected] of labels) {
    const report = buildTrafficReportContent([server], [{
      server_id: server.id,
      missing: true
    }], label);
    assert.match(report.msg, new RegExp(expected));
    assert.doesNotMatch(report.msg, /总计/);
  }
});
