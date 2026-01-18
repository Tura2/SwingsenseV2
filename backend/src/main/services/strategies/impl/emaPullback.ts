import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'emaPullback',
  kind: 'long',
  evaluate(ctx) {
    const { bundle, candles } = ctx;
    const n = candles.length; if (n === 0) return [];
    const close = bundle.closes[n-1];
    const ema20 = bundle.ema[20][n-1];
    const ema50 = bundle.ema[50][n-1];
    const ema100 = bundle.ema[100][n-1];
    const rsi = bundle.rsi14[n-1];
    // Required conditions
    const touched = (()=>{ for (let i=Math.max(0,n-5); i<n; i++){ const c = bundle.closes[i]; if (c <= bundle.ema[20][i]) return true; } return false; })();
    if (!(close > ema50 && close >= ema20 && touched && rsi >= 40 && rsi <= 55)) return [];
    const atr = bundle.atr14[n-1] || 0;
    // pivot low last 10 bars
    let pivot = Infinity; for (let i=Math.max(0,n-10); i<n; i++){ if (candles[i].low < pivot) pivot = candles[i].low; }
    const stop = Math.min(pivot, close - 1*atr);
    const firstTarget = close + 1.5*atr;
    return [{ id: 'emaPullback', kind: 'long', name: 'EMA Pullback', side: 'LONG', entry: close, stop, firstTarget, timestamp: candles[n-1].ts, tags: ['emaPullback'], notes: 'EMA20 pullback + RSI reset' }];
  }
};
