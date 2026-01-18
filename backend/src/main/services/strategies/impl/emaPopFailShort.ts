import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'emaPopFailShort',
  kind: 'short',
  evaluate(ctx) {
    const { bundle, candles } = ctx; const n = candles.length; if (n < 2) return [];
    const i = n-1; const prev = n-2;
    const close = bundle.closes[i];
    const prevClose = bundle.closes[prev];
    const ema20 = bundle.ema[20][i];
    const ema50 = bundle.ema[50][i];
    const high = bundle.highs[i];
    const macdHist = bundle.macd.hist[i];
    // Required: yesterday close > EMA20, today close < EMA20 with high >= EMA20, and close < EMA50
    if (!(prevClose > bundle.ema[20][prev] && close < ema20 && high >= ema20 && close < ema50)) return [];
    const atr = bundle.atr14[i] || 0;
    const stop = high;
    const firstTarget = close - 1.5*atr;
    return [{ id: 'emaPopFailShort', kind: 'short', name: 'EMA Pop-Fail Short', side: 'SHORT', entry: close, stop, firstTarget, timestamp: candles[i].ts, tags: ['emaPopFailShort'], notes: 'Failed rally to EMA20' }];
  }
};
