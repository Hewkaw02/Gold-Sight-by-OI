import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fetchStandaloneOi } from '../collector/cme/standalone-oi-collector.js';
import { CmeSessionError } from '../collector/cme/cme-browser.js';
import { FRONT_TARGET_DTES } from '../src/domain/front-equivalent.js';
import { buildOptionsPrediction } from '../src/domain/options-prediction.js';
import { buildDominanceOutlook } from '../collector/oi/dominance-projection.js';
import { extendFrontEquivalent } from '../collector/oi/front-equivalent.js';
import { deriveWalls, summarizeSnapshotHealth } from '../collector/oi/oi-wall-engine.js';
import { mergeByKey, readJson, sha256Json, writeJsonAtomic } from '../collector/shared/json-store.js';
import { latestClosedPriceBar, mergePriceBars } from '../collector/shared/price-bars.js';
import { oiFreshness, priceFreshness } from '../collector/shared/data-freshness.js';
import type { DataManifest, DashboardHealth, OISnapshot, PriceBar, RollMarker, SessionSlot } from '../src/domain/types.js';

const root = process.cwd();
const symbol = process.env.GOLD_SIGHT_SYMBOL ?? 'GC';
const dataRoot = path.resolve(process.env.GOLD_SIGHT_DATA_ROOT ?? 'public/data');

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

function parsePricePayload(stdout: string): PriceBar[] {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const candidate = lines.at(-1);
  if (!candidate) throw new Error('Price collector returned empty output');
  const payload = JSON.parse(candidate) as { bars?: PriceBar[] };
  if (!Array.isArray(payload.bars) || payload.bars.length === 0) throw new Error('Price collector returned no bars');
  return payload.bars;
}

async function updatePrice(timeframe: '4H' | '1D') {
  const python = process.env.PYTHON_BIN ?? 'python';
  const result = await run(python, [
    path.join(root, 'collector', 'price', 'tvdatafeed_adapter.py'),
    '--symbol', process.env.TV_SOURCE_SYMBOL ?? 'GOLD.F',
    '--exchange', process.env.TV_SOURCE_EXCHANGE ?? 'BLACKBULL',
    '--timeframe', timeframe,
    '--bars', '5000',
  ], { cwd: root });
  const incoming = parsePricePayload(result.stdout);
  const relative = timeframe === '4H' ? '4h' : '1d';
  const latestPath = path.join(dataRoot, 'price', symbol, relative, 'latest.json');
  const existing = await readJson<PriceBar[]>(latestPath, []);
  const merged = mergePriceBars(existing, incoming, timeframe);
  await writeJsonAtomic(latestPath, merged);
  const byPartition = new Map<string, PriceBar[]>();
  for (const bar of incoming.filter((value) => value.isClosed)) {
    const day = bar.time.slice(0, 10);
    const list = byPartition.get(day) ?? [];
    list.push(bar);
    byPartition.set(day, list);
  }
  for (const [day, bars] of byPartition) {
    const partitionPath = path.join(dataRoot, 'price', symbol, relative, day.slice(0, 4), day.slice(5, 7), `${day}.json`);
    const partitionExisting = await readJson<PriceBar[]>(partitionPath, []);
    const partitionMerged = mergePriceBars([], bars, timeframe);
    await writeJsonAtomic(partitionPath, partitionMerged);
  }
  return merged;
}

function priceFreshnessMessage(price1d: PriceBar[], price4h: PriceBar[]) {
  const daily = latestClosedPriceBar(price1d);
  const intraday = latestClosedPriceBar(price4h);
  const dailyLabel = daily?.closeTime ?? daily?.time ?? 'n/a';
  const intradayLabel = intraday?.closeTime ?? intraday?.time ?? 'n/a';
  return 'Latest closed price bars · 1D ' + dailyLabel + ' · 4H ' + intradayLabel;
}

function cmeDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.CME_TIMEZONE ?? 'America/Chicago' }).format(now);
}

function freshnessValue(hasRows: boolean, fresh: boolean): 'fresh' | 'stale' | 'missing' {
  return hasRows ? fresh ? 'fresh' : 'stale' : 'missing';
}

function sessionSlots(): SessionSlot[] {
  return (process.env.OI_SESSION_SLOTS ?? 'open,mid,close')
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is SessionSlot => value === 'open' || value === 'mid' || value === 'close');
}

function frontTargetDtes(): number[] {
  const configured = (process.env.OI_TARGET_DTES ?? FRONT_TARGET_DTES.join(','))
    .split(',')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(configured)].sort((a, b) => a - b).length > 0
    ? [...new Set(configured)].sort((a, b) => a - b)
    : [...FRONT_TARGET_DTES];
}

async function maybeFetchOi(fallbackFuturePrice: number): Promise<Awaited<ReturnType<typeof fetchStandaloneOi>> | null> {
  if (process.env.RUN_LIVE_OI !== 'true') return null;
  const date = process.env.OI_TRADE_DATE ?? new Intl.DateTimeFormat('en-CA', { timeZone: process.env.CME_TIMEZONE ?? 'America/Chicago' }).format(new Date());
  return fetchStandaloneOi({
    tradeDate: date,
    sessionSlots: sessionSlots(),
    targetDtes: frontTargetDtes(),
    fallbackFuturePrice,
  });
}

async function writeOiPartitions(front: OISnapshot[], allExpiry: OISnapshot[]) {
  for (const snapshot of front) {
    const filePath = path.join(dataRoot, 'oi', symbol, snapshot.tradeDate, `${snapshot.sessionSlot}-${snapshot.targetDte}dte.json`);
    await writeJsonAtomic(filePath, snapshot);
  }
  const byDate = new Map<string, OISnapshot[]>();
  for (const snapshot of allExpiry) {
    const list = byDate.get(snapshot.tradeDate) ?? [];
    list.push(snapshot);
    byDate.set(snapshot.tradeDate, list);
  }
  for (const [tradeDate, snapshots] of byDate) {
    await writeJsonAtomic(path.join(dataRoot, 'oi', symbol, 'all-expiry', `${tradeDate}.json`), snapshots);
  }
}

async function currentHealth(): Promise<DashboardHealth> {
  const manifest = await readJson<DataManifest | null>(path.join(dataRoot, 'manifest.json'), null);
  const status = await readJson<Partial<DashboardHealth> | null>(path.join(dataRoot, 'status', 'latest.json'), null);
  if (manifest?.health) {
    return {
      ...manifest.health,
      ...status,
      auth: status?.auth ?? manifest.health.auth,
      price: status?.price ?? manifest.health.price,
      oi: status?.oi ?? manifest.health.oi,
      notes: status?.notes ?? manifest.health.notes,
    };
  }
  return {
    state: 'stale', generatedAt: new Date(0).toISOString(), lastSuccessAt: null, lastAttemptAt: null,
    stale: true, partial: true, auth: { state: 'unknown', checkedAt: null, message: null },
    price: { state: 'stale', lastSuccessAt: null, message: null },
    oi: { state: 'stale', lastSuccessAt: null, message: null }, notes: [],
  };
}

