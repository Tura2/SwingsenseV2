import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import type { Candle, Position, Trade, Watchlist, SignalRow, QuoteLite, CandlesByIntervalRes, Interval } from "../src/shared/types.js";

contextBridge.exposeInMainWorld("api", {
  // Quotes
  getQuotes: (symbols: string[]) =>
    ipcRenderer.invoke("quotes:get", symbols) as Promise<QuoteLite[]>,

  // Market
  market: {
    getTrending: (params: { list: 'gainers'|'losers'|'active'; limit?: number }) =>
      ipcRenderer.invoke('market:getTrending', params) as Promise<{ symbol: string; price: number; changePct: number; volume: number }[]>,
  },
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
    getUniverse: (opts?: { portfolioId?: number }) => ipcRenderer.invoke('tsmom:get-universe', opts || {}),
    computePlan: (opts?: { portfolioId?: number }) => ipcRenderer.invoke('tsmom:compute-plan', opts || {}),
    getSignalMatrix: (opts?: { portfolioId?: number }) => ipcRenderer.invoke('tsmom:get-signal-matrix', opts || {}),
    getPerformance: (opts?: { portfolioId?: number; years?: number; benchmark?: string | null }) => ipcRenderer.invoke('tsmom:get-performance', opts || {}),
    sandboxRun: (opts?: { years?: number; benchmark?: string | null; params?: any }) => ipcRenderer.invoke('tsmom:sandbox-run', opts || {}),
    sandboxCompare: (opts: { years?: number; benchmark?: string | null; runs: Array<{ label: string; params: any }> }) => ipcRenderer.invoke('tsmom:sandbox-compare', opts),
    executeTrades: (payload: any) => ipcRenderer.invoke('tsmom:execute-trades', payload),
    listLedger: (opts?: { portfolioId?: number; limit?: number }) => ipcRenderer.invoke('tsmom:list-ledger', opts || {}),
    addLedgerEntry: (payload: any) => ipcRenderer.invoke('tsmom:add-ledger-entry', payload),
    deleteLedgerEntry: (id: number) => ipcRenderer.invoke('tsmom:delete-ledger-entry', id),
    listTrades: (opts?: { portfolioId?: number; limit?: number; strategyTagPrefix?: string }) => ipcRenderer.invoke('tsmom:list-trades', opts || {}),
    updateTradeNotes: (payload: { tradeId: number; notes: string | null }) => ipcRenderer.invoke('tsmom:update-trade-notes', payload),
    getSyncStatus: () => ipcRenderer.invoke('tsmom:get-sync-status'),
    listSyncRuns: (opts?: { limit?: number }) => ipcRenderer.invoke('tsmom:list-sync-runs', opts || {}),
    listPriceFlags: (opts?: { limit?: number; onlyUnacknowledged?: boolean; types?: string[]; ticker?: string }) => ipcRenderer.invoke('tsmom:list-price-flags', opts || {}),
    ackPriceFlag: (id: number) => ipcRenderer.invoke('tsmom:ack-price-flag', id),
    applyCorporateAction: (flagId: number) => ipcRenderer.invoke('tsmom:apply-corp-action', { flagId }),
  },

  portfolios: {
    list: () => ipcRenderer.invoke('portfolios:list'),
    create: (payload: any) => ipcRenderer.invoke('portfolios:create', payload),
    update: (payload: any) => ipcRenderer.invoke('portfolios:update', payload),
    delete: (id: number) => ipcRenderer.invoke('portfolios:delete', id),
    getSnapshot: (opts?: { portfolioId?: number }) => ipcRenderer.invoke('portfolios:getSnapshot', opts || {}),
    universe: {
      list: (opts?: { portfolioId?: number }) => ipcRenderer.invoke('portfolios:universe:list', opts || {}),
      getMode: (opts?: { portfolioId?: number }) => ipcRenderer.invoke('portfolios:universe:getMode', opts || {}),
      addTicker: (payload: any) => ipcRenderer.invoke('portfolios:universe:addTicker', payload),
      removeTicker: (payload: any) => ipcRenderer.invoke('portfolios:universe:removeTicker', payload),
      setAll: (payload: any) => ipcRenderer.invoke('portfolios:universe:setAll', payload),
    },
  },
});

