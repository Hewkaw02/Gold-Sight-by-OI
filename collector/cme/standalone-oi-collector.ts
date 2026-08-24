import type { OISnapshot, SessionSlot } from '../../src/domain/types.js';
import { ensureCmeAuthenticated, openCmeBrowser } from './cme-browser.js';
import { fetchAllExpiryOptions, mergeFrontOi } from './cme-options-fetcher.js';
import { fetchVol2VolSnapshots } from './vol2vol-fetcher.js';

export interface StandaloneOiFetchOptions {
  tradeDate: string;
  sessionSlots: SessionSlot[];
  targetDtes: number[];
  fallbackFuturePrice: number;
}

export interface StandaloneOiFetchResult {
  frontSnapshots: OISnapshot[];
  allExpirySnapshots: OISnapshot[];
}

export async function fetchStandaloneOi(options: StandaloneOiFetchOptions): Promise<StandaloneOiFetchResult> {
  const session = await openCmeBrowser();
  try {
    await ensureCmeAuthenticated(session);
    const allExpirySnapshots = await fetchAllExpiryOptions(
      session.page,
      options.tradeDate,
      options.sessionSlots.at(-1) ?? 'close',
      options.fallbackFuturePrice,
    );
    const frontSnapshots: OISnapshot[] = [];
    for (const sessionSlot of options.sessionSlots) {
      frontSnapshots.push(...await fetchVol2VolSnapshots(session.page, options.tradeDate, sessionSlot, options.targetDtes));
    }
    return {
      frontSnapshots: mergeFrontOi(frontSnapshots, allExpirySnapshots),
      allExpirySnapshots,
    };
  } finally {
    await session.close();
  }
}

