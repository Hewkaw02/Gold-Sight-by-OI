import test from 'node:test';
import assert from 'node:assert/strict';
import type { PriceBar } from '../src/domain/types.js';
import { buildPriceProjection } from '../src/domain/price-projection.js';

function priceSeries(count: number, timeframe: '1D' | '4H' = '1D'): PriceBar[] {
  const stepMs = timeframe === '1D' ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: count }, (_, index) => {
    const close = 4_000 + index * 3 + Math.sin(index / 4) * 5;
    const time = new Date(start + index * stepMs).toISOString();
    return {
      time,
      closeTime: time,
      symbol: 'GC',
      timeframe,
      open: close - 2,
      high: close + 5,
      low: close - 5,
      close,
      volume: null,
      source: 'test',
      sourceTimezone: 'UTC',
      isClosed: true,
    };
  });
}

test('builds a rolling-origin ensemble projection with an expanding uncertainty range', () => {
  const projection = buildPriceProjection(priceSeries(60), '1D', 30);

  assert.ok(projection);
  assert.equal(projection.data.length, 31);
  assert.equal(projection.lowerBand.length, projection.data.length);
  assert.equal(projection.upperBand.length, projection.data.length);
  assert.equal(projection.direction, 'up');
  assert.match(projection.method, /rolling-origin weighted ensemble/);
  assert.ok(projection.modelScores.length >= 2);
  assert.ok(Math.abs(projection.modelScores.reduce((sum, score) => sum + score.weight, 0) - 1) < 0.000001);
  assert.ok(projection.backtestObservations > 0);
  assert.ok(['trend', 'range', 'volatile'].includes(projection.regime));
  assert.ok(projection.featureSummary.some((feature) => feature.startsWith('EMA ')));
  assert.ok(projection.upperBand.at(-1)![1] > projection.data.at(-1)![1]);
  assert.ok(projection.lowerBand.at(-1)![1] < projection.data.at(-1)![1]);
});

test('uses the selected horizon for 4H projections', () => {
  const projection = buildPriceProjection(priceSeries(180, '4H'), '4H', 10);

  assert.ok(projection);
  assert.equal(projection.horizonDays, 10);
  assert.equal(projection.data.length, 61);
});

test('returns no forecast when there are too few observations', () => {
  assert.equal(buildPriceProjection(priceSeries(7), '1D', 30), null);
});

test('does not synthesize weekend dates when source history follows weekdays', () => {
  const rows = priceSeries(120).filter((bar) => {
    const weekday = new Date(bar.time).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  });
  const projection = buildPriceProjection(rows, '1D', 30);

  assert.ok(projection);
  assert.equal(projection.data.slice(1).some(([time]) => [0, 6].includes(new Date(time).getUTCDay())), false);
  assert.ok(projection.backtestError80 >= projection.backtestMae);
});
