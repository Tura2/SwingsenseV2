import { getDB } from '../../db.js';
import type { Candle } from '../../../shared/types.js';
import type { PerformancePoint, SignalMatrixRow, TsmomAssetRow } from './types.js';
import { resolveTicker } from './tickerMapper.js';

export type SandboxParams = {
  lookbackTradingDays: number;
  skipRecentTradingDays: number;
  volCenterDaysCOM: number;
  targetVolAnn: number;
  topK: number;
  maxLeverage: number;
  commissionNIS: number; // per trade
  rebalance: 'M21'; // every ~21 trading days
};

export type SandboxSummary = {
  start: string;
  end: string;
  years: number;
  cagr: number | null;
  volAnn: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  benchCagr: number | null;
};

export type SandboxRunResult = {
  asOf: string;
  benchmark: string | null;
  params: SandboxParams;
  summary: SandboxSummary;
  points: PerformancePoint[];
  topAtEnd: Array<Pick<SignalMatrixRow, 'ticker' | 'momentum' | 'sigmaAnn' | 'rank'>>;
  warnings: string[];
};

type CandleRow = { ts: number; close: number };

function toISODate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function ewmaVariance(returns: number[], com: number): number {
  const alpha = 1 / (1 + Math.max(1e-9, com));
  let v = 0;
  for (const r of returns) {
    const x = Number(r);
    if (!Number.isFinite(x)) continue;
    v = alpha * (x * x) + (1 - alpha) * v;
  }
  return v;
}

function computeMomentum(closes: number[], lookback: number, skip: number): number | null {
  const n = closes.length;
  const endIdx = n - 1 - skip;
  const startIdx = endIdx - lookback;
  if (startIdx < 0 || endIdx <= 0) return null;
  const a = closes[startIdx];
  const b = closes[endIdx];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return (b / a) - 1;
}

function computeSigmaAnn(closes: number[], com: number): number | null {
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) continue;
    rets.push((b / a) - 1);
  }
  if (rets.length < 3) return null;
  const v = ewmaVariance(rets, com);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.sqrt(v) * Math.sqrt(252);
}

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

function normalizeCandles(arr: any[]): Candle[] {
  const cleaned = (arr || []).filter(c => [c.ts, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite));
  cleaned.sort((a, b) => a.ts - b.ts);
  return cleaned as Candle[];
}

