import test from 'node:test';
import assert from 'node:assert/strict';
import type { PriceBar } from '../src/domain/types.js';
import { latestClosedPriceBar, mergePriceBars } from './shared/price-bars.js';

function bar(time: string, timeframe: '1D' | '4H', isClosed: boolean, close: number): PriceBar {
  const closeTime = new Date(Date.parse(time) + (timeframe === '1D' ? 24 : 4) * 60 * 60 * 1000).toISOString();
  return {
    time,
    closeTime,
    symbol: 'GC',
    timeframe,
    open: close,
    high: close,
    low: close,
    close,
    volume: null,
    source: 'test',
    sourceTimezone: 'America/Chicago',
    isClosed,
  };
}

test('deduplicates daily bars that use different UTC offsets for the same trading date', () => {
  const merged = mergePriceBars(
    [bar('2026-08-10T00:00:00.000Z', '1D', true, 4_300)],
    [bar('2026-08-10T05:00:00.000Z', '1D', true, 4_350)],
    '1D',
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].close, 4_350);
});

test('does not replace a closed daily bar with a newer open row', () => {
  const merged = mergePriceBars(
    [bar('2026-08-10T05:00:00.000Z', '1D', true, 4_300)],
    [bar('2026-08-10T05:00:00.000Z', '1D', false, 4_400)],
    '1D',
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].close, 4_300);
  assert.equal(latestClosedPriceBar(merged)?.close, 4_300);
});

test('keeps a current open bar alongside the latest closed history', () => {
  const merged = mergePriceBars(
    [bar('2026-08-07T10:00:00.000Z', '1D', true, 4_300)],
    [bar('2026-08-10T10:00:00.000Z', '1D', false, 4_400)],
    '1D',
  );

  assert.equal(merged.length, 2);
  assert.equal(merged.at(-1)?.isClosed, false);
  assert.equal(latestClosedPriceBar(merged)?.close, 4_300);
});

test('keeps distinct four-hour bars', () => {
  const merged = mergePriceBars(
    [bar('2026-08-10T05:00:00.000Z', '4H', true, 4_300)],
    [bar('2026-08-10T09:00:00.000Z', '4H', true, 4_400)],
    '4H',
  );

  assert.equal(merged.length, 2);
});
