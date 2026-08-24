import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  OISnapshot,
  OIStrike,
  SessionSlot,
  SymbolCode,
  WallLevel,
  WallSegment,
} from '../../src/domain/types.js';
import { enrichSnapshotsWithOptionsOi } from './options-chain-enricher.js';

export interface WallEngineOptions {
  p90Quantile?: number;
  maxGapTradingSessions?: number;
  endAt?: string;
  basisGrid?: number;
  frontEquivalent?: boolean;
  minStrikeFactor?: number;
  maxStrikeFactor?: number;
}

interface NormalizedStrikeInput {
  viewName?: string;
  strike: number;
  callOpenInterest?: number | null;
  putOpenInterest?: number | null;
  callVolume?: number | null;
  putVolume?: number | null;
  impliedVol?: number | null;
  settleVol?: number | null;
  extra?: Record<string, unknown>;
}

interface NormalizedSnapshotInput {
  schemaVersion?: number;
  symbol: string;
  tradeDate: string;
  sessionSlot: SessionSlot;
  targetDte: number;
  actualDte: number;
  expiryDate: string;
  futurePrice: number;
  sourceStatus?: 'VALID' | 'WARNING';
  sourceAsOf?: string | null;
  oiAsOfDate?: string | null;
  oiSource?: 'vol2vol' | 'options_chain_eod' | 'mixed' | 'missing';
  selectedViews?: string[];
  capturedAt?: string;
  strikes?: NormalizedStrikeInput[];
}

function numberOrNull(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function preferredStrikeRecords(strikes: NormalizedStrikeInput[]): NormalizedStrikeInput[] {
  const byStrike = new Map<number, NormalizedStrikeInput>();
  for (const strike of strikes) {
    const numericStrike = numberOrNull(strike.strike);
    if (numericStrike == null) continue;
    const current = byStrike.get(numericStrike);
    const currentIsOi = /open\s*interest|\boi\b/i.test(current?.viewName ?? '');
    const nextIsOi = /open\s*interest|\boi\b/i.test(strike.viewName ?? '');
    const currentHasOi = current?.callOpenInterest != null || current?.putOpenInterest != null;
    const nextHasOi = strike.callOpenInterest != null || strike.putOpenInterest != null;
    if (!current || (nextIsOi && !currentIsOi) || (nextHasOi && !currentHasOi)) {
      byStrike.set(numericStrike, { ...strike, strike: numericStrike });
    }
  }
  return [...byStrike.values()];
}

export function normalizeSnapshot(input: NormalizedSnapshotInput, sourceFile: string | null): OISnapshot {
  const snapshotId = [input.symbol, input.tradeDate, input.sessionSlot, input.targetDte, input.expiryDate].join('-');
  const strikes: OIStrike[] = preferredStrikeRecords(input.strikes ?? []).map((strike) => ({
    viewName: strike.viewName ?? 'unknown',
    strike: strike.strike,
    callOpenInterest: numberOrNull(strike.callOpenInterest),
    putOpenInterest: numberOrNull(strike.putOpenInterest),
    callVolume: numberOrNull(strike.callVolume),
    putVolume: numberOrNull(strike.putVolume),
    impliedVol: numberOrNull(strike.impliedVol),
    settleVol: numberOrNull(strike.settleVol),
    extra: strike.extra ?? {},
  }));
  const hasOi = strikes.some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null);
  return {
    snapshotId,
    symbol: input.symbol,
    tradeDate: input.tradeDate,
    fetchedAt: input.capturedAt ?? `${input.tradeDate}T20:00:00.000Z`,
    sessionSlot: input.sessionSlot,
    targetDte: input.targetDte,
    actualDte: input.actualDte,
    expiryDate: input.expiryDate,
    futurePrice: input.futurePrice,
    sourceStatus: input.sourceStatus ?? (hasOi ? 'VALID' : 'WARNING'),
    sourceAsOf: input.sourceAsOf ?? null,
    oiAsOfDate: input.oiAsOfDate ?? null,
    oiSource: input.oiSource ?? (hasOi ? 'vol2vol' : 'missing'),
    selectedViews: input.selectedViews ?? [],
    sourceFile,
    rawSha256: null,
    strikes,
  };
}

const SESSION_PRIORITY: Record<SessionSlot, number> = { close: 3, mid: 2, open: 1 };

