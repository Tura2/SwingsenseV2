import { getDB } from '../../db.js';
import type { Candle } from '../../../shared/types.js';
import type { RebalancePlan, RebalancePlanItem, SignalMatrix, SignalMatrixRow, TsmomAssetRow } from './types.js';
import { resolveTicker } from './tickerMapper.js';
import { getPortfolioState } from '../wealth/portfolioState.js';
import { getPortfolioBaseCurrency } from '../wealth/portfolioSnapshot.js';

function toISODate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function ewmaVariance(returns: number[], com: number): number {
  // EWMA with alpha derived from center-of-mass: alpha = 1/(1+com)
  const alpha = 1 / (1 + Math.max(1e-9, com));
  let v = 0;
  for (const r of returns) {
    const x = Number(r);
    if (!Number.isFinite(x)) continue;
    v = alpha * (x * x) + (1 - alpha) * v;
  }
  return v;
}

function normalizeCandles(arr: any[]): Candle[] {
  const cleaned = (arr || []).filter(c => [c.ts, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite));
  cleaned.sort((a, b) => a.ts - b.ts);
  return cleaned as Candle[];
}

function loadCloses(dbRows: any[], multiplier: number): Array<{ ts: number; close: number }> {
  const m = Number(multiplier);
  const mult = Number.isFinite(m) && m > 0 ? m : 1;
  const out: Array<{ ts: number; close: number }> = [];
  for (const r of dbRows) {
    const ts = Number(r.ts);
    const close = Number(r.close);
    if (!Number.isFinite(ts) || !Number.isFinite(close)) continue;
    const c = close * mult;
    if (!Number.isFinite(c) || c <= 0) continue;
    out.push({ ts, close: c });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
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

type BaseCurrency = 'USD' | 'ILS';

function inferAssetCurrency(ticker: string): BaseCurrency {
  const t = String(ticker || '').toUpperCase();
  if (t.endsWith('.TA')) return 'ILS';
  return 'USD';
}

function getUsdIls(db: any): number | null {
  try {
    const row = db.prepare("SELECT close FROM candles WHERE symbol='USDILS=X' AND timeframe='1d' ORDER BY ts DESC LIMIT 1").get() as any;
    const c = Number(row?.close);
    return Number.isFinite(c) && c > 0 ? c : null;
  } catch {
    return null;
  }
}

function fxRateToBase(db: any, base: BaseCurrency, assetCcy: BaseCurrency): { rate: number; warning?: string } {
  if (base === assetCcy) return { rate: 1 };
  const usdIls = getUsdIls(db);
  if (!usdIls) {
    return { rate: 1, warning: `Missing FX candle for USDILS=X; using 1.0 for ${assetCcy}->${base} conversion.` };
  }
  // usdIls is ILS per USD
  if (assetCcy === 'USD' && base === 'ILS') return { rate: usdIls };
  if (assetCcy === 'ILS' && base === 'USD') return { rate: 1 / usdIls };
  return { rate: 1 };
}

export async function computeTsmomTurboV2Plan(opts?: { portfolioId?: number }): Promise<RebalancePlan & { baseCurrency: BaseCurrency; raw: { items: Array<{ ticker: string; momentum: number | null; sigmaAnn: number | null; price: number | null; rawWeight: number; targetWeight: number }> } }> {
  const db = getDB();
  const portfolioId = Number(opts?.portfolioId ?? 1);
  const baseCurrency = getPortfolioBaseCurrency(portfolioId) as BaseCurrency;

  const params = {
    lookbackTradingDays: 63,
    skipRecentTradingDays: 10,
    volCenterDaysCOM: 20,
    targetVolAnn: 0.9,
    topK: 5,
    maxLeverage: 1,
    commissionNIS: 5,
  };

  const warnings: string[] = [];

  try {
    const corp = db.prepare(`
      SELECT ticker, ts, message
      FROM tsmom_price_flags
      WHERE acknowledged_at IS NULL AND type='CORP_ACTION_SUSPECT'
      ORDER BY ts DESC, id DESC
      LIMIT 10
    `).all() as Array<{ ticker: string; ts: number; message: string }>;
    if (corp.length) {
      warnings.push(`Data integrity: ${corp.length} corporate-action suspect flag(s) are still unacknowledged.`);
      for (const f of corp.slice(0, 3)) {
        warnings.push(`- ${String(f.ticker).toUpperCase()} ${toISODate(Number(f.ts))}: ${String(f.message || '').slice(0, 160)}`);
      }
      if (corp.length > 3) warnings.push(`- …and ${corp.length - 3} more (see /tsmom → Data Integrity / Sync).`);
    }
  } catch {
    // ignore
  }

  // Universe is portfolio-based only.
  const uniRows = db
    .prepare('SELECT ticker FROM portfolio_universe WHERE portfolio_id=? ORDER BY ticker ASC')
    .all(portfolioId) as Array<{ ticker: string }>;
  const tickers = uniRows.map(r => String(r.ticker).toUpperCase()).filter(Boolean);

  const placeholders = tickers.map(() => '?').join(',');
  const pRows = (tickers.length
    ? (db
        .prepare(
          `SELECT ticker, name, category, 'active' as status, yahoo_symbol, price_multiplier, created_at, updated_at, meta
           FROM portfolio_assets
           WHERE portfolio_id=? AND ticker IN (${placeholders})`
        )
        .all(portfolioId, ...tickers) as any[])
    : []) as any[];
  const pBy = new Map(pRows.map(a => [String(a.ticker).toUpperCase(), a as TsmomAssetRow]));

  const universeNow = Date.now();
  const assets: TsmomAssetRow[] = tickers.map(t => {
    const key = String(t).toUpperCase();
    const row = pBy.get(key);
    const pm = Number((row as any)?.price_multiplier);
    return (
      row ||
      ({
        ticker: key,
        name: null,
        category: null,
        status: 'active',
        yahoo_symbol: null,
        price_multiplier: (Number.isFinite(pm) && pm > 0) ? pm : (key.endsWith('.TA') ? 0.01 : 1),
        created_at: universeNow,
        updated_at: universeNow,
        meta: null,
      } as TsmomAssetRow)
    );
  });

  // Load close histories (shared by raw + instruction derivation)
  const historyStmt = db.prepare('SELECT ts, close FROM candles WHERE symbol=? AND timeframe=\'1d\' ORDER BY ts ASC');

  // --- Phase A: RAW strategy output (depends only on candles + universe) ---
  // IMPORTANT: This section must not depend on portfolio cash/positions.
  const rawUniverse: Array<{ ticker: string; yahooSymbol: string | null; name: string | null; category: string | null; price: number | null; momentum: number | null; sigmaAnn: number | null; rawWeight: number; targetWeight: number }> = [];

  for (const a of assets) {
    const { ticker, yahooSymbol, priceMultiplier } = resolveTicker(a);
    const dbRows = historyStmt.all(ticker) as any[];
    const series = loadCloses(dbRows, priceMultiplier);

    const closes = series.map(x => x.close);
    const last = series.length ? series[series.length - 1] : null;
    const price = last ? last.close : null;

    const momentum = computeMomentum(closes, params.lookbackTradingDays, params.skipRecentTradingDays);
    const sigmaAnn = computeSigmaAnn(closes.slice(-Math.max(260, params.lookbackTradingDays + params.skipRecentTradingDays + 50)), params.volCenterDaysCOM);

    rawUniverse.push({
      ticker,
      yahooSymbol,
      name: a.name,
      category: a.category,
      price,
      momentum,
      sigmaAnn,
      rawWeight: 0,
      targetWeight: 0,
    });
  }

  const eligible = rawUniverse
    .filter(x => (x.momentum ?? -1) > 0)
    .sort((a, b) => (b.momentum ?? -1) - (a.momentum ?? -1))
    .slice(0, params.topK);

  if (eligible.length < params.topK) {
    warnings.push(`Only ${eligible.length}/${params.topK} assets have positive momentum.`);
  }

  // Compute raw weights = targetVol / sigma (raw, then scaled)
  const raws: Array<{ ticker: string; raw: number }> = [];
  for (const e of eligible) {
    const s = Number(e.sigmaAnn);
    if (!Number.isFinite(s) || s <= 0) continue;
    raws.push({ ticker: e.ticker, raw: Math.min(params.maxLeverage, params.targetVolAnn / s) });
  }

  let sumRaw = raws.reduce((a, r) => a + r.raw, 0);
  if (sumRaw <= 0) {
    warnings.push('No assets had a valid volatility estimate; plan is all-cash.');
    sumRaw = 0;
  }

  const scale = sumRaw > params.maxLeverage ? (params.maxLeverage / sumRaw) : 1;
  const rawMap = new Map(raws.map(r => [r.ticker, r.raw]));
  const targetWMap = new Map(raws.map(r => [r.ticker, r.raw * scale]));

  for (const r of rawUniverse) {
    r.rawWeight = rawMap.get(r.ticker) || 0;
    r.targetWeight = targetWMap.get(r.ticker) || 0;
  }

  // --- Phase B: PORTFOLIO instructions (depends on cached state) ---
  const state = getPortfolioState(portfolioId);
  const positions = state.positions;
  const cashBase = Number(state.cashBase);

  // Ensure any held tickers not in universe still appear (so we can generate SELL-to-zero instructions)
  const heldTickers = Object.keys(positions || {}).map(t => String(t).toUpperCase()).filter(t => t && Number(positions[t]) !== 0);
  const knownSet = new Set(rawUniverse.map(r => String(r.ticker).toUpperCase()));
  const now = Date.now();
  for (const t of heldTickers) {
    if (knownSet.has(t)) continue;
    // Minimal placeholder row for held symbols outside the strategy universe.
    rawUniverse.push({
      ticker: t,
      yahooSymbol: null,
      name: null,
      category: 'held',
      price: null,
      momentum: null,
      sigmaAnn: null,
      rawWeight: 0,
      targetWeight: 0,
    });
    // Try to load a last price for mark-to-market and sell sizing.
    try {
      const dbRows = historyStmt.all(t) as any[];
      const series = loadCloses(dbRows, 1);
      const last = series.length ? series[series.length - 1] : null;
      rawUniverse[rawUniverse.length - 1].price = last ? last.close : null;
    } catch {
      // ignore
    }
  }

  // Compute holdings value using last prices and FX.
  let holdingsValueBase = 0;
  for (const it of rawUniverse) {
    const q = Number(positions[String(it.ticker).toUpperCase()] || 0);
    if (!Number.isFinite(q) || q === 0) continue;
    const px = Number(it.price);
    if (!Number.isFinite(px) || px <= 0) continue;
    const assetCcy = inferAssetCurrency(it.ticker);
    const { rate, warning } = fxRateToBase(db, baseCurrency, assetCcy);
    if (warning) warnings.push(warning);
    holdingsValueBase += q * px * rate;
  }

  const equityBase = cashBase + holdingsValueBase;
  if (equityBase <= 0) warnings.push('Equity is <= 0; add a DEPOSIT to start.');

  // Build executable items by applying target weights to portfolio state.
  const scored: Array<RebalancePlanItem> = [];
  for (const r of rawUniverse) {
    const currentQty = Number(positions[String(r.ticker).toUpperCase()] || 0);
    const px = Number(r.price);

    const assetCcy = inferAssetCurrency(r.ticker);
    const { rate } = fxRateToBase(db, baseCurrency, assetCcy);
    const pxBase = (Number.isFinite(px) && px > 0) ? px * rate : 0;

    const w = Number(r.targetWeight || 0);
    const targetValueBase = equityBase * w;
    const targetQty = (Number.isFinite(pxBase) && pxBase > 0)
      ? Math.floor(targetValueBase / pxBase)
      : 0;

    const deltaQty = targetQty - currentQty;
    const action = deltaQty > 0 ? 'BUY' : deltaQty < 0 ? 'SELL' : 'HOLD';

    scored.push({
      ticker: r.ticker,
      yahooSymbol: r.yahooSymbol,
      name: r.name,
      category: r.category,
      price: r.price,
      momentum: r.momentum,
      sigmaAnn: r.sigmaAnn,
      targetWeight: w,
      targetQty,
      currentQty,
      deltaQty,
      action,
    });
  }

  // Only return items with non-zero target weight or current holdings (to keep UI clean)
  const items = scored
    .filter(x => x.targetWeight > 0 || x.currentQty !== 0)
    .sort((a, b) => b.targetWeight - a.targetWeight);

  return {
    asOf: toISODate(Date.now()),
    baseCurrency,
    params,
    equityNIS: baseCurrency === 'ILS' ? equityBase : equityBase,
    cashNIS: baseCurrency === 'ILS' ? cashBase : cashBase,
    holdingsValueNIS: baseCurrency === 'ILS' ? holdingsValueBase : holdingsValueBase,
    items,
    warnings,
    raw: {
      items: rawUniverse
        .filter(r => r.category !== 'held')
        .map(r => ({
          ticker: r.ticker,
          momentum: r.momentum,
          sigmaAnn: r.sigmaAnn,
          price: r.price,
          rawWeight: r.rawWeight,
          targetWeight: r.targetWeight,
        })),
    },
  };
}

export async function computeTsmomSignalMatrix(opts?: { portfolioId?: number }): Promise<SignalMatrix> {
  const db = getDB();

  const params = {
    lookbackTradingDays: 63,
    skipRecentTradingDays: 10,
    volCenterDaysCOM: 20,
    topK: 5,
  };

  const portfolioId = Number(opts?.portfolioId ?? 1);

  // Universe is portfolio-based only.
  const uniRows = db
    .prepare('SELECT ticker FROM portfolio_universe WHERE portfolio_id=? ORDER BY ticker ASC')
    .all(portfolioId) as Array<{ ticker: string }>;
  const tickers = uniRows.map(r => String(r.ticker).toUpperCase()).filter(Boolean);
  if (!tickers.length) {
    return { asOf: toISODate(Date.now()), params, rows: [] };
  }

  const placeholders = tickers.map(() => '?').join(',');
  const pRows = (db
    .prepare(
      `SELECT ticker, name, category, 'active' as status, yahoo_symbol, price_multiplier, created_at, updated_at, meta
       FROM portfolio_assets
       WHERE portfolio_id=? AND ticker IN (${placeholders})`
    )
    .all(portfolioId, ...tickers) as any[]) as any[];
  const pBy = new Map(pRows.map(a => [String(a.ticker).toUpperCase(), a as TsmomAssetRow]));

  const now = Date.now();
  const assets: TsmomAssetRow[] = tickers.map(t => {
    const key = String(t).toUpperCase();
    const row = pBy.get(key);
    const pm = Number((row as any)?.price_multiplier);
    return (
      row ||
      ({
        ticker: key,
        name: null,
        category: null,
        status: 'active',
        yahoo_symbol: null,
        price_multiplier: Number.isFinite(pm) && pm > 0 ? pm : key.endsWith('.TA') ? 0.01 : 1,
        created_at: now,
        updated_at: now,
        meta: null,
      } as TsmomAssetRow)
    );
  });

  const historyStmt = db.prepare("SELECT ts, close FROM candles WHERE symbol=? AND timeframe='1d' ORDER BY ts ASC");
  const requiredClosesForMomentum = params.lookbackTradingDays + params.skipRecentTradingDays + 2;

  const scored: SignalMatrixRow[] = [];
  for (const a of assets) {
    const { ticker, priceMultiplier } = resolveTicker(a);
    const dbRows = historyStmt.all(ticker) as any[];
    const series = loadCloses(dbRows, priceMultiplier);
    const closes = series.map(x => x.close);
    const last = series.length ? series[series.length - 1] : null;
    const price = last ? last.close : null;

    const momentum = computeMomentum(closes, params.lookbackTradingDays, params.skipRecentTradingDays);
    const sigmaAnn = computeSigmaAnn(closes.slice(-Math.max(260, params.lookbackTradingDays + params.skipRecentTradingDays + 50)), params.volCenterDaysCOM);

    scored.push({
      ticker,
      name: a.name,
      category: a.category,
      status: a.status,
      price,
      momentum,
      sigmaAnn,
      rank: null,
      isTopK: false,

      candles1dTotal: dbRows.length,
      closes1dValid: series.length,
      requiredClosesForMomentum,
    });
  }

  const sorted = scored
    .slice()
    .sort((a, b) => (b.momentum ?? -999) - (a.momentum ?? -999));

  // Rank everything (including negative momentum)
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].rank = i + 1;
  }

  // Mark Top K among positive momentum
  const pos = sorted.filter(x => (x.momentum ?? -1) > 0).slice(0, params.topK);
  const topSet = new Set(pos.map(x => x.ticker));
  for (const r of sorted) r.isTopK = topSet.has(r.ticker);

  return {
    asOf: toISODate(Date.now()),
    params,
    rows: sorted,
  };
}
