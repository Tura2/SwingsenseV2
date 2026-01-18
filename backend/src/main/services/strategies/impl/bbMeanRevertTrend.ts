import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'bbMeanRevertTrend',
  kind: 'long',
  evaluate(ctx){
    const { candles, bundle } = ctx; const n=candles.length; if (n<25) return [];
    const i=n-1; const close=bundle.closes[i];
    const ema50=bundle.ema[50]?.[i]; if (!ema50) return [];
    if (!(close > ema50)) return [];
    // tag lower band within last 3 bars
    let tagged=false; for (let k=i-3;k<=i;k++){ if (k>=0 && bundle.closes[k] <= (bundle.bb.lower[k]||0)) { tagged=true; break; } }
    if (!tagged) return [];
    const mid = bundle.bb.middle[i];
    if (!(close > mid)) return [];
    const atr = bundle.atr14[i]||0;
    const stop = close - 1.3*atr;
    const firstTarget = close + 1.8*atr;
    const bar = candles[i]; const lowerTail = (bar.close - bar.low) / ((bar.high - bar.low)||1);
    const volDry = bundle.volumes[i] < 0.9*(bundle.volMA20[i]||1);
    return [{ id:'bbMeanRevertTrend', kind:'long', name:'BB Mean Revert Trend', side:'LONG', entry:close, stop, firstTarget, timestamp:bar.ts, tags:['bbMeanRevertTrend'], reasons:['tagLower','closeAboveMid','uptrend'], strategyFactors:[{ name:'rsiBullRange', hit: bundle.rsi14[i] > 50 }, { name:'volumeSpike', hit: bundle.volumes[i] >= 1.3*(bundle.volMA20[i]||1) }, { name:'patternTightness', hit: volDry }, { name:'macdHistUp', hit: bundle.macd.hist[i] > bundle.macd.hist[i-1] }, { name:'upperWickLong', hit: lowerTail > 0.4 }], notes:'Lower band tag to mean reversion in uptrend'}];
  }
};