export function chooseRepresentativeSnapshots(snapshots: OISnapshot[]): OISnapshot[] {
  const groups = new Map<string, OISnapshot>();
  for (const snapshot of snapshots) {
    const key = [snapshot.symbol, snapshot.tradeDate, snapshot.targetDte, snapshot.expiryDate].join('|');
    const current = groups.get(key);
    if (!current || SESSION_PRIORITY[snapshot.sessionSlot] > SESSION_PRIORITY[current.sessionSlot] || snapshot.fetchedAt > current.fetchedAt) {
      groups.set(key, snapshot);
    }
  }
  return [...groups.values()].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

interface UniqueExpiryStrike {
  expiryDate: string;
  strike: number;
  callOi: number;
  putOi: number;
  targetDtes: Set<number>;
  snapshotIds: Set<string>;
}

export function aggregateLevels(snapshots: OISnapshot[], options: WallEngineOptions = {}): WallLevel[] {
  const representatives = chooseRepresentativeSnapshots(snapshots);
  const byTradeDate = new Map<string, OISnapshot[]>();
  for (const snapshot of representatives) {
    const list = byTradeDate.get(snapshot.tradeDate) ?? [];
    list.push(snapshot);
    byTradeDate.set(snapshot.tradeDate, list);
  }

  const levels: WallLevel[] = [];
  for (const [tradeDate, dateSnapshots] of byTradeDate) {
    const activeSnapshots = dateSnapshots.filter((snapshot) => {
      if (snapshot.expiryDate < tradeDate) return false;
      return snapshot.strikes.some((strike) => (strike.callOpenInterest ?? 0) > 0 || (strike.putOpenInterest ?? 0) > 0);
    });
    if (activeSnapshots.length === 0) continue;
    const referenceSnapshot = [...activeSnapshots]
      .filter((snapshot) => Number.isFinite(snapshot.futurePrice) && snapshot.futurePrice > 0)
      .sort((a, b) => a.actualDte - b.actualDte || SESSION_PRIORITY[b.sessionSlot] - SESSION_PRIORITY[a.sessionSlot] || b.fetchedAt.localeCompare(a.fetchedAt))[0];
    const frontFuturePrice = referenceSnapshot?.futurePrice ?? 0;
    const basisGrid = Math.max(0.01, options.basisGrid ?? 5);
    const frontEquivalent = options.frontEquivalent ?? true;
    const minStrike = frontFuturePrice > 0 ? frontFuturePrice * (options.minStrikeFactor ?? 0.65) : Number.NEGATIVE_INFINITY;
    const maxStrike = frontFuturePrice > 0 ? frontFuturePrice * (options.maxStrikeFactor ?? 1.35) : Number.POSITIVE_INFINITY;
    const unique = new Map<string, UniqueExpiryStrike>();
    for (const snapshot of activeSnapshots) {
      const basisOffset = frontEquivalent && frontFuturePrice > 0 && Number.isFinite(snapshot.futurePrice)
        ? frontFuturePrice - snapshot.futurePrice
        : 0;
      for (const strike of snapshot.strikes) {
        const equivalentStrike = Math.round((strike.strike + basisOffset) / basisGrid) * basisGrid;
        if (equivalentStrike < minStrike || equivalentStrike > maxStrike) continue;
        const key = `${snapshot.expiryDate}|${equivalentStrike}`;
        const callOi = strike.callOpenInterest ?? 0;
        const putOi = strike.putOpenInterest ?? 0;
        const record = unique.get(key) ?? {
          expiryDate: snapshot.expiryDate,
          strike: equivalentStrike,
          callOi,
          putOi,
          targetDtes: new Set<number>(),
          snapshotIds: new Set<string>(),
        };
        // A duplicate expiry can appear under multiple target DTEs. Keep the
        // OI once and only union its provenance dimensions.
        record.targetDtes.add(snapshot.targetDte);
        record.snapshotIds.add(snapshot.snapshotId);
        if (callOi > record.callOi) record.callOi = callOi;
        if (putOi > record.putOi) record.putOi = putOi;
        unique.set(key, record);
      }
    }

    const byStrike = new Map<number, UniqueExpiryStrike[]>();
    for (const value of unique.values()) {
      const list = byStrike.get(value.strike) ?? [];
      list.push(value);
      byStrike.set(value.strike, list);
    }
    const rawRows = [...byStrike.entries()].map(([strike, rows]) => {
      const callOi = rows.reduce((sum, row) => sum + row.callOi, 0);
      const putOi = rows.reduce((sum, row) => sum + row.putOi, 0);
      const totalOi = callOi + putOi;
      const netOi = callOi - putOi;
      return {
        strike,
        callOi,
        putOi,
        totalOi,
        netOi,
        dominance: totalOi > 0 ? netOi / totalOi : 0,
        expiryDates: rows.map((row) => row.expiryDate).sort(),
        targetDtes: [...new Set(rows.flatMap((row) => [...row.targetDtes]))].sort((a, b) => a - b),
        snapshotIds: [...new Set(rows.flatMap((row) => [...row.snapshotIds]))],
      };
    });
    const wallThreshold = percentile(rawRows.map((row) => Math.max(row.callOi, row.putOi)).filter((value) => value > 0), options.p90Quantile ?? 0.9);
    const asOf = activeSnapshots.map((snapshot) => snapshot.fetchedAt).sort().at(-1) ?? `${tradeDate}T20:00:00.000Z`;
    const symbol = activeSnapshots[0]?.symbol ?? 'GC';
    for (const row of rawRows) {
      const sideOi = Math.max(row.callOi, row.putOi);
      const isSignificant = sideOi > 0 && sideOi >= wallThreshold;
      levels.push({
        symbol,
        asOf,
        strike: row.strike,
        callOi: row.callOi,
        putOi: row.putOi,
        totalOi: row.totalOi,
        netOi: row.netOi,
        dominance: row.dominance,
        significanceScore: wallThreshold > 0 ? sideOi / wallThreshold : 0,
        expiryDates: row.expiryDates,
        targetDtes: row.targetDtes,
        snapshotIds: row.snapshotIds,
        isSignificant,
      });
    }
  }
  return levels.sort((a, b) => a.asOf.localeCompare(b.asOf) || a.strike - b.strike);
}

function addBusinessDays(value: string, amount: number): string {
  const date = new Date(value);
  let remaining = amount;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString();
}

function businessDaysBetween(from: string, to: string): number {
  const start = new Date(from);
  const end = new Date(to);
  let cursor = new Date(start);
  let days = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days += 1;
  }
  return days;
}

