import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import type { Candle, Position, Trade, Watchlist, SignalRow, QuoteLite, CandlesByIntervalRes, Interval } from "../src/shared/types.js";

contextBridge.exposeInMainWorld("api", {
  // Quotes
  getQuotes: (symbols: string[]) =>
    ipcRenderer.invoke("quotes:get", symbols) as Promise<QuoteLite[]>,
  // Watchlists
  listWatchlists: () => ipcRenderer.invoke("watchlists:list") as Promise<Watchlist[]>,
  createWatchlist: (name: string) => ipcRenderer.invoke("watchlists:create", name) as Promise<Watchlist>,
  renameWatchlist: (id: number, name: string) => ipcRenderer.invoke("watchlists:rename", { id, name }),
  deleteWatchlist: (id: number) => ipcRenderer.invoke("watchlists:delete", id),
  getWatchlistSymbols: (watchlistId: number) => ipcRenderer.invoke("watchlists:symbols", watchlistId) as Promise<string[]>,
  addSymbolToWatchlist: (watchlistId: number, symbol: string) => ipcRenderer.invoke("watchlists:addSymbol", { watchlistId, symbol }),
  removeSymbolFromWatchlist: (watchlistId: number, symbol: string) => ipcRenderer.invoke("watchlists:removeSymbol", { watchlistId, symbol }),

  // Candles / Ticker
  getCandles: (symbol: string, range: "1M" | "6M" | "1Y" | "5Y" = "1Y") =>
    ipcRenderer.invoke("candles:get", { symbol, range }) as Promise<Candle[]>,
  getCandlesByInterval: (symbol: string, interval: Interval) =>
    ipcRenderer.invoke("candles:getByInterval", { symbol, interval }) as Promise<CandlesByIntervalRes>,
  getIndicators: (symbol: string, interval: Interval) =>
    ipcRenderer.invoke("indicators:get", { symbol, interval }) as Promise<{ overlays: { ema20: number[]; ema50: number[]; ema200: number[] }; snapshot: any }>,
  getIndicatorBundle: (symbol: string, interval: Interval) =>
    ipcRenderer.invoke("indicators:bundle", { symbol, interval }) as Promise<{ candles: Candle[]; bundle: any }>,
  getStrategies: (symbol: string, interval: Interval) =>
    ipcRenderer.invoke("strategies:get", { symbol, interval }) as Promise<any>,

  // Signals
  listSignals: () => ipcRenderer.invoke("signals:list") as Promise<SignalRow[]>,
  scanSignalsForAll: () => ipcRenderer.invoke("signals:scanAll"),
  scanWatchlistsSignals: (filters: { watchlistId?: number; timeframe: Interval; direction?: 'LONG'|'SHORT'; strategy?: string; minConfidence?: number; }) =>
    ipcRenderer.invoke("signals:scanWatchlists", filters),

  // Portfolio
  addTrade: (trade: Trade) => ipcRenderer.invoke("portfolio:addTrade", trade),
  listTrades: () => ipcRenderer.invoke("portfolio:listTrades") as Promise<Trade[]>,
  getPositions: () => ipcRenderer.invoke("portfolio:positions") as Promise<Position[]>,
  deleteTrade: (id: number) => ipcRenderer.invoke("portfolio:deleteTrade", id) as Promise<void>,

  // Logos
  getLogo: (symbol: string) => ipcRenderer.invoke("logos:get", symbol) as Promise<string>
  ,
  // Engine config snapshot
  getEngineConfig: () => ipcRenderer.invoke('engine:getConfig') as Promise<any>
  ,
  // Backtests v1
  backtests: {
    runTicker: (ticker: string, opts?: { minRRGlobal?: number; minRROverrides?: Record<string, number>; side?: 'BOTH'|'LONG'|'SHORT' }) =>
      ipcRenderer.invoke('backtests:runTicker', { ticker, ...(opts||{}) }) as Promise<{ runId: number }>,
    getLatestForTicker: (ticker: string) => ipcRenderer.invoke('backtests:getLatestForTicker', { ticker }) as Promise<{ runId: number; summary: any; trades: any[]; meta: any } | null>,
  },

  tsmom: {
    getUniverse: () => ipcRenderer.invoke('tsmom:get-universe'),
    computePlan: () => ipcRenderer.invoke('tsmom:compute-plan'),
    getSignalMatrix: () => ipcRenderer.invoke('tsmom:get-signal-matrix'),
    getPerformance: (opts?: { years?: number; benchmark?: string | null }) => ipcRenderer.invoke('tsmom:get-performance', opts || {}),
    sandboxRun: (opts?: { years?: number; benchmark?: string | null; params?: any }) => ipcRenderer.invoke('tsmom:sandbox-run', opts || {}),
    sandboxCompare: (opts: { years?: number; benchmark?: string | null; runs: Array<{ label: string; params: any }> }) => ipcRenderer.invoke('tsmom:sandbox-compare', opts),
    executeTrades: (payload: any) => ipcRenderer.invoke('tsmom:execute-trades', payload),
    listLedger: (opts?: { limit?: number }) => ipcRenderer.invoke('tsmom:list-ledger', opts || {}),
    addLedgerEntry: (payload: any) => ipcRenderer.invoke('tsmom:add-ledger-entry', payload),
    deleteLedgerEntry: (id: number) => ipcRenderer.invoke('tsmom:delete-ledger-entry', id),
    listTrades: (opts?: { limit?: number; strategyTagPrefix?: string }) => ipcRenderer.invoke('tsmom:list-trades', opts || {}),
    getSyncStatus: () => ipcRenderer.invoke('tsmom:get-sync-status'),
    listSyncRuns: (opts?: { limit?: number }) => ipcRenderer.invoke('tsmom:list-sync-runs', opts || {}),
    listPriceFlags: (opts?: { limit?: number; onlyUnacknowledged?: boolean; types?: string[]; ticker?: string }) => ipcRenderer.invoke('tsmom:list-price-flags', opts || {}),
    ackPriceFlag: (id: number) => ipcRenderer.invoke('tsmom:ack-price-flag', id),
    applyCorporateAction: (flagId: number) => ipcRenderer.invoke('tsmom:apply-corp-action', { flagId }),
  },
});

