import type { TsmomAssetRow } from './types.js';

export type ResolvedTicker = {
  ticker: string;
  yahooSymbol: string;
  priceMultiplier: number;
};

export function resolveTicker(asset: Pick<TsmomAssetRow, 'ticker' | 'yahoo_symbol' | 'price_multiplier'>): ResolvedTicker {
  const yahooSymbol = String(asset.yahoo_symbol || asset.ticker).trim();
  const m = Number(asset.price_multiplier);
  return {
    ticker: String(asset.ticker).trim(),
    yahooSymbol,
    priceMultiplier: Number.isFinite(m) && m > 0 ? m : 1,
  };
}
