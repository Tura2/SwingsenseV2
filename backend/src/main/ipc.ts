import { ipcMain } from "electron";
import { getDB } from "./db.js";
import { z } from "zod";
import { getCandles, getCandlesByInterval } from "./services/market.js";
import { getQuoteSafe } from "./services/quotes.js";
import { getLogo } from "./services/logos.js";
import { computeOverlaysAndSnapshot } from "./services/indicators.js";
import { buildIndicatorBundle } from "./services/indicatorService.js";
import { evaluateStrategies } from "./services/strategies.js";
import { ALL_STRATEGY_IDS } from './services/strategies/index.js';
import { scanGoldenCrossForSymbol, scanAllSymbols, scanWatchlistsSignals } from "./services/signals.js";
import { runTickerBacktest, getLatestForTicker } from './services/backtest/backtestRunner.js';
import { computeTsmomSignalMatrix, computeTsmomTurboV2Plan } from './services/tsmom/planner.js';
import { computeTsmomPerformanceSeries } from './services/tsmom/performance.js';
import { runTsmomSandbox } from './services/tsmom/sandbox.js';
import { runEaPortfolioSandboxBacktest } from './services/tsmom/eaSandboxBacktest.js';
import { applyLedgerToState, applyTradesToState, getDefaultPortfolioId, rebuildPortfolioStateFromHistory } from './services/wealth/portfolioState.js';
import { computePortfolioSnapshot, getPortfolioBaseCurrency } from './services/wealth/portfolioSnapshot.js';
import { resolveCanonicalYahooSymbol } from './services/symbols.js';
// Backtest engine removed; stale imports deleted
// --- Trending cache (60s TTL) ---
interface TrendingItem { symbol: string; price: number; changePct: number; volume: number; }
interface CacheEntry { ts: number; data: TrendingItem[]; }
const TRENDING_CACHE: Record<string, CacheEntry> = {};
const TRENDING_TTL_MS = 60_000;

// --- Background candle priming for newly added tickers ---
// Used to keep the UI responsive for large batch adds while still populating cached candles.
const PRIME_CANDLES_QUEUE = new Set<string>();
let primeCandlesRunning = false;
let primeCandlesTimer: NodeJS.Timeout | null = null;

// --- Background portfolio metadata priming (category/yahoo symbol) ---
const PRIME_PORTFOLIO_META_QUEUE = new Map<number, Set<string>>();
let primePortfolioMetaRunning = false;
let primePortfolioMetaTimer: NodeJS.Timeout | null = null;

function inferPriceMultiplierForTicker(ticker: string): number {
  const t = String(ticker || '').toUpperCase();
  return t.endsWith('.TA') ? 0.01 : 1;
}

function inferCategoryFromExchange(exchange?: string, ticker?: string): string | null {
  const ex = String(exchange || '').toUpperCase();
  const t = String(ticker || '').toUpperCase();
  if (t.endsWith('.TA') || ex.includes('TASE') || ex.includes('TEL AVIV')) return 'Israel / TASE';
  if (ex.includes('NASDAQ')) return 'US / NASDAQ';
  if (ex.includes('NYSE')) return 'US / NYSE';
  if (ex) return ex;
  return null;
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function enqueuePrimeCandles(symbols: string[]) {
  for (const s of symbols || []) {
    const t = String(s || '').trim().toUpperCase();
    if (!t) continue;
    PRIME_CANDLES_QUEUE.add(t);
  }
  if (primeCandlesTimer) return;
  primeCandlesTimer = setTimeout(() => {
    primeCandlesTimer = null;
    void drainPrimeCandlesQueue();
  }, 50);
}

function enqueuePrimePortfolioMeta(portfolioId: number, symbols: string[]) {
  const pid = Number(portfolioId);
  if (!Number.isFinite(pid) || pid <= 0) return;
  const set = PRIME_PORTFOLIO_META_QUEUE.get(pid) || new Set<string>();
  for (const s of symbols || []) {
    const t = String(s || '').trim().toUpperCase();
    if (!t) continue;
    set.add(t);
  }
  PRIME_PORTFOLIO_META_QUEUE.set(pid, set);
  if (primePortfolioMetaTimer) return;
  primePortfolioMetaTimer = setTimeout(() => {
    primePortfolioMetaTimer = null;
    void drainPrimePortfolioMetaQueue();
  }, 100);
}

async function drainPrimePortfolioMetaQueue() {
  if (primePortfolioMetaRunning) return;
  primePortfolioMetaRunning = true;
  try {
    const db = getDB();
    const upd = db.prepare(
      `UPDATE portfolio_assets
       SET yahoo_symbol=COALESCE(yahoo_symbol, ?),
           category=COALESCE(category, ?),
           updated_at=?
       WHERE portfolio_id=? AND ticker=?`
    );

    while (PRIME_PORTFOLIO_META_QUEUE.size) {
      const nextPid = PRIME_PORTFOLIO_META_QUEUE.keys().next().value as number | undefined;
      if (!nextPid) break;
      const set = PRIME_PORTFOLIO_META_QUEUE.get(nextPid);
      if (!set || set.size === 0) {
        PRIME_PORTFOLIO_META_QUEUE.delete(nextPid);
        continue;
      }

      const nextTicker = set.values().next().value as string | undefined;
      if (!nextTicker) {
        PRIME_PORTFOLIO_META_QUEUE.delete(nextPid);
        continue;
      }
      set.delete(nextTicker);
      if (set.size === 0) PRIME_PORTFOLIO_META_QUEUE.delete(nextPid);

      try {
        const resolved = await resolveCanonicalYahooSymbol(nextTicker).catch(() => ({ candidates: [nextTicker], exchange: undefined } as any));
        const ysym = String(resolved?.candidates?.[0] || nextTicker).toUpperCase();
        const cat = inferCategoryFromExchange(resolved?.exchange, nextTicker);
        upd.run(ysym || null, cat, Date.now(), nextPid, nextTicker);
        invalidatePortfolioTsmomCaches(nextPid);
      } catch {
        // ignore
      }

      await sleep(250);
    }
  } finally {
    primePortfolioMetaRunning = false;
  }
}

// --- L1 in-memory cache + persistent SQLite cache (app_cache) ---
// Memory cache is a small speedup; SQLite cache provides persistence across restarts.
const MEM_CACHE = new Map<string, { ts: number; data: any }>();
const MEM_CACHE_TTL_MS = 30_000;

function memGet(key: string) {
  const hit = MEM_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > MEM_CACHE_TTL_MS) {
    MEM_CACHE.delete(key);
    return null;
  }
  return hit.data;
}

function memSet(key: string, data: any) {
  MEM_CACHE.set(key, { ts: Date.now(), data });
}

function memDel(key: string) {
  MEM_CACHE.delete(key);
}

function invalidatePortfolioTsmomCaches(portfolioId: number) {
  const pid = Number(portfolioId);
  if (!Number.isFinite(pid) || pid <= 0) return;

  const kSignal = `tsmom:signal:p:${pid}`;
  const kUniverse = `tsmom:universe:p:${pid}`;

  memDel(kSignal);
  memDel(kUniverse);

  try {
    const db = getDB();
    db.prepare('DELETE FROM app_cache WHERE key=?').run(kSignal);
    db.prepare('DELETE FROM app_cache WHERE key=?').run(kUniverse);
  } catch {
    // ignore
  }
}

