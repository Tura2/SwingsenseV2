import { getDB } from '../../db.js';

export type EaSandboxParams = {
  lookbackTradingDays: number;
  skipRecentTradingDays: number;
  volCenterDaysCOM: number;
  targetVolAnn: number;
  topK: number;
  maxLeverage: number;
  commissionBase: number; // flat fee per executed trade, in portfolio base currency
  rebalanceEveryTradingDays: number; // e.g. 21
};

export type EaSandboxSummary = {
  valuationDate: string;
  startDate: string;
  endDate: string;
  yearsBack: number;

  finalEquityTurbo: number;
  totalCommissionsTurbo: number;

  finalEquityBuyHold: number;
  totalCommissionsBuyHold: number;

  universeSize: number;
  universeUsed: number;
  tradesTurbo: number;
};

export type EaSandboxRunResult = {
  runId: number;
  portfolioId: number;
  baseCurrency: 'USD' | 'ILS';
  params: EaSandboxParams;
  summary: EaSandboxSummary;
  warnings: string[];
};

type CandleRow = { ts: number; close: number };

type BaseCurrency = 'USD' | 'ILS';

function toISODate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function inferAssetCurrency(ticker: string): BaseCurrency {
  const t = String(ticker || '').toUpperCase();
  return t.endsWith('.TA') ? 'ILS' : 'USD';
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
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return (b / a) - 1;
}