async function updateManifest(
  price1d: PriceBar[],
  price4h: PriceBar[],
  walls: unknown[],
  allExpiryWalls: unknown[],
  oiSnapshots: OISnapshot[],
  allExpirySnapshots: OISnapshot[],
  dominanceOutlook: ReturnType<typeof buildDominanceOutlook>,
  optionsPrediction: ReturnType<typeof buildOptionsPrediction>,
  health: DashboardHealth,
) {
  const previous = await readJson<DataManifest | null>(path.join(dataRoot, 'manifest.json'), null);
  const generatedAt = new Date().toISOString();
  const rollMarkers = await readJson<RollMarker[]>(path.join(dataRoot, 'rolls', symbol, 'latest.json'), []);
  const oiHealth = summarizeSnapshotHealth(oiSnapshots);
  const allExpiryHealth = summarizeSnapshotHealth(allExpirySnapshots);
  const price1dAge = priceFreshness(price1d, '1D');
  const price4hAge = priceFreshness(price4h, '4H');
  const oiAge = oiFreshness(allExpirySnapshots, cmeDate(), Number(process.env.OI_MAX_BUSINESS_DAY_LAG ?? 2));
  const oiCurrent = health.oi.state !== 'stale' && oiAge.fresh;
  const latestClosed1d = price1dAge.bar;
  const latestClosed4h = price4hAge.bar;
  const expiryCoverage = {
    start: allExpirySnapshots.map((snapshot) => snapshot.expiryDate).sort()[0] ?? previous?.coverage.oiExpiry?.start ?? null,
    end: allExpirySnapshots.map((snapshot) => snapshot.expiryDate).sort().at(-1) ?? previous?.coverage.oiExpiry?.end ?? null,
  };
  const manifest: DataManifest = {
    schemaVersion: 1,
    generatedAt,
    symbol,
    priceTimeframes: ['4H', '1D'],
    displayTimezone: process.env.DISPLAY_TIMEZONE ?? 'Asia/Bangkok',
    cmeTimezone: process.env.CME_TIMEZONE ?? 'America/Chicago',
    coverage: {
      price: { start: price1d[0]?.time ?? price4h[0]?.time ?? previous?.coverage.price.start ?? null, end: latestClosed1d?.closeTime ?? latestClosed4h?.closeTime ?? previous?.coverage.price.end ?? null },
      oi: { start: allExpiryHealth.coverageStart ?? oiHealth.coverageStart ?? previous?.coverage.oi.start ?? null, end: allExpiryHealth.coverageEnd ?? oiHealth.coverageEnd ?? previous?.coverage.oi.end ?? null },
      oiExpiry: expiryCoverage,
    },
    datasets: {
      price_1d: { path: `price/${symbol}/1d/latest.json`, schemaVersion: 1, generatedAt, coverageStart: price1d[0]?.time.slice(0, 10) ?? null, coverageEnd: latestClosed1d?.closeTime.slice(0, 10) ?? null, rowCount: price1d.length, sha256: sha256Json(price1d), freshness: freshnessValue(price1d.length > 0, price1dAge.fresh) },
      price_4h: { path: `price/${symbol}/4h/latest.json`, schemaVersion: 1, generatedAt, coverageStart: price4h[0]?.time.slice(0, 10) ?? null, coverageEnd: latestClosed4h?.closeTime.slice(0, 10) ?? null, rowCount: price4h.length, sha256: sha256Json(price4h), freshness: freshnessValue(price4h.length > 0, price4hAge.fresh) },
      oi_walls: { path: `walls/${symbol}/latest.json`, schemaVersion: 1, generatedAt, coverageStart: oiHealth.coverageStart ?? null, coverageEnd: oiHealth.coverageEnd ?? null, rowCount: walls.length, sha256: sha256Json(walls), freshness: freshnessValue(oiSnapshots.length > 0, oiCurrent) },
      oi_front: { path: `oi/${symbol}/latest.json`, schemaVersion: 1, generatedAt, coverageStart: oiHealth.coverageStart ?? null, coverageEnd: oiHealth.coverageEnd ?? null, rowCount: oiSnapshots.length, sha256: sha256Json(oiSnapshots), freshness: freshnessValue(oiSnapshots.length > 0, oiCurrent) },
      oi_all_expiries: { path: `oi/${symbol}/all-expiries-latest.json`, schemaVersion: 1, generatedAt, coverageStart: allExpiryHealth.coverageStart ?? null, coverageEnd: allExpiryHealth.coverageEnd ?? null, rowCount: allExpirySnapshots.length, sha256: sha256Json(allExpirySnapshots), freshness: freshnessValue(allExpirySnapshots.length > 0, oiCurrent) },
      oi_walls_all_expiries: { path: `walls/${symbol}/all-expiries-latest.json`, schemaVersion: 1, generatedAt, coverageStart: allExpiryHealth.coverageStart ?? null, coverageEnd: allExpiryHealth.coverageEnd ?? null, rowCount: allExpiryWalls.length, sha256: sha256Json(allExpiryWalls), freshness: freshnessValue(allExpirySnapshots.length > 0, oiCurrent) },
      oi_dominance_outlook: { path: `oi/${symbol}/dominance-outlook.json`, schemaVersion: 1, generatedAt, coverageStart: dominanceOutlook.baseDate, coverageEnd: dominanceOutlook.points.at(-1)?.time ?? null, rowCount: dominanceOutlook.points.length, sha256: sha256Json(dominanceOutlook), freshness: freshnessValue(dominanceOutlook.points.length > 0, oiCurrent) },
      options_prediction: { path: `prediction/${symbol}/latest.json`, schemaVersion: 1, generatedAt, coverageStart: optionsPrediction.asOfDate, coverageEnd: optionsPrediction.maxPain.nearestExpiry, rowCount: optionsPrediction.levels.length, sha256: sha256Json(optionsPrediction), freshness: freshnessValue(optionsPrediction.quality.strikeCount > 0, oiCurrent && price4hAge.fresh) },
      rolls: { path: `rolls/${symbol}/latest.json`, schemaVersion: 1, generatedAt, coverageStart: rollMarkers[0]?.time.slice(0, 10) ?? null, coverageEnd: rollMarkers.at(-1)?.time.slice(0, 10) ?? null, rowCount: rollMarkers.length, sha256: sha256Json(rollMarkers), freshness: rollMarkers.length ? 'fresh' : 'missing' },
    },
    health,
  };
  await writeJsonAtomic(path.join(dataRoot, 'manifest.json'), manifest);
  await writeJsonAtomic(path.join(dataRoot, 'status', 'latest.json'), health);
}

