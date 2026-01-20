import { getDB } from '../../db.js';
import type { PerformancePoint } from './types.js';

type CandleRow = { ts: number; close: number };

type CashEvent = { ts: number; deltaCash: number };

type TradeRow = { symbol: string; side: 'BUY'|'SELL'; qty: number; price: number; ts: number; fee?: number | null; trade_currency?: string | null; fx_rate?: number | null; notional_base?: number | null; fee_base?: number | null };

type LedgerRow = { ts: number; amount: number };

type Currency = 'USD' | 'ILS';

function normalizeCurrency(x: any): Currency {
  const s = String(x || '').toUpperCase();
  if (s === 'USD') return 'USD';
  return 'ILS';
}

function inferAssetCurrency(ticker: string): Currency {
  const t = String(ticker || '').toUpperCase();
  if (t.endsWith('.TA')) return 'ILS';
  return 'USD';
}

function inferMultiplierForTicker(ticker: string): number {
  const t = String(ticker || '').toUpperCase();
  return t.endsWith('.TA') ? 0.01 : 1;
}

function loadCloseSeries(db: any, symbol: string): CandleRow[] {
  const rows = db
    .prepare("SELECT ts, close FROM candles WHERE symbol=? AND timeframe='1d' ORDER BY ts ASC")
    .all(symbol) as Array<{ ts: number; close: number }>;
  return rows
    .map(r => ({ ts: Number(r.ts), close: Number(r.close) }))
    .filter(r => Number.isFinite(r.ts) && Number.isFinite(r.close) && r.close > 0);
}

function applyMultiplier(series: CandleRow[], multiplier: number): CandleRow[] {
  const m = Number(multiplier);
  const mult = Number.isFinite(m) && m > 0 ? m : 1;
  if (mult === 1) return series;
  return series.map(p => ({ ts: p.ts, close: p.close * mult }));
}

function pickBenchmark(db: any, preferred?: string | null): string | null {
  const candCount = (sym: string) => {
    try {
      const row = db.prepare("SELECT COUNT(*) AS c FROM candles WHERE symbol=? AND timeframe='1d'").get(sym) as any;
      return Number(row?.c || 0);
    } catch {
      return 0;
    }
  };

  const prefs = [preferred, '^TA125.TA', 'TA125.TA', 'TA35.TA', 'SPY', '^GSPC'].filter(Boolean) as string[];
  for (const s of prefs) {
    if (candCount(s) > 50) return s;
  }
  return null;
}

