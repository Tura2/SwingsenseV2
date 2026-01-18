export type Candle = {
  symbol: string;
  timeframe: '1m' | '5m' | '15m' | '1h' | '1d';
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  provider?: string;
};

export type Fundamentals = {
  symbol: string;
  asOf: string; // YYYY-MM-DD
  pe?: number;
  ps?: number;
  pb?: number;
  roe?: number;
  debtToEquity?: number;
  marketCap?: number;
  dividendYield?: number; // extensible
  provider?: string;
};
