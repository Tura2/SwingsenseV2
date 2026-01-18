import { ipcMain } from "electron";
import { getDB } from "./db.js";
import { z } from "zod";
import { getCandles, getCandlesByInterval } from "./services/market.js";
import { getQuotes } from "./services/quotes.js";
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
import { applyLedgerToState, applyTradesToState, getDefaultPortfolioId, rebuildPortfolioStateFromHistory } from './services/wealth/portfolioState.js';
import { computePortfolioSnapshot, getPortfolioBaseCurrency } from './services/wealth/portfolioSnapshot.js';
// Backtest engine removed; stale imports deleted
// --- Trending cache (60s TTL) ---
interface TrendingItem { symbol: string; price: number; changePct: number; volume: number; }
interface CacheEntry { ts: number; data: TrendingItem[]; }
const TRENDING_CACHE: Record<string, CacheEntry> = {};
const TRENDING_TTL_MS = 60_000;

export function registerIpcHandlers() {
  const db = getDB();

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
    db.prepare('INSERT OR IGNORE INTO portfolio_states(portfolio_id, cash_base, positions_json, updated_at) VALUES(?,?,?,?)')
      .run(id, 0, JSON.stringify({}), now);
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
    if (id === getDefaultPortfolioId()) throw new Error('Refusing to delete default portfolio');
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

  ipcMain.handle('portfolios:universe:addTicker', async (_e, params: any) => {
    const P = z.object({
      portfolioId: PortfolioId.optional(),
      ticker: z.string().trim().toUpperCase().min(1).max(40),
    });
    const p = P.parse(params || {});
    const pid = Number(p.portfolioId ?? getDefaultPortfolioId());
    const ticker = p.ticker;

    // Pre-flight check: ensure we can fetch candles for the ticker.
    try {
      const candles = await getCandles(ticker, '6M');
      if (!candles || candles.length < 5) {
        throw new Error('No candles available');
      }
    } catch {
      throw new Error(`Error: Could not fetch data for ${ticker}. Please verify the symbol.`);
    }

    db.prepare('INSERT OR IGNORE INTO portfolio_universe(portfolio_id, ticker, created_at) VALUES(?,?,?)')
      .run(pid, ticker, Date.now());
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
  ipcMain.handle('tsmom:get-universe', async () => {
    return db
      .prepare("SELECT ticker, name, category, status, yahoo_symbol, price_multiplier, created_at, updated_at, meta FROM assets ORDER BY category, ticker")
      .all();
  });

  ipcMain.handle('tsmom:compute-plan', async (_e, params: any) => {
    const P = z.object({ portfolioId: z.number().int().positive().optional() });
    const p = P.parse(params || {});
    const portfolioId = Number(p.portfolioId ?? getDefaultPortfolioId());
    return await computeTsmomTurboV2Plan({ portfolioId });
  });

  ipcMain.handle('tsmom:get-signal-matrix', async () => {
    return await computeTsmomSignalMatrix();
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
      commissionNIS: z.number().positive().max(500).optional(), // legacy name
      commissionBase: z.number().positive().max(500).optional(),
      trades: z.array(Trade).min(1),
      cashFlows: z.array(CashFlow).optional(),
    });

    const p = P.parse(params);
    const portfolioId = Number(p.portfolioId ?? getDefaultPortfolioId());
    const baseCurrency = getPortfolioBaseCurrency(portfolioId);
    const defaultFeeBase = Number(p.commissionBase ?? p.commissionNIS ?? 5);

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
        const legacyFee = baseCurrency === 'ILS' ? feeBase : null;

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
          SELECT id, symbol, side, qty, price, ts, fee, strategy_tag, notes, meta
          FROM portfolio_trades
          WHERE portfolio_id=? AND strategy_tag LIKE ?
          ORDER BY ts DESC, id DESC
          LIMIT ?
        `)
        .all(portfolioId, like, limit);
    }

    return db
      .prepare(`
        SELECT id, symbol, side, qty, price, ts, fee, strategy_tag, notes, meta
        FROM portfolio_trades
        WHERE portfolio_id=?
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `)
      .all(portfolioId, limit);
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
    return await getQuotes(arr);
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