declare global {
  interface Window {
    api: {
      listWatchlists(): Promise<Watchlist[]>;
      createWatchlist(name: string): Promise<Watchlist>;
      renameWatchlist(id: number, name: string): Promise<void>;
      deleteWatchlist(id: number): Promise<void>;
      getWatchlistSymbols(watchlistId: number): Promise<string[]>;
      addSymbolToWatchlist(watchlistId: number, symbol: string): Promise<void>;
      removeSymbolFromWatchlist(watchlistId: number, symbol: string): Promise<void>;

  getQuotes(symbols: string[]): Promise<QuoteLite[]>;

      getCandles(symbol: string, range?: "1M"|"6M"|"1Y"|"5Y"): Promise<Candle[]>;
  getCandlesByInterval(symbol: string, interval: Interval): Promise<CandlesByIntervalRes>;
  getIndicators(symbol: string, interval: Interval): Promise<{ overlays: { ema20: number[]; ema50: number[]; ema200: number[] }; snapshot: any }>;
  getIndicatorBundle(symbol: string, interval: Interval): Promise<{ candles: Candle[]; bundle: any }>;
  getStrategies(symbol: string, interval: Interval): Promise<any>;

      listSignals(): Promise<SignalRow[]>;
      scanSignalsForAll(): Promise<void>;
  scanWatchlistsSignals(filters: { watchlistId?: number; timeframe: Interval; direction?: 'LONG'|'SHORT'; strategy?: string; minConfidence?: number; }): Promise<{ stats: { scanned: number; signaled: number; durationMs: number }, results: { watchlistId: number; name: string; cards: any[] }[] }>;

      addTrade(trade: Trade): Promise<void>;
      listTrades(): Promise<Trade[]>;
      getPositions(): Promise<Position[]>;
  deleteTrade(id: number): Promise<void>;

      getLogo(symbol: string): Promise<string>;
  getEngineConfig(): Promise<any>;

      backtests: {
  runTicker(ticker: string, opts?: { minRRGlobal?: number; minRROverrides?: Record<string, number>; side?: 'BOTH'|'LONG'|'SHORT' }): Promise<{ runId: number }>;
        getLatestForTicker(ticker: string): Promise<{ runId: number; summary: any; trades: any[]; meta: any } | null>;
      };
    };
  }
}
