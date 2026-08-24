import type {
  OISnapshot,
  OptionsExpiryMetric,
  OptionsPrediction,
  OptionsPredictionLevel,
  OptionsVolatilitySource,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VOLATILITY = 0.24;
const MIN_VOLATILITY = 0.04;
const MAX_VOLATILITY = 2.5;
const DEFAULT_CONTRACT_MULTIPLIER = 100;
const DEFAULT_RISK_FREE_RATE = 0.04;
const DEFAULT_DAYS_PER_YEAR = 365;

export interface OptionsPredictionOptions {
  asOfDate?: string;
  riskFreeRate?: number;
  contractMultiplier?: number;
  daysPerYear?: number;
  fallbackVolatility?: number;
  maxLevels?: number;
  horizonDays?: number;
}

interface SurfaceRow {
  expiryDate: string;
  tradeDate: string;
  futurePrice: number;
  strike: number;
  callOi: number;
  putOi: number;
  impliedVol: number;
  volatilitySource: OptionsVolatilitySource;
  daysToExpiry: number;
  timeToExpiry: number;
}

interface AggregateStrike {
  strike: number;
  callOi: number;
  putOi: number;
  expiryDates: Set<string>;
  deltaExposure: number;
  gammaExposure: number;
  vannaExposure: number;
  weightedVol: number;
  weightedDays: number;
  observedVolOi: number;
  observedVolSource: OptionsVolatilitySource | null;
  totalOiForWeight: number;
}

interface GreekResult {
  callDelta: number;
  putDelta: number;
  gamma: number;
  vanna: number;
}

interface PainResult {
  strike: number;
  pain: number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function normalPdf(value: number) {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const absolute = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-absolute * absolute);
  return 0.5 * (1 + sign * polynomial);
}

function dateDays(from: string, to: string) {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  return Number.isFinite(fromTime) && Number.isFinite(toTime) ? (toTime - fromTime) / DAY_MS : 0;
}

function rowVolatility(strike: { impliedVol: number | null; settleVol: number | null }) {
  if (finite(strike.impliedVol) && strike.impliedVol > 0) return { value: strike.impliedVol, source: 'observed-iv' as const };
  if (finite(strike.settleVol) && strike.settleVol > 0) return { value: strike.settleVol, source: 'observed-settle-vol' as const };
  return null;
}

function hasPositiveOpenInterest(snapshot: OISnapshot) {
  return snapshot.strikes.some((strike) =>
    (finite(strike.callOpenInterest) && strike.callOpenInterest > 0)
    || (finite(strike.putOpenInterest) && strike.putOpenInterest > 0));
}

function latestSnapshotByExpiry(snapshots: OISnapshot[], asOfDate: string) {
  const selected = new Map<string, OISnapshot>();
  for (const snapshot of snapshots) {
    if (!snapshot.expiryDate || snapshot.expiryDate <= asOfDate || snapshot.tradeDate > asOfDate) continue;
    const current = selected.get(snapshot.expiryDate);
    const snapshotHasOi = hasPositiveOpenInterest(snapshot);
    const currentHasOi = current ? hasPositiveOpenInterest(current) : false;
    if (!current
      || (snapshotHasOi && !currentHasOi)
      || (snapshotHasOi === currentHasOi && (snapshot.tradeDate > current.tradeDate || (snapshot.tradeDate === current.tradeDate && snapshot.fetchedAt > current.fetchedAt)))) {
      selected.set(snapshot.expiryDate, snapshot);
    }
  }
  return [...selected.values()].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}

function buildVolatilityLookup(snapshots: OISnapshot[], asOfDate: string) {
  const selected = latestSnapshotByExpiry(snapshots, asOfDate);
  const lookup = new Map<string, { value: number; source: OptionsVolatilitySource }>();
  const observed: number[] = [];
  for (const snapshot of selected) {
    for (const strike of snapshot.strikes) {
      const volatility = rowVolatility(strike);
      if (!volatility) continue;
      const value = clamp(volatility.value, MIN_VOLATILITY, MAX_VOLATILITY);
      const source = volatility.source;
      lookup.set(`${snapshot.expiryDate}|${strike.strike}`, { value, source });
      observed.push(value);
    }
  }
  return { lookup, observed };
}

function black76(futurePrice: number, strike: number, timeToExpiry: number, volatility: number, riskFreeRate: number): GreekResult {
  if (futurePrice <= 0 || strike <= 0 || timeToExpiry <= 0 || volatility <= 0) {
    return { callDelta: 0.5, putDelta: -0.5, gamma: 0, vanna: 0 };
  }
  const rootTime = Math.sqrt(timeToExpiry);
  const sigmaRootTime = volatility * rootTime;
  const d1 = (Math.log(futurePrice / strike) + 0.5 * volatility * volatility * timeToExpiry) / sigmaRootTime;
  const d2 = d1 - sigmaRootTime;
  const discount = Math.exp(-riskFreeRate * timeToExpiry);
  const gamma = discount * normalPdf(d1) / (futurePrice * sigmaRootTime);
  const vanna = discount * normalPdf(d1) * (-d2 / volatility);
  return {
    callDelta: discount * normalCdf(d1),
    putDelta: discount * (normalCdf(d1) - 1),
    gamma,
    vanna,
  };
}

function maxPain(rows: Array<Pick<SurfaceRow, 'strike' | 'callOi' | 'putOi'>>): PainResult | null {
  const byStrike = new Map<number, { callOi: number; putOi: number }>();
  for (const row of rows) {
    const current = byStrike.get(row.strike) ?? { callOi: 0, putOi: 0 };
    current.callOi += row.callOi;
    current.putOi += row.putOi;
    byStrike.set(row.strike, current);
  }
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  const first = strikes[0];
  let pain = 0;
  let totalPutOi = 0;
  for (const value of byStrike.values()) totalPutOi += value.putOi;
  for (const strike of strikes) pain += byStrike.get(strike)!.putOi * Math.max(0, strike - first);

  let bestStrike = first;
  let bestPain = pain;
  const firstRow = byStrike.get(first)!;
  let slope = firstRow.callOi - (totalPutOi - firstRow.putOi);
  for (let index = 1; index < strikes.length; index += 1) {
    const strike = strikes[index];
    const previousStrike = strikes[index - 1];
    pain += slope * (strike - previousStrike);
    if (pain < bestPain) {
      bestPain = pain;
      bestStrike = strike;
    }
    const row = byStrike.get(strike)!;
    slope += row.callOi + row.putOi;
  }
  return { strike: bestStrike, pain: Math.max(0, bestPain) };
}

function exposureAtPrice(rows: SurfaceRow[], price: number, riskFreeRate: number, contractMultiplier: number) {
  let net = 0;
  for (const row of rows) {
    const greek = black76(price, row.strike, row.timeToExpiry, row.impliedVol, riskFreeRate);
    net += greek.gamma * (row.callOi - row.putOi) * contractMultiplier * price * price * 0.01;
  }
  return net;
}

function findGammaFlip(rows: SurfaceRow[], futurePrice: number, riskFreeRate: number, contractMultiplier: number) {
  if (rows.length === 0 || futurePrice <= 0) return null;
  const lower = futurePrice * 0.75;
  const upper = futurePrice * 1.25;
  const points = Array.from({ length: 41 }, (_, index) => lower + (upper - lower) * index / 40);
  const values = points.map((price) => exposureAtPrice(rows, price, riskFreeRate, contractMultiplier));
  const candidates: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === 0) candidates.push(points[index - 1]);
    else if (previous * current < 0) {
      const fraction = Math.abs(previous) / (Math.abs(previous) + Math.abs(current));
      candidates.push(points[index - 1] + (points[index] - points[index - 1]) * fraction);
    }
  }
  return candidates.sort((a, b) => Math.abs(a - futurePrice) - Math.abs(b - futurePrice))[0] ?? null;
}

