import type { OptionsPrediction, PriceBar, PriceTimeframe } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;
const FORECAST_Z_80 = 1.28;
const MODEL_NAMES = ['naive', 'drift', 'ema-reversion', 'damped-trend'] as const;

export type ForecastDirection = 'up' | 'down' | 'flat';
export type ForecastModelName = typeof MODEL_NAMES[number];
export type ForecastRegime = 'trend' | 'range' | 'volatile';

export interface ForecastModelScore {
  name: ForecastModelName;
  weight: number;
  mae: number;
  mape: number;
}

export interface PriceProjection {
  data: Array<[number, number]>;
  optionsData: Array<[number, number]> | null;
  optionsAdjusted: boolean;
  optionsTargetPrice: number | null;
  optionsBias: number;
  lowerBand: Array<[number, number]>;
  upperBand: Array<[number, number]>;
  end: number;
  lookback: number;
  horizonDays: number;
  horizonLabel: string;
  method: string;
  direction: ForecastDirection;
  expectedMove: number;
  volatilityPerDay: number;
  fitR2: number;
  confidenceLevel: number;
  regime: ForecastRegime;
  modelScores: ForecastModelScore[];
  backtestMae: number;
  backtestMape: number;
  backtestError80: number;
  backtestHorizonBars: number;
  backtestObservations: number;
  featureSummary: string[];
}

interface Sample {
  time: number;
  close: number;
}

interface TrendFit {
  slope: number;
  residualStd: number;
  r2: number;
}

interface ModelFeatures {
  intervalMs: number;
  periodsPerDay: number;
  volatilityPerDay: number;
  shortVolatilityPerDay: number;
  longVolatilityPerDay: number;
  volatilityRatio: number;
  medianChange: number;
  emaShort: number;
  emaLong: number;
  emaShortPeriod: number;
  emaLongPeriod: number;
  fullFit: TrendFit;
  recentFit: TrendFit;
  blendedSlope: number;
  trendSignal: number;
}

