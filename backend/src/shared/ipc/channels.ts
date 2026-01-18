import type { IndicatorParams, IndicatorSeriesPoint } from '../../domain/indicators/types';
import type { BacktestConfig, BacktestResult } from '../../domain/backtest/types';
import type { Signal } from '../../domain/signals/types';
import { z } from 'zod';

export type MarketFetchResult = { fetched: number; upserted: number; lastTs?: number; durationMs: number };
export type FundamentalsRefreshResult = { upserted: boolean; asOf: string; provider: string };

export type BacktestStartReq = { id?: string; symbol: string; engine: { initialCash: number; feeBps?: number; slippageBps?: number; seed?: number } };
export type BacktestStartRes = { id: string };
export type BacktestStatusRes = { status: 'RUNNING'|'DONE'|'ERROR'; progress?: number; notes?: string };
export type BacktestExportReq = { id: string; type: 'trades'|'equity' };
export type BacktestExportRes = { csv: string };

// Event payloads published from main to renderer (via preload bridge)
export type IpcEventMap = {
  'backtest.progress': { id: string; pct: number; stage?: string };
  'backtest.complete': { id: string; tradeCount: number; durationMs: number };
  'market.fetch.progress'?: { symbol: string; fetched: number; upserted: number; pct?: number };
};

// Event payload schemas (S7-C)
export const BacktestProgressEventSchema = z.object({ id: z.string().min(1), pct: z.number().min(0).max(100), stage: z.string().optional() });

export type IpcChannels =
  | { name: 'market.fetch'; req: { symbol: string; timeframe: string }; res: { rows: MarketFetchResult } }
  | { name: 'market.candles'; req: { symbol: string; timeframe: '1M'|'1W'|'1D'|'4H'|'2H'|'1h'|'15m'|'5m'|'1m'|'1d'; limit?: number; sinceTs?: number }; res: { candles: Array<{ ts_utc_ms: number; open: number; high: number; low: number; close: number; volume: number }> } }
  | { name: 'indicators.compute'; req: { symbol: string; timeframe: string; indicators: Array<{ key: string; params: IndicatorParams }> }; res: { series: Record<string, IndicatorSeriesPoint[]> } }
  | { name: 'signals.generate'; req: { symbol: string; rules: string[] }; res: { signals: Signal[] } }
  | { name: 'backtest.run'; req: BacktestConfig; res: BacktestResult } // legacy from Story-005
  | { name: 'fundamentals.refresh'; req: { symbol: string }; res: FundamentalsRefreshResult }
  | { name: 'backtest.start'; req: BacktestStartReq; res: BacktestStartRes }
  | { name: 'backtest.status'; req: { id: string }; res: BacktestStatusRes }
  | { name: 'backtest.export'; req: BacktestExportReq; res: BacktestExportRes }
  | { name: 'portfolio.get'; req: PortfolioGetReq; res: PortfolioGetEnvelope }
  | { name: 'portfolio.addTrade'; req: { symbol: string; side: 'BUY'|'SELL'; qty: number; price: number; ts?: number }; res: { ok: true } }
  | { name: 'portfolio.clear'; req: Record<string, never>; res: { ok: true } }
  | { name: 'watchlists.get'; req: Record<string, never>; res: { items: Array<{ symbol: string; name?: string; lastUpdated?: number }> } }
  | { name: 'watchlists.index'; req: Record<string, never>; res: { lists: Array<{ id: string; name: string }>; activeId?: string } }
  | { name: 'watchlists.create'; req: { name: string }; res: { id: string; name: string } }
  | { name: 'watchlists.rename'; req: { id: string; name: string }; res: { ok: true } }
  | { name: 'watchlists.setActive'; req: { id: string }; res: { ok: true } }
  | { name: 'watchlists.items.get'; req: { listId: string }; res: { items: Array<{ symbol: string; name?: string; lastUpdated?: number }> } }
  | { name: 'watchlists.items.add'; req: { listId: string; symbol: string; name?: string }; res: { ok: true } }
  | { name: 'watchlists.items.remove'; req: { listId: string; symbol: string }; res: { ok: true } }
  | { name: 'signals.get'; req: { range?: { from?: number; to?: number } }; res: { rows: Signal[] } }
  | { name: 'backtests.get'; req: Record<string, never>; res: { rows: Array<{ id: string; status: 'RUNNING'|'DONE'|'ERROR'; startedAt: number; finishedAt?: number }> } }
  | { name: 'plans.save'; req: { symbol: string; timeframe?: string; direction: 'LONG'|'SHORT'; entry: number; stop: number; target: number; note?: string }; res: { id: number; savedAt: number } }
  | { name: 'plans.getForSymbol'; req: { symbol: string }; res: { rows: Array<{ id: number; symbol: string; timeframe?: string; direction: 'LONG'|'SHORT'; entry: number; stop: number; target: number; savedAt: number; note?: string }> } };