function sourcePriority(source: OptionsVolatilitySource) {
  return source === 'observed-iv' ? 3 : source === 'observed-settle-vol' ? 2 : 1;
}

export function buildOptionsPrediction(
  allExpirySnapshots: OISnapshot[],
  frontSnapshots: OISnapshot[] = [],
  underlyingPrice: number,
  options: OptionsPredictionOptions = {},
): OptionsPrediction {
  const latestOiDate = allExpirySnapshots
    .filter(hasPositiveOpenInterest)
    .map((snapshot) => snapshot.tradeDate)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const asOfDate = options.asOfDate ?? latestOiDate ?? new Date().toISOString().slice(0, 10);
  const riskFreeRate = clamp(options.riskFreeRate ?? DEFAULT_RISK_FREE_RATE, -0.05, 0.25);
  const contractMultiplier = Math.max(1, options.contractMultiplier ?? DEFAULT_CONTRACT_MULTIPLIER);
  const daysPerYear = Math.max(1, options.daysPerYear ?? DEFAULT_DAYS_PER_YEAR);
  const horizonDays = Math.max(1, Math.round(options.horizonDays ?? 90));
  const observedVolatility = buildVolatilityLookup(frontSnapshots, asOfDate);
  const fallbackVolatility = clamp(options.fallbackVolatility ?? (median(observedVolatility.observed) || DEFAULT_VOLATILITY), MIN_VOLATILITY, MAX_VOLATILITY);
  const snapshots = latestSnapshotByExpiry(allExpirySnapshots, asOfDate);
  const surfaceRows: SurfaceRow[] = [];
  const expiryMetrics: OptionsExpiryMetric[] = [];
  const warningSet = new Set<string>();

  if (snapshots.length === 0) warningSet.add('No active expiry snapshot is available for the selected as-of date.');
  if (latestOiDate && dateDays(latestOiDate, asOfDate) > 2) warningSet.add(`OI is ${Math.round(dateDays(latestOiDate, asOfDate))} calendar days behind the price date.`);

  for (const snapshot of snapshots) {
    const daysToExpiry = Math.max(1, dateDays(asOfDate, snapshot.expiryDate));
    const timeToExpiry = daysToExpiry / daysPerYear;
    const strikesByPrice = new Map<number, { callOi: number; putOi: number; volatility: number; source: OptionsVolatilitySource }>();
    for (const strike of snapshot.strikes) {
      const callOi = finite(strike.callOpenInterest) ? Math.max(0, strike.callOpenInterest) : 0;
      const putOi = finite(strike.putOpenInterest) ? Math.max(0, strike.putOpenInterest) : 0;
      if (callOi + putOi <= 0 || !finite(strike.strike) || strike.strike <= 0) continue;
      const observed = observedVolatility.lookup.get(`${snapshot.expiryDate}|${strike.strike}`);
      const direct = rowVolatility(strike);
      const volatility = observed ?? (direct ? { value: clamp(direct.value, MIN_VOLATILITY, MAX_VOLATILITY), source: direct.source } : null);
      const next = volatility ?? { value: fallbackVolatility, source: 'fallback-median' as const };
      const current = strikesByPrice.get(strike.strike);
      if (!current) strikesByPrice.set(strike.strike, { callOi, putOi, volatility: next.value, source: next.source });
      else {
        current.callOi = Math.max(current.callOi, callOi);
        current.putOi = Math.max(current.putOi, putOi);
        if (sourcePriority(next.source) > sourcePriority(current.source)) {
          current.volatility = next.value;
          current.source = next.source;
        }
      }
    }

    const expiryRows: SurfaceRow[] = [...strikesByPrice.entries()].map(([strike, value]) => ({
      expiryDate: snapshot.expiryDate,
      tradeDate: snapshot.tradeDate,
      futurePrice: finite(snapshot.futurePrice) && snapshot.futurePrice > 0 ? snapshot.futurePrice : underlyingPrice,
      strike,
      callOi: value.callOi,
      putOi: value.putOi,
      impliedVol: value.volatility,
      volatilitySource: value.source,
      daysToExpiry,
      timeToExpiry,
    }));
    surfaceRows.push(...expiryRows);
    const pain = maxPain(expiryRows);
    const expiryGamma = expiryRows.reduce((sum, row) => {
      const greek = black76(underlyingPrice, row.strike, row.timeToExpiry, row.impliedVol, riskFreeRate);
      return sum + greek.gamma * (row.callOi - row.putOi) * contractMultiplier * underlyingPrice * underlyingPrice * 0.01;
    }, 0);
    const expiryVanna = expiryRows.reduce((sum, row) => {
      const greek = black76(underlyingPrice, row.strike, row.timeToExpiry, row.impliedVol, riskFreeRate);
      return sum + greek.vanna * (row.callOi - row.putOi) * contractMultiplier * underlyingPrice * 0.01;
    }, 0);
    const observedVolRows = expiryRows.filter((row) => row.volatilitySource !== 'fallback-median').length;
    expiryMetrics.push({
      expiryDate: snapshot.expiryDate,
      tradeDate: snapshot.tradeDate,
      futurePrice: snapshot.futurePrice,
      daysToExpiry,
      strikeCount: expiryRows.length,
      oiContracts: expiryRows.reduce((sum, row) => sum + row.callOi + row.putOi, 0),
      observedVolCoverage: expiryRows.length > 0 ? observedVolRows / expiryRows.length : 0,
      maxPainStrike: pain?.strike ?? 0,
      maxPainValue: pain?.pain ? pain.pain * contractMultiplier : 0,
      netGammaExposure: expiryGamma,
      netVannaExposure: expiryVanna,
    });
  }

  const modeledRows = surfaceRows.filter((row) => row.daysToExpiry <= horizonDays);
  const analysisRows = modeledRows.length > 0 ? modeledRows : surfaceRows;
  if (modeledRows.length < surfaceRows.length) warningSet.add(`Predictive Greeks and composite pain use expiries within ${horizonDays} calendar days; farther expiries remain available in the expiry inventory.`);
  const levelMap = new Map<number, AggregateStrike>();
  let callDeltaExposure = 0;
  let putDeltaExposure = 0;
  let callGammaExposure = 0;
  let putGammaExposure = 0;
  let callVannaExposure = 0;
  let putVannaExposure = 0;
  let observedVolRows = 0;
  let oiRows = 0;
  for (const row of analysisRows) {
    const greek = black76(underlyingPrice, row.strike, row.timeToExpiry, row.impliedVol, riskFreeRate);
    const totalOi = row.callOi + row.putOi;
    const deltaScale = contractMultiplier * underlyingPrice;
    const gammaScale = contractMultiplier * underlyingPrice * underlyingPrice * 0.01;
    const vannaScale = contractMultiplier * underlyingPrice * 0.01;
    const rowCallDelta = greek.callDelta * row.callOi * deltaScale;
    const rowPutDelta = greek.putDelta * row.putOi * deltaScale;
    const rowCallGamma = greek.gamma * row.callOi * gammaScale;
    const rowPutGamma = -greek.gamma * row.putOi * gammaScale;
    const rowCallVanna = greek.vanna * row.callOi * vannaScale;
    const rowPutVanna = -greek.vanna * row.putOi * vannaScale;
    callDeltaExposure += rowCallDelta;
    putDeltaExposure += rowPutDelta;
    callGammaExposure += rowCallGamma;
    putGammaExposure += rowPutGamma;
    callVannaExposure += rowCallVanna;
    putVannaExposure += rowPutVanna;
    if (row.volatilitySource !== 'fallback-median') observedVolRows += 1;
    if (totalOi > 0) oiRows += 1;
    const current = levelMap.get(row.strike) ?? {
      strike: row.strike,
      callOi: 0,
      putOi: 0,
      expiryDates: new Set<string>(),
      deltaExposure: 0,
      gammaExposure: 0,
      vannaExposure: 0,
      weightedVol: 0,
      weightedDays: 0,
      observedVolOi: 0,
      observedVolSource: null,
      totalOiForWeight: 0,
    };
    current.callOi += row.callOi;
    current.putOi += row.putOi;
    current.expiryDates.add(row.expiryDate);
    current.deltaExposure += rowCallDelta + rowPutDelta;
    current.gammaExposure += rowCallGamma + rowPutGamma;
    current.vannaExposure += rowCallVanna + rowPutVanna;
    current.weightedVol += row.impliedVol * totalOi;
    current.weightedDays += row.daysToExpiry * totalOi;
    if (row.volatilitySource !== 'fallback-median') {
      current.observedVolOi += totalOi;
      if (!current.observedVolSource || sourcePriority(row.volatilitySource) > sourcePriority(current.observedVolSource)) current.observedVolSource = row.volatilitySource;
    }
    current.totalOiForWeight += totalOi;
    levelMap.set(row.strike, current);
  }

  const aggregateRows = [...levelMap.values()].map((level) => ({ strike: level.strike, callOi: level.callOi, putOi: level.putOi }));
  const compositePain = maxPain(aggregateRows);
  const sortedExpiryMetrics = expiryMetrics.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  const nearestMetric = sortedExpiryMetrics.find((metric) => metric.oiContracts > 0 && metric.daysToExpiry <= horizonDays) ?? sortedExpiryMetrics.find((metric) => metric.oiContracts > 0) ?? null;
  const grossGamma = Math.abs(callGammaExposure) + Math.abs(putGammaExposure);
  const gammaRatio = grossGamma > 0 ? (callGammaExposure + putGammaExposure) / grossGamma : 0;
  const gammaRegime = gammaRatio > 0.08 ? 'positive' : gammaRatio < -0.08 ? 'negative' : 'neutral';
  const gammaFlip = findGammaFlip(analysisRows, underlyingPrice, riskFreeRate, contractMultiplier);
  const netDeltaExposure = callDeltaExposure + putDeltaExposure;
  const grossDelta = Math.abs(callDeltaExposure) + Math.abs(putDeltaExposure);
  const deltaRatio = grossDelta > 0 ? netDeltaExposure / grossDelta : 0;
  const netVannaExposure = callVannaExposure + putVannaExposure;
  const grossVanna = Math.abs(callVannaExposure) + Math.abs(putVannaExposure);
  const vannaRatio = grossVanna > 0 ? netVannaExposure / grossVanna : 0;
  // A single-expiry Max Pain is the conventional calculation. The composite
  // remains a contextual horizon aggregate, while the scenario anchor uses
  // the nearest liquid expiry to avoid mixing settlement dates as one event.
  const painTarget = nearestMetric?.maxPainStrike ?? compositePain?.strike ?? null;
  const painDistance = painTarget && underlyingPrice > 0 ? clamp((painTarget - underlyingPrice) / underlyingPrice, -0.08, 0.08) : 0;
  const score = clamp(painDistance / 0.04 * 0.55 + deltaRatio * 0.3 + vannaRatio * 0.15, -1, 1);
  const targetPrice = painTarget && underlyingPrice > 0
    ? clamp(underlyingPrice * (1 + painDistance * 0.75 + score * 0.01), underlyingPrice * 0.92, underlyingPrice * 1.08)
    : null;
  const observedVolCoverage = oiRows > 0 ? observedVolRows / oiRows : 0;
  const scenarioWeight = clamp(0.12 + observedVolCoverage * 0.12 + Math.min(0.12, Math.abs(score) * 0.12), 0.08, 0.36);
  if (observedVolCoverage < 0.5) warningSet.add('Some or most active expiries use fallback median volatility because all-expiry IV is unavailable.');
  if (surfaceRows.length === 0) warningSet.add('No positive open interest rows are available for Greek or max-pain processing.');

  const levels: OptionsPredictionLevel[] = [...levelMap.values()]
    .sort((a, b) => b.totalOiForWeight - a.totalOiForWeight)
    .slice(0, options.maxLevels ?? 180)
    .map((level) => ({
      strike: level.strike,
      callOi: level.callOi,
      putOi: level.putOi,
      totalOi: level.callOi + level.putOi,
      distancePct: underlyingPrice > 0 ? (level.strike - underlyingPrice) / underlyingPrice : 0,
      expiryCount: level.expiryDates.size,
      expiryDates: [...level.expiryDates].sort(),
      impliedVol: level.totalOiForWeight > 0 ? level.weightedVol / level.totalOiForWeight : fallbackVolatility,
      volatilitySource: level.observedVolOi > 0 ? level.observedVolSource ?? 'observed-iv' : 'fallback-median',
      daysToExpiry: level.totalOiForWeight > 0 ? level.weightedDays / level.totalOiForWeight : 0,
      deltaExposure: level.deltaExposure,
      gammaExposure: level.gammaExposure,
      vannaExposure: level.vannaExposure,
    }));

  const dateLag = latestOiDate ? dateDays(latestOiDate, asOfDate) : 0;
  const scenarioLabel = score > 0.15 ? 'Upside options pressure' : score < -0.15 ? 'Downside options pressure' : 'Options range / pinning pressure';
  return {
    schemaVersion: 1,
    symbol: allExpirySnapshots[0]?.symbol ?? frontSnapshots[0]?.symbol ?? 'GC',
    generatedAt: new Date().toISOString(),
    asOfDate,
    underlyingPrice,
    method: 'black-76-horizon-oi',
    assumptions: {
      riskFreeRate,
      contractMultiplier,
      daysPerYear,
      analysisHorizonDays: horizonDays,
      signedOiConvention: 'heuristic OI proxy: call exposure positive, put exposure negative; OI does not reveal dealer side.',
      greekUnits: 'Gamma: USD per 1% futures move; Vanna: USD delta change per 1 vol-point; Delta: USD notional.',
    },
    quality: {
      snapshotCount: snapshots.length,
      activeExpiryCount: expiryMetrics.filter((metric) => metric.oiContracts > 0 && metric.daysToExpiry <= horizonDays).length,
      strikeCount: analysisRows.length,
      strikesWithOi: oiRows,
      strikesWithObservedVol: observedVolRows,
      observedVolCoverage,
      fallbackVolatility,
      latestOiDate,
      warnings: [...warningSet, ...(dateLag > 0 ? [`Price reference is ${Math.round(dateLag)} days newer than the latest OI snapshot.`] : [])],
    },
    maxPain: {
      compositeStrike: compositePain?.strike ?? null,
      compositeValue: compositePain ? compositePain.pain * contractMultiplier : null,
      nearestExpiry: nearestMetric?.expiryDate ?? null,
      nearestStrike: nearestMetric?.maxPainStrike ?? null,
      byExpiry: sortedExpiryMetrics,
    },
    gamma: {
      callExposure: callGammaExposure,
      putExposure: putGammaExposure,
      netExposure: callGammaExposure + putGammaExposure,
      flipStrike: gammaFlip,
      regime: gammaRegime,
    },
    vanna: {
      callExposure: callVannaExposure,
      putExposure: putVannaExposure,
      netExposure: netVannaExposure,
    },
    delta: {
      callExposure: callDeltaExposure,
      putExposure: putDeltaExposure,
      netExposure: netDeltaExposure,
    },
    scenario: {
      targetPrice,
      bias: score,
      weight: scenarioWeight,
      score,
      label: scenarioLabel,
      caveat: 'Options-aware scenario guide, not a guaranteed price target; direction uses a signed OI heuristic and fallback IV where noted.',
    },
    levels,
  };
}
