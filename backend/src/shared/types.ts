export type Candle = {
  ts: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Interval = '4h' | '1d' | '1wk' | '1mo';

export type Overlays = {
  ema20: number[];
  ema50: number[];
  ema200: number[];
};

export type IndicatorsSnapshot = {
  ema20: number;
  ema50: number;
  ema200: number;
  ema20Slope: number;
  ema50Slope: number;
  ema200Slope: number;
  rsi14: number;
  macd: { line: number; signal: number; hist: number };
  donchian20: { high: number; low: number };
  fib: {
    leg: { from: number; to: number; direction: 'up' | 'down' } | null;
    levels: { '38.2': number; '50': number; '61.8': number } | null;
    region?: 'above' | '38-50' | '50-61.8' | 'below';
  };
};

export type CandlesByIntervalRes = {
  candles: Candle[];
  partialRange?: boolean;
  // Intraday metadata for 4h path
  intradayAvailable?: boolean; // true if we fetched intraday (1h/60m) successfully
  fallbackInterval?: '1d' | '1wk' | '1mo'; // when intraday is unavailable, what we returned instead
  historyStart?: number; // unix ms of first candle returned
  historyEnd?: number;   // unix ms of last candle returned
  interval?: Interval;   // echoes what interval the candles represent (may be fallback)
};

export type StrategySignal = {
  strategyId?: string; // newly added for backtests/stats (optional to keep BC)
  name: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopPrice: number;
  targets: number[];
  rationale: string;
  timestamp: number; // unix ms
  // --- Enrichment (optional) ---
  rMultipleFirst?: number; // (target1-entry)/(entry-stop) for longs; mirrored for shorts
  rrTargets?: number[]; // R multiples for each target relative to stop
  confidence?: number; // 0-100
  regime?: 'trend' | 'mean-revert';
  timeframes?: { exec: '1D'; confirm: '1W'; macro?: '1M' };
  entryType?: 'stop' | 'limit' | 'market-on-close';
  trailing?: { type: 'chandelier' | 'supertrend' | null; params?: Record<string, any> } | null;
  reasons?: string[]; // bullet list of rule hits
  positionSizing?: { riskPct: number; unitRisk: number; suggestedSize?: number };
  cooldownUntilTs?: number; // suggested cooldown end time (unix ms)
  // New momentum engine optional metadata (non-breaking additions)
  tags?: string[];
  factors?: { name: string; weight: number; hit: boolean; contribution: number }[];
  qualityScore?: number; // alias of confidence or separate if needed
  // v1.1 exit behavior (optional)
  exitProfile?: {
    mode: 'fixed' | 'trailing' | 'mixed';
    trailingRules?: Array<
      | { type: 'moveStopToBEAtR'; k: number }
      | { type: 'trailUnderEMA20' }
      | { type: 'trailOverEMA20' }
      | { type: 'trailMidBollinger' }
    >;
    timeStopDays?: number;
    notes?: string;
  };
};

export type Watchlist = {
  id: number;
  name: string;
  created_at: number;
};

export type TradeSide = "BUY" | "SELL";

export type Trade = {
  id?: number;
  symbol: string;
  side: TradeSide;
  qty: number;
  price: number;
  ts: number; // unix ms
};

export type Position = {
  symbol: string;
  qty: number;
  avgPrice: number;
  lastClose?: number;
  pnl?: number;
};

export type SignalRow = {
  id: number;
  symbol: string;
  type: "golden_cross";
  ts: number;
  meta?: any;
};

export type QuoteLite = {
  symbol: string;
  last: number | null;
  change: number | null;
  changePct: number | null;
  ts: number | null;
};

// Backtest types removed (legacy engine cleared for custom rebuild)
