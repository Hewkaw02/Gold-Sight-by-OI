import type { DominanceOutlook, DominanceOutlookPoint, OISnapshot } from '../../src/domain/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ContractOi {
  expiryDate: string;
  callOi: number;
  putOi: number;
}

export interface DominanceOutlookOptions {
  baseDate?: string;
  horizonDays?: number;
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function snapshotOi(snapshot: OISnapshot): ContractOi | null {
  let callOi = 0;
  let putOi = 0;
  for (const strike of snapshot.strikes) {
    if (typeof strike.callOpenInterest === 'number' && Number.isFinite(strike.callOpenInterest)) callOi += Math.max(0, strike.callOpenInterest);
    if (typeof strike.putOpenInterest === 'number' && Number.isFinite(strike.putOpenInterest)) putOi += Math.max(0, strike.putOpenInterest);
  }
  return callOi + putOi > 0 ? { expiryDate: snapshot.expiryDate, callOi, putOi } : null;
}

function pointForDate(date: string, contracts: ContractOi[]): DominanceOutlookPoint {
  const active = contracts.filter((contract) => contract.expiryDate >= date);
  const callOi = active.reduce((sum, contract) => sum + contract.callOi, 0);
  const putOi = active.reduce((sum, contract) => sum + contract.putOi, 0);
  const totalOi = callOi + putOi;
  return {
    time: date,
    dominance: totalOi > 0 ? (callOi - putOi) / totalOi : null,
    callOi,
    putOi,
    totalOi,
    activeExpiryCount: active.length,
  };
}

export function buildDominanceOutlook(
  snapshots: OISnapshot[],
  options: DominanceOutlookOptions = {},
): DominanceOutlook {
  const validTradeDates = snapshots.map((snapshot) => snapshot.tradeDate).filter(Boolean).sort();
  const baseDate = options.baseDate ?? validTradeDates.at(-1) ?? new Date().toISOString().slice(0, 10);
  const requestedHorizonDays = Math.max(1, Math.round(options.horizonDays ?? 90));
  const requestedEndDate = addDays(baseDate, requestedHorizonDays);
  const latestByExpiry = new Map<string, { snapshot: OISnapshot; oi: ContractOi }>();

  for (const snapshot of snapshots) {
    if (!snapshot.expiryDate || snapshot.expiryDate <= baseDate || snapshot.expiryDate > requestedEndDate || snapshot.tradeDate > baseDate) continue;
    const oi = snapshotOi(snapshot);
    if (!oi) continue;
    const current = latestByExpiry.get(snapshot.expiryDate);
    if (!current || snapshot.fetchedAt > current.snapshot.fetchedAt) latestByExpiry.set(snapshot.expiryDate, { snapshot, oi });
  }

  const contracts = [...latestByExpiry.values()]
    .map(({ oi }) => oi)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  const effectiveEndDate = contracts.at(-1)?.expiryDate ?? baseDate;
  const endDate = effectiveEndDate < requestedEndDate ? effectiveEndDate : requestedEndDate;
  const points: DominanceOutlookPoint[] = [];
  for (let date = baseDate; date <= endDate; date = addDays(date, 1)) points.push(pointForDate(date, contracts));

  return {
    schemaVersion: 1,
    symbol: snapshots[0]?.symbol ?? 'GC',
    generatedAt: new Date().toISOString(),
    baseDate,
    horizonDays: points.length > 0 ? points.length - 1 : 0,
    expiryStart: contracts[0]?.expiryDate ?? null,
    expiryEnd: contracts.at(-1)?.expiryDate ?? null,
    method: 'unexpired-eod-oi-carry-forward',
    points,
  };
}
