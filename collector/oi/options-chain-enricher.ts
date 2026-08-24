import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { OISnapshot } from '../../src/domain/types.js';

export interface OptionsChainRow {
  tradeDate: string;
  fetchedAt: string | null;
  expiryCode: string | null;
  expiryDate: string;
  daysToExpiry: number | null;
  strike: number;
  optionType: 'C' | 'P';
  volume: number | null;
  openInterest: number | null;
  oiAsOfDate: string | null;
  isValid: boolean;
}

export interface ChainOi {
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  oiAsOfDate: string | null;
  fetchedAt: string | null;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else value += char;
  }
  values.push(value);
  return values;
}

function numeric(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function key(expiryDate: string, strike: number, optionType: string) {
  return `${expiryDate}|${strike}|${optionType.toUpperCase()}`;
}

async function findOptionsFile(optionsRoot: string, symbol: string, tradeDate: string): Promise<string | null> {
  const names = [
    `${symbol}_options_${tradeDate.replaceAll('-', '')}.csv`,
  ];
  for (const name of names) {
    const candidate = path.join(optionsRoot, name);
    try { await access(candidate); return candidate; } catch { /* try archive below */ }
  }
  try {
    const archiveRoot = path.join(optionsRoot, 'archive');
    const folders = await readdir(archiveRoot, { withFileTypes: true });
    for (const folder of folders.sort((a, b) => b.name.localeCompare(a.name))) {
      if (!folder.isDirectory()) continue;
      const folderPath = path.join(archiveRoot, folder.name);
      const files = await readdir(folderPath);
      const match = files.find((name) => name.startsWith(`${symbol}_options_${tradeDate.replaceAll('-', '')}_`) && name.endsWith('.csv'));
      if (match) return path.join(folderPath, match);
    }
  } catch { /* source may not have an archive */ }
  return null;
}

export async function loadOptionsChain(
  optionsRoot: string,
  symbol: string,
  tradeDate: string,
): Promise<{ filePath: string; rows: OptionsChainRow[] } | null> {
  const filePath = await findOptionsFile(optionsRoot, symbol, tradeDate);
  if (!filePath) return null;
  const content = await readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { filePath, rows: [] };
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const index = new Map(headers.map((header, position) => [header, position]));
  const column = (columns: string[], name: string) => columns[index.get(name) ?? -1]?.trim() ?? '';
  const rows: OptionsChainRow[] = [];
  for (const line of lines.slice(1)) {
    const columns = parseCsvLine(line);
    const expiryDate = column(columns, 'expiry_date');
    const strike = numeric(column(columns, 'strike'));
    const optionTypeRaw = column(columns, 'option_type').toUpperCase();
    const optionType = optionTypeRaw.startsWith('C') ? 'C' : optionTypeRaw.startsWith('P') ? 'P' : null;
    if (!expiryDate || strike == null || !optionType) continue;
    rows.push({
      tradeDate: column(columns, 'trade_date') || tradeDate,
      fetchedAt: column(columns, 'fetched_at') || null,
      expiryCode: column(columns, 'expiry_code') || null,
      expiryDate,
      daysToExpiry: numeric(column(columns, 'days_to_expiry')),
      strike,
      optionType,
      volume: numeric(column(columns, 'volume')),
      openInterest: numeric(column(columns, 'open_interest')),
      oiAsOfDate: column(columns, 'oi_as_of_date') || null,
      isValid: column(columns, 'is_valid').toLowerCase() !== 'false',
    });
  }
  return { filePath, rows };
}

export async function loadOptionsOi(optionsRoot: string, symbol: string, tradeDate: string): Promise<Map<string, ChainOi>> {
  const chain = await loadOptionsChain(optionsRoot, symbol, tradeDate);
  if (!chain) return new Map();
  const result = new Map<string, ChainOi>();
  for (const row of chain.rows) {
    const rowKey = key(row.expiryDate, row.strike, row.optionType);
    const current = result.get(rowKey) ?? { callOpenInterest: null, putOpenInterest: null, oiAsOfDate: null, fetchedAt: null };
    if (row.optionType === 'C') current.callOpenInterest = row.openInterest;
    if (row.optionType === 'P') current.putOpenInterest = row.openInterest;
    current.oiAsOfDate = row.oiAsOfDate;
    current.fetchedAt = row.fetchedAt;
    result.set(rowKey, current);
  }
  return result;
}

function latestNumber(current: number | null, next: number | null): number | null {
  if (current == null) return next;
  if (next == null) return current;
  return Math.max(current, next);
}

function calendarDte(tradeDate: string, expiryDate: string): number {
  const from = Date.parse(`${tradeDate}T00:00:00Z`);
  const to = Date.parse(`${expiryDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

interface AllExpiryStrike {
  strike: number;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  callVolume: number | null;
  putVolume: number | null;
  expiryCode: string | null;
}

/**
 * Build a reusable all-expiry OI layer from a canonical EOD options chain.
 * Vol2Vol tenor remains the front-equivalent layer; this layer preserves the
 * farther expiries exposed by the chain (including LEAPS) without treating
 * volume as open interest.
 */
export async function buildAllExpirySnapshots(
  frontSnapshots: OISnapshot[],
  optionsRoot: string,
): Promise<OISnapshot[]> {
  const anchors = new Map<string, OISnapshot>();
  const priority: Record<OISnapshot['sessionSlot'], number> = { open: 1, mid: 2, close: 3 };
  for (const snapshot of frontSnapshots) {
    const current = anchors.get(snapshot.tradeDate);
    if (!current || priority[snapshot.sessionSlot] > priority[current.sessionSlot] || snapshot.fetchedAt > current.fetchedAt) {
      anchors.set(snapshot.tradeDate, snapshot);
    }
  }

  const output: OISnapshot[] = [];
  for (const tradeDate of [...anchors.keys()].sort()) {
    const chain = await loadOptionsChain(optionsRoot, anchors.get(tradeDate)!.symbol, tradeDate);
    if (!chain || chain.rows.length === 0) continue;
    const byExpiry = new Map<string, { rows: OptionsChainRow[]; strikes: Map<number, AllExpiryStrike> }>();
    for (const row of chain.rows) {
      const expiry = byExpiry.get(row.expiryDate) ?? { rows: [], strikes: new Map<number, AllExpiryStrike>() };
      expiry.rows.push(row);
      const strike = expiry.strikes.get(row.strike) ?? {
        strike: row.strike,
        callOpenInterest: null,
        putOpenInterest: null,
        callVolume: null,
        putVolume: null,
        expiryCode: row.expiryCode,
      };
      if (row.optionType === 'C') {
        strike.callOpenInterest = latestNumber(strike.callOpenInterest, row.openInterest);
        strike.callVolume = latestNumber(strike.callVolume, row.volume);
      } else {
        strike.putOpenInterest = latestNumber(strike.putOpenInterest, row.openInterest);
        strike.putVolume = latestNumber(strike.putVolume, row.volume);
      }
      expiry.strikes.set(row.strike, strike);
      byExpiry.set(row.expiryDate, expiry);
    }

    const anchor = anchors.get(tradeDate)!;
    for (const [expiryDate, expiry] of byExpiry) {
      const actualDte = Math.max(
        0,
        Math.round(
          expiry.rows.map((row) => row.daysToExpiry).find((value): value is number => value != null)
            ?? calendarDte(tradeDate, expiryDate),
        ),
      );
      const fetchedAt = expiry.rows.map((row) => row.fetchedAt).filter(Boolean).sort().at(-1) ?? `${tradeDate}T23:59:59.000Z`;
      const oiAsOfDate = expiry.rows.map((row) => row.oiAsOfDate).filter(Boolean).sort().at(-1) ?? null;
      const hasInvalidRows = expiry.rows.some((row) => !row.isValid);
      output.push({
        snapshotId: `${anchor.symbol}-${tradeDate}-close-all-${expiryDate}`,
        symbol: anchor.symbol,
        tradeDate,
        fetchedAt,
        sessionSlot: 'close',
        targetDte: actualDte,
        actualDte,
        expiryDate,
        futurePrice: anchor.futurePrice,
        sourceStatus: hasInvalidRows ? 'WARNING' : 'VALID',
        sourceAsOf: fetchedAt,
        oiAsOfDate,
        oiSource: 'options_chain_eod',
        selectedViews: ['options_chain_eod'],
        sourceFile: chain.filePath,
        rawSha256: null,
        strikes: [...expiry.strikes.values()].sort((a, b) => a.strike - b.strike).map((strike) => ({
          viewName: 'options_chain_eod',
          strike: strike.strike,
          callOpenInterest: strike.callOpenInterest,
          putOpenInterest: strike.putOpenInterest,
          callVolume: strike.callVolume,
          putVolume: strike.putVolume,
          impliedVol: null,
          settleVol: null,
          extra: { expiryCode: strike.expiryCode },
        })),
      });
    }
  }
  return output.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.expiryDate.localeCompare(b.expiryDate));
}

export async function enrichSnapshotsWithOptionsOi(
  snapshots: OISnapshot[],
  optionsRoot: string,
): Promise<OISnapshot[]> {
  const cache = new Map<string, Map<string, ChainOi>>();
  const enriched: OISnapshot[] = [];
  for (const snapshot of snapshots) {
    let chain = cache.get(snapshot.tradeDate);
    if (!chain) {
      chain = await loadOptionsOi(optionsRoot, snapshot.symbol, snapshot.tradeDate);
      cache.set(snapshot.tradeDate, chain);
    }
    let fromChain = false;
    let oiAsOfDate: string | null = snapshot.oiAsOfDate ?? null;
    const strikes = snapshot.strikes.map((strike) => {
      const call = chain?.get(key(snapshot.expiryDate, strike.strike, 'C'));
      const put = chain?.get(key(snapshot.expiryDate, strike.strike, 'P'));
      const callOpenInterest = strike.callOpenInterest ?? call?.callOpenInterest ?? null;
      const putOpenInterest = strike.putOpenInterest ?? put?.putOpenInterest ?? null;
      if (strike.callOpenInterest == null && call?.callOpenInterest != null) fromChain = true;
      if (strike.putOpenInterest == null && put?.putOpenInterest != null) fromChain = true;
      oiAsOfDate = oiAsOfDate ?? call?.oiAsOfDate ?? put?.oiAsOfDate ?? null;
      return { ...strike, callOpenInterest, putOpenInterest };
    });
    const hasVol2VolOi = snapshot.strikes.some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null);
    const hasOi = strikes.some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null);
    enriched.push({
      ...snapshot,
      strikes,
      sourceStatus: hasOi ? snapshot.sourceStatus : 'WARNING',
      oiAsOfDate,
      oiSource: hasOi ? (hasVol2VolOi && fromChain ? 'mixed' : hasVol2VolOi ? 'vol2vol' : 'options_chain_eod') : 'missing',
    });
  }
  return enriched;
}
