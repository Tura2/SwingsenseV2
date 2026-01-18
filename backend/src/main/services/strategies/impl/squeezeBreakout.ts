import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'squeezeBreakout',
  kind: 'long',
  evaluate(ctx) {
    const { bundle, candles, config } = ctx; const n = candles.length; if (!n) return [];
    const i = n-1;
    const close = bundle.closes[i];
    const ema50 = bundle.ema[50][i];
    const macdHist = bundle.macd.hist[i];
    const bbU = bundle.bb.upper[i]; const bbL = bundle.bb.lower[i]; const bbMid = bundle.bb.middle[i];
    const widthRankPrev = bundle.bb.widthRank120[i-1] ?? 100;
    const expanding = bundle.bb.width[i] > (bundle.bb.width[i-1]||0);
    if (!(widthRankPrev <= 30 && expanding && close > bbU && close > ema50 && macdHist >= 0)) return [];
    const atr = bundle.atr14[i] || 0;
    const stop = Math.min(candles[i].low, bbMid);
    const firstTarget = close + 2*atr;
    return [{ id: 'squeezeBreakout', kind: 'long', name: 'Squeeze Breakout', side: 'LONG', entry: close, stop, firstTarget, timestamp: candles[i].ts, tags: ['squeezeBreakout','expansion'], notes: 'Squeeze expansion breakout' }];
  }
};