async function main() {
  await mkdir(dataRoot, { recursive: true });
  const before = await currentHealth();
  const attemptAt = new Date().toISOString();
  let price1d = await readJson<PriceBar[]>(path.join(dataRoot, 'price', symbol, '1d', 'latest.json'), []);
  let price4h = await readJson<PriceBar[]>(path.join(dataRoot, 'price', symbol, '4h', 'latest.json'), []);
  let priceError: string | null = null;
  try { price4h = await updatePrice('4H'); } catch (error) { priceError = error instanceof Error ? error.message : String(error); }
  try { price1d = await updatePrice('1D'); } catch (error) { priceError = [priceError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(' | '); }

  const oiAttempted = process.env.RUN_LIVE_OI === 'true';
  let oiError: string | null = null;
  let oiAuthFailure: DashboardHealth['auth'] | null = null;
  let liveOi: Awaited<ReturnType<typeof fetchStandaloneOi>> | null = null;
  if (oiAttempted) {
    try { liveOi = await maybeFetchOi(latestClosedPriceBar(price4h)?.close ?? 0); }
    catch (error) {
      oiError = error instanceof Error ? error.message : String(error);
      if (error instanceof CmeSessionError) {
        oiAuthFailure = { state: error.code, checkedAt: new Date().toISOString(), message: error.message };
      }
    }
  }

  let snapshots: OISnapshot[];
  let allExpirySnapshots: OISnapshot[];
  let walls: unknown[];
  let allExpiryWalls: unknown[];
  if (liveOi) {
    const existingFront = await readJson<OISnapshot[]>(path.join(dataRoot, 'oi', symbol, 'latest.json'), []);
    const existingAll = await readJson<OISnapshot[]>(path.join(dataRoot, 'oi', symbol, 'all-expiries-latest.json'), []);
    snapshots = mergeByKey(existingFront, liveOi.frontSnapshots, (snapshot) => snapshot.snapshotId).sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    allExpirySnapshots = mergeByKey(existingAll, liveOi.allExpirySnapshots, (snapshot) => snapshot.snapshotId).sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    const targetDtes = frontTargetDtes();
    snapshots = extendFrontEquivalent(snapshots, allExpirySnapshots, targetDtes);
    await writeJsonAtomic(path.join(dataRoot, 'oi', symbol, 'latest.json'), snapshots);
    await writeJsonAtomic(path.join(dataRoot, 'oi', symbol, 'all-expiries-latest.json'), allExpirySnapshots);
    await writeOiPartitions(extendFrontEquivalent(liveOi.frontSnapshots, liveOi.allExpirySnapshots, targetDtes), liveOi.allExpirySnapshots);
    const endAt = latestClosedPriceBar(price4h)?.closeTime ?? new Date().toISOString();
    const wallOptions = { p90Quantile: Number(process.env.OI_P90_QUANTILE ?? 0.9), maxGapTradingSessions: Number(process.env.OI_MAX_GAP_TRADING_SESSIONS ?? 2), endAt };
    walls = deriveWalls(snapshots, wallOptions);
    allExpiryWalls = deriveWalls(allExpirySnapshots, wallOptions);
    await writeJsonAtomic(path.join(dataRoot, 'walls', symbol, 'latest.json'), walls);
    await writeJsonAtomic(path.join(dataRoot, 'walls', symbol, 'all-expiries-latest.json'), allExpiryWalls);
  } else {
    snapshots = await readJson<OISnapshot[]>(path.join(dataRoot, 'oi', symbol, 'latest.json'), []);
    allExpirySnapshots = await readJson<OISnapshot[]>(path.join(dataRoot, 'oi', symbol, 'all-expiries-latest.json'), []);
    walls = await readJson<unknown[]>(path.join(dataRoot, 'walls', symbol, 'latest.json'), []);
    allExpiryWalls = await readJson<unknown[]>(path.join(dataRoot, 'walls', symbol, 'all-expiries-latest.json'), []);
  }

  const latestClosed4h = latestClosedPriceBar(price4h);
  const latestPriceDate = latestClosed4h?.closeTime.slice(0, 10);
  const dominanceOutlook = buildDominanceOutlook(allExpirySnapshots, { baseDate: latestPriceDate, horizonDays: 90 });
  await writeJsonAtomic(path.join(dataRoot, 'oi', symbol, 'dominance-outlook.json'), dominanceOutlook);
  const optionsPrediction = buildOptionsPrediction(
    allExpirySnapshots,
    snapshots,
    latestClosed4h?.close ?? 0,
    {
      asOfDate: latestPriceDate,
      riskFreeRate: Number(process.env.OPTIONS_RISK_FREE_RATE ?? 0.04),
      contractMultiplier: Number(process.env.GOLD_OPTION_CONTRACT_MULTIPLIER ?? 100),
    },
  );
  await writeJsonAtomic(path.join(dataRoot, 'prediction', symbol, 'latest.json'), optionsPrediction);

  const oiSummary = summarizeSnapshotHealth(snapshots);
  const allExpirySummary = summarizeSnapshotHealth(allExpirySnapshots);
  const hasPrice = price1d.length > 0 && price4h.length > 0;
  const hasOi = (snapshots.length > 0 && oiSummary.withOi > 0) || (allExpirySnapshots.length > 0 && allExpirySummary.withOi > 0);
  const now = Date.now();
  const dailyAge = priceFreshness(price1d, '1D', now);
  const intradayAge = priceFreshness(price4h, '4H', now);
  const priceIsFresh = dailyAge.fresh && intradayAge.fresh;
  const oiAge = oiFreshness(allExpirySnapshots, cmeDate(), Number(process.env.OI_MAX_BUSINESS_DAY_LAG ?? 2));
  const expiryStart = allExpirySnapshots.map((snapshot) => snapshot.expiryDate).sort()[0] ?? before.oi.message?.match(/expiry ([^ ]+)/)?.[1] ?? null;
  const expiryEnd = allExpirySnapshots.map((snapshot) => snapshot.expiryDate).sort().at(-1) ?? null;
  const oiState: DashboardHealth['oi']['state'] = oiError || (hasOi && !oiAge.fresh)
    ? 'stale'
    : hasOi
      ? oiSummary.missingOi > 0 ? 'partial' : 'ok'
      : 'error';
  const priceState: DashboardHealth['price']['state'] = priceError || (hasPrice && !priceIsFresh) ? 'stale' : hasPrice ? 'ok' : 'error';
  const state: DashboardHealth['state'] = priceState === 'ok' && oiState === 'ok'
    ? 'ok'
    : priceState === 'error' && oiState === 'error'
      ? 'error'
      : 'partial';
  const health: DashboardHealth = {
    state,
    generatedAt: new Date().toISOString(),
    lastSuccessAt: oiAttempted && !oiError && hasOi ? new Date().toISOString() : before.lastSuccessAt,
    lastAttemptAt: attemptAt,
    stale: priceState === 'stale' || oiState === 'stale',
    partial: state === 'partial',
    auth: oiAuthFailure ?? (liveOi
      ? { state: 'ok', checkedAt: new Date().toISOString(), message: 'CME session verified during live OI collection' }
      : before.auth),
    price: { state: priceState, lastSuccessAt: priceError ? before.price.lastSuccessAt : new Date().toISOString(), message: priceError ?? `${priceFreshnessMessage(price1d, price4h)} · ${priceIsFresh ? 'fresh' : 'stale by age'}` },
    oi: { state: oiState, lastSuccessAt: oiAttempted && !oiError && hasOi ? new Date().toISOString() : before.oi.lastSuccessAt, message: oiError ?? (hasOi ? `${oiSummary.count} front-equivalent snapshots; ${allExpirySummary.count} all-expiry snapshots; OI as-of ${oiAge.asOfDate ?? 'n/a'} (${Number.isFinite(oiAge.businessDayLag) ? oiAge.businessDayLag : 'n/a'} business-day lag); expiry ${expiryStart ?? 'n/a'} → ${expiryEnd ?? 'n/a'}` : 'No verified OI snapshot available') },
    notes: ['Standalone CME collector; no external project is used at runtime.', 'Failed collectors preserve the last successful dataset.', ...(priceError ? [`Price collector: ${priceError}`] : []), ...(oiError ? [`OI collector: ${oiError}`] : [])],
  };
  await updateManifest(price1d, price4h, walls, allExpiryWalls, snapshots, allExpirySnapshots, dominanceOutlook, optionsPrediction, health);
  console.log(JSON.stringify({ state, price1d: price1d.length, price4h: price4h.length, oiSnapshots: snapshots.length, allExpirySnapshots: allExpirySnapshots.length, walls: walls.length, allExpiryWalls: allExpiryWalls.length, dominancePoints: dominanceOutlook.points.length, predictionStrikes: optionsPrediction.quality.strikeCount, predictionExpiries: optionsPrediction.quality.activeExpiryCount, maxPain: optionsPrediction.maxPain.compositeStrike, gammaFlip: optionsPrediction.gamma.flipStrike, priceError, oiError }, null, 2));
  if (process.env.FAIL_ON_PRICE_ERROR === 'true' && priceError) {
    console.error(`Price collector reported an error: ${priceError}`);
    process.exitCode = 1;
  }
  if (process.env.FAIL_ON_OI_ERROR === 'true' && oiError) {
    console.error(`OI collector reported an error: ${oiError}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
