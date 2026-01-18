import { getDB } from '../../db.js';
import type { Candle } from '../../../shared/types.js';
import type { RebalancePlan, RebalancePlanItem, SignalMatrix, SignalMatrixRow, TsmomAssetRow } from './types.js';
import { resolveTicker } from './tickerMapper.js';

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
    out.push({ ts, close: close * mult });
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

function getCurrentPositions(db: any): Record<string, number> {
  // Sum BUY/SELL quantities
  const trades = db.prepare('SELECT symbol, side, qty FROM portfolio_trades').all() as Array<{ symbol: string; side: 'BUY'|'SELL'; qty: number }>;
  const map: Record<string, number> = {};
  for (const t of trades) {
    const s = String(t.symbol || '').toUpperCase();
    if (!s) continue;
    const q = Number(t.qty);
    if (!Number.isFinite(q)) continue;
    map[s] = (map[s] || 0) + (t.side === 'BUY' ? q : -q);
  }
  return map;
}

function getCashBalance(db: any, commissionDefault: number): number {
  const led = db.prepare('SELECT amount FROM capital_ledger').all() as Array<{ amount: number }>;
  const ledgerSum = led.reduce((a, r) => a + (Number(r.amount) || 0), 0);

  const trades = db.prepare('SELECT side, qty, price, fee FROM portfolio_trades').all() as Array<{ side: 'BUY'|'SELL'; qty: number; price: number; fee?: number }>;
  let cash = ledgerSum;
  for (const t of trades) {
    const qty = Number(t.qty);
    const price = Number(t.price);
    const fee = Number(t.fee);
    const commission = Number.isFinite(fee) ? fee : commissionDefault;
    if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;
    const gross = qty * price;
    if (t.side === 'BUY') cash -= gross + commission;
    else cash += gross - commission;
  }
  return cash;
}

export async function computeTsmomTurboV2Plan(): Promise<RebalancePlan> {
  const db = getDB();

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

  const assets = db
    .prepare("SELECT ticker, name, category, status, yahoo_symbol, price_multiplier, created_at, updated_at, meta FROM assets WHERE status='active'")
    .all() as TsmomAssetRow[];

  const positions = getCurrentPositions(db);
  const cashNIS = getCashBalance(db, params.commissionNIS);

  // Load close histories
  const historyStmt = db.prepare('SELECT ts, close FROM candles WHERE symbol=? AND timeframe=\'1d\' ORDER BY ts ASC');

  const scored: Array<RebalancePlanItem> = [];

  for (const a of assets) {
    const { ticker, yahooSymbol, priceMultiplier } = resolveTicker(a);
    const dbRows = historyStmt.all(ticker) as any[];
    const series = loadCloses(dbRows, priceMultiplier);

    const closes = series.map(x => x.close);
    const last = series.length ? series[series.length - 1] : null;
    const price = last ? last.close : null;

    const momentum = computeMomentum(closes, params.lookbackTradingDays, params.skipRecentTradingDays);
    const sigmaAnn = computeSigmaAnn(closes.slice(-Math.max(260, params.lookbackTradingDays + params.skipRecentTradingDays + 50)), params.volCenterDaysCOM);

    scored.push({
      ticker,
      yahooSymbol,
      name: a.name,
      category: a.category,
      price,
      momentum,
      sigmaAnn,
      targetWeight: 0,
      targetQty: 0,
      currentQty: Number(positions[ticker.toUpperCase()] || 0),
      deltaQty: 0,
      action: 'HOLD',
    });
  }

  const eligible = scored
    .filter(x => (x.momentum ?? -1) > 0)
    .sort((a, b) => (b.momentum ?? -1) - (a.momentum ?? -1))
    .slice(0, params.topK);

  if (eligible.length < params.topK) {
    warnings.push(`Only ${eligible.length}/${params.topK} assets have positive momentum.`);
  }

  // Compute raw weights = targetVol / sigma
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

  // Compute holdings value using last prices
  let holdingsValueNIS = 0;
  for (const it of scored) {
    const q = Number(it.currentQty || 0);
    if (!Number.isFinite(q) || !Number.isFinite(it.price || NaN)) continue;
    holdingsValueNIS += q * Number(it.price);
  }

  const equityNIS = cashNIS + holdingsValueNIS;
  if (equityNIS <= 0) warnings.push('Equity is <= 0 based on capital_ledger and trades; add a DEPOSIT in capital_ledger to start.');

  // Apply targets
  const rawMap = new Map(raws.map(r => [r.ticker, r.raw * scale]));

  for (const it of scored) {
    const w = rawMap.get(it.ticker) || 0;
    it.targetWeight = w;

    const px = Number(it.price);
    const targetValue = equityNIS * w;
    const targetQty = (Number.isFinite(px) && px > 0) ? Math.floor(targetValue / px) : 0;

    it.targetQty = targetQty;
    it.deltaQty = targetQty - it.currentQty;

    if (it.deltaQty > 0) it.action = 'BUY';
    else if (it.deltaQty < 0) it.action = 'SELL';
    else it.action = 'HOLD';
  }

  // Only return items with non-zero target weight or current holdings (to keep UI clean)
  const items = scored
    .filter(x => x.targetWeight > 0 || x.currentQty !== 0)
    .sort((a, b) => b.targetWeight - a.targetWeight);

  return {
    asOf: toISODate(Date.now()),
    params,
    equityNIS,
    cashNIS,
    holdingsValueNIS,
    items,
    warnings,
  };
}

export async function computeTsmomSignalMatrix(): Promise<SignalMatrix> {
  const db = getDB();

  const params = {
    lookbackTradingDays: 63,
    skipRecentTradingDays: 10,
    volCenterDaysCOM: 20,
    topK: 5,
  };

  const assets = db
    .prepare("SELECT ticker, name, category, status, yahoo_symbol, price_multiplier, created_at, updated_at, meta FROM assets WHERE status='active'")
    .all() as TsmomAssetRow[];

  const historyStmt = db.prepare("SELECT ts, close FROM candles WHERE symbol=? AND timeframe='1d' ORDER BY ts ASC");

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
