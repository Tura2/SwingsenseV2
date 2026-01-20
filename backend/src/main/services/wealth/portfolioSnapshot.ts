import { getDB } from '../../db.js';
import { getPortfolioState, type Currency } from './portfolioState.js';

export type PositionSnapshot = {
  ticker: string;
  qty: number;
  lastPrice: number | null;
  avgBuyPrice: number | null;
  costBasisBase: number | null;
  pnlOpenBase: number | null;
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

type TradeRow = {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  trade_currency?: string | null;
  fx_rate?: number | null;
  notional_base?: number | null;
  fee_base?: number | null;
  fee?: number | null;
  ts: number;
  id: number;
};

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

  function priceMultiplierFor(ticker: string): number {
    const t = String(ticker || '').toUpperCase();
    try {
      const r1 = multPortfolioStmt.get(pid, t) as any;
      const m1 = Number(r1?.m);
      if (Number.isFinite(m1) && m1 > 0) return m1;
    } catch {
      // ignore
    }
    // Fallback: Yahoo TASE prices are typically in agorot; convert to ILS for valuation.
    return t.endsWith('.TA') ? 0.01 : 1;
  }

  const warnings: string[] = [];

  // Reconstruct per-symbol average cost from trade history (average cost method).
  // - costBasisBase excludes fees (fees are tracked separately in the trade ledger / record book).
  // - avgBuyPrice is returned in trade/asset currency units.
  const tradeRows = db
    .prepare(`SELECT id, symbol, side, qty, price, ts, trade_currency, fx_rate, notional_base, fee_base, fee FROM portfolio_trades WHERE portfolio_id=? ORDER BY ts ASC, id ASC`)
    .all(pid) as TradeRow[];

  const costBySymbol: Record<string, { shares: number; costBasisBase: number; costTrade: number }> = {};

  for (const tr of tradeRows) {
    const symbol = String(tr.symbol || '').toUpperCase();
    const side = String(tr.side || '').toUpperCase() as 'BUY' | 'SELL';
    const qty = Number(tr.qty);
    const price = Number(tr.price);
    if (!symbol || !Number.isFinite(qty) || qty <= 0) continue;

    let notionalBase = Number(tr.notional_base);
    if (!Number.isFinite(notionalBase) || notionalBase < 0) {
      // Fallback for legacy rows.
      const tradeCurrency = String(tr.trade_currency || '').toUpperCase() || baseCurrency;
      const grossTrade = (Number.isFinite(price) ? price : 0) * qty;
      if (tradeCurrency === baseCurrency) {
        notionalBase = grossTrade;
      } else {
        const fx = Number(tr.fx_rate);
        notionalBase = (Number.isFinite(fx) && fx > 0) ? grossTrade * fx : 0;
      }
    }
    if (!Number.isFinite(notionalBase) || notionalBase < 0) notionalBase = 0;

    const slot = costBySymbol[symbol] || { shares: 0, costBasisBase: 0, costTrade: 0 };

    if (side === 'BUY') {
      slot.shares += qty;
      slot.costBasisBase += notionalBase;
      // We treat `price` as already in trade currency units (USD or ILS).
      if (Number.isFinite(price) && price > 0) slot.costTrade += qty * price;
    } else {
      // SELL: reduce cost basis by average-cost-per-share (ignores sell proceeds and sell fees).
      if (slot.shares > 0) {
        const sellQty = Math.min(qty, slot.shares);
        const avgBase = slot.costBasisBase / slot.shares;
        const avgTrade = slot.costTrade / slot.shares;
        slot.shares -= sellQty;
        slot.costBasisBase -= avgBase * sellQty;
        slot.costTrade -= avgTrade * sellQty;
        if (slot.shares <= 1e-9) {
          slot.shares = 0;
          slot.costBasisBase = 0;
          slot.costTrade = 0;
        }
      }
    }

    costBySymbol[symbol] = slot;
  }

  const positions: PositionSnapshot[] = [];
  // holdingsValueBase is the market value of holdings in base currency (sum over positions of qty * last * FX).
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

  let holdingsPrevMarketBase = 0;

  let costBasisOpenBase = 0;

  for (const [ticker, qtyRaw] of Object.entries(state.positions)) {
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty === 0) continue;

    const assetCurrency = inferAssetCurrency(ticker);
    const closes2 = getLatestTwoCloses(ticker);
    const pxMult = priceMultiplierFor(ticker);

    // Normalize candle prices into asset currency units (e.g., ILS for .TA) by applying multiplier.
    const lastPrice = (closes2.last != null && Number.isFinite(closes2.last)) ? (Number(closes2.last) * pxMult) : null;
    const prevPrice = (closes2.prev != null && Number.isFinite(closes2.prev)) ? (Number(closes2.prev) * pxMult) : null;

    const { rate, warning } = fxRateToBase(baseCurrency, assetCurrency);
    if (warning) warnings.push(warning);

    const marketValueBase = (lastPrice != null && Number.isFinite(lastPrice) && lastPrice > 0) ? (qty * lastPrice * rate) : 0;
    holdingsValueBase += marketValueBase;

    // Daily P&L: compare last close vs previous close in base currency.
    // We use FX close-to-close when asset currency differs from base.
    let ratePrev = rate;
    if (baseCurrency !== assetCurrency) {
      if (assetCurrency === 'USD' && baseCurrency === 'ILS') {
        ratePrev = (usdIls2.prev != null ? usdIls2.prev : rate);
      } else if (assetCurrency === 'ILS' && baseCurrency === 'USD') {
        ratePrev = (usdIls2.prev != null ? 1 / usdIls2.prev : rate);
      }
    }

    const marketValuePrevBase = (prevPrice != null && Number.isFinite(prevPrice) && prevPrice > 0) ? (qty * prevPrice * ratePrev) : 0;
    holdingsPrevMarketBase += marketValuePrevBase;

    // Attach avg buy price + cost basis for this holding (best-effort).
    const symKey = String(ticker).toUpperCase();
    const slot = costBySymbol[symKey];

    let avgBuyPrice: number | null = null;
    let costBasisBase: number | null = null;
    if (slot && slot.shares > 0 && qty > 0) {
      const basePerShare = slot.costBasisBase / slot.shares;
      const tradePerShare = slot.costTrade / slot.shares;
      costBasisBase = Math.max(0, basePerShare * qty);
      avgBuyPrice = Number.isFinite(tradePerShare) && tradePerShare > 0 ? tradePerShare : null;
      costBasisOpenBase += Math.max(0, Number(costBasisBase) || 0);
    }

    // Open P&L (unrealized) is market value minus cost basis (avg cost).
    const pnlOpenBase = (costBasisBase != null && Number.isFinite(costBasisBase)) ? (marketValueBase - costBasisBase) : null;

    positions.push({
      ticker,
      qty,
      lastPrice,
      avgBuyPrice,
      costBasisBase,
      pnlOpenBase,
      assetCurrency,
      fxRateToBase: rate,
      valueBase: marketValueBase,
    });
  }

  positions.sort((a, b) => Math.abs(b.valueBase) - Math.abs(a.valueBase));

  const cashBase = Number(state.cashBase);
  // NAV per Wealth UI definition: sum of position market values (cash is shown separately).
  const navBase = holdingsValueBase;

  // Daily P&L
  // Daily P&L is the cumulative close-to-close change across all held assets.
  const pnlDailyBase = Number.isFinite(holdingsValueBase) && Number.isFinite(holdingsPrevMarketBase) ? (holdingsValueBase - holdingsPrevMarketBase) : null;
  const pnlDailyPct = (pnlDailyBase != null && holdingsPrevMarketBase > 0) ? (pnlDailyBase / holdingsPrevMarketBase) : null;

  // Open P&L (unrealized)
  // Open P&L is the cumulative unrealized P&L across held assets.
  const pnlOpenBase = Number.isFinite(holdingsValueBase) && Number.isFinite(costBasisOpenBase) ? (holdingsValueBase - costBasisOpenBase) : null;
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
