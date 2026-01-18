import { getDB } from '../../db.js';
import { getPortfolioState, type Currency } from './portfolioState.js';

export type PositionSnapshot = {
  ticker: string;
  qty: number;
  lastPrice: number | null;
  assetCurrency: Currency;
  fxRateToBase: number;
  valueBase: number;
};

export type PortfolioSnapshot = {
  portfolioId: number;
  baseCurrency: Currency;
  cashBase: number;
  holdingsValueBase: number;
  navBase: number;
  pnlDailyBase: number | null;
  pnlDailyPct: number | null;
  pnlOpenBase: number | null;
  pnlOpenPct: number | null;
  positions: PositionSnapshot[];
  warnings: string[];
};

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

function getLatestClose(symbol: string): number | null {
  const db = getDB();
  const row = db
    .prepare("SELECT close FROM candles WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 1")
    .get(symbol) as any;
  const c = Number(row?.close);
  return Number.isFinite(c) ? c : null;
}

function getLatestTwoCloses(symbol: string): { last: number | null; prev: number | null } {
  const db = getDB();
  const rows = db
    .prepare("SELECT close FROM candles WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 2")
    .all(symbol) as any[];
  const last = Number(rows?.[0]?.close);
  const prev = Number(rows?.[1]?.close);
  return {
    last: Number.isFinite(last) ? last : null,
    prev: Number.isFinite(prev) ? prev : null,
  };
}

function getUsdIls(): number | null {
  // Yahoo FX ticker typically used: USDILS=X
  const c = getLatestClose('USDILS=X');
  return c;
}

function fxRateToBase(base: Currency, assetCcy: Currency): { rate: number; warning?: string } {
  if (base === assetCcy) return { rate: 1 };

  const usdIls = getUsdIls();
  if (!usdIls || !Number.isFinite(usdIls) || usdIls <= 0) {
    return {
      rate: 1,
      warning: `Missing FX candle for USDILS=X; using 1.0 for ${assetCcy}->${base} conversion.`,
    };
  }

  // usdIls is ILS per USD
  if (assetCcy === 'USD' && base === 'ILS') return { rate: usdIls };
  if (assetCcy === 'ILS' && base === 'USD') return { rate: 1 / usdIls };
  return { rate: 1 };
}

export function getPortfolioBaseCurrency(portfolioId: number): Currency {
  const db = getDB();
  const pid = Number(portfolioId);
  const row = db.prepare('SELECT base_currency FROM portfolios WHERE id=?').get(pid) as any;
  return normalizeCurrency(row?.base_currency);
}