declare global {
  interface Window {
    api: {
      market: {
        getTrending(params: { list: 'gainers'|'losers'|'active'; limit?: number }): Promise<{ symbol: string; price: number; changePct: number; volume: number }[]>;
      };

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

      tsmom: {
        getUniverse(opts?: { portfolioId?: number }): Promise<any[]>;
        computePlan(opts?: { portfolioId?: number }): Promise<any>;
        getSignalMatrix(opts?: { portfolioId?: number }): Promise<{ asOf: string; params: any; rows: any[] }>;
        getPerformance(opts?: { portfolioId?: number; years?: number; benchmark?: string | null }): Promise<{ benchmark: string | null; points: Array<{ ts: number; equity: number; bench_equity: number }> }>;

        sandboxRun(opts?: { years?: number; benchmark?: string | null; params?: any }): Promise<any>;
        sandboxCompare(opts: { years?: number; benchmark?: string | null; runs: Array<{ label: string; params: any }> }): Promise<any>;

        executeTrades(payload: any): Promise<{ ok: true }>;
        listLedger(opts?: { portfolioId?: number; limit?: number }): Promise<any[]>;
        addLedgerEntry(payload: any): Promise<{ id: number; ts: number }>;
        deleteLedgerEntry(id: number): Promise<{ ok: true }>;
        listTrades(opts?: { portfolioId?: number; limit?: number; strategyTagPrefix?: string }): Promise<any[]>;
        updateTradeNotes(payload: { tradeId: number; notes: string | null }): Promise<{ ok: true }>;

        getSyncStatus(): Promise<{ lastRun: any | null; openFlags: number }>;
        listSyncRuns(opts?: { limit?: number }): Promise<any[]>;
        listPriceFlags(opts?: { limit?: number; onlyUnacknowledged?: boolean; types?: string[]; ticker?: string }): Promise<any[]>;
        ackPriceFlag(id: number): Promise<{ ok: true }>;
        applyCorporateAction(flagId: number): Promise<{ ok: true; ticker: string; factor: number; cutoffTs: number; updatedCandles: number }>;
      };

      portfolios: {
        list(): Promise<any[]>;
        create(payload: { name: string; baseCurrency?: 'USD'|'ILS'; strategyRef?: string; meta?: any }): Promise<any>;
        update(payload: { id: number; patch: any }): Promise<{ ok: true }>;
        delete(id: number): Promise<{ ok: true }>;
        getSnapshot(opts?: { portfolioId?: number }): Promise<{
          portfolioId: number;
          baseCurrency: 'USD'|'ILS';
          cashBase: number;
          holdingsValueBase: number;
          navBase: number;
          pnlDailyBase: number | null;
          pnlDailyPct: number | null;
          pnlOpenBase: number | null;
          pnlOpenPct: number | null;
          positions: Array<{ ticker: string; qty: number; lastPrice: number | null; avgBuyPrice: number | null; costBasisBase: number | null; pnlOpenBase: number | null; assetCurrency: 'USD'|'ILS'; fxRateToBase: number; valueBase: number }>;
          warnings: string[];
        }>;
        universe: {
          list(opts?: { portfolioId?: number }): Promise<string[]>;
          getMode(opts?: { portfolioId?: number }): Promise<'default'|'custom'>;
          addTicker(payload: { portfolioId?: number; ticker: string; skipPreflight?: boolean }): Promise<{ ok: true }>;
          removeTicker(payload: { portfolioId?: number; ticker: string }): Promise<{ ok: true }>;
          setAll(payload: { portfolioId?: number; tickers: string[]; skipPreflight?: boolean }): Promise<{ ok: true }>;
        };
      };
    };
  }
}
