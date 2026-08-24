import type { OISnapshot, OIStrike, SessionSlot, SymbolCode } from '../../src/domain/types.js';
import { pageFetch } from './cme-browser.js';

interface ExpiryInfo {
  code: string;
  label: string;
  groupLabel: string;
  date: string;
}

interface SettlementRow {
  strike: number;
  optionType: 'C' | 'P';
  openInterest: number | null;
  volume: number | null;
}

const GC_OPTIONS_PRODUCT_ID = 192;
const GC_SETTLEMENT_PRODUCT_ID = 437;

function numeric(value: unknown): number | null {
  if (value == null || String(value).trim() === '' || String(value).trim() === '-') return null;
  const parsed = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value: unknown): string | null {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value))) {
    const parsed = new Date(Number(value));
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  const match = String(value ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function calendarDte(tradeDate: string, expiryDate: string): number {
  const start = Date.parse(`${tradeDate}T00:00:00Z`);
  const end = Date.parse(`${expiryDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function monthCode(month: number): string {
  return ({ 1: 'F', 2: 'G', 3: 'H', 4: 'J', 5: 'K', 6: 'M', 7: 'N', 8: 'Q', 9: 'U', 10: 'V', 11: 'X', 12: 'Z' } as Record<number, string>)[month] ?? 'X';
}

async function getExpiries(page: any): Promise<ExpiryInfo[]> {
  const raw = await pageFetch<any[]>(page, `https://www.cmegroup.com/CmeWS/mvc/atm/expirations/${GC_OPTIONS_PRODUCT_ID}`);
  const result: ExpiryInfo[] = [];
  const seen = new Set<string>();
  for (const group of Array.isArray(raw) ? raw : []) {
    for (const expiry of Array.isArray(group?.contractExpirations) ? group.contractExpirations : []) {
      const date = dateOnly(expiry.lastTradeDate ?? expiry.expirationDate);
      if (!date || seen.has(date)) continue;
      const parsedDate = new Date(`${date}T00:00:00Z`);
      const code = `${monthCode(parsedDate.getUTCMonth() + 1)}${String(parsedDate.getUTCFullYear()).slice(-1)}_${expiry.productId ?? GC_OPTIONS_PRODUCT_ID}`;
      const groupLabel = String(group.label ?? group.name ?? 'Options');
      const expiryLabel = String(expiry.label ?? expiry.name ?? date);
      result.push({ code, label: `${groupLabel} - ${expiryLabel}`, groupLabel, date });
      seen.add(date);
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchStrikePrices(page: any, expiry: ExpiryInfo): Promise<any> {
  const date = new Date(`${expiry.date}T00:00:00Z`);
  const url = `https://www.cmegroup.com/CmeWS/mvc/atm/strike-prices/${GC_OPTIONS_PRODUCT_ID}/${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/ALL`;
  return pageFetch<any>(page, url, { headers: { Accept: 'application/json' } });
}

function usDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

function isoFromUsDate(value: string): string | null {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}` : null;
}

async function fetchSettlementMetadata(page: any): Promise<any[]> {
  try {
    const raw = await pageFetch<any[]>(page, `https://www.cmegroup.com/CmeWS/mvc/Settlements/Options/TradeDateAndExpirations/${GC_SETTLEMENT_PRODUCT_ID}`);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function findMatchedExpiration(metadata: any[], expiry: ExpiryInfo): any | null {
  const group = metadata.find((item) => String(item?.label ?? '').toLowerCase() === expiry.groupLabel.toLowerCase());
  const expirations = Array.isArray(group?.expirations) ? group.expirations : [];
  return expirations.find((item: any) => {
    const lastTradeDate = dateOnly(item?.lastTradeDate?.timestamp ?? item?.lastTradeDate);
    const itemDate = lastTradeDate ?? (item?.expiration?.year && item?.expiration?.month
      ? `${item.expiration.year}-${String(item.expiration.month).padStart(2, '0')}-01`
      : null);
    return itemDate === expiry.date;
  }) ?? null;
}

async function fetchSettlementRows(page: any, expiry: ExpiryInfo, matched: any | null, tradeDate: string, metadata: any[]): Promise<{ rows: SettlementRow[]; oiAsOfDate: string | null }> {
  if (!matched) return { rows: [], oiAsOfDate: null };
  const contractId = matched.contractId ?? matched.monthYear ?? matched.expiration?.monthYear;
  const expirationCode = matched.expiration?.code ?? expiry.code;
  if (!contractId) return { rows: [], oiAsOfDate: null };
  const availableDates = (Array.isArray(matched.tradeDates) ? matched.tradeDates : metadata
    .flatMap((group) => Array.isArray(group?.tradeDates) ? group.tradeDates : []))
    .map((item: any) => item.formatedDate ?? item.formattedDate)
    .filter(Boolean);
  const requested = usDate(tradeDate);
  const requestedDate = availableDates.includes(requested) ? requested : availableDates[0] ?? requested;
  const url = `https://www.cmegroup.com/CmeWS/mvc/Settlements/Options/Settlements/${GC_SETTLEMENT_PRODUCT_ID}/OOF?strategy=DEFAULT&optionProductId=${GC_SETTLEMENT_PRODUCT_ID}&monthYear=${contractId}&optionExpiration=${GC_SETTLEMENT_PRODUCT_ID}-${expirationCode}&pageSize=5000&tradeDate=${requestedDate}`;
  try {
    const raw = await pageFetch<any>(page, url, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
    const rows: SettlementRow[] = [];
    for (const row of Array.isArray(raw?.settlements) ? raw.settlements : []) {
      const strike = numeric(row.strike ?? row.strikePrice);
      const rawType = String(row.type ?? row.optionType ?? row.option_type ?? '').toUpperCase();
      const optionType = rawType.startsWith('C') ? 'C' : rawType.startsWith('P') ? 'P' : null;
      if (strike == null || !optionType) continue;
      rows.push({ strike, optionType, openInterest: numeric(row.openInterest ?? row.oi ?? row.open_interest), volume: numeric(row.volume) });
    }
    return { rows, oiAsOfDate: rows.length > 0 ? isoFromUsDate(requestedDate) : null };
  } catch {
    return { rows: [], oiAsOfDate: null };
  }
}

function sideValue(side: any, keys: string[]): number | null {
  for (const key of keys) {
    const value = numeric(side?.[key]);
    if (value != null) return value;
  }
  return null;
}

function settlementMap(rows: SettlementRow[]): Map<string, SettlementRow> {
  return new Map(rows.map((row) => [`${row.strike}|${row.optionType}`, row]));
}

function parseSnapshot(
  raw: any,
  expiry: ExpiryInfo,
  settlement: { rows: SettlementRow[]; oiAsOfDate: string | null },
  tradeDate: string,
  sessionSlot: SessionSlot,
  fallbackFuturePrice: number,
): OISnapshot {
  const settlements = settlementMap(settlement.rows);
  const rawRows = raw?.strikePrices ?? raw?.optionContractQuotes ?? [];
  const strikes: OIStrike[] = [];
  for (const row of rawRows) {
    const strike = numeric(row.strikePrice ?? row.strike);
    if (strike == null || strike <= 0) continue;
    const call = row.call ?? row.calls;
    const put = row.put ?? row.puts;
    const callSettlement = settlements.get(`${strike}|C`);
    const putSettlement = settlements.get(`${strike}|P`);
    strikes.push({
      viewName: 'options_chain_eod',
      strike,
      // Only official settlement OI is used for walls. Live quote volume is
      // retained separately and is never substituted for missing OI.
      callOpenInterest: callSettlement?.openInterest ?? null,
      putOpenInterest: putSettlement?.openInterest ?? null,
      callVolume: sideValue(call, ['volume']),
      putVolume: sideValue(put, ['volume']),
      impliedVol: sideValue(call, ['impliedVolatility', 'impliedVol']) ?? sideValue(put, ['impliedVolatility', 'impliedVol']),
      settleVol: null,
      extra: { expiryCode: expiry.code },
    });
  }
  const actualDte = calendarDte(tradeDate, expiry.date);
  const futurePrice = numeric(raw?.underlyingPrice) ?? fallbackFuturePrice;
  const withOi = strikes.some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null);
  return {
    snapshotId: `GC-${tradeDate}-${sessionSlot}-all-${expiry.date}`,
    symbol: 'GC' as SymbolCode,
    tradeDate,
    fetchedAt: new Date().toISOString(),
    sessionSlot,
    targetDte: actualDte,
    actualDte,
    expiryDate: expiry.date,
    futurePrice,
    sourceStatus: withOi ? 'VALID' : 'WARNING',
    sourceAsOf: tradeDate,
    oiAsOfDate: settlement.oiAsOfDate,
    oiSource: withOi ? 'options_chain_eod' : 'missing',
    selectedViews: ['options_chain_eod'],
    sourceFile: null,
    rawSha256: null,
    strikes,
  };
}

export async function fetchAllExpiryOptions(
  page: any,
  tradeDate: string,
  sessionSlot: SessionSlot,
  fallbackFuturePrice: number,
): Promise<OISnapshot[]> {
  const expiries = await getExpiries(page);
  const metadata = await fetchSettlementMetadata(page);
  const snapshots: OISnapshot[] = [];
  for (const expiry of expiries) {
    try {
      const [raw, settlement] = await Promise.all([
        fetchStrikePrices(page, expiry),
        fetchSettlementRows(page, expiry, findMatchedExpiration(metadata, expiry), tradeDate, metadata),
      ]);
      snapshots.push(parseSnapshot(raw, expiry, settlement, tradeDate, sessionSlot, fallbackFuturePrice));
    } catch {
      // Keep the expiry fail-closed; a missing expiry must not become a zero-OI wall.
    }
  }
  return snapshots;
}

export function mergeFrontOi(front: OISnapshot[], allExpiry: OISnapshot[]): OISnapshot[] {
  const chain = new Map<string, OIStrike>();
  for (const snapshot of allExpiry) {
    for (const strike of snapshot.strikes) chain.set(`${snapshot.expiryDate}|${strike.strike}`, strike);
  }
  return front.map((snapshot) => {
    let fromChain = false;
    const strikes = snapshot.strikes.map((strike) => {
      const chainStrike = chain.get(`${snapshot.expiryDate}|${strike.strike}`);
      if (!chainStrike) return strike;
      const callOpenInterest = strike.callOpenInterest ?? chainStrike.callOpenInterest;
      const putOpenInterest = strike.putOpenInterest ?? chainStrike.putOpenInterest;
      fromChain = fromChain || (strike.callOpenInterest == null && chainStrike.callOpenInterest != null) || (strike.putOpenInterest == null && chainStrike.putOpenInterest != null);
      return { ...strike, callOpenInterest, putOpenInterest };
    });
    const hasOi = strikes.some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null);
    return { ...snapshot, strikes, sourceStatus: hasOi ? snapshot.sourceStatus : 'WARNING', oiAsOfDate: snapshot.oiAsOfDate ?? allExpiry.find((item) => item.expiryDate === snapshot.expiryDate)?.oiAsOfDate ?? null, oiSource: hasOi ? fromChain ? 'mixed' : snapshot.oiSource ?? 'vol2vol' : 'missing' };
  });
}