export function computePortfolioSnapshot(portfolioId: number): PortfolioSnapshot {
  const pid = Number(portfolioId);
  const baseCurrency = getPortfolioBaseCurrency(pid);
  const state = getPortfolioState(pid);

  const db = getDB();
  const multPortfolioStmt = db.prepare('SELECT price_multiplier as m FROM portfolio_assets WHERE portfolio_id=? AND ticker=?');
  const multGlobalStmt = db.prepare('SELECT price_multiplier as m FROM assets WHERE ticker=?');

  function priceMultiplierFor(ticker: string): number {
    const t = String(ticker || '').toUpperCase();
    try {
      const r1 = multPortfolioStmt.get(pid, t) as any;
      const m1 = Number(r1?.m);
      if (Number.isFinite(m1) && m1 > 0) return m1;
    } catch {
      // ignore
    }
    try {
      const r2 = multGlobalStmt.get(t) as any;
      const m2 = Number(r2?.m);
      if (Number.isFinite(m2) && m2 > 0) return m2;
    } catch {
      // ignore
    }
    // Fallback: Yahoo TASE prices are typically in agorot; convert to ILS for valuation.
    return t.endsWith('.TA') ? 0.01 : 1;
  }

  const warnings: string[] = [];

  const positions: PositionSnapshot[] = [];
  let holdingsValueBase = 0;

  // For daily P&L we need previous close for assets and FX.
  const usdIls2 = getLatestTwoCloses('USDILS=X');
  if (baseCurrency !== 'USD' && baseCurrency !== 'ILS') {
    warnings.push(`Unknown base currency ${String(baseCurrency)}; daily P&L may be incorrect.`);
  }

  // Only needed when the portfolio base currency isn't USD.
  if (baseCurrency === 'ILS' && (usdIls2.last == null || usdIls2.prev == null)) {
    warnings.push('Missing FX history for USDILS=X; daily P&L may be unavailable.');
  }

  let holdingsPrevBase = 0;

  for (const [ticker, qtyRaw] of Object.entries(state.positions)) {
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty === 0) continue;

    const assetCurrency = inferAssetCurrency(ticker);
    const closes2 = getLatestTwoCloses(ticker);
    const lastPrice = closes2.last;

    // Keep lastPrice in the raw candle units (useful for UI), but use multiplier for valuation.
    const pxMult = priceMultiplierFor(ticker);

    const { rate, warning } = fxRateToBase(baseCurrency, assetCurrency);
    if (warning) warnings.push(warning);

    const valueBase = (Number.isFinite(lastPrice as any) && lastPrice != null) ? (qty * lastPrice * pxMult * rate) : 0;
    holdingsValueBase += valueBase;

    // Daily P&L: compare last close vs previous close in base currency.
    // We use FX close-to-close when asset currency differs from base.
    const prevPrice = closes2.prev;
    let ratePrev = rate;
    if (baseCurrency !== assetCurrency) {
      if (assetCurrency === 'USD' && baseCurrency === 'ILS') {
        ratePrev = (usdIls2.prev != null ? usdIls2.prev : rate);
      } else if (assetCurrency === 'ILS' && baseCurrency === 'USD') {
        ratePrev = (usdIls2.prev != null ? 1 / usdIls2.prev : rate);
      }
    }

    const valuePrev = (prevPrice != null && Number.isFinite(prevPrice)) ? (qty * prevPrice * pxMult * ratePrev) : 0;
    holdingsPrevBase += valuePrev;

    positions.push({
      ticker,
      qty,
      lastPrice,
      assetCurrency,
      fxRateToBase: rate,
      valueBase,
    });
  }

  positions.sort((a, b) => Math.abs(b.valueBase) - Math.abs(a.valueBase));

  const cashBase = Number(state.cashBase);
  const navBase = cashBase + holdingsValueBase;

  // Daily P&L
  const prevNavBase = cashBase + holdingsPrevBase;
  const pnlDailyBase = Number.isFinite(holdingsValueBase) && Number.isFinite(holdingsPrevBase) ? (holdingsValueBase - holdingsPrevBase) : null;
  const pnlDailyPct = (pnlDailyBase != null && Number.isFinite(prevNavBase) && prevNavBase > 0) ? (pnlDailyBase / prevNavBase) : null;

  // Open P&L (unrealized): reconstruct remaining cost basis from trade history using average cost method.
  const tradeRows = db
    .prepare(`SELECT symbol, side, qty, notional_base, fee_base, fee, ts, id FROM portfolio_trades WHERE portfolio_id=? ORDER BY ts ASC, id ASC`)
    .all(pid) as any[];

  const costShares: Record<string, { shares: number; costBasis: number }> = {};
  for (const tr of tradeRows) {
    const symbol = String(tr.symbol || '').toUpperCase();
    const side = String(tr.side || '').toUpperCase();
    const qty = Number(tr.qty);
    if (!symbol || !Number.isFinite(qty) || qty <= 0) continue;

    const feeBase = Number.isFinite(Number(tr.fee_base)) ? Number(tr.fee_base) : (Number.isFinite(Number(tr.fee)) ? Number(tr.fee) : 0);
    const notionalBase = Number(tr.notional_base);
    const grossBase = Number.isFinite(notionalBase) && notionalBase >= 0 ? notionalBase : 0;

    const slot = costShares[symbol] || { shares: 0, costBasis: 0 };

    if (side === 'BUY') {
      slot.shares += qty;
      slot.costBasis += grossBase + feeBase;
    } else if (side === 'SELL') {
      if (slot.shares <= 0) {
        // Nothing to reduce; ignore.
      } else {
        const sellQty = Math.min(qty, slot.shares);
        const avgCost = slot.costBasis / slot.shares;
        slot.shares -= sellQty;
        slot.costBasis -= avgCost * sellQty;
        if (slot.shares <= 1e-9) {
          slot.shares = 0;
          slot.costBasis = 0;
        }
      }
    }

    costShares[symbol] = slot;
  }

  let costBasisOpenBase = 0;
  for (const p of positions) {
    const slot = costShares[String(p.ticker).toUpperCase()];
    if (!slot) continue;
    // If we have negative/short positions, cost basis isn't well-defined in this v1.
    if (Number(p.qty) <= 0) continue;
    costBasisOpenBase += Math.max(0, Number(slot.costBasis) || 0);
  }

  const pnlOpenBase = Number.isFinite(costBasisOpenBase) ? (holdingsValueBase - costBasisOpenBase) : null;
  const pnlOpenPct = (pnlOpenBase != null && costBasisOpenBase > 0) ? (pnlOpenBase / costBasisOpenBase) : null;

  return {
    portfolioId: pid,
    baseCurrency,
    cashBase,
    holdingsValueBase,
    navBase,
    pnlDailyBase,
    pnlDailyPct,
    pnlOpenBase,
    pnlOpenPct,
    positions,
    warnings,
  };
}
