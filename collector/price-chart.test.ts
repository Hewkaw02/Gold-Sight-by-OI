import assert from 'node:assert/strict';
import test from 'node:test';
import { chartPriceValue, toChartPriceBars } from '../src/domain/price-chart.js';
import type { PriceBar } from '../src/domain/types.js';

const bar: PriceBar = {
  time: '2026-08-10T00:00:00.000Z',
  closeTime: '2026-08-10T23:00:00.000Z',
  symbol: 'GC',
  timeframe: '1D',
  open: 4_400,
  high: 4_500,
  low: 4_300,
  close: 4_420,
  volume: 100,
  source: 'test',
  sourceTimezone: 'UTC',
  isClosed: true,
};

test('uses close for the normal price chart basis', () => {
  assert.equal(chartPriceValue(bar, 'close'), 4_420);
});

test('uses OHLC4 for the mean price chart basis', () => {
  assert.equal(chartPriceValue(bar, 'mean'), 4_405);
});

test('maps mean prices without mutating the source bar', () => {
  const mapped = toChartPriceBars([bar], 'mean');
  assert.equal(mapped[0].close, 4_405);
  assert.equal(bar.close, 4_420);
});
