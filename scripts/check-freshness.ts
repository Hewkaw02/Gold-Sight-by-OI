import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PriceBar, PriceTimeframe } from '../src/domain/types.js';
import { priceFreshness } from '../collector/shared/data-freshness.js';

const dataRoot = path.resolve(process.env.GOLD_SIGHT_DATA_ROOT ?? 'public/data');
const symbol = process.env.GOLD_SIGHT_SYMBOL ?? 'GC';
const now = Date.parse(process.env.FRESHNESS_NOW ?? new Date().toISOString());

async function readPrice(timeframe: PriceTimeframe) {
  const relative = timeframe === '1D' ? '1d' : '4h';
  return JSON.parse(await readFile(path.join(dataRoot, 'price', symbol, relative, 'latest.json'), 'utf8')) as PriceBar[];
}

const results = await Promise.all((['1D', '4H'] as const).map(async (timeframe) => {
  const result = priceFreshness(await readPrice(timeframe), timeframe, now);
  return {
    timeframe,
    closeTime: result.closeTime,
    ageHours: Number.isFinite(result.ageHours) ? Number(result.ageHours.toFixed(2)) : null,
    maxAgeHours: result.maxAgeHours,
    fresh: result.fresh,
  };
}));

console.log(JSON.stringify({ checkedAt: new Date(now).toISOString(), results }, null, 2));
if (results.some((result) => !result.fresh)) {
  console.error('Price freshness check failed: at least one timeframe is beyond its allowed age.');
  process.exitCode = 1;
}