function maxDrawdown(series: number[]): number | null {
  if (!series.length) return null;
  let peak = series[0];
  let mdd = 0;
  for (const x of series) {
    if (!Number.isFinite(x)) continue;
    if (x > peak) peak = x;
    const dd = peak > 0 ? (x / peak) - 1 : 0;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

function annVolFromEquity(eq: number[]): number | null {
  if (eq.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < eq.length; i++) {
    const a = eq[i - 1];
    const b = eq[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) continue;
    rets.push((b / a) - 1);
  }
  if (rets.length < 3) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / Math.max(1, rets.length - 1);
  if (!Number.isFinite(varr) || varr < 0) return null;
  return Math.sqrt(varr) * Math.sqrt(252);
}

function cagrFromEquity(eq: number[], years: number): number | null {
  if (!eq.length || years <= 0) return null;
  const a = eq[0];
  const b = eq[eq.length - 1];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.pow(b / a, 1 / years) - 1;
}

export async function runTsmomSandbox(opts?: { years?: number; benchmark?: string | null; params?: Partial<SandboxParams> }): Promise<SandboxRunResult> {
  const db = getDB();

  const years = Math.min(10, Math.max(1, Number(opts?.years ?? 5)));
  const benchmark = pickBenchmark(db, opts?.benchmark ?? null);
  const warnings: string[] = [];
  if (!benchmark) warnings.push('No benchmark candles found (TA125.TA/TA35.TA/SPY/^GSPC).');

  const params: SandboxParams = {
    lookbackTradingDays: 63,
    skipRecentTradingDays: 10,
    volCenterDaysCOM: 20,
    targetVolAnn: 0.9,
    topK: 5,
    maxLeverage: 1,
    commissionNIS: 5,
    rebalance: 'M21',
    ...(opts?.params || {}),
  };

  const endMs = Date.now();
  const startMs = endMs - years * 366 * 24 * 60 * 60 * 1000;

  // Benchmark provides the calendar.
  const benchSeries = benchmark ? loadCloseSeries(db, benchmark).filter(r => r.ts >= startMs) : [];
  if (benchSeries.length < 60) {
    return {
      asOf: toISODate(Date.now()),
      benchmark: benchmark ?? null,
      params,
      summary: { start: '', end: '', years, cagr: null, volAnn: null, sharpe: null, maxDrawdown: null, benchCagr: null },
      points: [],
      topAtEnd: [],
      warnings: [...warnings, 'Not enough benchmark candles to run sandbox.'],
    };
  }

  const assets = db
    .prepare("SELECT ticker, name, category, status, yahoo_symbol, price_multiplier, created_at, updated_at, meta FROM assets WHERE status='active'")
    .all() as TsmomAssetRow[];

  // Load asset close series once.
  const seriesByTicker = new Map<string, CandleRow[]>();
  for (const a of assets) {
    const { ticker, priceMultiplier } = resolveTicker(a);
    const ser = applyMultiplier(loadCloseSeries(db, ticker), priceMultiplier).filter(r => r.ts >= (startMs - 400 * 24 * 60 * 60 * 1000));
    if (ser.length >= 100) seriesByTicker.set(ticker, ser);
  }

  if (seriesByTicker.size < Math.max(5, params.topK)) {
    warnings.push(`Only ${seriesByTicker.size} assets have enough candle history.`);
  }

  // Pointers into each series (advance as we move through time)
  const idxByTicker: Record<string, number> = {};
  for (const t of seriesByTicker.keys()) idxByTicker[t] = 0;

  // Holdings and cash in NIS. Start with 1.0 equity normalized (so cash starts at 1.0).
  let cash = 1.0;
  const qtyByTicker: Record<string, number> = {};

  const equityAbs: number[] = [];
  const benchAbs: number[] = [];
  const points: PerformancePoint[] = [];

  const rebalanceEvery = 21;

  const timeline = benchSeries;
  const startTs = timeline[0].ts;
  const endTs = timeline[timeline.length - 1].ts;

  let lastRebalanceIdx = -999;

  // For UI: snapshot TopK at end
  let lastTop: Array<{ ticker: string; momentum: number | null; sigmaAnn: number | null; rank: number | null }> = [];

  for (let dayIdx = 0; dayIdx < timeline.length; dayIdx++) {
    const ts = timeline[dayIdx].ts;

    // Mark-to-market
    let holdings = 0;
    for (const [ticker, ser] of seriesByTicker.entries()) {
      let i = idxByTicker[ticker] || 0;
      while (i + 1 < ser.length && ser[i + 1].ts <= ts) i++;
      idxByTicker[ticker] = i;
      const px = ser[i]?.close;
      const q = Number(qtyByTicker[ticker] || 0);
      if (!q || !Number.isFinite(px)) continue;
      holdings += q * px;
    }
    const equity = cash + holdings;
    equityAbs.push(equity);
    benchAbs.push(timeline[dayIdx].close);

    // Rebalance
    const shouldRebalance = (dayIdx === 0) || (dayIdx - lastRebalanceIdx >= rebalanceEvery);
    if (!shouldRebalance) continue;
    lastRebalanceIdx = dayIdx;

    // Build momentum + vol estimates using series up to (ts)
    const scored: Array<{ ticker: string; momentum: number | null; sigmaAnn: number | null }> = [];
    for (const [ticker, ser] of seriesByTicker.entries()) {
      const i = idxByTicker[ticker] || 0;
      const slice = ser.slice(0, i + 1);
      const closes = slice.map(x => x.close);
      const mom = computeMomentum(closes, params.lookbackTradingDays, params.skipRecentTradingDays);
      const sig = computeSigmaAnn(closes.slice(-Math.max(260, params.lookbackTradingDays + params.skipRecentTradingDays + 50)), params.volCenterDaysCOM);
      scored.push({ ticker, momentum: mom, sigmaAnn: sig });
    }

    const ranked = scored.slice().sort((a, b) => (b.momentum ?? -999) - (a.momentum ?? -999));

    const eligible = ranked.filter(x => (x.momentum ?? -1) > 0).slice(0, params.topK);
    if (dayIdx === 0 && eligible.length < params.topK) {
      warnings.push(`Only ${eligible.length}/${params.topK} assets have positive momentum at start.`);
    }

    // Compute target weights
    const raws: Array<{ ticker: string; raw: number }> = [];
    for (const e of eligible) {
      const s = Number(e.sigmaAnn);
      if (!Number.isFinite(s) || s <= 0) continue;
      raws.push({ ticker: e.ticker, raw: Math.min(params.maxLeverage, params.targetVolAnn / s) });
    }
    let sumRaw = raws.reduce((a, r) => a + r.raw, 0);
    const scale = sumRaw > params.maxLeverage ? (params.maxLeverage / sumRaw) : 1;

    const targetW = new Map<string, number>();
    for (const r of raws) targetW.set(r.ticker, r.raw * scale);

    // Execute trades to match target weights (continuous sizing).
    // Trade cost: commission per trade when delta value != 0.
    // We treat price as the latest close at rebalance day.
    let rebHoldings = 0;
    const priceAt: Record<string, number> = {};
    for (const [ticker, ser] of seriesByTicker.entries()) {
      const i = idxByTicker[ticker] || 0;
      const px = ser[i]?.close;
      if (Number.isFinite(px)) priceAt[ticker] = px;
      const q = Number(qtyByTicker[ticker] || 0);
      if (Number.isFinite(px) && q) rebHoldings += q * px;
    }
    const rebEquity = cash + rebHoldings;

    // Desired position values
    const desiredValue: Record<string, number> = {};
    for (const [ticker, w] of targetW.entries()) {
      desiredValue[ticker] = rebEquity * w;
    }

    // Convert desired values to quantities
    const desiredQty: Record<string, number> = {};
    for (const t of Object.keys(desiredValue)) {
      const px = Number(priceAt[t]);
      if (!Number.isFinite(px) || px <= 0) continue;
      desiredQty[t] = desiredValue[t] / px;
    }

    // Liquidate symbols not in target set
    for (const t of Object.keys(qtyByTicker)) {
      if (!Object.prototype.hasOwnProperty.call(desiredQty, t)) desiredQty[t] = 0;
    }

    // Apply deltas
    for (const t of Object.keys(desiredQty)) {
      const curQ = Number(qtyByTicker[t] || 0);
      const newQ = Number(desiredQty[t] || 0);
      const px = Number(priceAt[t]);
      if (!Number.isFinite(px) || px <= 0) {
        // can't trade without price
        continue;
      }
      const dq = newQ - curQ;
      if (Math.abs(dq) < 1e-9) continue;

      const tradeValue = dq * px;
      // BUY => cash decreases; SELL => cash increases
      cash -= tradeValue;
      cash -= params.commissionNIS / Math.max(1, rebEquity); // commission in equity units
      qtyByTicker[t] = newQ;
    }

    // keep a snapshot for UI
    lastTop = eligible.map((e, i) => ({ ticker: e.ticker, momentum: e.momentum, sigmaAnn: e.sigmaAnn, rank: i + 1 }));
  }

  // Normalize to 1.0 start
  const e0 = equityAbs[0];
  const b0 = benchAbs[0];
  const eqNorm = equityAbs.map(x => x / e0);
  const benchNorm = benchAbs.map(x => x / b0);

  for (let i = 0; i < timeline.length; i++) {
    points.push({ ts: timeline[i].ts, equity: eqNorm[i], bench_equity: benchNorm[i] });
  }

  const yearsActual = Math.max(1e-9, (endTs - startTs) / (365.25 * 24 * 60 * 60 * 1000));
  const cagr = cagrFromEquity(eqNorm, yearsActual);
  const benchCagr = cagrFromEquity(benchNorm, yearsActual);
  const volAnn = annVolFromEquity(eqNorm);
  const sharpe = volAnn && Number.isFinite(volAnn) && volAnn > 0 && cagr != null ? (cagr / volAnn) : null;
  const mdd = maxDrawdown(eqNorm);

  return {
    asOf: toISODate(Date.now()),
    benchmark: benchmark ?? null,
    params,
    summary: {
      start: toISODate(startTs),
      end: toISODate(endTs),
      years: yearsActual,
      cagr,
      volAnn,
      sharpe,
      maxDrawdown: mdd,
      benchCagr,
    },
    points,
    topAtEnd: lastTop,
    warnings,
  };
}
