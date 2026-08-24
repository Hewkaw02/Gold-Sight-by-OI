import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDominanceOutlook } from './dominance-projection.js';
import type { OISnapshot } from '../../src/domain/types.js';

function snapshot(expiryDate: string, fetchedAt: string, callOi: number, putOi: number): OISnapshot {
  return {
    snapshotId: `GC-${expiryDate}-${fetchedAt}`,
    symbol: 'GC',
    tradeDate: fetchedAt.slice(0, 10),
    fetchedAt,
    sessionSlot: 'close',
    targetDte: 0,
    actualDte: 0,
    expiryDate,
    futurePrice: 4300,
    sourceStatus: 'VALID',
    sourceAsOf: fetchedAt,
    oiAsOfDate: fetchedAt.slice(0, 10),
    oiSource: 'options_chain_eod',
    selectedViews: ['options_chain_eod'],
    sourceFile: null,
    rawSha256: null,
    strikes: [{
      viewName: 'options_chain_eod',
      strike: 4300,
      callOpenInterest: callOi,
      putOpenInterest: putOi,
      callVolume: null,
      putVolume: null,
      impliedVol: null,
      settleVol: null,
      extra: {},
    }],
  };
}

test('builds an expiry-aware dominance outlook and removes expired contracts', () => {
  const outlook = buildDominanceOutlook([
    snapshot('2026-08-20', '2026-08-09T20:00:00.000Z', 100, 50),
    snapshot('2026-08-20', '2026-08-08T20:00:00.000Z', 10, 100),
    snapshot('2026-09-20', '2026-08-09T20:00:00.000Z', 20, 80),
  ], { baseDate: '2026-08-10', horizonDays: 90 });

  assert.equal(outlook.expiryStart, '2026-08-20');
  assert.equal(outlook.expiryEnd, '2026-09-20');
  assert.equal(outlook.points[0].activeExpiryCount, 2);
  assert.equal(outlook.points[0].dominance, (120 - 130) / 250);
  const afterFirstExpiry = outlook.points.find((point) => point.time === '2026-08-21');
  assert.equal(afterFirstExpiry?.activeExpiryCount, 1);
  assert.equal(afterFirstExpiry?.dominance, (20 - 80) / 100);
});
