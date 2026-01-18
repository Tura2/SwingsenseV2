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

  const warnings: string[] = [];

  const positions: PositionSnapshot[] = [];
  let holdingsValueBase = 0;

  for (const [ticker, qtyRaw] of Object.entries(state.positions)) {
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty === 0) continue;

    const assetCurrency = inferAssetCurrency(ticker);
    const lastPrice = getLatestClose(ticker);

    const { rate, warning } = fxRateToBase(baseCurrency, assetCurrency);
    if (warning) warnings.push(warning);

    const valueBase = (Number.isFinite(lastPrice as any) && lastPrice != null) ? (qty * lastPrice * rate) : 0;
    holdingsValueBase += valueBase;

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

  return {
    portfolioId: pid,
    baseCurrency,
    cashBase,
    holdingsValueBase,
    navBase,
    positions,
    warnings,
  };
}
