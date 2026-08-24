import type { WallSegment } from './types';

export type WallExpiryState = 'expired' | 'unexpired' | 'mixed' | 'unknown';

export function expiryEndTime(expiryDate: string): number {
  return Date.parse(`${expiryDate}T23:59:59.999Z`);
}

export function isExpiryDateExpired(expiryDate: string, referenceTime: number): boolean {
  const expiryTime = expiryEndTime(expiryDate);
  return Number.isFinite(expiryTime) && expiryTime < referenceTime;
}

export function wallExpiryEndTime(wall: WallSegment): number | null {
  const expiryTimes = wall.expiryDates
    .map(expiryEndTime)
    .filter((value) => Number.isFinite(value));
  return expiryTimes.length > 0 ? Math.max(...expiryTimes) : null;
}

export function wallExpiryState(wall: WallSegment, referenceTime: number): WallExpiryState {
  if (wall.expiryDates.length === 0) return 'unknown';
  const expiryStates = wall.expiryDates.map((expiryDate) => isExpiryDateExpired(expiryDate, referenceTime));
  if (expiryStates.every(Boolean)) return 'expired';
  if (expiryStates.every((expired) => !expired)) return 'unexpired';
  return 'mixed';
}

export function isWallExpired(wall: WallSegment, referenceTime: number): boolean {
  return wallExpiryState(wall, referenceTime) === 'expired';
}
