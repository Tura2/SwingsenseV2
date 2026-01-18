// Global type augmentation for renderer window.api additions
export {};
declare global {
  interface Window {
    api: {
      // existing methods (not re-listing to avoid drift); this file only adds market namespace at type level if missing
      market: {
        getTrending(p: { list: 'gainers'|'losers'|'active'; limit?: number }): Promise<{ symbol: string; price: number; changePct: number; volume: number }[]>;
      };

      tsmom?: {
        getUniverse(): Promise<any[]>;
        computePlan(): Promise<any>;
        getSignalMatrix(): Promise<{ asOf: string; params: any; rows: any[] }>;
        getPerformance(opts?: { years?: number; benchmark?: string | null }): Promise<{ benchmark: string | null; points: Array<{ ts: number; equity: number; bench_equity: number }> }>;

        sandboxRun(opts?: { years?: number; benchmark?: string | null; params?: any }): Promise<any>;
        sandboxCompare(opts: { years?: number; benchmark?: string | null; runs: Array<{ label: string; params: any }> }): Promise<any>;

        executeTrades(payload: any): Promise<{ ok: true }>;
        listLedger(opts?: { limit?: number }): Promise<any[]>;
        addLedgerEntry(payload: any): Promise<{ id: number; ts: number }>;
        deleteLedgerEntry(id: number): Promise<{ ok: true }>;
        listTrades(opts?: { limit?: number; strategyTagPrefix?: string }): Promise<any[]>;

        getSyncStatus(): Promise<{ lastRun: any | null; openFlags: number }>;
        listSyncRuns(opts?: { limit?: number }): Promise<any[]>;
        listPriceFlags(opts?: { limit?: number; onlyUnacknowledged?: boolean; types?: string[]; ticker?: string }): Promise<any[]>;
        ackPriceFlag(id: number): Promise<{ ok: true }>;
        applyCorporateAction(flagId: number): Promise<{ ok: true; ticker: string; factor: number; cutoffTs: number; updatedCandles: number }>;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [k: string]: any;
    };
  }
}