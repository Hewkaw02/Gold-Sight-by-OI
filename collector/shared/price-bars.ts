import type { PriceBar, PriceTimeframe } from '../../src/domain/types.js';

function barKey(bar: PriceBar, timeframe: PriceTimeframe) {
  const timeKey = timeframe === '1D' ? bar.time.slice(0, 10) : bar.time;
  return bar.symbol + '|' + bar.timeframe + '|' + timeKey;
}

export function mergePriceBars(
  existing: PriceBar[],
  incoming: PriceBar[],
  timeframe: PriceTimeframe,
) {
  const closedIncoming = incoming.filter((bar) => bar.isClosed);
  const incomingStart = Math.min(...closedIncoming.map((bar) => Date.parse(bar.time)));
  const canonicalWindow = closedIncoming.length >= 100 && Number.isFinite(incomingStart);
  const overlapMs = timeframe === '1D' ? 36 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const base = canonicalWindow
    ? existing.filter((bar) => Date.parse(bar.time) < incomingStart - overlapMs)
    : existing;
  const values = new Map<string, PriceBar>();
  for (const bar of [...base, ...incoming]) {
    const key = barKey(bar, timeframe);
    const current = values.get(key);
    if (!current || bar.isClosed || !current.isClosed) values.set(key, bar);
  }
  return [...values.values()]
    .sort((a, b) => a.time.localeCompare(b.time));
}

export function latestClosedPriceBar(price: PriceBar[]) {
  return price
    .filter((bar) => bar.isClosed)
    .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))
    .at(-1) ?? null;
}
