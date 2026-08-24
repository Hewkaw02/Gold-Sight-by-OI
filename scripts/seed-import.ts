import path from 'node:path';
import { FRONT_TARGET_DTES } from '../src/domain/front-equivalent.js';
import { buildDominanceOutlook } from '../collector/oi/dominance-projection.js';
import { dedupeOiSnapshots, extendFrontEquivalent } from '../collector/oi/front-equivalent.js';
import { deriveWalls, summarizeSnapshotHealth } from '../collector/oi/oi-wall-engine.js';
import { buildOptionsPrediction } from '../src/domain/options-prediction.js';
import { latestClosedPriceBar } from '../collector/shared/price-bars.js';
import { oiFreshness, priceFreshness } from '../collector/shared/data-freshness.js';
import { readJson, sha256Json, writeJsonAtomic } from '../collector/shared/json-store.js';
import type { DataManifest, DashboardHealth, OISnapshot, PriceBar, RollMarker } from '../src/domain/types.js';

const symbol = process.env.GOLD_SIGHT_SYMBOL ?? 'GC';
const dataRoot = path.resolve(process.env.GOLD_SIGHT_DATA_ROOT ?? 'public/data');

function localizeSnapshot(snapshot: OISnapshot): OISnapshot {
  // Historical seed files may contain paths from the original source system.
  // Keep the normalized values, but never publish another project's path.
  return { ...snapshot, sourceFile: null };
}

