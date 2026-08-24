export type SymbolCode = 'GC' | string;
export type PriceTimeframe = '4H' | '1D';
export type PriceChartMode = 'close' | 'mean';
export type WallMode = 'combined' | 'call' | 'put' | 'split';
export type ExpiryScope = 'front' | 'all';
export type DominanceFilter = 'all' | 'call' | 'put' | 'balanced';
export type SessionSlot = 'open' | 'mid' | 'close';
export type HealthState = 'ok' | 'partial' | 'stale' | 'error';

export interface PriceBar {
  time: string;
  closeTime: string;
  symbol: SymbolCode;
  timeframe: PriceTimeframe;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  source: string;
  sourceTimezone: string | null;
  isClosed: boolean;
}

export interface OIStrike {
  viewName: string;
  strike: number;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  callVolume: number | null;
  putVolume: number | null;
  impliedVol: number | null;
  settleVol: number | null;
  extra: Record<string, unknown>;
}

export interface OISnapshot {
  snapshotId: string;
  symbol: SymbolCode;
  tradeDate: string;
  fetchedAt: string;
  sessionSlot: SessionSlot;
  targetDte: number;
  actualDte: number;
  expiryDate: string;
  futurePrice: number;
  sourceStatus: 'VALID' | 'WARNING';
  sourceAsOf: string | null;
  oiAsOfDate?: string | null;
  oiSource?: 'vol2vol' | 'options_chain_eod' | 'mixed' | 'missing';
  selectedViews: string[];
  sourceFile: string | null;
  rawSha256: string | null;
  strikes: OIStrike[];
}

export interface WallLevel {
  symbol: SymbolCode;
  asOf: string;
  strike: number;
  callOi: number;
  putOi: number;
  totalOi: number;
  netOi: number;
  dominance: number;
  significanceScore: number;
  expiryDates: string[];
  targetDtes: number[];
  snapshotIds: string[];
  isSignificant: boolean;
}

export interface WallSegment extends WallLevel {
  from: string;
  to: string;
  stale: boolean;
  status: 'active' | 'closed' | 'stale';
}

export interface RollMarker {
  time: string;
  fromContract: string;
  toContract: string;
  source: 'futures_oi' | 'expiry_metadata' | 'calendar_fallback';
}

export interface DominanceOutlookPoint {
  time: string;
  dominance: number | null;
  callOi: number;
  putOi: number;
  totalOi: number;
  activeExpiryCount: number;
}

export interface DominanceOutlook {
  schemaVersion: 1;
  symbol: SymbolCode;
  generatedAt: string;
  baseDate: string;
  horizonDays: number;
  expiryStart: string | null;
  expiryEnd: string | null;
  method: 'unexpired-eod-oi-carry-forward';
  points: DominanceOutlookPoint[];
}

export type OptionsVolatilitySource = 'observed-iv' | 'observed-settle-vol' | 'fallback-median';
export type OptionsGreekRegime = 'positive' | 'negative' | 'neutral';

export interface OptionsPredictionLevel {
  strike: number;
  callOi: number;
  putOi: number;
  totalOi: number;
  distancePct: number;
  expiryCount: number;
  expiryDates: string[];
  impliedVol: number;
  volatilitySource: OptionsVolatilitySource;
  daysToExpiry: number;
  deltaExposure: number;
  gammaExposure: number;
  vannaExposure: number;
}

export interface OptionsExpiryMetric {
  expiryDate: string;
  tradeDate: string;
  futurePrice: number;
  daysToExpiry: number;
  strikeCount: number;
  oiContracts: number;
  observedVolCoverage: number;
  maxPainStrike: number;
  maxPainValue: number;
  netGammaExposure: number;
  netVannaExposure: number;
}

export interface OptionsPrediction {
  schemaVersion: 1;
  symbol: SymbolCode;
  generatedAt: string;
  asOfDate: string;
  underlyingPrice: number;
  method: 'black-76-horizon-oi';
  assumptions: {
    riskFreeRate: number;
    contractMultiplier: number;
    daysPerYear: number;
    analysisHorizonDays: number;
    signedOiConvention: string;
    greekUnits: string;
  };
  quality: {
    snapshotCount: number;
    activeExpiryCount: number;
    strikeCount: number;
    strikesWithOi: number;
    strikesWithObservedVol: number;
    observedVolCoverage: number;
    fallbackVolatility: number;
    latestOiDate: string | null;
    warnings: string[];
  };
  maxPain: {
    compositeStrike: number | null;
    compositeValue: number | null;
    nearestExpiry: string | null;
    nearestStrike: number | null;
    byExpiry: OptionsExpiryMetric[];
  };
  gamma: {
    callExposure: number;
    putExposure: number;
    netExposure: number;
    flipStrike: number | null;
    regime: OptionsGreekRegime;
  };
  vanna: {
    callExposure: number;
    putExposure: number;
    netExposure: number;
  };
  delta: {
    callExposure: number;
    putExposure: number;
    netExposure: number;
  };
  scenario: {
    targetPrice: number | null;
    bias: number;
    weight: number;
    score: number;
    label: string;
    caveat: string;
  };
  levels: OptionsPredictionLevel[];
}

export interface DatasetManifest {
  path: string;
  schemaVersion: number;
  generatedAt: string;
  coverageStart: string | null;
  coverageEnd: string | null;
  rowCount: number;
  sha256: string | null;
  freshness: 'fresh' | 'stale' | 'missing';
}

export interface DataManifest {
  schemaVersion: number;
  generatedAt: string;
  symbol: SymbolCode;
  priceTimeframes: PriceTimeframe[];
  displayTimezone: string;
  cmeTimezone: string;
  coverage: {
    price: { start: string | null; end: string | null };
    oi: { start: string | null; end: string | null };
    oiExpiry: { start: string | null; end: string | null };
  };
  datasets: Record<string, DatasetManifest>;
  health: DashboardHealth;
}

export interface AuthHealth {
  state: 'ok' | 'reauth_required' | 'challenge' | 'failed' | 'unknown';
  checkedAt: string | null;
  message: string | null;
}

export interface DashboardHealth {
  state: HealthState;
  generatedAt: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  stale: boolean;
  partial: boolean;
  auth: AuthHealth;
  price: { state: HealthState; lastSuccessAt: string | null; message: string | null };
  oi: { state: HealthState; lastSuccessAt: string | null; message: string | null };
  notes: string[];
}

export interface DashboardData {
  price: PriceBar[];
  walls: WallSegment[];
  allExpiryWalls: WallSegment[];
  rolls: RollMarker[];
  dominanceOutlook: DominanceOutlook | null;
  optionsPrediction: OptionsPrediction | null;
  manifest: DataManifest;
}
