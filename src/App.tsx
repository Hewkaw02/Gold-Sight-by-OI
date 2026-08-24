import { useEffect, useMemo, useState } from 'react';
import type { DataManifest, DashboardHealth, DominanceFilter, ExpiryScope, PriceChartMode, PriceTimeframe, WallMode, WallSegment } from './domain/types';
import { FRONT_TARGET_DTES } from './domain/front-equivalent';
import { wallExpiryState } from './domain/wall-status';
import { loadDashboardData } from './data/loaders';
import OIWallChart from './components/OIWallChart';
import SeriesDetails from './components/SeriesDetails';
import StatusBanner from './components/StatusBanner';

const EMPTY_HEALTH: DashboardHealth = {
  state: 'error',
  generatedAt: new Date(0).toISOString(),
  lastSuccessAt: null,
  lastAttemptAt: null,
  stale: true,
  partial: false,
  auth: { state: 'unknown', checkedAt: null, message: null },
  price: { state: 'error', lastSuccessAt: null, message: 'กำลังโหลดข้อมูล' },
  oi: { state: 'error', lastSuccessAt: null, message: 'กำลังโหลดข้อมูล' },
  notes: [],
};

const DOMINANCE_FILTERS: Array<[DominanceFilter, string]> = [
  ['all', 'All'],
  ['call', 'Call-led'],
  ['put', 'Put-led'],
  ['balanced', 'Balanced'],
];
const MAX_WALL_STRENGTH = 20;
const MIN_OI_FILTER = 1_000;
const MAX_OI_FILTER = 10_000;
const OI_FILTER_STEP = 500;
const OI_FILTER_TICKS = [1_000, 2_500, 5_000, 7_500, 10_000];
type DashboardView = 'chart' | 'details';
type ProjectionHorizonDays = 30 | 60 | 90;

function wallOiForFilter(wall: Pick<WallSegment, 'callOi' | 'putOi' | 'totalOi'>, wallMode: WallMode) {
  if (wallMode === 'call') return wall.callOi;
  if (wallMode === 'put') return wall.putOi;
  return wall.totalOi;
}

function formatOiLabel(value: number) {
  return value >= 1_000 ? `${value / 1_000}K` : value.toLocaleString();
}

function formatExposure(value: number) {
  const absolute = Math.abs(value);
  const suffix = absolute >= 1_000_000_000 ? 'B' : absolute >= 1_000_000 ? 'M' : absolute >= 1_000 ? 'K' : '';
  const divisor = suffix === 'B' ? 1_000_000_000 : suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : 1;
  return `${value < 0 ? '-' : ''}${(absolute / divisor).toFixed(absolute >= 1_000 ? 1 : 0)}${suffix}`;
}

