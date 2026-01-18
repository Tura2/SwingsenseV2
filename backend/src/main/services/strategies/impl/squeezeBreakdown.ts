import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'squeezeBreakdown',
  kind: 'short',
  evaluate(ctx) {
    const { bundle, candles } = ctx; const n = candles.length; if (!n) return [];
    const i = n-1;
    const close = bundle.closes[i];
    const ema50 = bundle.ema[50][i];
    const macdHist = bundle.macd.hist[i];
    const bbU = bundle.bb.upper[i]; const bbL = bundle.bb.lower[i];
    const widthRankPrev = bundle.bb.widthRank120[i-1] ?? 100;
    const expanding = bundle.bb.width[i] > (bundle.bb.width[i-1]||0);
    if (!(widthRankPrev <= 30 && expanding && close < bbL && close < ema50 && macdHist <= 0)) return [];
    const atr = bundle.atr14[i] || 0;
    const high = candles[i].high;
    const stop = high;
    const firstTarget = close - 2*atr;
    return [{ id: 'squeezeBreakdown', kind: 'short', name: 'Squeeze Breakdown', side: 'SHORT', entry: close, stop, firstTarget, timestamp: candles[i].ts, tags: ['squeezeBreakdown','expansion'], notes: 'Squeeze expansion breakdown' }];
  }
};