// ---- S7-B: Portfolio schemas ----
export const PortfolioPositionSchema = z.object({
  symbol: z.string().min(1),
  qty: z.number().finite(),
  price: z.number().finite().optional(),
  equity: z.number().finite().optional(),
});

export const PortfolioTotalsSchema = z.object({
  equity: z.number().finite(),
  cash: z.number().finite().optional(),
  pnl: z.number().finite().optional(),
});

export const PortfolioGetReqSchema = z.object({}).strict();
export const PortfolioGetResSchema = z.object({
  positions: z.array(PortfolioPositionSchema),
  totals: PortfolioTotalsSchema,
});

export type PortfolioGetReq = z.infer<typeof PortfolioGetReqSchema>;
export type PortfolioGetRes = z.infer<typeof PortfolioGetResSchema>;

export type ErrorEnvelope = { ok: false; error: { code: string; message: string; issues?: unknown } };
export type DataEnvelope<T> = { ok: true; data: T };
export type PortfolioGetEnvelope = DataEnvelope<PortfolioGetRes> | ErrorEnvelope;

// S7-B: Watchlists schemas
export const WatchlistItemSchema = z.object({ symbol: z.string().min(1), name: z.string().optional(), lastUpdated: z.number().int().optional() });
export const WatchlistsGetResSchema = z.object({ items: z.array(WatchlistItemSchema) });

// S7-B: Signals list schema (re-using domain Signal shape partially)
export const SignalRowSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  ts: z.number().int(),
  kind: z.enum(['ENTRY','EXIT']),
  ruleId: z.string().min(1),
  confidence: z.number().optional(),
  rationale: z.string().optional(),
});
export const SignalsGetResSchema = z.object({ rows: z.array(SignalRowSchema) });

// S7-C: Backtests list schema
export const BacktestsRowSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['RUNNING','DONE','ERROR']),
  startedAt: z.number().int(),
  finishedAt: z.number().int().optional(),
});
export const BacktestsGetResSchema = z.object({ rows: z.array(BacktestsRowSchema) });

// ---- Runtime validation schemas for primary IPC channels ----
// Market candles
export const CandleSchema = z.object({
  ts_utc_ms: z.number().int().nonnegative(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite(),
});
export const MarketCandlesReqSchema = z.object({
  symbol: z.string().min(1),
  timeframe: z.enum(['1M','1W','1D','4H','2H','1h','15m','5m','1m','1d']),
  limit: z.number().int().positive().max(5000).optional(),
  sinceTs: z.number().int().nonnegative().optional(),
});
export const MarketCandlesResSchema = z.object({ candles: z.array(CandleSchema) });

// Signals list
export const SignalsGetReqSchema = z.object({
  range: z
    .object({ from: z.number().int().optional(), to: z.number().int().optional() })
    .partial()
    .optional(),
});

// Watchlists v2
export const WatchlistsIndexReqSchema = z.object({}).strict();
export const WatchlistsIndexResSchema = z.object({
  lists: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
  activeId: z.string().min(1).optional(),
});
export const WatchlistsCreateReqSchema = z.object({ name: z.string().min(1).max(80) });
export const WatchlistsCreateResSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export const WatchlistsRenameReqSchema = z.object({ id: z.string().min(1), name: z.string().min(1).max(80) });
export const WatchlistsSetActiveReqSchema = z.object({ id: z.string().min(1) });
export const OkResSchema = z.object({ ok: z.literal(true) });
export const WatchlistsItemsGetReqSchema = z.object({ listId: z.string().min(1) });
export const WatchlistsItemsGetResSchema = z.object({ items: z.array(WatchlistItemSchema) });
export const WatchlistsItemsAddReqSchema = z.object({ listId: z.string().min(1), symbol: z.string().min(1), name: z.string().optional() });
export const WatchlistsItemsRemoveReqSchema = z.object({ listId: z.string().min(1), symbol: z.string().min(1) });

// Plans
export const PlanDirectionSchema = z.enum(['LONG','SHORT']);
export const PlansSaveReqSchema = z.object({
  symbol: z.string().min(1),
  timeframe: z.string().optional(),
  direction: PlanDirectionSchema,
  entry: z.number().finite(),
  stop: z.number().finite(),
  target: z.number().finite(),
  note: z.string().optional(),
});
export const PlansSaveResSchema = z.object({ id: z.number().int().positive(), savedAt: z.number().int() });
export const PlansGetForSymbolReqSchema = z.object({ symbol: z.string().min(1) });
export const PlansGetForSymbolResSchema = z.object({
  rows: z.array(
    z.object({
      id: z.number().int().positive(),
      symbol: z.string().min(1),
      timeframe: z.string().optional(),
      direction: PlanDirectionSchema,
      entry: z.number().finite(),
      stop: z.number().finite(),
      target: z.number().finite(),
      savedAt: z.number().int(),
      note: z.string().optional(),
    })
  ),
});

// Portfolio envelope
export const ErrorEnvelopeSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string(), issues: z.unknown().optional() }) });
export const PortfolioGetEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: PortfolioGetResSchema }),
  ErrorEnvelopeSchema,
]);