interface BacktestSummary {
  scores: ForecastModelScore[];
  mae: number;
  mape: number;
  horizonBars: number;
  observations: number;
  error80: number;
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

function quantile(values: number[], level: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(level * sorted.length) - 1));
  return sorted[index];
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function robustScale(values: number[]) {
  if (values.length < 2) return standardDeviation(values);
  const centre = median(values);
  const mad = median(values.map((value) => Math.abs(value - centre)));
  const scaledMad = mad * 1.4826;
  return scaledMad > 0 ? scaledMad : standardDeviation(values);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function fitTrend(samples: Sample[]): TrendFit {
  if (samples.length < 2) {
    return { slope: 0, residualStd: 0, r2: 0 };
  }
  const origin = samples[0].time / DAY_MS;
  const xValues = samples.map((sample) => sample.time / DAY_MS - origin);
  const yValues = samples.map((sample) => sample.close);
  const meanX = mean(xValues);
  const meanY = mean(yValues);
  const denominator = xValues.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  if (denominator <= 0) return { slope: 0, residualStd: standardDeviation(yValues), r2: 0 };

  const slope = xValues.reduce((sum, value, index) => sum + (value - meanX) * (yValues[index] - meanY), 0) / denominator;
  const intercept = meanY - slope * meanX;
  const residuals = yValues.map((value, index) => value - (intercept + slope * xValues[index]));
  const residualStd = robustScale(residuals);
  const totalSumSquares = yValues.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
  const residualSumSquares = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const r2 = totalSumSquares > 0 ? Math.max(0, Math.min(1, 1 - residualSumSquares / totalSumSquares)) : 0;
  return { slope, residualStd, r2 };
}

function exponentialMovingAverage(values: number[], period: number) {
  if (values.length === 0) return 0;
  const alpha = 2 / (period + 1);
  let current = values[0];
  for (const value of values.slice(1)) current = alpha * value + (1 - alpha) * current;
  return current;
}

function samplesFromPrice(price: PriceBar[], timeframe: PriceTimeframe) {
  const byTime = new Map<number, Sample>();
  for (const bar of price) {
    if (!bar.isClosed || bar.timeframe !== timeframe) continue;
    const time = Date.parse(bar.time);
    if (Number.isFinite(time) && Number.isFinite(bar.close)) byTime.set(time, { time, close: bar.close });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function buildFeatures(samples: Sample[], timeframe: PriceTimeframe): ModelFeatures {
  const intervalValues = samples.slice(1).map((sample, index) => sample.time - samples[index].time).filter((value) => value > 0);
  const intervalMs = median(intervalValues) || (timeframe === '1D' ? DAY_MS : FOUR_HOUR_MS);
  const periodsPerDay = Math.max(1, DAY_MS / intervalMs);
  const changes = samples.slice(1).map((sample, index) => sample.close - samples[index].close);
  const shortWindow = Math.min(changes.length, timeframe === '1D' ? 20 : 30);
  const longWindow = Math.min(changes.length, timeframe === '1D' ? 60 : 120);
  const recentChanges = changes.slice(-Math.min(changes.length, timeframe === '1D' ? 40 : 120));
  const shortVolatilityPerDay = robustScale(changes.slice(-shortWindow)) * Math.sqrt(periodsPerDay);
  const longVolatilityPerDay = robustScale(changes.slice(-longWindow)) * Math.sqrt(periodsPerDay);
  const volatilityPerDay = (robustScale(recentChanges) || robustScale(changes)) * Math.sqrt(periodsPerDay);
  const emaShortPeriod = Math.min(20, Math.max(5, Math.floor(samples.length / 4)));
  const emaLongPeriod = Math.min(60, Math.max(emaShortPeriod + 5, Math.floor(samples.length / 2)));
  const closes = samples.map((sample) => sample.close);
  const fullFit = fitTrend(samples);
  const recentCount = Math.min(samples.length, timeframe === '1D' ? 40 : 120);
  const recentFit = fitTrend(samples.slice(-recentCount));
  const blendedSlope = fullFit.slope * 0.4 + recentFit.slope * 0.6;
  const trendSignal = Math.abs(blendedSlope) * Math.sqrt(20) / Math.max(volatilityPerDay, 1);

  return {
    intervalMs,
    periodsPerDay,
    volatilityPerDay,
    shortVolatilityPerDay,
    longVolatilityPerDay,
    volatilityRatio: shortVolatilityPerDay / Math.max(longVolatilityPerDay, 1),
    medianChange: median(changes),
    emaShort: exponentialMovingAverage(closes, emaShortPeriod),
    emaLong: exponentialMovingAverage(closes, emaLongPeriod),
    emaShortPeriod,
    emaLongPeriod,
    fullFit,
    recentFit,
    blendedSlope,
    trendSignal,
  };
}

function classifyRegime(features: ModelFeatures): ForecastRegime {
  if (features.volatilityRatio >= 1.45) return 'volatile';
  if (features.fullFit.r2 >= 0.12 && features.trendSignal >= 0.5) return 'trend';
  return 'range';
}

function buildModelPath(
  samples: Sample[],
  features: ModelFeatures,
  model: ForecastModelName,
  steps: number,
  timeframe: PriceTimeframe,
) {
  const last = samples.at(-1)?.close ?? 0;
  const path: number[] = [];
  const stepMs = features.intervalMs || (timeframe === '1D' ? DAY_MS : FOUR_HOUR_MS);
  const stepDays = stepMs / DAY_MS;
  const trendSlopeCap = Math.max(5, features.volatilityPerDay * 0.85);
  const slope = clamp(features.blendedSlope, -trendSlopeCap, trendSlopeCap);
  const driftDampingBars = timeframe === '1D' ? 45 : 120;
  const trendDecayDays = timeframe === '1D' ? 45 : 30;
  const reversionHalfLifeBars = timeframe === '1D' ? 30 : 90;

  for (let step = 1; step <= steps; step += 1) {
    const elapsedDays = step * stepDays;
    let value = last;
    if (model === 'drift') {
      value = last + features.medianChange * driftDampingBars * (1 - Math.exp(-step / driftDampingBars));
    } else if (model === 'ema-reversion') {
      const reversion = 1 - Math.exp(-step / reversionHalfLifeBars);
      value = last + (features.emaLong - last) * reversion;
    } else if (model === 'damped-trend') {
      value = last + slope * trendDecayDays * (1 - Math.exp(-elapsedDays / trendDecayDays));
    }
    path.push(Math.max(0, value));
  }
  return path;
}

function buildBacktest(
  samples: Sample[],
  timeframe: PriceTimeframe,
  forecastSteps: number,
): BacktestSummary {
  const horizonBars = timeframe === '1D'
    ? clamp(Math.round(forecastSteps / 6), 5, 20)
    : clamp(Math.round(forecastSteps / 6), 12, 90);
  const minTrainingBars = Math.max(24, Math.min(120, Math.floor(samples.length * 0.55)));
  const lastOrigin = samples.length - horizonBars;
  const errors: Record<ForecastModelName, number[]> = {
    naive: [],
    drift: [],
    'ema-reversion': [],
    'damped-trend': [],
  };
  const percentageErrors: Record<ForecastModelName, number[]> = {
    naive: [],
    drift: [],
    'ema-reversion': [],
    'damped-trend': [],
  };
  const cases: Array<{ actual: number; predictions: Record<ForecastModelName, number> }> = [];

  if (lastOrigin > minTrainingBars) {
    const span = lastOrigin - minTrainingBars;
    const originCount = Math.min(16, span + 1);
    const stride = Math.max(1, Math.ceil(span / Math.max(1, originCount - 1)));
    const origins: number[] = [];
    for (let origin = minTrainingBars; origin <= lastOrigin; origin += stride) origins.push(origin);
    if (origins.at(-1) !== lastOrigin) origins.push(lastOrigin);

    for (const origin of origins) {
      const train = samples.slice(0, origin);
      const features = buildFeatures(train, timeframe);
      const paths = new Map<ForecastModelName, number[]>();
      for (const model of MODEL_NAMES) paths.set(model, buildModelPath(train, features, model, horizonBars, timeframe));
      for (let index = 0; index < horizonBars; index += 1) {
        const actual = samples[origin + index]?.close;
        if (!Number.isFinite(actual)) continue;
        cases.push({
          actual,
          predictions: Object.fromEntries(MODEL_NAMES.map((model) => [model, paths.get(model)?.[index] ?? actual])) as Record<ForecastModelName, number>,
        });
      }
      for (const model of MODEL_NAMES) {
        const path = paths.get(model)!;
        path.forEach((prediction, index) => {
          const actual = samples[origin + index]?.close;
          if (!Number.isFinite(actual)) return;
          const absoluteError = Math.abs(prediction - actual);
          errors[model].push(absoluteError);
          percentageErrors[model].push(absoluteError / Math.max(Math.abs(actual), 1) * 100);
        });
      }
    }
  }

  const lastClose = samples.at(-1)?.close ?? 1;
  const fallbackMae = Math.max(1, lastClose * 0.01);
  const rawScores = MODEL_NAMES.map((name) => {
    const modelErrors = errors[name];
    const modelPercentageErrors = percentageErrors[name];
    return {
      name,
      mae: modelErrors.length > 0 ? mean(modelErrors) : fallbackMae,
      mape: modelPercentageErrors.length > 0 ? mean(modelPercentageErrors) : 1,
    };
  });
  const temperature = Math.max(1, median(rawScores.map((score) => score.mae)) * 0.75, lastClose * 0.0025);
  const rawWeights = rawScores.map((score) => Math.exp(-score.mae / temperature));
  const rawWeightTotal = rawWeights.reduce((sum, value) => sum + value, 0) || 1;
  const weightFloor = 0.07;
  const remainingWeight = 1 - weightFloor * MODEL_NAMES.length;
  const scores = rawScores
    .map((score, index) => ({
      ...score,
      weight: weightFloor + remainingWeight * (rawWeights[index] / rawWeightTotal),
    }))
    .sort((a, b) => b.weight - a.weight);
  const ensembleErrors = cases.map((item) => Math.abs(scores.reduce((sum, score) => sum + item.predictions[score.name] * score.weight, 0) - item.actual));
  const ensemblePercentageErrors = ensembleErrors.map((error, index) => error / Math.max(Math.abs(cases[index].actual), 1) * 100);
  const mae = ensembleErrors.length > 0 ? mean(ensembleErrors) : scores.reduce((sum, score) => sum + score.weight * score.mae, 0);
  const mape = ensemblePercentageErrors.length > 0 ? mean(ensemblePercentageErrors) : scores.reduce((sum, score) => sum + score.weight * score.mape, 0);
  return {
    scores,
    mae,
    mape,
    horizonBars,
    observations: cases.length,
    error80: ensembleErrors.length > 0 ? quantile(ensembleErrors, 0.8) : mae * FORECAST_Z_80,
  };
}

function forecastTimes(samples: Sample[], timeframe: PriceTimeframe, horizonDays: number, intervalMs: number) {
  const lastTime = samples.at(-1)?.time ?? 0;
  const endTime = lastTime + horizonDays * DAY_MS;
  const recent = samples.slice(-(timeframe === '1D' ? 180 : 720));
  const allowedWeekdays = new Set(recent.map((sample) => new Date(sample.time).getUTCDay()));
  const allowedSlots = new Set(recent.map((sample) => {
    const date = new Date(sample.time);
    return `${date.getUTCDay()}|${date.getUTCHours()}|${date.getUTCMinutes()}`;
  }));
  const increment = timeframe === '1D' ? DAY_MS : intervalMs;
  const output: number[] = [];
  for (let time = lastTime + increment; time <= endTime; time += increment) {
    const date = new Date(time);
    const allowed = timeframe === '1D'
      ? allowedWeekdays.has(date.getUTCDay())
      : allowedSlots.has(`${date.getUTCDay()}|${date.getUTCHours()}|${date.getUTCMinutes()}`);
    if (allowed) output.push(time);
  }
  return output.length > 0 ? output : [endTime];
}

export function buildPriceProjection(
  price: PriceBar[],
  timeframe: PriceTimeframe,
  horizonDaysOverride = 90,
  optionsPrediction: OptionsPrediction | null = null,
): PriceProjection | null {
  const lookbackLimit = timeframe === '1D' ? 720 : 1_440;
  const samples = samplesFromPrice(price, timeframe).slice(-lookbackLimit);
  if (samples.length < 24) return null;

  const horizonDays = Math.max(1, Math.round(horizonDaysOverride));
  const features = buildFeatures(samples, timeframe);
  const stepMs = features.intervalMs || (timeframe === '1D' ? DAY_MS : FOUR_HOUR_MS);
  const times = forecastTimes(samples, timeframe, horizonDays, stepMs);
  const steps = times.length;
  const backtest = buildBacktest(samples, timeframe, steps);
  const regime = classifyRegime(features);
  const modelPaths = new Map<ForecastModelName, number[]>();
  for (const model of MODEL_NAMES) modelPaths.set(model, buildModelPath(samples, features, model, steps, timeframe));

  const last = samples.at(-1)!;
  const data: Array<[number, number]> = [[last.time, last.close]];
  const lowerBand: Array<[number, number]> = [[last.time, last.close]];
  const upperBand: Array<[number, number]> = [[last.time, last.close]];
  const validationDays = Math.max(stepMs / DAY_MS, backtest.horizonBars / features.periodsPerDay);
  const errorScale = Math.max(
    1,
    backtest.error80,
    features.volatilityPerDay * 0.25,
  );

  for (let step = 1; step <= steps; step += 1) {
    const time = times[step - 1];
    const value = Math.max(0, backtest.scores.reduce((sum, score) => {
      return sum + (modelPaths.get(score.name)?.[step - 1] ?? last.close) * score.weight;
    }, 0));
    const elapsedDays = (time - last.time) / DAY_MS;
    const forecastSpread = errorScale * Math.sqrt(elapsedDays / validationDays);
    data.push([time, value]);
    lowerBand.push([time, Math.max(0, value - forecastSpread)]);
    upperBand.push([time, value + forecastSpread]);
  }

  const optionsTargetPrice = optionsPrediction?.scenario.targetPrice ?? null;
  const optionsBias = optionsPrediction?.scenario.bias ?? 0;
  const optionsData: Array<[number, number]> | null = optionsTargetPrice && Number.isFinite(optionsTargetPrice)
    ? data.map(([time, value], index) => {
      if (index === 0) return [time, last.close];
      const elapsedDays = (time - last.time) / DAY_MS;
      const decay = 1 - Math.exp(-elapsedDays / Math.max(5, horizonDays * 0.65));
      const targetPull = (optionsTargetPrice - value) * (optionsPrediction?.scenario.weight ?? 0.12) * decay;
      const directionalDrift = last.close * clamp(optionsBias, -1, 1) * 0.01 * Math.min(1, elapsedDays / Math.max(1, horizonDays));
      const maxOptionsShift = Math.max(errorScale * 2, last.close * 0.05);
      return [time, clamp(value + targetPull + directionalDrift, value - maxOptionsShift, value + maxOptionsShift)];
    })
    : null;

  const expectedMove = data.at(-1)![1] - last.close;
  const flatThreshold = Math.max(10, errorScale * 0.5);
  const direction: ForecastDirection = expectedMove > flatThreshold ? 'up' : expectedMove < -flatThreshold ? 'down' : 'flat';
  const fitR2 = Math.max(0, Math.min(1, features.fullFit.r2 * 0.4 + features.recentFit.r2 * 0.6));
  const featureSummary = [
    'EMA ' + features.emaShortPeriod + '/' + features.emaLongPeriod,
    'robust volatility $' + features.volatilityPerDay.toFixed(0) + '/day',
    'trend R² ' + Math.round(fitR2 * 100) + '%',
    'short/long volatility ' + features.volatilityRatio.toFixed(2) + 'x',
    'exchange-session calendar (no synthetic weekend bars)',
    optionsData ? 'options-aware scenario: Max Pain + Black-76 Greeks' : 'options-aware scenario unavailable',
  ];
  return {
    data,
    optionsData,
    optionsAdjusted: optionsData !== null,
    optionsTargetPrice,
    optionsBias,
    lowerBand,
    upperBand,
    end: data.at(-1)![0],
    lookback: samples.length,
    horizonDays,
    horizonLabel: 'next ' + horizonDays + ' days',
    method: 'rolling-origin weighted ensemble',
    direction,
    expectedMove,
    volatilityPerDay: features.volatilityPerDay,
    fitR2,
    confidenceLevel: 0.8,
    regime,
    modelScores: backtest.scores,
    backtestMae: backtest.mae,
    backtestMape: backtest.mape,
    backtestError80: backtest.error80,
    backtestHorizonBars: backtest.horizonBars,
    backtestObservations: backtest.observations,
    featureSummary,
  };
}
