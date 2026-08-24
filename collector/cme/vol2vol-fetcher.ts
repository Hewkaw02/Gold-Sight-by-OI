import type { OISnapshot, SessionSlot } from '../../src/domain/types.js';
import { normalizeSnapshot } from '../oi/oi-wall-engine.js';
import { CME_VOL2VOL_URL } from './cme-browser.js';

const VOL2VOL_PRODUCT = { pid: '40', pf: '6' };

interface ExpiryCandidate {
  expiryDate: string;
  actualDte: number;
  label: string;
  eventTarget: string;
}

interface ViewCapture {
  name: string;
  settings: Record<string, any>;
  capturedAt: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function numeric(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function calendarDte(tradeDate: string, expiryDate: string): number {
  const start = Date.parse(`${tradeDate}T00:00:00Z`);
  const end = Date.parse(`${expiryDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function buildToolUrl(session?: { insid: string; qsid: string }): string {
  const params = new URLSearchParams({ viewitemid: 'IntegratedV2VExpectedRange', ...VOL2VOL_PRODUCT });
  if (session) {
    params.set('insid', session.insid);
    params.set('qsid', session.qsid);
  }
  return `https://cmegroup-tools.quikstrike.net/User/QuikStrikeView.aspx?${params.toString()}`;
}

async function discoverSession(page: any): Promise<{ insid: string; qsid: string } | undefined> {
  for (const frame of page.frames?.() ?? []) {
    const url = String(frame.url?.() ?? '');
    if (!url.includes('QuikStrikeView.aspx')) continue;
    const parsed = new URL(url);
    const insid = parsed.searchParams.get('insid');
    const qsid = parsed.searchParams.get('qsid');
    if (insid && qsid) return { insid, qsid };
  }
  return undefined;
}

async function discoverExpiries(page: any, tradeDate: string): Promise<ExpiryCandidate[]> {
  const raw = await page.evaluate(() => {
    const doc = (globalThis as any).document as any;
    return Array.from(doc.querySelectorAll('#ctl00_ucSelector_pnlExpirations a') as any[]).map((element: any) => {
    const href = element.getAttribute('href') ?? '';
    return {
      label: (element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim(),
      eventTarget: href.match(/__doPostBack\('([^']+)'/)?.[1] ?? '',
    };
    });
  });
  const seen = new Set<string>();
  return raw.flatMap((item: { label: string; eventTarget: string }) => {
    const match = item.label.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!match || !item.eventTarget) return [];
    const expiryDate = `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    if (seen.has(expiryDate)) return [];
    seen.add(expiryDate);
    return [{ expiryDate, actualDte: calendarDte(tradeDate, expiryDate), label: item.label, eventTarget: item.eventTarget }];
  });
}

async function postback(page: any, eventTarget: string): Promise<void> {
  await Promise.all([
    page.waitForNavigation?.({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined),
    page.evaluate((target: string) => {
      const doc = (globalThis as any).document as any;
      const form = (doc.forms as any).Form1 || doc.forms[0];
      if (!form) throw new Error('QuikStrike postback form is missing');
      let eventInput = form.elements.__EVENTTARGET as any;
      if (!eventInput) {
        eventInput = doc.createElement('input');
        eventInput.type = 'hidden';
        eventInput.name = '__EVENTTARGET';
        form.appendChild(eventInput);
      }
      eventInput.value = target;
      form.submit();
    }, eventTarget),
  ]);
  await sleep(5_000);
}

async function extractSettings(page: any): Promise<Record<string, any>> {
  const html = typeof page.content === 'function'
    ? await page.content()
    : await page.evaluate(() => (globalThis as any).document.documentElement.outerHTML);
  const match = String(html).match(/"JSONSettings"\s*:\s*"({[\s\S]*?})"\s*}/);
  if (!match) throw new Error('Vol2Vol JSONSettings script block not found');
  return JSON.parse(match[1].replaceAll('\\"', '"').replaceAll('\\\\', '\\'));
}

function series(settings: Record<string, any>, key: string): any[] {
  return Array.isArray(settings[key]?.data) ? settings[key].data : [];
}

function valuesByStrike(settings: Record<string, any>, keys: string[]): Map<number, number> {
  const values = new Map<number, number>();
  for (const key of keys) {
    for (const item of series(settings, key)) {
      const strike = numeric(item.x ?? item.Strike ?? item.strike);
      const value = numeric(item.y ?? item.Value ?? item.value);
      if (strike != null && value != null) values.set(strike, value);
    }
  }
  return values;
}

function isOpenInterestView(name: string): boolean {
  return /open\s*interest|\boi\b/i.test(name);
}

function parseView(view: ViewCapture): Array<any> {
  const settings = view.settings;
  const call = valuesByStrike(settings, ['Call', 'CallVolume']);
  const put = valuesByStrike(settings, ['Put', 'PutVolume']);
  const callOi = valuesByStrike(settings, ['CallOI', 'CallOpenInterest']);
  const putOi = valuesByStrike(settings, ['PutOI', 'PutOpenInterest']);
  const impliedVol = valuesByStrike(settings, ['Vol', 'ImpliedVol']);
  const settleVol = valuesByStrike(settings, ['VolSettle', 'SettlementVol']);
  const strikes = new Set<number>([
    ...call.keys(), ...put.keys(), ...callOi.keys(), ...putOi.keys(), ...impliedVol.keys(), ...settleVol.keys(),
  ]);
  const oiView = isOpenInterestView(view.name);
  return [...strikes].sort((a, b) => a - b).map((strike) => ({
    viewName: view.name,
    strike,
    callVolume: oiView ? null : call.get(strike) ?? null,
    putVolume: oiView ? null : put.get(strike) ?? null,
    callOpenInterest: callOi.get(strike) ?? (oiView ? call.get(strike) ?? null : null),
    putOpenInterest: putOi.get(strike) ?? (oiView ? put.get(strike) ?? null : null),
    impliedVol: impliedVol.get(strike) ?? null,
    settleVol: settleVol.get(strike) ?? null,
    extra: {},
  }));
}

async function discoverViewPostbacks(page: any): Promise<Array<{ name: string; eventTarget: string }>> {
  const options = await page.evaluate(() => {
    const doc = (globalThis as any).document as any;
    return Array.from(doc.querySelectorAll('a') as any[]).flatMap((element: any) => {
      if (element.closest('#ctl00_ucSelector_pnlExpirations')) return [];
      const name = (element.textContent || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      const allowed = new Set(['intraday', 'intraday volume', 'volume', 'open interest', 'settlement', 'settlement volume', 'settle']);
      if (!allowed.has(name.toLowerCase())) return [];
      const href = element.getAttribute('href') ?? '';
      const eventTarget = href.match(/__doPostBack\('([^']+)'/)?.[1] ?? '';
      return eventTarget ? [{ name, eventTarget }] : [];
    });
  });
  const seen = new Set<string>();
  return rawFilter(options as Array<{ name: string; eventTarget: string }>, (option: { eventTarget: string }) => {
    if (seen.has(option.eventTarget)) return false;
    seen.add(option.eventTarget);
    return true;
  }).slice(0, 8);
}

function rawFilter<T>(values: T[], predicate: (value: T) => boolean): T[] {
  return Array.isArray(values) ? values.filter(predicate) : [];
}

async function captureViews(page: any): Promise<ViewCapture[]> {
  const views: ViewCapture[] = [{ name: 'default', settings: await extractSettings(page), capturedAt: new Date().toISOString() }];
  for (const view of await discoverViewPostbacks(page)) {
    try {
      await postback(page, view.eventTarget);
      views.push({ name: view.name, settings: await extractSettings(page), capturedAt: new Date().toISOString() });
    } catch {
      // Optional views are best-effort; the default Vol2Vol view remains usable.
    }
  }
  return views;
}

async function openVol2Vol(page: any): Promise<void> {
  await page.goto(CME_VOL2VOL_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(5_000);
  const session = await discoverSession(page);
  await page.goto(buildToolUrl(session), { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(8_000);
}

export async function fetchVol2VolSnapshots(
  page: any,
  tradeDate: string,
  sessionSlot: SessionSlot,
  targetDtes: number[],
): Promise<OISnapshot[]> {
  await openVol2Vol(page);
  const candidates = await discoverExpiries(page, tradeDate);
  const maxDte = Math.max(...targetDtes, 30);
  const selected = candidates.filter((candidate) => candidate.actualDte <= maxDte);
  const grouped = new Map<string, ExpiryCandidate[]>();
  for (const candidate of selected) {
    const list = grouped.get(candidate.eventTarget) ?? [];
    list.push(candidate);
    grouped.set(candidate.eventTarget, list);
  }
  const snapshots: OISnapshot[] = [];
  for (const entries of grouped.values()) {
    const candidate = entries[0];
    try {
      await postback(page, candidate.eventTarget);
      const views = await captureViews(page);
      const primary = views[0]?.settings ?? {};
      const futurePrice = numeric(primary.FuturePrice);
      // Store calendar DTE as an integer. QuikStrike's live DTE includes a
      // fractional intraday remainder, which can incorrectly push 30.00xD
      // contracts into the 60D bucket.
      const actualDte = candidate.actualDte;
      if (futurePrice == null || futurePrice <= 0) continue;
      const strikes = views.flatMap(parseView);
      for (const entry of entries) {
        const targetDte = targetDtes.find((target) => target >= entry.actualDte) ?? Math.max(...targetDtes, entry.actualDte);
        snapshots.push(normalizeSnapshot({
          schemaVersion: 1,
          symbol: 'GC',
          tradeDate,
          sessionSlot,
          targetDte,
          actualDte,
          expiryDate: entry.expiryDate,
          futurePrice,
          sourceStatus: 'VALID',
          sourceAsOf: null,
          selectedViews: views.map((view) => view.name),
          capturedAt: views.at(-1)?.capturedAt,
          strikes,
        }, null));
      }
    } catch {
      // A single expiry failure must not invalidate other discovered expiries.
    }
  }
  return snapshots;
}
