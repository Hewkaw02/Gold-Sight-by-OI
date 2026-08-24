import type {
  DashboardData,
  DataManifest,
  DominanceOutlook,
  OptionsPrediction,
  PriceBar,
  PriceTimeframe,
  RollMarker,
  WallSegment,
  DashboardHealth,
} from '../domain/types';

const DATA_ROOT = `${import.meta.env.BASE_URL}data`;

async function readJson<T>(path: string, version: number): Promise<T> {
  const response = await fetch(`${DATA_ROOT}/${path}?v=${version}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Data request failed (${response.status}): ${path}`);
  return response.json() as Promise<T>;
}

export async function loadDashboardData(timeframe: PriceTimeframe): Promise<DashboardData> {
  const version = Date.now();
  const [manifest, status, price, walls, allExpiryWalls, rolls, dominanceOutlook, optionsPrediction] = await Promise.all([
    readJson<DataManifest>('manifest.json', version),
    readJson<DashboardHealth>('status/latest.json', version).catch(() => null),
    readJson<PriceBar[]>(`price/GC/${timeframe.toLowerCase()}/latest.json`, version),
    readJson<WallSegment[]>('walls/GC/latest.json', version),
    readJson<WallSegment[]>('walls/GC/all-expiries-latest.json', version).catch(() => []),
    readJson<RollMarker[]>('rolls/GC/latest.json', version),
    readJson<DominanceOutlook>('oi/GC/dominance-outlook.json', version).catch(() => null),
    readJson<OptionsPrediction>('prediction/GC/latest.json', version).catch(() => null),
  ]);
  const mergedManifest = status
    ? { ...manifest, health: { ...manifest.health, ...status, auth: status.auth ?? manifest.health.auth, price: status.price ?? manifest.health.price, oi: status.oi ?? manifest.health.oi, notes: status.notes ?? manifest.health.notes } }
    : manifest;
  return { price, walls, allExpiryWalls, rolls, dominanceOutlook, optionsPrediction, manifest: mergedManifest };
}