function computeSigmaAnn(closes: number[], com: number): number | null {
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
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

function fxSeriesToBase(db: any, baseCurrency: BaseCurrency): CandleRow[] {
  if (baseCurrency === 'USD') {
    // USD base: we still load USDILS=X so we can invert when needed.
  }
  return loadCloseSeries(db, 'USDILS=X');
}

function fxRateToBaseAtTs(opts: { fx: CandleRow[]; baseCurrency: BaseCurrency; assetCurrency: BaseCurrency; ts: number; idxRef: { idx: number } }): number {
  const { fx, baseCurrency, assetCurrency, ts, idxRef } = opts;
  if (baseCurrency === assetCurrency) return 1;
  if (!fx.length) return 1;

  let i = idxRef.idx;
  while (i + 1 < fx.length && fx[i + 1].ts <= ts) i++;
  idxRef.idx = i;

  const usdIls = Number(fx[i]?.close);
  if (!Number.isFinite(usdIls) || usdIls <= 0) return 1;

  // usdIls is ILS per USD
  if (assetCurrency === 'USD' && baseCurrency === 'ILS') return usdIls;
  if (assetCurrency === 'ILS' && baseCurrency === 'USD') return 1 / usdIls;
  return 1;
}

function findSeriesIndexAtOrBefore(series: CandleRow[], ts: number, idxRef: { idx: number }): number {
  let i = idxRef.idx;
  while (i + 1 < series.length && series[i + 1].ts <= ts) i++;
  idxRef.idx = i;
  return i;
}

function getPortfolioBaseCurrency(db: any, portfolioId: number): BaseCurrency {
  try {
    const row = db.prepare('SELECT base_currency FROM portfolios WHERE id=?').get(portfolioId) as any;
    const c = String(row?.base_currency || 'ILS').toUpperCase();
    return c === 'USD' ? 'USD' : 'ILS';
  } catch {
    return 'ILS';
  }
}

function getMultiplierForTicker(db: any, portfolioId: number, ticker: string): number {
  const t = String(ticker).toUpperCase();
  try {
    const pr = db.prepare('SELECT price_multiplier FROM portfolio_assets WHERE portfolio_id=? AND ticker=?').get(portfolioId, t) as any;
    const pm = Number(pr?.price_multiplier);
    if (Number.isFinite(pm) && pm > 0) return pm;
  } catch {
    // ignore
  }
  return t.endsWith('.TA') ? 0.01 : 1;
}

export async function runEaPortfolioSandboxBacktest(opts: {
  portfolioId: number;
  tickers: string[];
  yearsBack?: number;
  startCapital: number;
  benchmark?: string | null;
  params?: Partial<EaSandboxParams>;
}): Promise<EaSandboxRunResult> {
  const db = getDB();
  const portfolioId = Number(opts.portfolioId || 1);
  const yearsBack = Math.min(10, Math.max(1, Number(opts.yearsBack ?? 5)));
  const startCapital = Number(opts.startCapital);
  if (!Number.isFinite(startCapital) || startCapital <= 0) throw new Error('startCapital must be > 0');

  const baseCurrency = getPortfolioBaseCurrency(db, portfolioId);

  const params: EaSandboxParams = {
    lookbackTradingDays: 63,
    skipRecentTradingDays: 10,
    volCenterDaysCOM: 20,
    targetVolAnn: 0.9,
    topK: 5,
    maxLeverage: 1,
    commissionBase: 5,
    rebalanceEveryTradingDays: 21,
    ...(opts.params || {}),
  };

  const warnings: string[] = [];

  const benchmark = pickBenchmark(db, opts.benchmark ?? null);
  if (!benchmark) warnings.push('No benchmark candles found (^TA125.TA/TA35.TA/SPY/^GSPC).');

  const benchSeriesAll = benchmark ? loadCloseSeries(db, benchmark) : [];
  if (benchSeriesAll.length < 60) {
    throw new Error('Not enough benchmark candles to run sandbox backtest.');
  }

  const endTs = benchSeriesAll[benchSeriesAll.length - 1].ts;
  const startMs = endTs - yearsBack * 366 * 24 * 60 * 60 * 1000;
  const timeline = benchSeriesAll.filter(r => r.ts >= startMs);
  if (timeline.length < 60) {
    throw new Error('Not enough benchmark candles in requested window.');
  }

  const startTs = timeline[0].ts;
  const valuationTs = timeline[timeline.length - 1].ts;

  const fx = fxSeriesToBase(db, baseCurrency);
  if (!fx.length) warnings.push('Missing FX candles for USDILS=X; using 1.0 conversions.');

  // Universe (as provided by UI; do not mutate portfolio).
  const tickersIn = Array.from(new Set((opts.tickers || []).map(t => String(t || '').trim().toUpperCase()).filter(Boolean)));
  const universeSize = tickersIn.length;

  // Build per-ticker series in base currency.
  const seriesByTicker = new Map<string, CandleRow[]>();
  for (const rawTicker of tickersIn) {
    const ticker = rawTicker;
    const mult = getMultiplierForTicker(db, portfolioId, ticker);
    const assetCcy = inferAssetCurrency(ticker);

    const raw = applyMultiplier(loadCloseSeries(db, ticker), mult);
    if (raw.length < 100) continue;

    const fxIdxRef = { idx: 0 };
    const baseSeries = raw
      .filter(p => p.ts >= (startTs - 400 * 24 * 60 * 60 * 1000))
      .map(p => {
        const rate = fxRateToBaseAtTs({ fx, baseCurrency, assetCurrency: assetCcy, ts: p.ts, idxRef: fxIdxRef });
        const close = p.close * rate;
        return { ts: p.ts, close };
      })
      .filter(p => Number.isFinite(p.close) && p.close > 0);

    if (baseSeries.length >= 100) seriesByTicker.set(ticker, baseSeries);
  }

  const universeUsed = seriesByTicker.size;
  if (universeUsed < Math.max(3, params.topK)) {
    warnings.push(`Only ${universeUsed} tickers have enough history in the last ${yearsBack}y.`);
  }

  // --- Turbo backtest ---
  let cash = startCapital;
  const qtyByTicker: Record<string, number> = {};
  const idxByTicker: Record<string, number> = {};
  for (const t of seriesByTicker.keys()) idxByTicker[t] = 0;

  const trades: Array<{ ts: number; symbol: string; side: 'BUY' | 'SELL'; qty: number; price: number; notionalBase: number; feeBase: number }>=[];

  let totalCommissionsTurbo = 0;
  let lastRebalanceIdx = -999999;

  for (let dayIdx = 0; dayIdx < timeline.length; dayIdx++) {
    const ts = timeline[dayIdx].ts;

    // Mark-to-market
    let holdings = 0;
    const priceAt: Record<string, number> = {};

    for (const [ticker, ser] of seriesByTicker.entries()) {
      const iRef = { idx: idxByTicker[ticker] || 0 };
      const i = findSeriesIndexAtOrBefore(ser, ts, iRef);
      idxByTicker[ticker] = iRef.idx;
      const px = Number(ser[i]?.close);
      if (Number.isFinite(px) && px > 0) priceAt[ticker] = px;
      const q = Number(qtyByTicker[ticker] || 0);
      if (q && Number.isFinite(px)) holdings += q * px;
    }

    const equity = cash + holdings;

    const shouldRebalance = (dayIdx === 0) || (dayIdx - lastRebalanceIdx >= params.rebalanceEveryTradingDays);
    if (!shouldRebalance) continue;
    lastRebalanceIdx = dayIdx;

    // Score
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

    const raws: Array<{ ticker: string; raw: number }> = [];
    for (const e of eligible) {
      const s = Number(e.sigmaAnn);
      if (!Number.isFinite(s) || s <= 0) continue;
      raws.push({ ticker: e.ticker, raw: Math.min(params.maxLeverage, params.targetVolAnn / s) });
    }

    const sumRaw = raws.reduce((a, r) => a + r.raw, 0);
    const scale = sumRaw > params.maxLeverage ? (params.maxLeverage / sumRaw) : 1;
    const targetW = new Map<string, number>();
    for (const r of raws) targetW.set(r.ticker, r.raw * scale);

    // Desired values
    const desiredQty: Record<string, number> = {};
    for (const [ticker, w] of targetW.entries()) {
      const px = Number(priceAt[ticker]);
      if (!Number.isFinite(px) || px <= 0) continue;
      desiredQty[ticker] = (equity * w) / px;
    }

    // Liquidate non-target holdings
    for (const t of Object.keys(qtyByTicker)) {
      if (!Object.prototype.hasOwnProperty.call(desiredQty, t)) desiredQty[t] = 0;
    }

    // Apply deltas
    for (const t of Object.keys(desiredQty)) {
      const px = Number(priceAt[t]);
      if (!Number.isFinite(px) || px <= 0) continue;
      const curQ = Number(qtyByTicker[t] || 0);
      const newQ = Number(desiredQty[t] || 0);
      const dq = newQ - curQ;
      if (Math.abs(dq) < 1e-9) continue;

      const side: 'BUY' | 'SELL' = dq > 0 ? 'BUY' : 'SELL';
      const qty = Math.abs(dq);
      const notionalBase = qty * px;
      const feeBase = Math.max(0, Number(params.commissionBase) || 0);

      // Cash: BUY reduces cash, SELL increases
      cash -= dq * px;
      cash -= feeBase;
      totalCommissionsTurbo += feeBase;
      qtyByTicker[t] = newQ;

      trades.push({ ts, symbol: t, side, qty, price: px, notionalBase, feeBase });
    }
  }

  // Final valuation at valuationTs
  let turboHoldings = 0;
  const endPriceAt: Record<string, number> = {};
  for (const [ticker, ser] of seriesByTicker.entries()) {
    const idxRef = { idx: idxByTicker[ticker] || 0 };
    const i = findSeriesIndexAtOrBefore(ser, valuationTs, idxRef);
    const px = Number(ser[i]?.close);
    if (Number.isFinite(px) && px > 0) endPriceAt[ticker] = px;
    const q = Number(qtyByTicker[ticker] || 0);
    if (q && Number.isFinite(px)) turboHoldings += q * px;
  }
  const finalEquityTurbo = cash + turboHoldings;

  // --- Buy & Hold (equal-weight one-time buy at start) ---
  const eligibleBh = Array.from(seriesByTicker.keys()).filter(t => {
    const ser = seriesByTicker.get(t)!;
    const idxRef = { idx: 0 };
    const i = findSeriesIndexAtOrBefore(ser, startTs, idxRef);
    const px = Number(ser[i]?.close);
    return Number.isFinite(px) && px > 0;
  });

  const bhN = eligibleBh.length;
  const perBudget = bhN > 0 ? (startCapital / bhN) : 0;
  const bhQty: Record<string, number> = {};

  let bhCash = startCapital;
  let totalCommissionsBuyHold = 0;

  for (const t of eligibleBh) {
    const ser = seriesByTicker.get(t)!;
    const idxRef = { idx: 0 };
    const i = findSeriesIndexAtOrBefore(ser, startTs, idxRef);
    const px = Number(ser[i]?.close);
    if (!Number.isFinite(px) || px <= 0) continue;

    const feeBase = Math.max(0, Number(params.commissionBase) || 0);
    totalCommissionsBuyHold += feeBase;

    const invest = Math.max(0, perBudget - feeBase);
    const qty = invest / px;
    bhQty[t] = qty;
    bhCash -= invest;
    bhCash -= feeBase;
  }

  let bhHoldings = 0;
  for (const t of Object.keys(bhQty)) {
    const px = Number(endPriceAt[t]);
    const q = Number(bhQty[t] || 0);
    if (!q || !Number.isFinite(px)) continue;
    bhHoldings += q * px;
  }
  const finalEquityBuyHold = bhCash + bhHoldings;

  // Persist sandbox run + record book rows (separate from wealth).
  const runIns = db.prepare(`
    INSERT INTO tsmom_sandbox_runs(portfolio_id, created_at, start_ts, end_ts, valuation_ts, base_currency, start_capital_base, params_json, meta)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  const runInfo = runIns.run(
    portfolioId,
    now,
    startTs,
    valuationTs,
    valuationTs,
    baseCurrency,
    startCapital,
    JSON.stringify(params),
    JSON.stringify({ kind: 'EA_BACKTEST', benchmark, universeSize, universeUsed })
  );
  const runId = Number(runInfo.lastInsertRowid);

  const insLedger = db.prepare(`
    INSERT INTO tsmom_sandbox_ledger(run_id, ts, amount, type, description, meta)
    VALUES(@run_id, @ts, @amount, @type, @description, @meta)
  `);

  const insTrade = db.prepare(`
    INSERT INTO tsmom_sandbox_trades(run_id, ts, symbol, side, qty, price_base, notional_base, fee_base, strategy_tag, meta)
    VALUES(@run_id, @ts, @symbol, @side, @qty, @price_base, @notional_base, @fee_base, @strategy_tag, @meta)
  `);

  const trx = db.transaction(() => {
    insLedger.run({
      run_id: runId,
      ts: startTs,
      amount: startCapital,
      type: 'DEPOSIT',
      description: 'Sandbox start capital',
      meta: JSON.stringify({ source: 'tsmom-sandbox' }),
    });

    for (const t of trades) {
      insTrade.run({
        run_id: runId,
        ts: t.ts,
        symbol: t.symbol,
        side: t.side,
        qty: t.qty,
        price_base: t.price,
        notional_base: t.notionalBase,
        fee_base: t.feeBase,
        strategy_tag: 'TSMOM_TURBO_SANDBOX',
        meta: null,
      });
    }
  });
  trx();

  return {
    runId,
    portfolioId,
    baseCurrency,
    params,
    summary: {
      valuationDate: toISODate(valuationTs),
      startDate: toISODate(startTs),
      endDate: toISODate(valuationTs),
      yearsBack,
      finalEquityTurbo,
      totalCommissionsTurbo,
      finalEquityBuyHold,
      totalCommissionsBuyHold,
      universeSize,
      universeUsed,
      tradesTurbo: trades.length,
    },
    warnings,
  };
}
