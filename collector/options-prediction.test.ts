import test from 'node:test';
import assert from 'node:assert/strict';
import type { OISnapshot, OIStrike } from '../src/domain/types.js';
import { buildOptionsPrediction } from '../src/domain/options-prediction.js';

function strike(strike: number, callOi: number, putOi: number, impliedVol: number | null = null): OIStrike {
  return {
    viewName: 'test',
    strike,
    callOpenInterest: callOi,
    putOpenInterest: putOi,
    callVolume: null,
    putVolume: null,
    impliedVol,
    settleVol: null,
    extra: {},
  };
}

function snapshot(expiryDate: string, strikes: OIStrike[]): OISnapshot {
  return {
    snapshotId: `GC-2026-08-07-close-all-${expiryDate}`,
    symbol: 'GC',
    tradeDate: '2026-08-07',
    fetchedAt: '2026-08-07T19:30:00.000Z',
    sessionSlot: 'close',
    targetDte: 30,
    actualDte: 30,
    expiryDate,
    futurePrice: 4_400,
    sourceStatus: 'VALID',
    sourceAsOf: '2026-08-07T19:30:00.000Z',
    oiAsOfDate: '2026-08-06',
    oiSource: 'options_chain_eod',
    selectedViews: ['test'],
    sourceFile: null,
    rawSha256: null,
    strikes,
  };
}

test('processes full-expiry OI into max pain and Black-76 exposures', () => {
  const all = [snapshot('2026-09-07', [
    strike(4_200, 100, 10),
    strike(4_400, 40, 80),
    strike(4_600, 20, 120),
  ])];
  const front = [snapshot('2026-09-07', [
    strike(4_200, 100, 10, 0.22),
    strike(4_400, 40, 80, 0.2),
    strike(4_600, 20, 120, 0.24),
  ])];

  const prediction = buildOptionsPrediction(all, front, 4_400, { asOfDate: '2026-08-11' });

  assert.equal(prediction.method, 'black-76-horizon-oi');
  assert.equal(prediction.quality.activeExpiryCount, 1);
  assert.equal(prediction.quality.strikesWithOi, 3);
  assert.equal(prediction.quality.strikesWithObservedVol, 3);
  assert.ok(prediction.maxPain.compositeStrike !== null);
  assert.ok(prediction.gamma.netExposure !== 0);
  assert.ok(Number.isFinite(prediction.vanna.netExposure));
  assert.ok(prediction.scenario.targetPrice !== null);
});

test('falls back transparently when all-expiry rows have no IV', () => {
  const prediction = buildOptionsPrediction(
    [snapshot('2026-09-07', [strike(4_400, 100, 100)])],
    [],
    4_400,
    { asOfDate: '2026-08-11', fallbackVolatility: 0.3 },
  );

  assert.equal(prediction.quality.observedVolCoverage, 0);
  assert.equal(prediction.quality.fallbackVolatility, 0.3);
  assert.ok(prediction.quality.warnings.some((warning) => warning.includes('fallback median volatility')));
  assert.equal(prediction.levels[0]?.volatilitySource, 'fallback-median');
});

test('does not include expiry snapshots that are already expired at the as-of date', () => {
  const prediction = buildOptionsPrediction(
    [
      snapshot('2026-08-10', [strike(4_400, 100, 100)]),
      snapshot('2026-09-07', [strike(4_400, 50, 50)]),
    ],
    [],
    4_400,
    { asOfDate: '2026-08-11' },
  );

  assert.equal(prediction.quality.activeExpiryCount, 1);
  assert.equal(prediction.maxPain.nearestExpiry, '2026-09-07');
});

test('keeps the last usable OI when a newer snapshot is warning-only', () => {
  const valid = snapshot('2026-09-07', [strike(4_400, 100, 100)]);
  const warningOnly = {
    ...valid,
    snapshotId: 'GC-2026-08-12-close-all-2026-09-07',
    tradeDate: '2026-08-12',
    fetchedAt: '2026-08-12T19:30:00.000Z',
    sourceStatus: 'WARNING' as const,
    oiAsOfDate: null,
    oiSource: 'missing' as const,
    strikes: [strike(4_400, 0, 0)],
  };

  const prediction = buildOptionsPrediction([valid, warningOnly], [], 4_400, { asOfDate: '2026-08-12' });

  assert.equal(prediction.quality.activeExpiryCount, 1);
  assert.equal(prediction.quality.strikesWithOi, 1);
  assert.equal(prediction.quality.latestOiDate, '2026-08-07');
});

test('keeps far expiries in inventory but excludes them from the 90D predictive surface', () => {
  const prediction = buildOptionsPrediction([
    snapshot('2026-09-07', [strike(4_400, 100, 100)]),
    snapshot('2027-09-07', [strike(8_000, 100_000, 0)]),
  ], [], 4_400, { asOfDate: '2026-08-11', horizonDays: 90 });

  assert.equal(prediction.maxPain.byExpiry.length, 2);
  assert.equal(prediction.quality.activeExpiryCount, 1);
  assert.equal(prediction.levels.some((level) => level.strike === 8_000), false);
  assert.ok(prediction.quality.warnings.some((warning) => warning.includes('within 90 calendar days')));
});