function memDelPrefix(prefix: string) {
  for (const k of Array.from(MEM_CACHE.keys())) {
    if (k.startsWith(prefix)) MEM_CACHE.delete(k);
  }
}

async function drainPrimeCandlesQueue() {
  if (primeCandlesRunning) return;
  primeCandlesRunning = true;
  try {
    // Conservative throttle to avoid Yahoo rate limiting.
    while (PRIME_CANDLES_QUEUE.size) {
      const next = PRIME_CANDLES_QUEUE.values().next();
      const ticker = next.value as string | undefined;
      if (!ticker) break;
      PRIME_CANDLES_QUEUE.delete(ticker);
      try {
        await getCandles(ticker, '6M');
      } catch {
        // ignore; the ticker may be invalid or temporarily unavailable
      }
      await sleep(350);
    }
  } finally {
    primeCandlesRunning = false;
  }
}

export function registerIpcHandlers() {
  const db = getDB();

  // --- Persistent computed cache (SQLite: app_cache) ---
  const cacheGetStmt = db.prepare('SELECT value, deps, updated_at FROM app_cache WHERE key=?');
  const cacheSetStmt = db.prepare('INSERT OR REPLACE INTO app_cache(key, value, deps, created_at, updated_at) VALUES(?,?,?,?,?)');

  function getCandlesVersionMs(): number {
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key='candles_version_ms'").get() as { value?: any } | undefined;
      const n = Number(row?.value ?? 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  function ensureCandlesVersionInitialized() {
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key='candles_version_ms'").get() as { value?: any } | undefined;
      const n = Number(row?.value ?? 0);
      if (Number.isFinite(n) && n > 0) return;
      const cnt = db.prepare('SELECT COUNT(*) as c FROM candles').get() as { c: number };
      const v = (Number(cnt?.c || 0) > 0) ? Date.now() : 0;
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('candles_version_ms', ?)").run(String(v));
    } catch {
      // ignore
    }
  }

  function persistentCacheGet<T>(key: string, deps?: { candlesVersionMs?: number }): T | null {
    const mem = memGet(key);
    if (mem) return mem as T;

    try {
      const row = cacheGetStmt.get(key) as { value?: string; deps?: string; updated_at?: any } | undefined;
      if (!row?.value) return null;
      if (deps?.candlesVersionMs != null) {
        const storedDeps = row.deps ? JSON.parse(row.deps) : {};
        const storedV = Number(storedDeps?.candlesVersionMs ?? 0);
        if (storedV !== Number(deps.candlesVersionMs)) return null;
      }
      const parsed = JSON.parse(row.value) as T;
      memSet(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  function persistentCacheGetFresh<T>(key: string, maxAgeMs: number): T | null {
    const mem = memGet(key);
    if (mem) return mem as T;

    try {
      const row = cacheGetStmt.get(key) as { value?: string; deps?: string; updated_at?: any } | undefined;
      if (!row?.value) return null;
      const updatedAt = Number(row.updated_at ?? 0);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
      if (Date.now() - updatedAt > maxAgeMs) return null;
      const parsed = JSON.parse(row.value) as T;
      memSet(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  function persistentCacheSet(key: string, value: any, deps?: any) {
    try {
      const now = Date.now();
      cacheSetStmt.run(key, JSON.stringify(value), deps ? JSON.stringify(deps) : null, now, now);
      memSet(key, value);
    } catch {
      // ignore
    }
  }

  ensureCandlesVersionInitialized();

  // --- Portfolios / Wealth (client-facing primitives) ---
  const Currency = z.enum(['USD', 'ILS']);
  const PortfolioId = z.number().int().positive();

  ipcMain.handle('portfolios:list', async () => {
    return db
      .prepare('SELECT id, name, base_currency, strategy_ref, created_at, meta FROM portfolios ORDER BY created_at ASC, id ASC')
      .all();
  });

  ipcMain.handle('portfolios:create', async (_e, params: any) => {
    const P = z.object({
      name: z.string().trim().min(1).max(80),
      baseCurrency: Currency.default('ILS').optional(),
      strategyRef: z.string().trim().max(80).optional(),
      meta: z.any().optional(),
    });
    const p = P.parse(params || {});
    const now = Date.now();
    const info = db
      .prepare('INSERT INTO portfolios(name, base_currency, strategy_ref, created_at, meta) VALUES(?,?,?,?,?)')
      .run(p.name, p.baseCurrency ?? 'ILS', p.strategyRef ?? null, now, p.meta ? JSON.stringify(p.meta) : null);
    const id = Number(info.lastInsertRowid);
    // New portfolios should start with an empty universe.
    // Treat this as a custom universe (empty list) rather than falling back to the global default assets list.
    db.prepare('INSERT OR IGNORE INTO portfolio_states(portfolio_id, cash_base, positions_json, universe_mode, updated_at) VALUES(?,?,?,?,?)')
      .run(id, 0, JSON.stringify({}), 'custom', now);
    return { id, name: p.name, base_currency: p.baseCurrency ?? 'ILS', strategy_ref: p.strategyRef ?? null, created_at: now, meta: p.meta ? JSON.stringify(p.meta) : null };
  });

  ipcMain.handle('portfolios:update', async (_e, params: any) => {
    const P = z.object({
      id: PortfolioId,
      patch: z.object({
        name: z.string().trim().min(1).max(80).optional(),
        baseCurrency: Currency.optional(),
        strategyRef: z.string().trim().max(80).optional().nullable(),
        meta: z.any().optional().nullable(),
      }),
    });
    const p = P.parse(params || {});
    const existing = db.prepare('SELECT id FROM portfolios WHERE id=?').get(p.id) as any;
    if (!existing) throw new Error('Portfolio not found');

    const sets: string[] = [];
    const args: any[] = [];
    if (p.patch.name != null) { sets.push('name=?'); args.push(p.patch.name); }
    if (p.patch.baseCurrency != null) { sets.push('base_currency=?'); args.push(p.patch.baseCurrency); }
    if (p.patch.strategyRef !== undefined) { sets.push('strategy_ref=?'); args.push(p.patch.strategyRef ?? null); }
    if (p.patch.meta !== undefined) { sets.push('meta=?'); args.push(p.patch.meta == null ? null : JSON.stringify(p.patch.meta)); }
    if (!sets.length) return { ok: true };

    db.prepare(`UPDATE portfolios SET ${sets.join(', ')} WHERE id=?`).run(...args, p.id);
    return { ok: true };
  });

  ipcMain.handle('portfolios:delete', async (_e, portfolioId: number) => {
    const id = PortfolioId.parse(portfolioId);
    const cnt = db.prepare('SELECT COUNT(*) as c FROM portfolios').get() as { c: number };
    if (Number(cnt?.c || 0) <= 1) throw new Error('Cannot delete the last portfolio');
    db.prepare('DELETE FROM portfolios WHERE id=?').run(id);
    return { ok: true };
  });

  ipcMain.handle('portfolios:getSnapshot', async (_e, params: any) => {
    const P = z.object({ portfolioId: PortfolioId.optional() });
    const p = P.parse(params || {});
    const pid = Number(p.portfolioId ?? getDefaultPortfolioId());
    return computePortfolioSnapshot(pid);
  });

  ipcMain.handle('portfolios:universe:list', async (_e, params: any) => {
    const P = z.object({ portfolioId: PortfolioId.optional() });
    const p = P.parse(params || {});
    const pid = Number(p.portfolioId ?? getDefaultPortfolioId());
    const rows = db.prepare('SELECT ticker FROM portfolio_universe WHERE portfolio_id=? ORDER BY ticker ASC').all(pid) as Array<{ ticker: string }>;
    return rows.map(r => String(r.ticker).toUpperCase());
  });

  ipcMain.handle('portfolios:universe:getMode', async (_e, params: any) => {
    const P = z.object({ portfolioId: PortfolioId.optional() });
    const p = P.parse(params || {});
    const pid = Number(p.portfolioId ?? getDefaultPortfolioId());
    try {
      const row = db.prepare("SELECT universe_mode as mode FROM portfolio_states WHERE portfolio_id=?").get(pid) as { mode?: string } | undefined;
      const mode = String(row?.mode || 'default').toLowerCase();
      return mode === 'custom' ? 'custom' : 'default';
    } catch {
      return 'default';
    }
  });

  ipcMain.handle('portfolios:universe:addTicker', async (_e, params: any) => {
    const P = z.object({
      portfolioId: PortfolioId.optional(),
      ticker: z.string().trim().toUpperCase().min(1).max(40),
      skipPreflight: z.boolean().optional(),
    });
    const p = P.parse(params || {});
    const pid = Number(p.portfolioId ?? getDefaultPortfolioId());
    const ticker = p.ticker;

    // Pre-flight check: ensure we can fetch candles for the ticker.
    if (!p.skipPreflight) {
      try {
        const candles = await getCandles(ticker, '6M');
        if (!candles || candles.length < 5) {
          throw new Error('No candles available');
        }
      } catch {
        throw new Error(`Error: Could not fetch data for ${ticker}. Please verify the symbol.`);
      }
    }

    db.prepare('INSERT OR IGNORE INTO portfolio_universe(portfolio_id, ticker, created_at) VALUES(?,?,?)')
      .run(pid, ticker, Date.now());

    // Upsert portfolio-scoped metadata (kept separate from global seeded assets)
    try {
      const now = Date.now();
      db.prepare(
        `INSERT OR IGNORE INTO portfolio_assets(portfolio_id, ticker, name, category, yahoo_symbol, price_multiplier, created_at, updated_at, meta)
         VALUES(?,?,?,?,?,?,?,?,?)`
      ).run(pid, ticker, null, null, null, inferPriceMultiplierForTicker(ticker), now, now, null);
      db.prepare('UPDATE portfolio_assets SET updated_at=? WHERE portfolio_id=? AND ticker=?').run(now, pid, ticker);
    } catch {
      // ignore
    }

    // If we skipped preflight, prime candles + metadata in the background.
    if (p.skipPreflight) {
      enqueuePrimeCandles([ticker]);
      enqueuePrimePortfolioMeta(pid, [ticker]);
    } else {
      enqueuePrimePortfolioMeta(pid, [ticker]);
    }

    invalidatePortfolioTsmomCaches(pid);

    try { db.prepare("UPDATE portfolio_states SET universe_mode='custom' WHERE portfolio_id=?").run(pid); } catch {}
    return { ok: true };
  });

  ipcMain.handle('portfolios:universe:removeTicker', async (_e, params: any) => {
    const P = z.object({
      portfolioId: PortfolioId.optional(),
      ticker: z.string().trim().toUpperCase().min(1).max(40),
    });
    const p = P.parse(params || {});
    const pid = Number(p.portfolioId ?? getDefaultPortfolioId());
    db.prepare('DELETE FROM portfolio_universe WHERE portfolio_id=? AND ticker=?').run(pid, p.ticker);
    invalidatePortfolioTsmomCaches(pid);
    try { db.prepare("UPDATE portfolio_states SET universe_mode='custom' WHERE portfolio_id=?").run(pid); } catch {}
    return { ok: true };
  });

  ipcMain.handle('portfolios:universe:setAll', async (_e, params: any) => {
    const P = z.object({
      portfolioId: PortfolioId.optional(),
      tickers: z.array(z.string().trim().toUpperCase().min(1).max(40)).max(2000),
      skipPreflight: z.boolean().optional(),
    });
    const p = P.parse(params || {});
    const pid = Number(p.portfolioId ?? getDefaultPortfolioId());
    const now = Date.now();

    const tickers = Array.from(new Set((p.tickers || []).map(t => String(t).trim().toUpperCase()).filter(Boolean)));

    if (!p.skipPreflight) {
      for (const ticker of tickers) {
        try {
          const candles = await getCandles(ticker, '6M');
          if (!candles || candles.length < 5) throw new Error('No candles available');
        } catch {
          throw new Error(`Error: Could not fetch data for ${ticker}. Please verify the symbol.`);
        }
      }
    }

    const trx = db.transaction(() => {
      db.prepare('DELETE FROM portfolio_universe WHERE portfolio_id=?').run(pid);
      const ins = db.prepare('INSERT OR IGNORE INTO portfolio_universe(portfolio_id, ticker, created_at) VALUES(?,?,?)');
      for (const t of tickers) ins.run(pid, t, now);
    });

    trx();

    // Upsert portfolio-scoped metadata rows.
    try {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO portfolio_assets(portfolio_id, ticker, name, category, yahoo_symbol, price_multiplier, created_at, updated_at, meta)
         VALUES(?,?,?,?,?,?,?,?,?)`
      );
      const upd = db.prepare('UPDATE portfolio_assets SET updated_at=? WHERE portfolio_id=? AND ticker=?');
      for (const t of tickers) {
        ins.run(pid, t, null, null, null, inferPriceMultiplierForTicker(t), now, now, null);
        upd.run(now, pid, t);
      }
    } catch {
      // ignore
    }

    // Prime candles and metadata in the background (especially for fast add)
    if (p.skipPreflight) enqueuePrimeCandles(tickers);
    enqueuePrimePortfolioMeta(pid, tickers);

    invalidatePortfolioTsmomCaches(pid);

    if (p.skipPreflight) enqueuePrimeCandles(tickers);
    try { db.prepare("UPDATE portfolio_states SET universe_mode='custom' WHERE portfolio_id=?").run(pid); } catch {}
    return { ok: true };
  });

  // Watchlists
  ipcMain.handle("watchlists:list", () => {
    return db.prepare("SELECT id, name, created_at FROM watchlists ORDER BY created_at ASC").all();
  });

  ipcMain.handle("watchlists:create", (_e, name: string) => {
    const n = z.string().min(1).max(40).parse(name.trim());
    const stmt = db.prepare("INSERT INTO watchlists(name, created_at) VALUES (?, ?)");
    const info = stmt.run(n, Date.now());
    return { id: info.lastInsertRowid as number, name: n, created_at: Date.now() };
  });

  ipcMain.handle("watchlists:rename", (_e, { id, name }) => {
    const i = z.number().int().positive().parse(id);
    const n = z.string().min(1).max(40).parse(name.trim());
    db.prepare("UPDATE watchlists SET name=? WHERE id=?").run(n, i);
  });

  ipcMain.handle("watchlists:delete", (_e, id: number) => {
    const i = z.number().int().positive().parse(id);
    db.prepare("DELETE FROM watchlists WHERE id=?").run(i);
  });

  ipcMain.handle("watchlists:symbols", (_e, watchlistId: number) => {
    const i = z.number().int().positive().parse(watchlistId);
    const rows = db.prepare("SELECT symbol FROM watchlist_symbols WHERE watchlist_id=? ORDER BY symbol ASC").all(i) as {symbol: string}[];
    return rows.map(r => r.symbol);
  });

  ipcMain.handle("watchlists:addSymbol", (_e, { watchlistId, symbol }) => {
    const i = z.number().int().positive().parse(watchlistId);
    const s = z.string().trim().toUpperCase().min(1).max(15).parse(symbol);
    db.prepare("INSERT OR IGNORE INTO watchlist_symbols(watchlist_id, symbol) VALUES (?, ?)").run(i, s);
  });

  ipcMain.handle("watchlists:removeSymbol", (_e, { watchlistId, symbol }) => {
    const i = z.number().int().positive().parse(watchlistId);
    const s = z.string().trim().toUpperCase().min(1).max(15).parse(symbol);
    db.prepare("DELETE FROM watchlist_symbols WHERE watchlist_id=? AND symbol=?").run(i, s);
  });

  // Candles / Ticker
  ipcMain.handle("candles:get", async (_e, { symbol, range }) => {
    const s = z.string().trim().toUpperCase().min(1).max(15).parse(symbol);
    const r = z.enum(["1M","6M","1Y","5Y"]).parse(range ?? "1Y");
    const candles = await getCandles(s, r);
    // also scan for signals when fresh candles are available
    scanGoldenCrossForSymbol(s);
    return candles;
  });

  ipcMain.handle("candles:getByInterval", async (_e, { symbol, interval }) => {
    const s = z.string().trim().toUpperCase().min(1).max(15).parse(symbol);
    const iv = z.enum(["4h","1d","1wk","1mo"]).parse(interval);
    console.log('[IPC] candles:getByInterval', { symbol: s, interval: iv });
    return await getCandlesByInterval(s, iv);
  });

  ipcMain.handle("indicators:get", async (_e, { symbol, interval }) => {
    const s = z.string().trim().toUpperCase().min(1).max(15).parse(symbol);
    const iv = z.enum(["4h","1d","1wk","1mo"]).parse(interval);
    console.log('[IPC] indicators:get', { symbol: s, interval: iv });
    const { candles } = await getCandlesByInterval(s, iv);
    return computeOverlaysAndSnapshot(candles);
  });

  // Full indicator bundle for export/debugging
  ipcMain.handle("indicators:bundle", async (_e, { symbol, interval }) => {
    const s = z.string().trim().toUpperCase().min(1).max(15).parse(symbol);
    const iv = z.enum(["4h","1d","1wk","1mo"]).parse(interval);
    console.log('[IPC] indicators:bundle', { symbol: s, interval: iv });
    const { candles } = await getCandlesByInterval(s, iv);
    // Use defaults for now; future: allow overrides via params
    const bundle = buildIndicatorBundle(candles, { emaPeriods: [20,50,100,200], bb: { period: 20, mult: 2 }, rsiPeriod: 14, macd: { fast: 12, slow: 26, signal: 9 }, atrPeriod: 14, donchianPeriod: 20, bbWidthRankLookback: 120 });
    return { candles, bundle };
  });

  ipcMain.handle("strategies:get", async (_e, { symbol, interval }) => {
    const s = z.string().trim().toUpperCase().min(1).max(15).parse(symbol);
    const iv = z.enum(["4h","1d","1wk","1mo"]).parse(interval);
    const { candles } = await getCandlesByInterval(s, iv);
    return evaluateStrategies(candles);
  });

  ipcMain.handle("strategies:diagnostics", async (_e, { symbol }) => {
    const s = z.string().trim().toUpperCase().min(1).max(15).parse(symbol);
    const { candles } = await getCandlesByInterval(s, '1d');
    const signalsEnabled = evaluateStrategies(candles);
    const signalsAll = evaluateStrategies(candles, { useAll: true });
    const enabledSet = new Set(signalsEnabled.map(sig=>sig.name));
    const allSet = new Set(signalsAll.map(sig=>sig.name));
    const registry = ALL_STRATEGY_IDS.map(id => ({ id, produced: signalsAll.filter(g=>g.name===id).length, enabledProduced: signalsEnabled.filter(g=>g.name===id).length }));
    return { totalEnabledSignals: signalsEnabled.length, totalAllSignals: signalsAll.length, strategies: registry, missingFromAll: ALL_STRATEGY_IDS.filter(id=>!allSet.has(id)), symbol: s };
  });

  // market:getTrending
  // Data contract:
  // Params: { list: 'gainers' | 'losers' | 'active', limit?: number }
  // Returns: TrendingItem[] where TrendingItem = { symbol, price, changePct, volume }
  // Implementation: derive from last two daily candles per symbol; volume from latest bar.
  ipcMain.handle('market:getTrending', async (_e, params) => {
    const P = z.object({ list: z.enum(['gainers','losers','active']), limit: z.number().int().positive().max(50).default(12).optional() });
    const p = P.parse(params||{});
    const key = `${p.list}:${p.limit||12}`;
    const now = Date.now();
    const cached = TRENDING_CACHE[key];
    if (cached && (now - cached.ts) < TRENDING_TTL_MS) return cached.data.slice(0, p.limit || 12);
    try {
      // Get symbol universe (limit to keep fast)
      const symbolsRows = db.prepare("SELECT DISTINCT symbol FROM candles WHERE timeframe='1d' LIMIT 800").all() as { symbol: string }[];
      const out: TrendingItem[] = [];
      const twoStmt = db.prepare("SELECT ts, close, volume FROM candles WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 2");
      for (const r of symbolsRows) {
        const bars = twoStmt.all(r.symbol) as { ts: number; close: number; volume: number }[];
        if (bars.length < 1) continue;
        const latest = bars[0];
        const prev = bars[1];
        if (!prev) continue; // need two for pct change
        if (!Number.isFinite(latest.close) || !Number.isFinite(prev.close) || prev.close === 0) continue;
        const changePct = ((latest.close - prev.close) / prev.close) * 100;
        out.push({ symbol: r.symbol, price: latest.close, changePct, volume: latest.volume });
      }
      let sorted: TrendingItem[];
      if (p.list === 'gainers') sorted = out.sort((a,b)=>b.changePct - a.changePct);
      else if (p.list === 'losers') sorted = out.sort((a,b)=>a.changePct - b.changePct);
      else sorted = out.sort((a,b)=>b.volume - a.volume); // 'active'
      const limited = sorted.slice(0, p.limit || 12);
      TRENDING_CACHE[key] = { ts: now, data: limited };
      return limited;
    } catch (e:any) {
      console.warn('[market:getTrending] failed', e?.message||e);
      return [];
    }
  });

  // Backtests v1 (ticker-based)
  ipcMain.handle('backtests:runTicker', async (_e, params: { ticker: string; minRRGlobal?: number; minRROverrides?: Record<string, number>; side?: 'BOTH'|'LONG'|'SHORT' }) => {
    const P = z.object({
      ticker: z.string().toUpperCase().min(1).max(15),
      minRRGlobal: z.number().min(0).max(5).optional(),
      minRROverrides: z.record(z.number().min(0).max(5)).optional(),
      side: z.enum(['BOTH','LONG','SHORT']).optional()
    });
    const p = P.parse(params);
    const { runId } = await runTickerBacktest({ ticker: p.ticker, minRRGlobal: p.minRRGlobal, minRROverrides: p.minRROverrides, side: p.side });
    return { runId };
  });

  ipcMain.handle('backtests:getLatestForTicker', async (_e, params: { ticker: string }) => {
    const P = z.object({ ticker: z.string().toUpperCase().min(1).max(15) });
    const p = P.parse(params);
    const res = getLatestForTicker(p.ticker);
    return res;
  });

  // --- TSMOM Command Center ---
  ipcMain.handle('tsmom:get-universe', async (_e, params: any) => {
    const P = z.object({ portfolioId: z.number().int().positive().optional() });
    const p = P.parse(params || {});
    const pid = Number(p.portfolioId ?? getDefaultPortfolioId());

    const cacheKey = `tsmom:universe:p:${pid}`;
    const cached = persistentCacheGet<any[]>(cacheKey);
    if (cached) return cached;

    // TSMOM universe is now strictly portfolio-based.
    // We do not use the legacy global `assets` table for calculations.
    try {
      db.prepare("UPDATE portfolio_states SET universe_mode='custom' WHERE portfolio_id=?").run(pid);
    } catch {
      // ignore
    }

    const rows = db
      .prepare(
        `SELECT u.ticker as ticker,
                pa.name as name,
                pa.category as category,
                'active' as status,
                pa.yahoo_symbol as yahoo_symbol,
                COALESCE(pa.price_multiplier,
                  CASE WHEN UPPER(u.ticker) LIKE '%.TA' THEN 0.01 ELSE 1 END
                ) as price_multiplier,
                COALESCE(pa.created_at, u.created_at) as created_at,
                COALESCE(pa.updated_at, u.created_at) as updated_at,
                pa.meta as meta
         FROM portfolio_universe u
         LEFT JOIN portfolio_assets pa ON pa.portfolio_id=u.portfolio_id AND pa.ticker=u.ticker
         WHERE u.portfolio_id=?
         ORDER BY category, ticker`
      )
      .all(pid);

    persistentCacheSet(cacheKey, rows);
    return rows;
  });

  ipcMain.handle('tsmom:compute-plan', async (_e, params: any) => {
    const P = z.object({ portfolioId: z.number().int().positive().optional() });
    const p = P.parse(params || {});
    const portfolioId = Number(p.portfolioId ?? getDefaultPortfolioId());
    return await computeTsmomTurboV2Plan({ portfolioId });
  });

  ipcMain.handle('tsmom:get-signal-matrix', async (_e, params: any) => {
    const P = z.object({ portfolioId: z.number().int().positive().optional() });
    const p = P.parse(params || {});
    const pid = p.portfolioId != null ? Number(p.portfolioId) : null;
    const cacheKey = pid ? `tsmom:signal:p:${pid}` : 'tsmom:signal:global';
    const candlesVersionMsBefore = getCandlesVersionMs();
    const cached = persistentCacheGet<any>(cacheKey, { candlesVersionMs: candlesVersionMsBefore });
    if (cached) return cached;
    const data = await computeTsmomSignalMatrix(pid ? { portfolioId: pid } : undefined);
    // Important: computing the matrix may fetch/insert candles, which bumps candles_version_ms.
    // Store deps AFTER compute so the cache is immediately usable.
    const candlesVersionMsAfter = getCandlesVersionMs();
    persistentCacheSet(cacheKey, data, { candlesVersionMs: candlesVersionMsAfter });
    return data;
  });

  ipcMain.handle('tsmom:get-performance', async (_e, params: any) => {
    const P = z.object({
      portfolioId: z.number().int().positive().optional(),
      years: z.number().int().positive().max(10).optional(),
      benchmark: z.string().trim().max(40).optional().nullable(),
    });
    const p = P.parse(params || {});
    const portfolioId = Number(p.portfolioId ?? getDefaultPortfolioId());
    return await computeTsmomPerformanceSeries({ portfolioId, years: p.years, benchmark: p.benchmark ?? null });
  });

  ipcMain.handle('tsmom:sandbox-run', async (_e, params: any) => {
    const P = z.object({
      years: z.number().int().positive().max(10).optional(),
      benchmark: z.string().trim().max(40).optional().nullable(),
      params: z.object({
        lookbackTradingDays: z.number().int().positive().max(2000).optional(),
        skipRecentTradingDays: z.number().int().min(0).max(365).optional(),
        volCenterDaysCOM: z.number().int().positive().max(365).optional(),
        targetVolAnn: z.number().positive().max(5).optional(),
        topK: z.number().int().positive().max(50).optional(),
        maxLeverage: z.number().positive().max(50).optional(),
        commissionNIS: z.number().min(0).max(500).optional(),
      }).optional(),
    });
    const p = P.parse(params || {});
    return await runTsmomSandbox({ years: p.years, benchmark: p.benchmark ?? null, params: p.params });
  });

  ipcMain.handle('tsmom:sandbox-compare', async (_e, params: any) => {
    const One = z.object({
      label: z.string().trim().min(1).max(60),
      params: z.object({
        lookbackTradingDays: z.number().int().positive().max(2000).optional(),
        skipRecentTradingDays: z.number().int().min(0).max(365).optional(),
        volCenterDaysCOM: z.number().int().positive().max(365).optional(),
        targetVolAnn: z.number().positive().max(5).optional(),
        topK: z.number().int().positive().max(50).optional(),
        maxLeverage: z.number().positive().max(50).optional(),
        commissionNIS: z.number().min(0).max(500).optional(),
      }),
    });
    const P = z.object({ years: z.number().int().positive().max(10).optional(), benchmark: z.string().trim().max(40).optional().nullable(), runs: z.array(One).min(1).max(12) });
    const p = P.parse(params || {});

    const out: any[] = [];
    for (const r of p.runs) {
      const res = await runTsmomSandbox({ years: p.years, benchmark: p.benchmark ?? null, params: r.params });
      out.push({ label: r.label, ...res });
    }
    return { benchmark: p.benchmark ?? null, years: p.years ?? 5, results: out };
  });

  // --- TSMOM sandbox: EA portfolio backtest (isolated; does NOT touch wealth tables) ---
  ipcMain.handle('tsmom:sandbox-ea-run', async (_e, params: any) => {
    const P = z.object({
      portfolioId: z.number().int().positive(),
      tickers: z.array(z.string().trim().toUpperCase().min(1).max(40)).min(1).max(500),
      yearsBack: z.number().int().positive().max(10).optional(),
      startCapital: z.number().positive().max(1e9),
      benchmark: z.string().trim().max(40).optional().nullable(),
      params: z.object({
        lookbackTradingDays: z.number().int().positive().max(2000).optional(),
        skipRecentTradingDays: z.number().int().min(0).max(365).optional(),
        volCenterDaysCOM: z.number().int().positive().max(365).optional(),
        targetVolAnn: z.number().positive().max(5).optional(),
        topK: z.number().int().positive().max(50).optional(),
        maxLeverage: z.number().positive().max(50).optional(),
        commissionBase: z.number().min(0).max(500).optional(),
        rebalanceEveryTradingDays: z.number().int().positive().max(90).optional(),
      }).optional(),
    });

    const p = P.parse(params || {});
    return await runEaPortfolioSandboxBacktest({
      portfolioId: p.portfolioId,
      tickers: p.tickers,
      yearsBack: p.yearsBack,
      startCapital: p.startCapital,
      benchmark: p.benchmark ?? null,
      params: p.params,
    });
  });

  ipcMain.handle('tsmom:sandbox-ea-recordbook', async (_e, params: any) => {
    const P = z.object({ runId: z.number().int().positive() });
    const p = P.parse(params || {});
    const run = db.prepare(`
      SELECT id, portfolio_id, created_at, start_ts, end_ts, valuation_ts, base_currency, start_capital_base, params_json, meta
      FROM tsmom_sandbox_runs
      WHERE id=?
    `).get(p.runId);
    if (!run) throw new Error('Sandbox run not found');

    const trades = db.prepare(`
      SELECT id, ts, symbol, side, qty, price_base, notional_base, fee_base, strategy_tag, meta
      FROM tsmom_sandbox_trades
      WHERE run_id=?
      ORDER BY ts DESC, id DESC
      LIMIT 5000
    `).all(p.runId);

    const ledger = db.prepare(`
      SELECT id, ts, amount, type, description, meta
      FROM tsmom_sandbox_ledger
      WHERE run_id=?
      ORDER BY ts DESC, id DESC
      LIMIT 5000
    `).all(p.runId);

    return { run, trades, ledger };
  });

  ipcMain.handle('tsmom:execute-trades', async (_e, params: any) => {
    const Trade = z.object({
      ticker: z.string().trim().toUpperCase().min(1).max(40),
      side: z.enum(['BUY','SELL']),
      qty: z.number().positive(), // actual executed qty
      price: z.number().positive(), // actual executed price (in trade currency)
      tradeCurrency: z.enum(['USD','ILS']).optional(),
      fxRate: z.number().positive().optional(),
      notionalBase: z.number().nonnegative().optional(), // gross value in portfolio base currency
      feeBase: z.number().nonnegative().optional(),
      meta: z.any().optional(),
    });

    const CashFlow = z.object({
      ts: z.number().int().positive(),
      amount: z.number(),
      type: z.enum(['DEPOSIT','WITHDRAWAL','ADJUSTMENT']),
      description: z.string().max(240).optional(),
      meta: z.any().optional(),
    });

    const P = z.object({
      portfolioId: z.number().int().positive().optional(),
      ts: z.number().int().positive(),
      strategyTag: z.string().max(40).optional(),
      notes: z.string().max(500).optional(),
      commissionNIS: z.number().nonnegative().max(500).optional(), // legacy name
      commissionBase: z.number().nonnegative().max(500).optional(),
      trades: z.array(Trade).min(1),
      cashFlows: z.array(CashFlow).optional(),
    });

    const p = P.parse(params);
    const portfolioId = Number(p.portfolioId ?? getDefaultPortfolioId());
    const baseCurrency = getPortfolioBaseCurrency(portfolioId);
    // Fees are recorded for the trade ledger / record book, but should not be assumed.
    // If not supplied, default to 0 (caller can set explicit fees elsewhere).
    const defaultFeeBase = Number(p.commissionBase ?? p.commissionNIS ?? 0);

    const insTrade = db.prepare(`
      INSERT INTO portfolio_trades(portfolio_id, symbol, side, qty, price, trade_currency, fx_rate, notional_base, fee_base, ts, fee, strategy_tag, notes, meta)
      VALUES(@portfolio_id, @symbol, @side, @qty, @price, @trade_currency, @fx_rate, @notional_base, @fee_base, @ts, @fee, @strategy_tag, @notes, @meta)
    `);

    const insLedger = db.prepare(`
      INSERT INTO capital_ledger(portfolio_id, ts, amount, currency, fx_rate, type, description, meta)
      VALUES(@portfolio_id, @ts, @amount, @currency, @fx_rate, @type, @description, @meta)
    `);

    const trx = db.transaction(() => {
      const appliedTrades: Array<{ ticker: string; side: 'BUY'|'SELL'; qty: number; notionalBase: number; feeBase: number }> = [];

      for (const t of p.trades) {
        const tradeCurrency = (t.tradeCurrency || baseCurrency);
        const fxRate = t.fxRate;

        let notionalBase = Number(t.notionalBase);
        if (!Number.isFinite(notionalBase) || notionalBase < 0) {
          const grossTrade = Number(t.qty) * Number(t.price);
          if (tradeCurrency === baseCurrency) {
            notionalBase = grossTrade;
          } else {
            if (!Number.isFinite(Number(fxRate)) || Number(fxRate) <= 0) {
              throw new Error(`Missing fxRate for ${t.ticker} trade (${tradeCurrency}->${baseCurrency}). Provide notionalBase or fxRate.`);
            }
            notionalBase = grossTrade * Number(fxRate);
          }
        }

        const feeBase = Number.isFinite(Number(t.feeBase)) ? Number(t.feeBase) : defaultFeeBase;
        const legacyFee = (baseCurrency === 'ILS' && feeBase > 0) ? feeBase : null;

        insTrade.run({
          portfolio_id: portfolioId,
          symbol: t.ticker,
          side: t.side,
          qty: t.qty,
          price: t.price,
          trade_currency: tradeCurrency,
          fx_rate: (tradeCurrency === baseCurrency) ? null : (Number.isFinite(Number(fxRate)) ? Number(fxRate) : null),
          notional_base: notionalBase,
          fee_base: feeBase,
          ts: p.ts,
          fee: legacyFee,
          strategy_tag: p.strategyTag || null,
          notes: p.notes || null,
          meta: t.meta ? JSON.stringify(t.meta) : null,
        });

        appliedTrades.push({ ticker: t.ticker, side: t.side, qty: t.qty, notionalBase, feeBase });
      }

      for (const c of p.cashFlows || []) {
        insLedger.run({
          portfolio_id: portfolioId,
          ts: c.ts,
          amount: c.amount,
          currency: baseCurrency,
          fx_rate: null,
          type: c.type,
          description: c.description || null,
          meta: c.meta ? JSON.stringify(c.meta) : null,
        });
        applyLedgerToState({ portfolioId, deltaCashBase: Number(c.amount || 0), ts: c.ts });
      }

      applyTradesToState({
        portfolioId,
        ts: p.ts,
        trades: appliedTrades.map(t => ({
          ticker: t.ticker,
          side: t.side,
          qty: t.qty,
          notionalBase: t.notionalBase,
          feeBase: t.feeBase,
        })),
      });
    });

    trx();
    return { ok: true };
  });

  ipcMain.handle('tsmom:list-ledger', async (_e, params: any) => {
    const P = z.object({
      portfolioId: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(2000).optional(),
    });
    const p = P.parse(params || {});
    const portfolioId = Number(p.portfolioId ?? getDefaultPortfolioId());
    const limit = p.limit ?? 500;
    return db
      .prepare('SELECT id, ts, amount, type, description, meta, currency, fx_rate, portfolio_id FROM capital_ledger WHERE portfolio_id=? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(portfolioId, limit);
  });

  ipcMain.handle('tsmom:add-ledger-entry', async (_e, params: any) => {
    const P = z.object({
      portfolioId: z.number().int().positive().optional(),
      ts: z.number().int().positive().optional(),
      amount: z.number(),
      type: z.enum(['DEPOSIT','WITHDRAWAL','ADJUSTMENT']),
      description: z.string().max(240).optional(),
      meta: z.any().optional(),
    });
    const p = P.parse(params);
    const portfolioId = Number(p.portfolioId ?? getDefaultPortfolioId());
    const baseCurrency = getPortfolioBaseCurrency(portfolioId);
    const ts = Number(p.ts ?? Date.now());
    const info = db
      .prepare('INSERT INTO capital_ledger(portfolio_id, ts, amount, currency, fx_rate, type, description, meta) VALUES(?,?,?,?,?,?,?,?)')
      .run(
        portfolioId,
        ts,
        p.amount,
        baseCurrency,
        null,
        p.type,
        p.description || null,
        p.meta ? JSON.stringify(p.meta) : null,
      );

    applyLedgerToState({ portfolioId, deltaCashBase: Number(p.amount || 0), ts });
    return { id: Number(info.lastInsertRowid), ts };
  });

  ipcMain.handle('tsmom:delete-ledger-entry', async (_e, ledgerId: number) => {
    const id = z.number().int().positive().parse(ledgerId);
    const row = db.prepare('SELECT portfolio_id FROM capital_ledger WHERE id=?').get(id) as any;
    db.prepare('DELETE FROM capital_ledger WHERE id=?').run(id);
    // Deletes are admin operations; rebuild cached state for correctness.
    const pid = Number(row?.portfolio_id || getDefaultPortfolioId());
    rebuildPortfolioStateFromHistory(pid);
    return { ok: true };
  });

  ipcMain.handle('tsmom:list-trades', async (_e, params: any) => {
    const P = z.object({
      portfolioId: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(2000).optional(),
      strategyTagPrefix: z.string().trim().max(40).optional(),
    });
    const p = P.parse(params || {});
    const portfolioId = Number(p.portfolioId ?? getDefaultPortfolioId());
    const limit = p.limit ?? 500;

    if (p.strategyTagPrefix) {
      const like = `${p.strategyTagPrefix.toUpperCase()}%`;
      return db
        .prepare(`
          SELECT id, symbol, side, qty, price, trade_currency, fx_rate, notional_base, fee, fee_base, ts, strategy_tag, notes, meta
          FROM portfolio_trades
          WHERE portfolio_id=? AND strategy_tag LIKE ?
          ORDER BY ts DESC, id DESC
          LIMIT ?
        `)
        .all(portfolioId, like, limit);
    }

    return db
      .prepare(`
        SELECT id, symbol, side, qty, price, trade_currency, fx_rate, notional_base, fee, fee_base, ts, strategy_tag, notes, meta
        FROM portfolio_trades
        WHERE portfolio_id=?
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `)
      .all(portfolioId, limit);
  });

  ipcMain.handle('tsmom:update-trade-notes', async (_e, params: any) => {
    const P = z.object({
      tradeId: z.number().int().positive(),
      notes: z.string().max(2000).nullable().optional(),
    });
    const p = P.parse(params || {});

    const row = db.prepare('SELECT id FROM portfolio_trades WHERE id=?').get(p.tradeId) as any;
    if (!row) throw new Error(`Trade not found: ${p.tradeId}`);

    db.prepare('UPDATE portfolio_trades SET notes=? WHERE id=?').run(p.notes ?? null, p.tradeId);
    return { ok: true };
  });

  ipcMain.handle('tsmom:list-sync-runs', async (_e, params: any) => {
    const P = z.object({ limit: z.number().int().positive().max(2000).optional() });
    const p = P.parse(params || {});
    const limit = p.limit ?? 50;
    return db
      .prepare(`
        SELECT id, started_at, finished_at, assets, updated, status, warnings, meta
        FROM tsmom_sync_runs
        ORDER BY started_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit);
  });

  ipcMain.handle('tsmom:list-price-flags', async (_e, params: any) => {
    const P = z.object({
      limit: z.number().int().positive().max(5000).optional(),
      onlyUnacknowledged: z.boolean().optional(),
      types: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
      ticker: z.string().trim().toUpperCase().min(1).max(40).optional(),
    });
    const p = P.parse(params || {});
    const limit = p.limit ?? 200;

    const where: string[] = [];
    const args: any[] = [];
    if (p.onlyUnacknowledged) where.push('acknowledged_at IS NULL');
    if (p.ticker) {
      where.push('ticker = ?');
      args.push(p.ticker);
    }
    if (p.types?.length) {
      where.push(`type IN (${p.types.map(() => '?').join(',')})`);
      args.push(...p.types);
    }

    const sql = `
      SELECT id, ticker, ts, type, severity, message, move_pct, prev_close, close, acknowledged_at, meta
      FROM tsmom_price_flags
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `;

    return db.prepare(sql).all(...args, limit);
  });

  ipcMain.handle('tsmom:ack-price-flag', async (_e, flagId: number) => {
    const id = z.number().int().positive().parse(flagId);
    db.prepare('UPDATE tsmom_price_flags SET acknowledged_at=? WHERE id=?').run(Date.now(), id);
    return { ok: true };
  });

  ipcMain.handle('tsmom:apply-corp-action', async (_e, params: any) => {
    const P = z.object({ flagId: z.number().int().positive() });
    const p = P.parse(params || {});

    const flag = db.prepare(`
      SELECT id, ticker, ts, type, prev_close, close, meta
      FROM tsmom_price_flags
      WHERE id=?
    `).get(p.flagId) as any;

    if (!flag) throw new Error('Flag not found');
    if (String(flag.type) !== 'CORP_ACTION_SUSPECT') throw new Error('Flag is not a corporate action suspect');

    const ticker = String(flag.ticker).toUpperCase();
    const cutoffTs = Number(flag.ts);
    const prevClose = Number(flag.prev_close);
    const close = Number(flag.close);

    let factor: number | null = null;
    try {
      const meta = flag.meta ? JSON.parse(String(flag.meta)) : null;
      const suggested = Number(meta?.suggestedScaleBeforeFactor);
      if (Number.isFinite(suggested) && suggested > 0) factor = suggested;
    } catch {
      // ignore
    }
    if (factor == null) {
      if (!Number.isFinite(prevClose) || !Number.isFinite(close) || prevClose <= 0 || close <= 0) {
        throw new Error('Flag does not include valid prev_close/close to derive factor');
      }
      factor = close / prevClose;
    }

    if (!Number.isFinite(factor) || factor <= 0) throw new Error('Invalid adjustment factor');
    if (Math.abs(1 - factor) < 0.05) throw new Error('Factor too close to 1; refusing to apply');

    const upd = db.prepare(`
      UPDATE candles
      SET
        open = open * @f,
        high = high * @f,
        low = low * @f,
        close = close * @f,
        volume = CASE WHEN @f != 0 THEN volume / @f ELSE volume END
      WHERE symbol = @ticker AND timeframe='1d' AND ts < @cutoff
    `);

    const now = Date.now();

    const trx = db.transaction(() => {
      const info = upd.run({ f: factor, ticker, cutoff: cutoffTs });

      let nextMeta: any = {};
      try { nextMeta = flag.meta ? JSON.parse(String(flag.meta)) : {}; } catch { nextMeta = {}; }
      nextMeta.appliedAt = now;
      nextMeta.appliedFactor = factor;
      nextMeta.appliedCutoffTs = cutoffTs;

      db.prepare('UPDATE tsmom_price_flags SET acknowledged_at=?, meta=? WHERE id=?')
        .run(now, JSON.stringify(nextMeta), p.flagId);

      return { changes: Number((info as any).changes || 0) };
    });

    const res = trx();
    return { ok: true, ticker, factor, cutoffTs, updatedCandles: res.changes };
  });

  ipcMain.handle('tsmom:get-sync-status', async () => {
    const last = db.prepare(`
      SELECT id, started_at, finished_at, assets, updated, status, warnings
      FROM tsmom_sync_runs
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get();
    const openFlags = db.prepare(`
      SELECT COUNT(*) AS c FROM tsmom_price_flags WHERE acknowledged_at IS NULL
    `).get() as { c: number };
    return { lastRun: last || null, openFlags: Number(openFlags?.c || 0) };
  });

  // Engine config snapshot for export
  ipcMain.handle('engine:getConfig', async () => {
    try {
      // Lazy import to avoid circulars
      const { loadEngineConfig } = await import('./services/config/engineConfig.js');
      const cfg = loadEngineConfig();
      return cfg;
    } catch (e:any) {
      console.warn('[engine:getConfig] failed', e?.message || e);
      return {};
    }
  });

  // Quotes
  ipcMain.handle("quotes:get", async (_e, symbols: string[]) => {
    const arr = z.array(z.string().trim().toUpperCase().min(1).max(15)).parse(symbols);
    // Persisted quotes cache (prevents refetching on screen switches)
    const QUOTES_TTL_MS = 5 * 60 * 1000;
    const out: any[] = [];
    for (const sym of arr) {
      const key = `quote:${sym}`;
      const cached = persistentCacheGetFresh<any>(key, QUOTES_TTL_MS);
      if (cached) {
        out.push(cached);
        continue;
      }
      const q = await getQuoteSafe(sym);
      // Ensure we preserve the original requested symbol as the key
      const normalized = q && typeof q === 'object' ? { ...q, symbol: sym } : q;
      persistentCacheSet(key, normalized);
      out.push(normalized);
    }
    return out;
  });

  // Logos
  ipcMain.handle("logos:get", async (_e, symbol: string) => {
    const s = z.string().trim().toUpperCase().min(1).max(20).parse(symbol);
    return await getLogo(s);
  });

  // Signals
  ipcMain.handle("signals:list", () => {
    return db.prepare("SELECT id, symbol, type, ts, meta FROM signals ORDER BY ts DESC").all();
  });
  ipcMain.handle("signals:scanAll", () => {
    scanAllSymbols();
  });

  // Signals scanning (cards per watchlist)
  ipcMain.handle("signals:scanWatchlists", async (_e, filters: any) => {
    const F = z.object({
      watchlistId: z.number().int().positive().optional(),
      timeframe: z.enum(["4h","1d","1wk","1mo"]),
      direction: z.enum(["LONG","SHORT"]).optional(),
      strategy: z.string().max(60).optional(),
      minConfidence: z.number().min(0).max(100).optional(),
      minRR: z.number().min(0).max(10).optional()
    });
    const f = F.parse(filters);
    return await scanWatchlistsSignals(f as any);
  });

  // Portfolio
  ipcMain.handle("portfolio:addTrade", (_e, trade) => {
    const T = z.object({
      symbol: z.string().toUpperCase(),
      side: z.enum(["BUY","SELL"]),
      qty: z.number().positive(),
      price: z.number().positive(),
      ts: z.number().int().positive()
    });
    const t = T.parse(trade);
    const portfolioId = getDefaultPortfolioId();
    db.prepare("INSERT INTO portfolio_trades(portfolio_id, symbol, side, qty, price, ts, notional_base, trade_currency, fee_base) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(portfolioId, t.symbol, t.side, t.qty, t.price, t.ts, Number(t.qty) * Number(t.price), null, 0);
    applyTradesToState({
      portfolioId,
      ts: t.ts,
      trades: [{ ticker: t.symbol, side: t.side, qty: t.qty, notionalBase: Number(t.qty) * Number(t.price), feeBase: 0 }],
    });
  });

  ipcMain.handle("portfolio:listTrades", () => {
    const portfolioId = getDefaultPortfolioId();
    return db.prepare("SELECT id, symbol, side, qty, price, ts FROM portfolio_trades WHERE portfolio_id=? ORDER BY ts DESC").all(portfolioId);
  });

  ipcMain.handle("portfolio:deleteTrade", (_e, tradeId: number) => {
    const id = z.number().int().positive().parse(tradeId);
    const row = db.prepare('SELECT portfolio_id FROM portfolio_trades WHERE id=?').get(id) as any;
    db.prepare("DELETE FROM portfolio_trades WHERE id=?").run(id);
    const pid = Number(row?.portfolio_id || getDefaultPortfolioId());
    rebuildPortfolioStateFromHistory(pid);
  });

  ipcMain.handle("portfolio:positions", () => {
    // Aggregate qty & avgPrice, fetch last close from DB
    const portfolioId = getDefaultPortfolioId();
    const trades = db.prepare("SELECT symbol, side, qty, price FROM portfolio_trades WHERE portfolio_id=?").all(portfolioId) as any[];
    const map: Record<string, { qty: number; cost: number }> = {};
    for (const t of trades) {
      const s = t.symbol as string;
      if (!map[s]) map[s] = { qty: 0, cost: 0 };
      const signedQty = t.side === "BUY" ? t.qty : -t.qty;
      map[s].qty += signedQty;
      map[s].cost += t.price * signedQty;
    }
    const out: any[] = [];
    for (const [symbol, { qty, cost }] of Object.entries(map)) {
      if (qty === 0) continue;
      const avg = cost / qty;
      const lastRow = db.prepare(`
        SELECT close FROM candles WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 1
      `).get(symbol) as { close?: number } | undefined;
      const lastClose = lastRow?.close ?? undefined;
      const pnl = lastClose ? (lastClose - avg) * qty : undefined;
      out.push({ symbol, qty, avgPrice: avg, lastClose, pnl });
    }
    return out;
  });
}