function formatPredictionPercent(value: number) {
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%`;
}

export default function App() {
  const [timeframe, setTimeframe] = useState<PriceTimeframe>('1D');
  const [priceMode, setPriceMode] = useState<PriceChartMode>('close');
  const [wallMode, setWallMode] = useState<WallMode>('combined');
  const [expiryScope, setExpiryScope] = useState<ExpiryScope>('front');
  const [timezone, setTimezone] = useState('Asia/Bangkok');
  const [showProjection, setShowProjection] = useState(true);
  const [projectionHorizonDays, setProjectionHorizonDays] = useState<ProjectionHorizonDays>(90);
  const [showForecastRange, setShowForecastRange] = useState(false);
  const [showDominanceProjection, setShowDominanceProjection] = useState(true);
  const [dashboardView, setDashboardView] = useState<DashboardView>('chart');
  const [minWallStrength, setMinWallStrength] = useState(1);
  const [minWallOi, setMinWallOi] = useState(MIN_OI_FILTER);
  const [dominanceFilter, setDominanceFilter] = useState<DominanceFilter>('all');
  const [showExpiredWalls, setShowExpiredWalls] = useState(false);
  const [showMixedExpiryWalls, setShowMixedExpiryWalls] = useState(false);
  const [frontDtes, setFrontDtes] = useState<number[]>([...FRONT_TARGET_DTES]);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadDashboardData>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const next = await loadDashboardData(timeframe);
        if (!cancelled) { setData(next); setError(null); }
      } catch (reason: unknown) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        running = false;
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, 5 * 60 * 1000);
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [timeframe]);

  const manifest: DataManifest | null = data?.manifest ?? null;
  const health = useMemo(() => {
    const base = manifest?.health ?? EMPTY_HEALTH;
    if (!data || !manifest) return base;
    const now = Date.now();
    const latestClosed = data.price
      .filter((bar) => bar.isClosed)
      .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))
      .at(-1);
    const maxPriceAgeHours = timeframe === '1D' ? 72 : 12;
    const priceAgeHours = latestClosed ? (now - Date.parse(latestClosed.closeTime)) / 3_600_000 : Number.POSITIVE_INFINITY;
    const priceStale = !Number.isFinite(priceAgeHours) || priceAgeHours > maxPriceAgeHours;
    const oiEnd = manifest.coverage.oi.end;
    let oiBusinessDayLag = 0;
    if (oiEnd) {
      const cursor = new Date(`${oiEnd}T00:00:00.000Z`);
      const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      while (cursor < today) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) oiBusinessDayLag += 1;
      }
    }
    const oiStale = !oiEnd || oiBusinessDayLag > 2;
    if (!priceStale && !oiStale) return base;
    const price = priceStale
      ? { ...base.price, state: 'stale' as const, message: `${base.price.message ?? 'Price data'} · ${Number.isFinite(priceAgeHours) ? priceAgeHours.toFixed(1) : 'n/a'}h old` }
      : base.price;
    const oi = oiStale
      ? { ...base.oi, state: 'stale' as const, message: base.oi.message?.includes('business-day lag') ? base.oi.message : `${base.oi.message ?? 'OI data'} · ${oiBusinessDayLag} business-day lag` }
      : base.oi;
    return { ...base, state: 'partial' as const, stale: true, partial: true, price, oi };
  }, [data, manifest, timeframe]);
  const selectedWalls = expiryScope === 'all' ? data?.allExpiryWalls ?? [] : data?.walls ?? [];
  const wallReferenceTime = useMemo(() => {
    const latestPriceTime = (data?.price ?? []).reduce((latest, bar) => {
      const time = Date.parse(bar.time);
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, 0);
    return Math.max(latestPriceTime, Date.now());
  }, [data]);
  const filteredWalls = useMemo(() => selectedWalls.filter((wall) => {
    const expiryState = wallExpiryState(wall, wallReferenceTime);
    if (!showExpiredWalls && expiryState === 'expired') return false;
    if (!showMixedExpiryWalls && expiryState === 'mixed') return false;
    if (wallOiForFilter(wall, wallMode) < minWallOi) return false;
    if (wallMode === 'call' && wall.callOi <= 0) return false;
    if (wallMode === 'put' && wall.putOi <= 0) return false;
    if (wall.significanceScore < minWallStrength) return false;
    if (dominanceFilter === 'call' && wall.dominance < 0.15) return false;
    if (dominanceFilter === 'put' && wall.dominance > -0.15) return false;
    if (dominanceFilter === 'balanced' && (wall.dominance < -0.15 || wall.dominance > 0.15)) return false;
    if (expiryScope === 'front' && frontDtes.length < FRONT_TARGET_DTES.length && !frontDtes.some((dte) => wall.targetDtes.includes(dte))) return false;
    return true;
  }), [dominanceFilter, expiryScope, frontDtes, minWallOi, minWallStrength, selectedWalls, showExpiredWalls, showMixedExpiryWalls, wallMode, wallReferenceTime]);
  const resetWallFilters = () => {
    setMinWallStrength(1);
    setMinWallOi(MIN_OI_FILTER);
    setDominanceFilter('all');
    setShowExpiredWalls(false);
    setShowMixedExpiryWalls(false);
    setFrontDtes([...FRONT_TARGET_DTES]);
  };
  const toggleFrontDte = (dte: number) => {
    setFrontDtes((current) => {
      const next = current.length === FRONT_TARGET_DTES.length
        ? [dte]
        : current.includes(dte)
          ? current.filter((value) => value !== dte)
          : [...current, dte].sort((a, b) => a - b);
      return next.length > 0 ? next : [...FRONT_TARGET_DTES];
    });
  };
  const title = manifest?.symbol === 'GC' ? 'Gold Sight by OI' : 'Time-Price OI Liquidity Map';
  const coverageLabel = useMemo(() => {
    if (!manifest) return 'กำลังโหลด coverage';
    const dailyEnd = manifest.datasets.price_1d?.coverageEnd ?? manifest.coverage.price.end?.slice(0, 10) ?? '—';
    const intradayEnd = manifest.datasets.price_4h?.coverageEnd ?? manifest.coverage.price.end?.slice(0, 10) ?? '—';
    return 'closed 1D ' + dailyEnd + ' · 4H ' + intradayEnd;
  }, [manifest]);
  const latestBarLabel = useMemo(() => {
    const latest = (data?.price ?? []).reduce<{ time: number; closeTime: number; isClosed: boolean } | null>((current, bar) => {
      const time = Date.parse(bar.time);
      if (!Number.isFinite(time) || (current && time <= current.time)) return current;
      const closeTime = Date.parse(bar.closeTime || bar.time);
      return {
        time,
        closeTime: Number.isFinite(closeTime) ? closeTime : time,
        isClosed: bar.isClosed,
      };
    }, null);
    if (!latest) return 'Latest bar —';
    return `Latest ${latest.isClosed ? 'closed' : 'open'} ${timeframe} ${new Date(latest.closeTime).toISOString().slice(0, 10)}`;
  }, [data, timeframe]);
  const oiExpiryLabel = useMemo(() => {
    const start = manifest?.coverage.oiExpiry?.start ?? '—';
    const end = manifest?.coverage.oiExpiry?.end ?? '—';
    return `${start} → ${end}`;
  }, [manifest]);

  const chartWindowLabel = useMemo(() => {
    const latestAvailableTime = (data?.price ?? []).reduce((latest, bar) => {
      // Include the current open bar. Its closeTime identifies the current
      // trading date even though the bar has not completed yet.
      const closeTime = Date.parse(bar.closeTime || bar.time);
      return Number.isFinite(closeTime) ? Math.max(latest, closeTime) : latest;
    }, Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(latestAvailableTime)) return '— → —';
    const latestDate = new Date(latestAvailableTime);
    return `${latestDate.getUTCFullYear()}-06-01 → ${latestDate.toISOString().slice(0, 10)}`;
  }, [data]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <div className="eyebrow">SIGNIFICANT COMBINED OI WALLS · {expiryScope === 'all' ? 'ALL EXPIRIES' : 'FRONT-EQUIVALENT COMPOSITE'} · $5 BASIS GRID</div>
          <h1>{title}</h1>
          <p className="subtitle">Futures Price Line Chart + Options Open Interest Wall Overlay</p>
        </div>
        <div className="header-meta">
          <span className="instrument-pill">BLACKBULL:GOLD.F</span>
          <span className="coverage">Chart window {chartWindowLabel}</span>
          <span className="coverage">{latestBarLabel}</span>
          <span className="coverage">Data coverage {coverageLabel}</span>
          <span className="coverage">OI expiry {oiExpiryLabel}</span>
        </div>
      </header>

      <StatusBanner health={health} />

      <section className="control-bar" aria-label="Chart controls">
        <div className="control-group">
          <span className="control-label">Price</span>
          <div className="segmented">
            {(['1D', '4H'] as PriceTimeframe[]).map((item) => (
              <button key={item} className={timeframe === item ? 'active' : ''} onClick={() => setTimeframe(item)}>{item}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">Price basis</span>
          <div className="segmented">
            <button className={priceMode === 'close' ? 'active' : ''} onClick={() => setPriceMode('close')}>Normal</button>
            <button className={priceMode === 'mean' ? 'active' : ''} onClick={() => setPriceMode('mean')}>Mean</button>
          </div>
          <small className="control-help">Mean = OHLC4 · ไม่ใช่ moving average</small>
        </div>
        <div className="control-group">
          <span className="control-label">Projection</span>
          <div className="segmented">
            <button className={showProjection ? 'active' : ''} onClick={() => setShowProjection(true)}>On</button>
            <button className={!showProjection ? 'active' : ''} onClick={() => setShowProjection(false)}>Off</button>
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">Forecast horizon</span>
          <div className="segmented">
            {([30, 60, 90] as ProjectionHorizonDays[]).map((days) => (
              <button key={days} className={projectionHorizonDays === days ? 'active' : ''} onClick={() => setProjectionHorizonDays(days)}>{days}D</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">Confidence range</span>
          <div className="segmented">
            <button className={showForecastRange ? 'active' : ''} onClick={() => setShowForecastRange(true)}>On</button>
            <button className={!showForecastRange ? 'active' : ''} onClick={() => setShowForecastRange(false)}>Off</button>
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">Dominance outlook</span>
          <div className="segmented">
            <button className={showDominanceProjection ? 'active' : ''} onClick={() => setShowDominanceProjection(true)}>On</button>
            <button className={!showDominanceProjection ? 'active' : ''} onClick={() => setShowDominanceProjection(false)}>Off</button>
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">Wall mode</span>
          <div className="segmented wide">
            {([
              ['combined', 'Combined'],
              ['call', 'Call only'],
              ['put', 'Put only'],
              ['split', 'Split'],
            ] as Array<[WallMode, string]>).map(([value, label]) => (
              <button key={value} className={wallMode === value ? 'active' : ''} onClick={() => setWallMode(value)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">Expiry scope</span>
          <div className="segmented wide">
            {([
              ['front', 'Front equivalent'],
              ['all', 'All expiries'],
            ] as Array<[ExpiryScope, string]>).map(([value, label]) => (
              <button key={value} className={expiryScope === value ? 'active' : ''} onClick={() => setExpiryScope(value)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">View</span>
          <div className="segmented">
            <button className={dashboardView === 'chart' ? 'active' : ''} onClick={() => setDashboardView('chart')}>Chart</button>
            <button className={dashboardView === 'details' ? 'active' : ''} onClick={() => setDashboardView('details')}>Series details</button>
          </div>
        </div>
        <label className="control-group timezone-control">
          <span className="control-label">Timezone</span>
          <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
            <option value="Asia/Bangkok">Bangkok</option>
            <option value="America/Chicago">Chicago / CME</option>
            <option value="UTC">UTC</option>
          </select>
        </label>
      </section>

      <section className="filter-panel" aria-label="OI noise filters">
        <div className="filter-panel-header">
          <div>
            <span className="control-label">Noise filters</span>
            <p className="filter-description">
              {expiryScope === 'front'
                ? 'Front composite · native 7/15/30D plus verified 60/90D coverage; each wall OI remains the composite value.'
                : 'All expiry mode · use strength and dominance filters to reduce visual noise.'}
            </p>
          </div>
          <div className="filter-summary">
            <span><strong>{filteredWalls.length}</strong> / {selectedWalls.length} walls</span>
            <button className="reset-button" onClick={resetWallFilters}>Reset</button>
          </div>
        </div>
        <div className="filter-grid">
          <div className="filter-control">
            <span className="control-label">Minimum wall strength</span>
            <div className="range-row">
              <input
                className="range-input"
                type="range"
                min="1"
                max={MAX_WALL_STRENGTH}
                step="0.25"
                value={minWallStrength}
                aria-label="Minimum wall strength"
                aria-valuetext={minWallStrength <= 1 ? 'All significant walls' : `${minWallStrength.toFixed(2)} times threshold or stronger`}
                onChange={(event) => setMinWallStrength(Number(event.target.value))}
              />
              <span className="filter-value">{minWallStrength <= 1 ? 'All' : `≥ ${minWallStrength.toFixed(2)}×`}</span>
            </div>
            <small>ปรับขึ้นเพื่อซ่อน wall ที่อ่อนกว่าเกณฑ์รายวัน</small>
          </div>
          <div className="filter-control oi-slicer">
            <div className="slicer-heading">
              <span className="control-label">Minimum OI</span>
              <span className="filter-value">≥ {minWallOi.toLocaleString()}</span>
            </div>
            <div className="slicer-range">
              <span className="slicer-bound">1K</span>
              <input
                className="range-input"
                type="range"
                min={MIN_OI_FILTER}
                max={MAX_OI_FILTER}
                step={OI_FILTER_STEP}
                value={minWallOi}
                list="oi-filter-ticks"
                aria-label="Minimum open interest"
                aria-valuetext={`Show walls with ${wallMode === 'call' ? 'Call' : wallMode === 'put' ? 'Put' : 'total'} OI of ${minWallOi.toLocaleString()} or more`}
                onChange={(event) => setMinWallOi(Number(event.target.value))}
              />
              <span className="slicer-bound">10K</span>
              <datalist id="oi-filter-ticks">
                {OI_FILTER_TICKS.map((value) => <option key={value} value={value} label={formatOiLabel(value)} />)}
              </datalist>
            </div>
            <div className="slicer-ticks" aria-hidden="true">
              {OI_FILTER_TICKS.map((value) => <span key={value}>{formatOiLabel(value)}</span>)}
            </div>
            <small>{wallMode === 'call' ? 'Call OI' : wallMode === 'put' ? 'Put OI' : 'Total OI'} · ต่ำกว่าเกณฑ์จะไม่แสดงในกราฟ</small>
          </div>
          <div className="filter-control">
            <span className="control-label">Dominance filter</span>
            <div className="segmented wide">
              {DOMINANCE_FILTERS.map(([value, label]) => (
                <button key={value} className={dominanceFilter === value ? 'active' : ''} onClick={() => setDominanceFilter(value)}>{label}</button>
              ))}
            </div>
            <small>Call-led ≥ +15% · Put-led ≤ −15% · ที่เหลือคือ Balanced</small>
          </div>
          <div className="filter-control">
            <span className="control-label">Expired walls</span>
            <div className="segmented wide">
              <button className={!showExpiredWalls ? 'active' : ''} onClick={() => setShowExpiredWalls(false)}>Hide expired</button>
              <button className={showExpiredWalls ? 'active' : ''} onClick={() => setShowExpiredWalls(true)}>Show expired</button>
            </div>
            <small>ซ่อนเฉพาะ wall ที่ทุก expiry หมดอายุแล้ว</small>
          </div>
          <div className="filter-control">
            <span className="control-label">Mixed expiry walls</span>
            <div className="segmented wide">
              <button className={!showMixedExpiryWalls ? 'active' : ''} onClick={() => setShowMixedExpiryWalls(false)}>Hide mixed</button>
              <button className={showMixedExpiryWalls ? 'active' : ''} onClick={() => setShowMixedExpiryWalls(true)}>Show mixed</button>
            </div>
            <small>Hide composite walls containing both expired and unexpired expiries.</small>
          </div>
          {expiryScope === 'front' ? (
            <div className="filter-control">
              <span className="control-label">Front DTE coverage</span>
              <div className="segmented wide">
                <button className={frontDtes.length === FRONT_TARGET_DTES.length ? 'active' : ''} onClick={() => setFrontDtes([...FRONT_TARGET_DTES])}>All</button>
                {FRONT_TARGET_DTES.map((dte) => (
                  <button key={dte} className={frontDtes.includes(dte) && frontDtes.length < FRONT_TARGET_DTES.length ? 'active' : ''} onClick={() => toggleFrontDte(dte)}>{dte}D</button>
                ))}
              </div>
              <small>เลือกได้หลายค่า · ใช้กรอง wall ที่มี target DTE นี้อยู่ใน composite</small>
            </div>
          ) : null}
        </div>
      </section>

      {dashboardView === 'chart' ? (
        <section className="chart-card">
        {error ? (
          <div className="empty-state">
            <strong>ยังโหลดข้อมูลไม่ได้</strong>
            <span>{error}</span>
            <span>ตรวจสอบว่า public/data มี manifest และ dataset แล้ว</span>
          </div>
        ) : data ? (
          <OIWallChart
            price={data.price}
            walls={filteredWalls}
            rolls={data.rolls}
            timeframe={timeframe}
            priceMode={priceMode}
            wallMode={wallMode}
            displayTimezone={timezone}
            showProjection={showProjection}
            projectionHorizonDays={projectionHorizonDays}
            showForecastRange={showForecastRange}
            dominanceOutlook={data.dominanceOutlook}
            optionsPrediction={data.optionsPrediction}
            showDominanceProjection={showDominanceProjection}
          />
        ) : (
          <div className="empty-state"><strong>กำลังโหลด chart…</strong></div>
        )}
        </section>
      ) : error ? (
        <div className="details-panel"><div className="details-empty">{error}</div></div>
      ) : data ? (
        <SeriesDetails
          walls={filteredWalls}
          wallMode={wallMode}
          expiryScope={expiryScope}
          displayTimezone={timezone}
          referenceTime={wallReferenceTime}
        />
      ) : (
        <div className="details-panel"><div className="details-empty">Loading series details…</div></div>
      )}

      {dashboardView === 'chart' && data?.optionsPrediction ? (
        <section className="prediction-panel" aria-label="Options-aware prediction diagnostics">
          <div className="prediction-panel-header">
            <div>
              <span className="control-label">Processed prediction inputs</span>
              <h2>Options-aware forecast diagnostics</h2>
              <p>Black-76 on the active expiry inventory · 90D predictive horizon · expiry-specific Max Pain + Gamma + Vanna</p>
            </div>
            <span className="prediction-asof">OI as of {data.optionsPrediction.quality.latestOiDate ?? data.optionsPrediction.asOfDate}</span>
          </div>
          <div className="prediction-grid">
            <div className="prediction-card"><span>Scenario</span><strong>{data.optionsPrediction.scenario.label}</strong><small>score {formatPredictionPercent(data.optionsPrediction.scenario.score)} · weight {(data.optionsPrediction.scenario.weight * 100).toFixed(0)}%</small></div>
            <div className="prediction-card"><span>90D composite pain heuristic</span><strong>{data.optionsPrediction.maxPain.compositeStrike ? `$${data.optionsPrediction.maxPain.compositeStrike.toLocaleString()}` : 'n/a'}</strong><small>nearest-expiry Max Pain {data.optionsPrediction.maxPain.nearestStrike ? `$${data.optionsPrediction.maxPain.nearestStrike.toLocaleString()}` : 'n/a'}</small></div>
            <div className="prediction-card"><span>Gamma</span><strong>{data.optionsPrediction.gamma.regime}</strong><small>net {formatExposure(data.optionsPrediction.gamma.netExposure)} · flip {data.optionsPrediction.gamma.flipStrike?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? 'n/a'}</small></div>
            <div className="prediction-card"><span>Vanna</span><strong>{formatExposure(data.optionsPrediction.vanna.netExposure)}</strong><small>call {formatExposure(data.optionsPrediction.vanna.callExposure)} · put {formatExposure(data.optionsPrediction.vanna.putExposure)}</small></div>
            <div className="prediction-card"><span>Options target guide</span><strong>{data.optionsPrediction.scenario.targetPrice ? `$${data.optionsPrediction.scenario.targetPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'n/a'}</strong><small>heuristic, not a guaranteed price target</small></div>
            <div className="prediction-card"><span>Observed IV coverage</span><strong>{(data.optionsPrediction.quality.observedVolCoverage * 100).toFixed(0)}%</strong><small>{data.optionsPrediction.quality.activeExpiryCount} active expiries · {data.optionsPrediction.quality.strikeCount.toLocaleString()} OI rows</small></div>
          </div>
          {data.optionsPrediction.quality.warnings.length > 0 ? <p className="prediction-warning">{data.optionsPrediction.quality.warnings.join(' · ')}</p> : null}
        </section>
      ) : null}

      <section className="legend-grid">
        <div className="legend-card"><span className="legend-line price-line" /><div><strong>{priceMode === 'mean' ? 'Mean price (OHLC4)' : 'Futures close'}</strong><small>เส้นสีเหลือง · {priceMode === 'mean' ? 'ค่าเฉลี่ย Open/High/Low/Close ต่อจุด' : 'ราคาปิดจริงของแต่ละจุด'} · line chart ไม่มี OHLC candle</small></div></div>
        <div className="legend-card"><span className="legend-line call-line" /><div><strong>Call dominance</strong><small>สีเขียว · wall ยังไม่หมดอายุและ dominance เป็นบวก</small></div></div>
        <div className="legend-card"><span className="legend-line put-line" /><div><strong>Put dominance</strong><small>สีแดง · wall ยังไม่หมดอายุและ dominance เป็นลบ</small></div></div>
        <div className="legend-card"><span className="legend-line balanced-line" /><div><strong>Balanced Call / Put</strong><small>สีขาว · dominance ใกล้สมดุลภายใน ±15%</small></div></div>
        <div className="legend-card"><span className="legend-line high-oi-line" /><div><strong>High OI wall</strong><small>เส้นหนา · OI ตาม Wall mode ตั้งแต่ 10,000 ขึ้นไป</small></div></div>
        <div className="legend-card"><span className="legend-line roll-line" /><div><strong>Contract roll</strong><small>เส้นประแนวตั้งจาก expiry/roll metadata</small></div></div>
        <div className="legend-card"><span className="legend-line projection-line" /><div><strong>Projected price</strong><small>เส้นประสีส้ม · rolling-origin weighted ensemble guide ไม่ใช่ราคาจริง</small></div></div>
        <div className="legend-card"><span className="legend-line projection-band-line" /><div><strong>Forecast error band</strong><small>แถบสีส้มจาง · empirical 80th-percentile backtest error ที่ขยายตามเวลา ไม่ใช่ guaranteed confidence interval</small></div></div>
        <div className="legend-card"><span className="legend-line options-scenario-line" /><div><strong>Options-aware scenario</strong><small>เส้นฟ้า · historical ensemble ที่ปรับด้วย Max Pain และ Black-76 OI Greeks</small></div></div>
        <div className="legend-card"><span className="legend-line max-pain-line" /><div><strong>90D composite pain heuristic</strong><small>เส้นส้มแนวนอน · aggregate ภายใน horizon; scenario ใช้ Max Pain ของ expiry ใกล้สุดเป็น anchor หลัก</small></div></div>
        <div className="legend-card"><span className="legend-line gamma-flip-line" /><div><strong>Gamma flip</strong><small>เส้นฟ้าจุด · ระดับที่ net Gamma exposure เปลี่ยนเครื่องหมาย</small></div></div>
        <div className="legend-card"><span className="legend-line dominance-projection-line" /><div><strong>Dominance expiry-decay outlook</strong><small>เส้นจุดสีม่วง · carry-forward OI แล้วตัดสัญญาเมื่อหมดอายุ ไม่ได้ทำนายการเปิด/ปิดสถานะใหม่</small></div></div>
        <div className="legend-card"><span className="legend-line expired-line" /><div><strong>Expired wall</strong><small>สีเทา · expiry ผ่านแล้ว ณ เวลาปัจจุบัน</small></div></div>
        <div className="legend-card"><span className="legend-line mixed-line" /><div><strong>Mixed expiry wall</strong><small>สีเหลืองอมส้ม · wall รวม series ที่หมดและยังไม่หมดอายุ</small></div></div>
      </section>

      <footer className="app-footer">
        <span>OI source: standalone CME Vol2Vol tenor + EOD options chain · {expiryScope === 'all' ? 'all listed expiries' : 'front target DTE 7/15/30/60/90'} · close → mid → open</span>
        <span>{health.lastSuccessAt ? `Last success ${new Date(health.lastSuccessAt).toLocaleString()}` : 'No successful collection yet'}</span>
      </footer>
    </main>
  );
}