function firstExpiryEnd(level: WallLevel): string | null {
  const expiry = level.expiryDates.filter(Boolean).sort()[0];
  return expiry ? `${expiry}T23:59:59.999Z` : null;
}

export function buildWallSegments(levels: WallLevel[], options: WallEngineOptions = {}): WallSegment[] {
  const maxGap = options.maxGapTradingSessions ?? 2;
  const times = [...new Set(levels.map((level) => level.asOf))].sort();
  const byStrike = new Map<number, WallLevel[]>();
  for (const level of levels) {
    const list = byStrike.get(level.strike) ?? [];
    list.push(level);
    byStrike.set(level.strike, list);
  }
  const segments: WallSegment[] = [];
  for (const [strike, events] of byStrike) {
    const byTime = new Map(events.map((event) => [event.asOf, event]));
    let current: WallLevel | null = null;
    let startedAt = '';
    let lastSeen = '';
    const closeCurrent = (to: string, stale: boolean) => {
      if (!current) return;
      const expiryEnd = firstExpiryEnd(current);
      const candidateTo = expiryEnd && expiryEnd < to ? expiryEnd : to;
      const actualTo = candidateTo < startedAt ? startedAt : candidateTo;
      segments.push({ ...current, strike, from: startedAt, to: actualTo, stale, status: stale ? 'stale' : 'closed' });
      current = null;
      startedAt = '';
      lastSeen = '';
    };

    for (const time of times) {
      const event = byTime.get(time);
      if (current && lastSeen && businessDaysBetween(lastSeen, time) > maxGap) {
        closeCurrent(addBusinessDays(lastSeen, maxGap), true);
      }
      if (event?.isSignificant) {
        if (!current) {
          current = event;
          startedAt = time;
        } else {
          current = {
            ...event,
            snapshotIds: [...new Set([...current.snapshotIds, ...event.snapshotIds])],
          };
        }
        lastSeen = time;
      } else if (current) {
        closeCurrent(time, false);
      }
    }
    if (current) {
      const endAt = options.endAt ?? new Date().toISOString();
      const expiryEnd = firstExpiryEnd(current);
      const candidateTo = expiryEnd && expiryEnd < endAt ? expiryEnd : endAt;
      const to = candidateTo < startedAt ? startedAt : candidateTo;
      segments.push({ ...current, strike, from: startedAt, to, stale: false, status: 'active' });
    }
  }
  return segments.sort((a, b) => a.from.localeCompare(b.from) || a.strike - b.strike);
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(fullPath));
    else if (entry.isFile() && entry.name === 'normalized.json') result.push(fullPath);
  }
  return result;
}

export async function loadNormalizedSnapshots(root: string, symbol = 'GC', optionsRoot?: string): Promise<OISnapshot[]> {
  const files = await walkFiles(root);
  const snapshots: OISnapshot[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(file, 'utf8')) as NormalizedSnapshotInput;
    if (raw.symbol !== symbol) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(path.dirname(file), 'manifest.json'), 'utf8')) as { status?: string };
      if (manifest.status === 'VALID' || manifest.status === 'WARNING') raw.sourceStatus = manifest.status;
    } catch { /* manifest is optional for legacy normalized files */ }
    snapshots.push(normalizeSnapshot(raw, file));
  }
  return optionsRoot ? enrichSnapshotsWithOptionsOi(snapshots, optionsRoot) : snapshots;
}

export function deriveWalls(snapshots: OISnapshot[], options: WallEngineOptions = {}): WallSegment[] {
  return buildWallSegments(aggregateLevels(snapshots, options), options);
}

export function summarizeSnapshotHealth(snapshots: OISnapshot[]) {
  return {
    count: snapshots.length,
    valid: snapshots.filter((snapshot) => snapshot.sourceStatus === 'VALID').length,
    warning: snapshots.filter((snapshot) => snapshot.sourceStatus === 'WARNING').length,
    withOi: snapshots.filter((snapshot) => snapshot.strikes.some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null)).length,
    missingOi: snapshots.filter((snapshot) => !snapshot.strikes.some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null)).length,
    coverageStart: snapshots.map((snapshot) => snapshot.tradeDate).sort()[0] ?? null,
    coverageEnd: snapshots.map((snapshot) => snapshot.tradeDate).sort().at(-1) ?? null,
  };
}
