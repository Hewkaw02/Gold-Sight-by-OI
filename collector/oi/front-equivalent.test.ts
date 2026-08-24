import test from 'node:test';
import assert from 'node:assert/strict';
import type { OISnapshot } from '../../src/domain/types.js';
import { dedupeOiSnapshots, extendFrontEquivalent } from './front-equivalent.js';

function snapshot(expiryDate: string, actualDte: number, targetDte = 30): OISnapshot {
  return {
    snapshotId: `GC-2026-08-07-close-${expiryDate}`,
    symbol: 'GC',
    tradeDate: '2026-08-07',
    fetchedAt: '2026-08-07T20:00:00.000Z',
    sessionSlot: 'close',
    targetDte,
    actualDte,
    expiryDate,
    futurePrice: 3400,
    sourceStatus: 'VALID',
    sourceAsOf: '2026-08-07',
    oiAsOfDate: '2026-08-07',
    oiSource: 'options_chain_eod',
    selectedViews: ['options_chain_eod'],
    sourceFile: null,
    rawSha256: null,
    strikes: [
      { viewName: 'options_chain_eod', strike: 4000, callOpenInterest: 100, putOpenInterest: 20, callVolume: null, putVolume: null, impliedVol: null, settleVol: null, extra: {} },
      { viewName: 'options_chain_eod', strike: 20000, callOpenInterest: 1000, putOpenInterest: 0, callVolume: null, putVolume: null, impliedVol: null, settleVol: null, extra: {} },
    ],
  };
}

test('extends front equivalent with verified 60D/90D contracts without duplicating existing expiries', () => {
  const front = [snapshot('2026-08-21', 14, 15), snapshot('2026-09-07', 31, 60)];
  const allExpiry = [
    snapshot('2026-08-21', 14, 14),
    snapshot('2026-09-21', 45, 45),
    snapshot('2026-11-05', 90, 90),
    snapshot('2027-01-05', 151, 151),
  ];
  const extended = extendFrontEquivalent(front, allExpiry);

  assert.deepEqual(extended.map((item) => [item.expiryDate, item.targetDte]), [
    ['2026-08-21', 15],
    ['2026-09-07', 60],
    ['2026-09-21', 60],
    ['2026-11-05', 90],
  ]);
  assert.equal(extended.find((item) => item.expiryDate === '2026-09-21')?.strikes.some((strike) => strike.strike === 20000), false);
});

test('deduplicates snapshot ids and marks missing OI as warning', () => {
  const original = snapshot('2026-09-07', 30.003, 30);
  original.strikes = original.strikes.map((strike) => ({ ...strike, callOpenInterest: null, putOpenInterest: null }));
  const result = dedupeOiSnapshots([original, { ...original }]);

  assert.equal(result.length, 1);
  assert.equal(result[0].actualDte, 30);
  assert.equal(result[0].sourceStatus, 'WARNING');
  assert.equal(result[0].oiSource, 'missing');
});