async function main() {
  const storedFront = dedupeOiSnapshots((await readJson<OISnapshot[]>(path.join(dataRoot, 'oi', symbol, 'latest.json'), [])).map(localizeSnapshot));
  const allExpiry = dedupeOiSnapshots((await readJson<OISnapshot[]>(path.join(dataRoot, 'oi', symbol, 'all-expiries-latest.json'), [])).map(localizeSnapshot));
  if (storedFront.length === 0) throw new Error('No local front OI snapshots found under public/data');
  const front = extendFrontEquivalent(storedFront, allExpiry, FRONT_TARGET_DTES);

  const price4h = await readJson<PriceBar[]>(path.join(dataRoot, 'price', symbol, '4h', 'latest.json'), []);
  const price1d = await readJson<PriceBar[]>(path.join(dataRoot, 'price', symbol, '1d', 'latest.json'), []);
  const latestClosed4h = latestClosedPriceBar(price4h);
  const endAt = latestClosed4h?.closeTime ?? new Date().toISOString();
  const latestPriceDate = latestClosed4h?.closeTime.slice(0, 10);
  const dominanceOutlook = buildDominanceOutlook(allExpiry, { baseDate: latestPriceDate, horizonDays: 90 });
  const optionsPrediction = buildOptionsPrediction(allExpiry, front, latestClosed4h?.close ?? 0, { asOfDate: latestPriceDate });
  const wallOptions = {
    p90Quantile: Number(process.env.OI_P90_QUANTILE ?? 0.9),
    maxGapTradingSessions: Number(process.env.OI_MAX_GAP_TRADING_SESSIONS ?? 2),
    endAt,
  };
  const walls = deriveWalls(front, wallOptions);
  const allExpiryWalls = deriveWalls(allExpiry, wallOptions);
  await writeJsonAtomic(path.join(dataRoot, 'oi', symbol, 'latest.json'), front);
  await writeJsonAtomic(path.join(dataRoot, 'oi', symbol, 'all-expiries-latest.json'), allExpiry);
  await writeJsonAtomic(path.join(dataRoot, 'walls', symbol, 'latest.json'), walls);
  await writeJsonAtomic(path.join(dataRoot, 'walls', symbol, 'all-expiries-latest.json'), allExpiryWalls);
  await writeJsonAtomic(path.join(dataRoot, 'oi', symbol, 'dominance-outlook.json'), dominanceOutlook);
  await writeJsonAtomic(path.join(dataRoot, 'prediction', symbol, 'latest.json'), optionsPrediction);

  const existing = await readJson<DataManifest | null>(path.join(dataRoot, 'manifest.json'), null);
  const generatedAt = new Date().toISOString();
  const frontHealth = summarizeSnapshotHealth(front);
  const allHealth = summarizeSnapshotHealth(allExpiry);
  const expiryCoverage = {
    start: allExpiry.map((snapshot) => snapshot.expiryDate).sort()[0] ?? existing?.coverage.oiExpiry?.start ?? null,
    end: allExpiry.map((snapshot) => snapshot.expiryDate).sort().at(-1) ?? existing?.coverage.oiExpiry?.end ?? null,
  };
  const referenceDate = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.CME_TIMEZONE ?? 'America/Chicago' }).format(new Date());
  const oiAge = oiFreshness(allExpiry, referenceDate, Number(process.env.OI_MAX_BUSINESS_DAY_LAG ?? 2));
  const price1dAge = priceFreshness(price1d, '1D');
  const price4hAge = priceFreshness(price4h, '4H');
  const pricesFresh = price1dAge.fresh && price4hAge.fresh;
  const derivedOiState: DashboardHealth['oi']['state'] = oiAge.fresh ? frontHealth.missingOi > 0 ? 'partial' : 'ok' : 'stale';
  const health: DashboardHealth = existing?.health ?? {
    state: frontHealth.missingOi > 0 ? 'partial' : 'ok',
    generatedAt,
    lastSuccessAt: generatedAt,
    lastAttemptAt: generatedAt,
    stale: false,
    partial: frontHealth.missingOi > 0,
    auth: { state: 'unknown', checkedAt: null, message: 'Local seed does not test live credentials' },
    price: { state: price4h.length ? 'ok' : 'partial', lastSuccessAt: generatedAt, message: null },
    oi: { state: frontHealth.missingOi > 0 ? 'partial' : 'ok', lastSuccessAt: generatedAt, message: null },
    notes: [],
  };
  const manifest: DataManifest = {
    ...(existing ?? {
      schemaVersion: 1,
      symbol,
      priceTimeframes: ['4H', '1D'],
      displayTimezone: process.env.DISPLAY_TIMEZONE ?? 'Asia/Bangkok',
      cmeTimezone: process.env.CME_TIMEZONE ?? 'America/Chicago',
      coverage: { price: { start: null, end: null }, oi: { start: null, end: null }, oiExpiry: { start: null, end: null } },
      datasets: {},
      health,
    }),
    generatedAt,
    coverage: {
      ...(existing?.coverage ?? { price: { start: null, end: null }, oi: { start: null, end: null } }),
      price: {
        start: price1d[0]?.time ?? price4h[0]?.time ?? existing?.coverage.price.start ?? null,
        end: price1dAge.bar?.closeTime ?? price4hAge.bar?.closeTime ?? existing?.coverage.price.end ?? null,
      },
      oi: { start: frontHealth.coverageStart, end: frontHealth.coverageEnd },
      oiExpiry: expiryCoverage,
    },
    health: {
      ...health,
      state: pricesFresh && derivedOiState === 'ok' ? 'ok' : 'partial',
      generatedAt,
      lastAttemptAt: generatedAt,
      stale: !pricesFresh || derivedOiState === 'stale',
      partial: !pricesFresh || derivedOiState !== 'ok',
      price: { ...health.price, state: pricesFresh ? 'ok' : 'stale', message: `Latest closed price bars · 1D ${price1dAge.closeTime ?? 'n/a'} · 4H ${price4hAge.closeTime ?? 'n/a'} · ${pricesFresh ? 'fresh' : 'stale by age'}` },
      oi: { ...health.oi, state: derivedOiState, message: `${front.length} front-equivalent snapshots; ${allExpiry.length} all-expiry snapshots; OI as-of ${oiAge.asOfDate ?? 'n/a'} (${oiAge.businessDayLag} business-day lag); expiry ${expiryCoverage.start ?? 'n/a'} → ${expiryCoverage.end ?? 'n/a'}` },
      notes: [...health.notes.filter((note) => !note.startsWith('Standalone CME collector')), 'Local seed rebuild only; no external project is used.'],
    },
    datasets: {
      ...existing?.datasets,
      price_1d: { path: `price/${symbol}/1d/latest.json`, schemaVersion: 1, generatedAt, coverageStart: price1d[0]?.time.slice(0, 10) ?? null, coverageEnd: price1dAge.bar?.closeTime.slice(0, 10) ?? null, rowCount: price1d.length, sha256: sha256Json(price1d), freshness: price1d.length ? price1dAge.fresh ? 'fresh' : 'stale' : 'missing' },
      price_4h: { path: `price/${symbol}/4h/latest.json`, schemaVersion: 1, generatedAt, coverageStart: price4h[0]?.time.slice(0, 10) ?? null, coverageEnd: price4hAge.bar?.closeTime.slice(0, 10) ?? null, rowCount: price4h.length, sha256: sha256Json(price4h), freshness: price4h.length ? price4hAge.fresh ? 'fresh' : 'stale' : 'missing' },
      oi_walls: { path: `walls/${symbol}/latest.json`, schemaVersion: 1, generatedAt, coverageStart: frontHealth.coverageStart, coverageEnd: frontHealth.coverageEnd, rowCount: walls.length, sha256: sha256Json(walls), freshness: walls.length ? oiAge.fresh ? 'fresh' : 'stale' : 'missing' },
      oi_front: { path: `oi/${symbol}/latest.json`, schemaVersion: 1, generatedAt, coverageStart: frontHealth.coverageStart, coverageEnd: frontHealth.coverageEnd, rowCount: front.length, sha256: sha256Json(front), freshness: front.length ? oiAge.fresh ? 'fresh' : 'stale' : 'missing' },
      oi_all_expiries: { path: `oi/${symbol}/all-expiries-latest.json`, schemaVersion: 1, generatedAt, coverageStart: allHealth.coverageStart, coverageEnd: allHealth.coverageEnd, rowCount: allExpiry.length, sha256: sha256Json(allExpiry), freshness: allExpiry.length ? oiAge.fresh ? 'fresh' : 'stale' : 'missing' },
      oi_walls_all_expiries: { path: `walls/${symbol}/all-expiries-latest.json`, schemaVersion: 1, generatedAt, coverageStart: allHealth.coverageStart, coverageEnd: allHealth.coverageEnd, rowCount: allExpiryWalls.length, sha256: sha256Json(allExpiryWalls), freshness: allExpiryWalls.length ? oiAge.fresh ? 'fresh' : 'stale' : 'missing' },
      oi_dominance_outlook: { path: `oi/${symbol}/dominance-outlook.json`, schemaVersion: 1, generatedAt, coverageStart: dominanceOutlook.baseDate, coverageEnd: dominanceOutlook.points.at(-1)?.time ?? null, rowCount: dominanceOutlook.points.length, sha256: sha256Json(dominanceOutlook), freshness: dominanceOutlook.points.length ? oiAge.fresh ? 'fresh' : 'stale' : 'missing' },
      options_prediction: { path: `prediction/${symbol}/latest.json`, schemaVersion: 1, generatedAt, coverageStart: optionsPrediction.asOfDate, coverageEnd: optionsPrediction.maxPain.nearestExpiry, rowCount: optionsPrediction.levels.length, sha256: sha256Json(optionsPrediction), freshness: optionsPrediction.levels.length ? oiAge.fresh && price4hAge.fresh ? 'fresh' : 'stale' : 'missing' },
    },
  };
  await writeJsonAtomic(path.join(dataRoot, 'manifest.json'), manifest);
  await writeJsonAtomic(path.join(dataRoot, 'status', 'latest.json'), manifest.health);
  console.log(JSON.stringify({ mode: 'local-rebuild', frontSnapshots: front.length, allExpirySnapshots: allExpiry.length, walls: walls.length, allExpiryWalls: allExpiryWalls.length, dominancePoints: dominanceOutlook.points.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
