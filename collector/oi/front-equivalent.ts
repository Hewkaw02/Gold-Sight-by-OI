import type { OISnapshot } from '../../src/domain/types.js';
import { FRONT_CORE_DTES, FRONT_TARGET_DTES } from '../../src/domain/front-equivalent.js';

function snapshotKey(snapshot: OISnapshot): string {
  return `${snapshot.tradeDate}|${snapshot.expiryDate}`;
}

function targetForActualDte(actualDte: number, targetDtes: number[]): number | null {
  const calendarDte = Math.max(0, Math.round(actualDte));
  return targetDtes.find((targetDte) => targetDte >= calendarDte) ?? null;
}

const FRONT_STRIKE_MIN_FACTOR = 0.65;
const FRONT_STRIKE_MAX_FACTOR = 1.35;

function nearMarketStrikes(snapshot: OISnapshot) {
  if (!Number.isFinite(snapshot.futurePrice) || snapshot.futurePrice <= 0) return snapshot.strikes;
  const minStrike = snapshot.futurePrice * FRONT_STRIKE_MIN_FACTOR;
  const maxStrike = snapshot.futurePrice * FRONT_STRIKE_MAX_FACTOR;
  return snapshot.strikes.filter((strike) => strike.strike >= minStrike && strike.strike <= maxStrike);
}

function hasOpenInterest(snapshot: OISnapshot) {
  return snapshot.strikes.some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null);
}

function normalizeQuality(snapshot: OISnapshot): OISnapshot {
  const hasOi = hasOpenInterest(snapshot);
  return {
    ...snapshot,
    actualDte: Math.max(0, Math.round(snapshot.actualDte)),
    sourceStatus: hasOi ? snapshot.sourceStatus : 'WARNING',
    oiSource: hasOi ? snapshot.oiSource ?? 'vol2vol' : 'missing',
  };
}

function snapshotQuality(snapshot: OISnapshot) {
  const oiRows = snapshot.strikes.filter((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null).length;
  const observedVolRows = snapshot.strikes.filter((strike) => strike.impliedVol != null || strike.settleVol != null).length;
  return oiRows * 10_000 + observedVolRows * 10 + snapshot.strikes.length;
}

export function dedupeOiSnapshots(snapshots: OISnapshot[]): OISnapshot[] {
  const byId = new Map<string, OISnapshot>();
  for (const input of snapshots) {
    const snapshot = normalizeQuality(input);
    const current = byId.get(snapshot.snapshotId);
    if (!current || snapshotQuality(snapshot) > snapshotQuality(current) || (snapshotQuality(snapshot) === snapshotQuality(current) && snapshot.fetchedAt > current.fetchedAt)) {
      byId.set(snapshot.snapshotId, snapshot);
    }
  }
  return [...byId.values()].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.expiryDate.localeCompare(b.expiryDate));
}

/**
 * Add verified chain snapshots beyond the native 7/15/30D Vol2Vol layer.
 * Existing front snapshots win for the same trade date + expiry, so this
 * cannot double-count an expiry when live Vol2Vol already supplied it.
 */
export function extendFrontEquivalent(
  frontSnapshots: OISnapshot[],
  allExpirySnapshots: OISnapshot[],
  targetDtes: readonly number[] = FRONT_TARGET_DTES,
): OISnapshot[] {
  const sortedTargetDtes = [...new Set(targetDtes)]
    .filter((targetDte) => Number.isInteger(targetDte) && targetDte > 0)
    .sort((a, b) => a - b);
  const maxTargetDte = sortedTargetDtes.at(-1);
  const nativeCutoff = Math.max(...FRONT_CORE_DTES);
  if (maxTargetDte == null || maxTargetDte <= nativeCutoff) return frontSnapshots;

  const retainedFront = dedupeOiSnapshots(frontSnapshots).map((snapshot) => snapshot.targetDte > nativeCutoff
    ? { ...snapshot, strikes: nearMarketStrikes(snapshot) }
    : snapshot);
  const existing = new Set(retainedFront.map(snapshotKey));
  const supplements = allExpirySnapshots.flatMap((snapshot) => {
    const actualDte = Math.max(0, Math.round(snapshot.actualDte));
    if (actualDte <= nativeCutoff || actualDte > maxTargetDte) return [];
    if (existing.has(snapshotKey(snapshot))) return [];
    const targetDte = targetForActualDte(actualDte, sortedTargetDtes);
    if (targetDte == null || targetDte <= nativeCutoff) return [];
    const strikes = nearMarketStrikes(snapshot);
    if (!strikes.some((strike) => strike.callOpenInterest != null || strike.putOpenInterest != null)) return [];
    existing.add(snapshotKey(snapshot));
    return [{
      ...snapshot,
      snapshotId: `${snapshot.symbol}-${snapshot.tradeDate}-${snapshot.sessionSlot}-${targetDte}-${snapshot.expiryDate}`,
      targetDte,
      actualDte,
      strikes,
    }];
  });

  return dedupeOiSnapshots([...retainedFront, ...supplements]);
}
