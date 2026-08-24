import type { OISnapshot, PriceBar, PriceTimeframe } from '../../src/domain/types.js';
import { latestClosedPriceBar } from './price-bars.js';

const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_PRICE_MAX_AGE_HOURS: Record<PriceTimeframe, number> = {
  '1D': 72,
  '4H': 12,
};

export function priceMaxAgeHours(timeframe: PriceTimeframe) {
  const name = timeframe === '1D' ? 'PRICE_1D_MAX_AGE_HOURS' : 'PRICE_4H_MAX_AGE_HOURS';
  const configured = Number(process.env[name] ?? DEFAULT_PRICE_MAX_AGE_HOURS[timeframe]);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PRICE_MAX_AGE_HOURS[timeframe];
}

export function priceFreshness(price: PriceBar[], timeframe: PriceTimeframe, now = Date.now()) {
  const bar = latestClosedPriceBar(price);
  const closeTime = bar ? Date.parse(bar.closeTime) : Number.NaN;
  const ageHours = Number.isFinite(closeTime) ? Math.max(0, (now - closeTime) / HOUR_MS) : Number.POSITIVE_INFINITY;
  const maxAgeHours = priceMaxAgeHours(timeframe);
  return {
    bar,
    closeTime: bar?.closeTime ?? null,
    ageHours,
    maxAgeHours,
    fresh: Number.isFinite(ageHours) && ageHours <= maxAgeHours,
  };
}

export function latestOiAsOfDate(snapshots: OISnapshot[]) {
  const settledDates = snapshots
    .filter((snapshot) => (snapshot.strikes ?? []).some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null))
    .map((snapshot) => snapshot.oiAsOfDate)
    .filter((value): value is string => Boolean(value))
    .sort();
  return settledDates.at(-1) ?? null;
}

export function businessDaysBetween(fromDate: string, toDate: string) {
  const from = new Date(`${fromDate}T00:00:00.000Z`);
  const to = new Date(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) return 0;
  let days = 0;
  for (const cursor = new Date(from); cursor < to;) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}

export function oiFreshness(snapshots: OISnapshot[], referenceDate: string, maxBusinessDayLag = 2) {
  const asOfDate = latestOiAsOfDate(snapshots);
  const businessDayLag = asOfDate ? businessDaysBetween(asOfDate, referenceDate) : Number.POSITIVE_INFINITY;
  return {
    asOfDate,
    businessDayLag,
    maxBusinessDayLag,
    fresh: Number.isFinite(businessDayLag) && businessDayLag <= maxBusinessDayLag,
  };
}
