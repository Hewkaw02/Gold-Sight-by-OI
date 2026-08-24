import type { DashboardHealth } from '../domain/types';

interface StatusBannerProps {
  health: DashboardHealth;
}

export default function StatusBanner({ health }: StatusBannerProps) {
  const authMessage = health.auth.state === 'challenge'
    ? 'CME login challenge ต้องทำต่อบน self-hosted runner'
    : health.auth.state === 'reauth_required'
      ? 'CME session หมดอายุ กำลังรอ re-authentication'
      : health.auth.message;

  const messages = [health.price.message, health.oi.message, authMessage]
    .filter((message, index, values): message is string => Boolean(message) && values.indexOf(message) === index);
  const stateLabel = health.state === 'ok'
    ? 'LIVE / FRESH'
    : health.state === 'partial'
      ? 'PARTIAL'
      : health.state === 'stale'
        ? 'STALE'
        : 'ERROR';

  return (
    <div className={`status-banner status-${health.state}`} role="status">
      <span className="status-dot" />
      <strong>{stateLabel}</strong>
      <span>{messages.length > 0 ? messages.join(' · ') : `ข้อมูลล่าสุด ${health.lastSuccessAt ?? 'ไม่ทราบเวลา'}`}</span>
      {health.price.state === 'stale' && <span className="status-chip">PRICE STALE</span>}
      {health.oi.state === 'stale' && <span className="status-chip">OI STALE</span>}
      {health.auth.state === 'challenge' && <span className="status-chip">AUTH CHALLENGE</span>}
      {health.auth.state === 'reauth_required' && <span className="status-chip">CME REAUTH REQUIRED</span>}
      {health.auth.state === 'failed' && <span className="status-chip">CME AUTH FAILED</span>}
    </div>
  );
}
