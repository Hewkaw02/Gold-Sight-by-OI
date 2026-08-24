import type { PriceBar, PriceChartMode } from './types.js';

/**
 * Returns the price plotted for the selected chart basis.
 * Mean uses OHLC4, while close preserves the existing close-price view.
 */
export function chartPriceValue(bar: PriceBar, mode: PriceChartMode): number {
  if (mode === 'close') return bar.close;
  const values = [bar.open, bar.high, bar.low, bar.close].filter(Number.isFinite);
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : bar.close;
}

/**
 * Creates a projection-compatible price series without mutating the source data.
 */
export function toChartPriceBars(price: PriceBar[], mode: PriceChartMode): PriceBar[] {
  if (mode === 'close') return price;
  return price.map((bar) => ({ ...bar, close: chartPriceValue(bar, mode) }));
}

export function chartPriceLabel(mode: PriceChartMode): string {
  return mode === 'mean' ? 'Mean price (OHLC4)' : 'Futures close';
}
