export type AssetStatus = 'active' | 'inactive';

export type TsmomAssetRow = {
  ticker: string;
  name: string | null;
  category: string | null;
  status: AssetStatus;
  yahoo_symbol: string | null;
  price_multiplier: number;
  created_at: number;
  updated_at: number;
  meta: string | null;
};

export type CapitalLedgerType = 'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT';

export type CapitalLedgerRow = {
  id: number;
  ts: number;
  amount: number;
  type: CapitalLedgerType;
  description: string | null;
  meta: string | null;
};

export type RebalancePlanItem = {
  ticker: string;
  yahooSymbol: string | null;
  name: string | null;
  category: string | null;
  price: number | null;
  momentum: number | null;
  sigmaAnn: number | null;
  targetWeight: number;
  targetQty: number;
  currentQty: number;
  deltaQty: number;
  action: 'BUY' | 'SELL' | 'HOLD';
};

export type RebalancePlan = {
  asOf: string;
  params: {
    lookbackTradingDays: number;
    skipRecentTradingDays: number;
    volCenterDaysCOM: number;
    targetVolAnn: number;
    topK: number;
    maxLeverage: number;
    commissionNIS: number;
  };
  equityNIS: number;
  cashNIS: number;
  holdingsValueNIS: number;
  items: RebalancePlanItem[];
  warnings: string[];
};

export type ExecuteTradesRequest = {
  ts: number; // unix ms
  strategyTag?: string;
  notes?: string;
  commissionNIS?: number; // default 5
  trades: Array<{ ticker: string; side: 'BUY' | 'SELL'; qty: number; price: number; meta?: any }>;
  cashFlows?: Array<{ ts: number; amount: number; type: CapitalLedgerType; description?: string; meta?: any }>;
};

export type SignalMatrixRow = {
  ticker: string;
  name: string | null;
  category: string | null;
  status: AssetStatus;
  price: number | null;
  momentum: number | null;
  sigmaAnn: number | null;
  rank: number | null;
  isTopK: boolean;

  // Diagnostics / UI helpers
  candles1dTotal?: number;
  closes1dValid?: number;
  requiredClosesForMomentum?: number;
};

export type SignalMatrix = {
  asOf: string;
  params: {
    lookbackTradingDays: number;
    skipRecentTradingDays: number;
    volCenterDaysCOM: number;
    topK: number;
  };
  rows: SignalMatrixRow[];
};

export type PerformancePoint = {
  ts: number;
  equity: number; // normalized (1.0 at start)
  bench_equity: number; // normalized (1.0 at start)
};
