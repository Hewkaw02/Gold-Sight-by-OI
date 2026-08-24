import { useMemo } from 'react';
import type { ExpiryScope, WallMode, WallSegment } from '../domain/types';
import { isExpiryDateExpired, wallExpiryState } from '../domain/wall-status';

interface SeriesDetailsProps {
  walls: WallSegment[];
  wallMode: WallMode;
  expiryScope: ExpiryScope;
  displayTimezone: string;
  referenceTime: number;
}

interface ExpiryRow {
  expiryDate: string;
  targetDtes: number[];
  wallCount: number;
  strikeCount: number;
  firstObserved: string;
  lastObserved: string;
  expired: boolean;
}

const MAX_WALL_ROWS = 100;

function formatDate(value: string, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(new Date(value));
}

function formatDateTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatOi(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function wallOi(wall: WallSegment, wallMode: WallMode) {
  if (wallMode === 'call') return wall.callOi;
  if (wallMode === 'put') return wall.putOi;
  return wall.totalOi;
}

function formatDominance(value: number) {
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%`;
}

function expiryLabel(expiryDate: string, referenceTime: number) {
  return isExpiryDateExpired(expiryDate, referenceTime) ? 'Expired' : 'Unexpired';
}

export default function SeriesDetails({ walls, wallMode, expiryScope, displayTimezone, referenceTime }: SeriesDetailsProps) {
  const expiryRows = useMemo<ExpiryRow[]>(() => {
    const byExpiry = new Map<string, { targetDtes: Set<number>; strikes: Set<number>; wallCount: number; firstObserved: string; lastObserved: string }>();
    for (const wall of walls) {
      for (const expiryDate of wall.expiryDates) {
        const current = byExpiry.get(expiryDate) ?? {
          targetDtes: new Set<number>(),
          strikes: new Set<number>(),
          wallCount: 0,
          firstObserved: wall.from,
          lastObserved: wall.to,
        };
        wall.targetDtes.forEach((dte) => current.targetDtes.add(dte));
        current.strikes.add(wall.strike);
        current.wallCount += 1;
        if (wall.from < current.firstObserved) current.firstObserved = wall.from;
        if (wall.to > current.lastObserved) current.lastObserved = wall.to;
        byExpiry.set(expiryDate, current);
      }
    }
    return [...byExpiry.entries()]
      .map(([expiryDate, value]) => ({
        expiryDate,
        targetDtes: [...value.targetDtes].sort((a, b) => a - b),
        wallCount: value.wallCount,
        strikeCount: value.strikes.size,
        firstObserved: value.firstObserved,
        lastObserved: value.lastObserved,
        expired: isExpiryDateExpired(expiryDate, referenceTime),
      }))
      .sort((a, b) => Number(a.expired) - Number(b.expired) || a.expiryDate.localeCompare(b.expiryDate));
  }, [referenceTime, walls]);

  const wallRows = useMemo(
    () => [...walls].sort((a, b) => wallOi(b, wallMode) - wallOi(a, wallMode) || a.strike - b.strike).slice(0, MAX_WALL_ROWS),
    [wallMode, walls],
  );
  const unexpiredCount = expiryRows.filter((row) => !row.expired).length;
  const expiredCount = expiryRows.length - unexpiredCount;
  const unexpiredWallCount = walls.filter((wall) => wallExpiryState(wall, referenceTime) === 'unexpired').length;
  const mixedWallCount = walls.filter((wall) => wallExpiryState(wall, referenceTime) === 'mixed').length;
  const expiredWallCount = walls.filter((wall) => wallExpiryState(wall, referenceTime) === 'expired').length;

  return (
    <section className="details-panel" aria-label="Series details">
      <div className="details-header">
        <div>
          <span className="control-label">Series details</span>
          <h2>OI series and expiry status</h2>
          <p>รายการด้านล่างใช้ชุด wall เดียวกับกราฟและตัวกรองเดียวกัน · reference {new Date(referenceTime).toLocaleString()}</p>
        </div>
        <div className="details-summary">
          <div><strong>{walls.length}</strong><small>wall segments</small></div>
          <div><strong>{unexpiredWallCount}</strong><small>unexpired walls</small></div>
          <div><strong>{expiredWallCount}</strong><small>expired walls</small></div>
          <div><strong>{mixedWallCount}</strong><small>mixed expiry walls</small></div>
        </div>
      </div>

      <div className="details-section">
        <div className="details-section-header">
          <div><strong>Contract / expiry series</strong><small>{expiryScope === 'front' ? 'Front equivalent target-DTE coverage' : 'All listed expiries'}</small></div>
          <span className="details-count">{unexpiredCount} unexpired · {expiredCount} expired</span>
        </div>
        {expiryRows.length === 0 ? (
          <div className="details-empty">No expiry series match the current filters.</div>
        ) : (
          <div className="details-table-wrap">
            <table className="details-table">
              <thead>
                <tr>
                  <th>Series / expiry</th>
                  <th>Status</th>
                  <th>DTE coverage</th>
                  <th>Wall segments</th>
                  <th>Strike levels</th>
                  <th>Observed period</th>
                </tr>
              </thead>
              <tbody>
                {expiryRows.map((row) => (
                  <tr key={row.expiryDate}>
                    <td><strong>GC · {formatDate(row.expiryDate, 'UTC')}</strong><small>{row.expiryDate}</small></td>
                    <td><span className={`expiry-badge ${row.expired ? 'expired' : 'unexpired'}`}>{expiryLabel(row.expiryDate, referenceTime)}</span></td>
                    <td>{row.targetDtes.length > 0 ? row.targetDtes.map((dte) => `${dte}D`).join(' · ') : '—'}</td>
                    <td>{row.wallCount.toLocaleString()}</td>
                    <td>{row.strikeCount.toLocaleString()}</td>
                    <td><small>{formatDate(row.firstObserved, displayTimezone)} → {formatDate(row.lastObserved, displayTimezone)}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="details-section">
        <div className="details-section-header">
          <div><strong>Wall segments shown in chart</strong><small>เรียงจาก OI สูงสุดตาม Wall mode ปัจจุบัน</small></div>
          <span className="details-count">Top {Math.min(MAX_WALL_ROWS, walls.length)} / {walls.length}</span>
        </div>
        {wallRows.length === 0 ? (
          <div className="details-empty">No wall segments match the current filters.</div>
        ) : (
          <div className="details-table-wrap">
            <table className="details-table wall-details-table">
              <thead>
                <tr>
                  <th>Expiry status</th>
                  <th>Strike</th>
                  <th>OI</th>
                  <th>Call</th>
                  <th>Put</th>
                  <th>Dominance</th>
                  <th>DTE tags</th>
                  <th>Expiry dates</th>
                  <th>Chart period</th>
                  <th>Lifecycle</th>
                </tr>
              </thead>
              <tbody>
                {wallRows.map((wall) => {
                  const expiryState = wallExpiryState(wall, referenceTime);
                  const expiryText = expiryState === 'unexpired'
                    ? 'Unexpired'
                    : expiryState === 'expired'
                      ? 'Expired'
                      : expiryState === 'mixed'
                        ? 'Mixed'
                        : 'Unknown';
                  return (
                    <tr key={`${wall.from}-${wall.strike}-${wall.expiryDates.join('|')}`}>
                      <td><span className={`expiry-badge ${expiryState}`}>{expiryText}</span></td>
                      <td><strong>${wall.strike.toLocaleString()}</strong></td>
                      <td>{formatOi(wallOi(wall, wallMode))}</td>
                      <td>{formatOi(wall.callOi)}</td>
                      <td>{formatOi(wall.putOi)}</td>
                      <td className={wall.dominance > 0.15 ? 'dominance-call' : wall.dominance < -0.15 ? 'dominance-put' : ''}>{formatDominance(wall.dominance)}</td>
                      <td>{wall.targetDtes.map((dte) => `${dte}D`).join(' · ') || '—'}</td>
                      <td><small>{wall.expiryDates.join(' · ') || '—'}</small></td>
                      <td><small>{formatDateTime(wall.from, displayTimezone)} → {formatDateTime(wall.to, displayTimezone)}</small></td>
                      <td><span className={`lifecycle-badge ${wall.status}`}>{wall.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
