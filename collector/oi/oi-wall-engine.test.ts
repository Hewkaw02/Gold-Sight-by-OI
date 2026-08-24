import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLevels, buildWallSegments, normalizeSnapshot } from './oi-wall-engine.js';

function snapshot(date: string, call: number, put: number, slot: 'open' | 'mid' | 'close' = 'close') {
  return normalizeSnapshot({
    symbol: 'GC', tradeDate: date, sessionSlot: slot, targetDte: 7, actualDte: 7,
    expiryDate: '2026-08-14', futurePrice: 4300, capturedAt: `${date}T20:00:00.000Z`,
    strikes: [{ viewName: 'Open Interest', strike: 4300, callOpenInterest: call, putOpenInterest: put }],
  }, null);
}

test('prefers close over mid and open for the same tenor', () => {
  const levels = aggregateLevels([
    snapshot('2026-08-01', 100, 10, 'open'),
    snapshot('2026-08-01', 120, 10, 'close'),
  ], { p90Quantile: 0.9 });
  assert.equal(levels.length, 1);
  assert.equal(levels[0].callOi, 120);
});

test('keeps unique expiry once when multiple target DTEs reference it', () => {
  const first = snapshot('2026-08-01', 100, 20);
  const second = { ...snapshot('2026-08-01', 100, 20), targetDte: 15, snapshotId: 'second' };
  const levels = aggregateLevels([first, second], { p90Quantile: 0.9 });
  assert.equal(levels[0].callOi, 100);
  assert.deepEqual(levels[0].targetDtes, [7, 15]);
});

test('derives dominance and closes a wall when it stops being significant', () => {
  const weakerNextDay = snapshot('2026-08-02', 10, 10);
  weakerNextDay.strikes.push({
    viewName: 'Open Interest', strike: 4400, callOpenInterest: 500, putOpenInterest: 20,
    callVolume: null, putVolume: null, impliedVol: null, settleVol: null, extra: {},
  });
  const levels = aggregateLevels([
    snapshot('2026-08-01', 200, 20),
    weakerNextDay,
  ], { p90Quantile: 0.9 });
  const segments = buildWallSegments(levels, { p90Quantile: 0.9, endAt: '2026-08-03T20:00:00.000Z' });
  assert.equal(levels[0].dominance > 0, true);
  assert.equal(segments[0].status, 'closed');
  assert.equal(segments[0].to, '2026-08-02T20:00:00.000Z');
});

test('keeps consecutive significant observations in one lifecycle segment', () => {
  const levels = aggregateLevels([
    snapshot('2026-08-01', 200, 20),
    snapshot('2026-08-02', 220, 20),
    snapshot('2026-08-03', 240, 20),
  ]);
  const segments = buildWallSegments(levels, { endAt: '2026-08-04T20:00:00.000Z' });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].from, '2026-08-01T20:00:00.000Z');
  assert.equal(segments[0].to, '2026-08-04T20:00:00.000Z');
  assert.equal(segments[0].callOi, 240);
  assert.equal(segments[0].status, 'active');
});

test('maps different futures bases onto the same $5 front-equivalent strike', () => {
  const near = snapshot('2026-08-01', 100, 0);
  const far = {
    ...snapshot('2026-08-01', 80, 20),
    snapshotId: 'far-expiry',
    expiryDate: '2026-09-30',
    targetDte: 60,
    actualDte: 60,
    futurePrice: 4350,
    strikes: [{ ...snapshot('2026-08-01', 80, 20).strikes[0], strike: 4350 }],
  };
  const levels = aggregateLevels([near, far], { basisGrid: 5, frontEquivalent: true });
  const combined = levels.find((level) => level.strike === 4300);

  assert.equal(combined?.callOi, 180);
  assert.equal(combined?.putOi, 20);
  assert.deepEqual(combined?.snapshotIds.sort(), [near.snapshotId, far.snapshotId].sort());
});

test('ignores snapshots whose expiry is before the observation date', () => {
  const expired = { ...snapshot('2026-08-15', 500, 0), expiryDate: '2026-08-14' };
  assert.equal(aggregateLevels([expired]).length, 0);
});