export async function computeTsmomPerformanceSeries(opts?: { portfolioId?: number; years?: number; benchmark?: string | null }): Promise<{ benchmark: string | null; points: PerformancePoint[] }> {
  const db = getDB();
  const portfolioId = Number(opts?.portfolioId ?? 1);
  const years = Math.min(10, Math.max(1, Number(opts?.years ?? 5)));

  const baseRow = db.prepare('SELECT base_currency FROM portfolios WHERE id=?').get(portfolioId) as any;
  const baseCurrency = normalizeCurrency(baseRow?.base_currency);

  const benchmark = pickBenchmark(db, opts?.benchmark ?? null);
  if (!benchmark) return { benchmark: null, points: [] };

  const endMs = Date.now();
  const startMs = endMs - years * 366 * 24 * 60 * 60 * 1000;

  // Benchmark drives the timeline
  const benchAll = loadCloseSeries(db, benchmark).filter(r => r.ts >= startMs);
  if (benchAll.length < 10) return { benchmark, points: [] };

  // Traded symbols drive what we need to price for equity
  const trades = db.prepare('SELECT symbol, side, qty, price, ts, fee, trade_currency, fx_rate, notional_base, fee_base FROM portfolio_trades WHERE portfolio_id=? ORDER BY ts ASC, id ASC').all(portfolioId) as TradeRow[];
  const led = db.prepare('SELECT ts, amount FROM capital_ledger WHERE portfolio_id=? ORDER BY ts ASC, id ASC').all(portfolioId) as LedgerRow[];

  const tradedSymbols = Array.from(new Set(trades.map(t => String(t.symbol || '').toUpperCase()).filter(Boolean)));

  // Load multipliers from portfolio_assets (portfolio universe metadata). Fallback: infer from ticker.
  const multMap = new Map<string, number>();
  try {
    const rows = db
      .prepare('SELECT ticker, price_multiplier FROM portfolio_assets WHERE portfolio_id=?')
      .all(portfolioId) as Array<{ ticker: string; price_multiplier: number }>;
    for (const r of rows) {
      const key = String(r.ticker || '').toUpperCase();
      const pm = Number((r as any).price_multiplier);
      if (key && Number.isFinite(pm) && pm > 0) multMap.set(key, pm);
    }
  } catch {
    // ignore
  }

  const priceSeries: Record<string, CandleRow[]> = {};
  for (const s of tradedSymbols) {
    const ser = applyMultiplier(loadCloseSeries(db, s), multMap.get(s) ?? inferMultiplierForTicker(s)).filter(
      r => r.ts >= (startMs - 10 * 24 * 60 * 60 * 1000)
    );
    priceSeries[s] = ser;
  }

  // FX series (USDILS=X) used for base-currency conversion when needed.
  const fxSeries = loadCloseSeries(db, 'USDILS=X').filter(r => r.ts >= (startMs - 10 * 24 * 60 * 60 * 1000));
  let fxIdx = 0;
  const fxAt = (ts: number): number | null => {
    if (!fxSeries.length) return null;
    while (fxIdx + 1 < fxSeries.length && fxSeries[fxIdx + 1].ts <= ts) fxIdx++;
    const v = fxSeries[fxIdx]?.close;
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  // Build cash events from ledger + trades
  const cashEvents: CashEvent[] = [];
  for (const r of led) {
    const ts = Number(r.ts);
    const amt = Number(r.amount);
    if (!Number.isFinite(ts) || !Number.isFinite(amt)) continue;
    cashEvents.push({ ts, deltaCash: amt });
  }
  for (const t of trades) {
    const ts = Number(t.ts);
    const qty = Number(t.qty);
    const price = Number(t.price);
    const feeLegacy = Number(t.fee);
    const feeBase = Number.isFinite(Number(t.fee_base)) ? Number(t.fee_base) : (Number.isFinite(feeLegacy) ? feeLegacy : 0);
    if (!Number.isFinite(ts) || !Number.isFinite(qty) || !Number.isFinite(price)) continue;

    let grossBase = Number(t.notional_base);
    if (!Number.isFinite(grossBase) || grossBase < 0) {
      const grossTrade = qty * price;
      const tradeCcy = normalizeCurrency(t.trade_currency);
      if (tradeCcy === baseCurrency) {
        grossBase = grossTrade;
      } else {
        const fxRate = Number(t.fx_rate);
        grossBase = (Number.isFinite(fxRate) && fxRate > 0) ? (grossTrade * fxRate) : grossTrade;
      }
    }

    // Fees are tracked in the trade ledger / record book, but are not applied to portfolio cash.
    void feeBase;
    const deltaCash = t.side === 'BUY' ? (-grossBase) : (grossBase);
    cashEvents.push({ ts, deltaCash });
  }
  cashEvents.sort((a, b) => a.ts - b.ts);

  // Position events
  const posEvents = trades
    .map(t => ({ ts: Number(t.ts), symbol: String(t.symbol || '').toUpperCase(), delta: (t.side === 'BUY' ? 1 : -1) * Number(t.qty) }))
    .filter(e => e.symbol && Number.isFinite(e.ts) && Number.isFinite(e.delta))
    .sort((a, b) => a.ts - b.ts);

  // Iterate timeline
  const positions: Record<string, number> = {};
  let cash = 0;
  let cashIdx = 0;
  let posIdx = 0;

  // Per-symbol pointers to find latest close at/before current ts
  const seriesIdx: Record<string, number> = {};
  for (const s of tradedSymbols) seriesIdx[s] = 0;

  const outAbs: Array<{ ts: number; equityAbs: number; benchAbs: number }> = [];

  for (const b of benchAll) {
    const ts = b.ts;

    while (cashIdx < cashEvents.length && cashEvents[cashIdx].ts <= ts) {
      cash += cashEvents[cashIdx].deltaCash;
      cashIdx++;
    }

    while (posIdx < posEvents.length && posEvents[posIdx].ts <= ts) {
      const e = posEvents[posIdx];
      positions[e.symbol] = (positions[e.symbol] || 0) + e.delta;
      posIdx++;
    }

    let holdings = 0;
    for (const sym of tradedSymbols) {
      const qty = Number(positions[sym] || 0);
      if (!qty) continue;
      const ser = priceSeries[sym] || [];
      let i = seriesIdx[sym] || 0;
      while (i + 1 < ser.length && ser[i + 1].ts <= ts) i++;
      seriesIdx[sym] = i;
      const px = ser[i]?.close;
      if (!Number.isFinite(px)) continue;

      const assetCcy = inferAssetCurrency(sym);
      let rate = 1;
      if (assetCcy !== baseCurrency) {
        const fx = fxAt(ts);
        if (fx && Number.isFinite(fx) && fx > 0) {
          // fx is ILS per USD
          rate = (assetCcy === 'USD' && baseCurrency === 'ILS') ? fx : (assetCcy === 'ILS' && baseCurrency === 'USD') ? (1 / fx) : 1;
        }
      }
      holdings += qty * px * rate;
    }

    const equityAbs = cash + holdings;
    if (!Number.isFinite(equityAbs)) continue;
    outAbs.push({ ts, equityAbs, benchAbs: b.close });
  }

  if (outAbs.length < 10) return { benchmark, points: [] };

  const e0 = outAbs[0].equityAbs;
  const b0 = outAbs[0].benchAbs;
  if (!Number.isFinite(e0) || !Number.isFinite(b0) || e0 === 0 || b0 === 0) return { benchmark, points: [] };

  const points: PerformancePoint[] = outAbs.map(p => ({
    ts: p.ts,
    equity: p.equityAbs / e0,
    bench_equity: p.benchAbs / b0,
  }));

  return { benchmark, points };
}
