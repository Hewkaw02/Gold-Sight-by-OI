import test from 'node:test';
import assert from 'node:assert/strict';
import type { OISnapshot, PriceBar } from '../src/domain/types.js';
import { businessDaysBetween, oiFreshness, priceFreshness } from './shared/data-freshness.js';

const price: PriceBar = {
  time: '2026-08-11T02:00:00.000Z', closeTime: '2026-08-11T06:00:00.000Z', symbol: 'GC', timeframe: '4H',
  open: 4400, high: 4410, low: 4390, close: 4405, volume: null, source: 'test', sourceTimezone: 'UTC', isClosed: true,
};

test('uses a strict 12-hour default for 4H freshness', () => {
  assert.equal(priceFreshness([price], '4H', Date.parse('2026-08-11T17:59:00.000Z')).fresh, true);
  assert.equal(priceFreshness([price], '4H', Date.parse('2026-08-11T18:01:00.000Z')).fresh, false);
});

test('measures OI lag in business days', () => {
  const snapshot = { tradeDate: '2026-08-07', oiAsOfDate: '2026-08-07' } as OISnapshot;
  assert.equal(businessDaysBetween('2026-08-07', '2026-08-12'), 3);
  assert.equal(oiFreshness([snapshot], '2026-08-12', 2).fresh, false);
});

test('does not treat a newer warning-only snapshot as fresh OI', () => {
  const valid = {
    tradeDate: '2026-08-07',
    oiAsOfDate: '2026-08-06',
    strikes: [{ callOpenInterest: 100, putOpenInterest: 50 }],
  } as OISnapshot;
  const warningOnly = {
    tradeDate: '2026-08-12',
    oiAsOfDate: null,
    strikes: [{ callOpenInterest: null, putOpenInterest: null }],
  } as OISnapshot;
  const freshness = oiFreshness([valid, warningOnly], '2026-08-13', 2);
  assert.equal(freshness.asOfDate, '2026-08-06');
  assert.equal(freshness.fresh, false);
});
