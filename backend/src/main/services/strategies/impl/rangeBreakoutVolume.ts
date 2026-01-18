import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'rangeBreakoutVolume',
  kind: 'long',
  evaluate(ctx) {
    const { bundle, candles } = ctx; const n = candles.length; if (!n) return [];
    const i = n-1;
    const close = bundle.closes[i];
    const ema100 = bundle.ema[100][i];
    const hi20 = bundle.donchian20.hi[i];
    const volMA20 = bundle.volMA20[i] || 0;
    const vol = bundle.volumes[i] || 0;
    if (!(close > hi20 && close > ema100 && vol >= 1.25 * volMA20)) return [];
    const atr = bundle.atr14[i] || 0;
    const stop = Math.min(candles[i].low, bundle.donchian20.lo[i]);
    const firstTarget = close + 2*atr;
    return [{ id: 'rangeBreakoutVolume', kind: 'long', name: 'Range Breakout + Vol', side: 'LONG', entry: close, stop, firstTarget, timestamp: candles[i].ts, tags: ['rangeBreakout'], notes: '20-bar breakout with volume' }];
  }
};
