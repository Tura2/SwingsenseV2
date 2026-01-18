import { getDB } from '../../db.js';
import type { PerformancePoint, TsmomAssetRow } from './types.js';
import { resolveTicker } from './tickerMapper.js';

type CandleRow = { ts: number; close: number };

type CashEvent = { ts: number; deltaCash: number };

type TradeRow = { symbol: string; side: 'BUY'|'SELL'; qty: number; price: number; ts: number; fee?: number | null };

type LedgerRow = { ts: number; amount: number };

function loadCloseSeries(db: any, symbol: string): CandleRow[] {
  const rows = db
    .prepare("SELECT ts, close FROM candles WHERE symbol=? AND timeframe='1d' ORDER BY ts ASC")
    .all(symbol) as Array<{ ts: number; close: number }>;
  return rows
    .map(r => ({ ts: Number(r.ts), close: Number(r.close) }))
    .filter(r => Number.isFinite(r.ts) && Number.isFinite(r.close));
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

  const prefs = [preferred, 'TA125.TA', 'TA35.TA', 'SPY', '^GSPC'].filter(Boolean) as string[];
  for (const s of prefs) {
    if (candCount(s) > 50) return s;
  }
  return null;
}

export async function computeTsmomPerformanceSeries(opts?: { years?: number; benchmark?: string | null }): Promise<{ benchmark: string | null; points: PerformancePoint[] }> {
  const db = getDB();
  const years = Math.min(10, Math.max(1, Number(opts?.years ?? 5)));

  const benchmark = pickBenchmark(db, opts?.benchmark ?? null);
  if (!benchmark) return { benchmark: null, points: [] };

  const endMs = Date.now();
  const startMs = endMs - years * 366 * 24 * 60 * 60 * 1000;

  // Benchmark drives the timeline
  const benchAll = loadCloseSeries(db, benchmark).filter(r => r.ts >= startMs);
  if (benchAll.length < 10) return { benchmark, points: [] };

  // Traded symbols drive what we need to price for equity
  const trades = db.prepare('SELECT symbol, side, qty, price, ts, fee FROM portfolio_trades ORDER BY ts ASC, id ASC').all() as TradeRow[];
  const led = db.prepare('SELECT ts, amount FROM capital_ledger ORDER BY ts ASC, id ASC').all() as LedgerRow[];

  const tradedSymbols = Array.from(new Set(trades.map(t => String(t.symbol || '').toUpperCase()).filter(Boolean)));

  // Load multipliers for traded symbols (default 1)
  const assetRows = db
    .prepare('SELECT ticker, name, category, status, yahoo_symbol, price_multiplier, created_at, updated_at, meta FROM assets')
    .all() as TsmomAssetRow[];
  const multMap = new Map<string, number>();
  for (const a of assetRows) {
    const { ticker, priceMultiplier } = resolveTicker(a);
    multMap.set(String(ticker).toUpperCase(), Number(priceMultiplier || 1));
  }

  const priceSeries: Record<string, CandleRow[]> = {};
  for (const s of tradedSymbols) {
    const ser = applyMultiplier(loadCloseSeries(db, s), multMap.get(s) ?? 1).filter(r => r.ts >= (startMs - 10 * 24 * 60 * 60 * 1000));
    priceSeries[s] = ser;
  }

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
    const fee = Number(t.fee);
    const commission = Number.isFinite(fee) ? fee : 5;
    if (!Number.isFinite(ts) || !Number.isFinite(qty) || !Number.isFinite(price)) continue;
    const gross = qty * price;
    const deltaCash = t.side === 'BUY' ? (-(gross + commission)) : (gross - commission);
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
      holdings += qty * px;
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
