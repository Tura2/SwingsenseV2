import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'ema200RejectionShort',
  kind: 'short',
  evaluate(ctx){
    const { candles, bundle } = ctx; const n=candles.length; if (n<50) return [];
    const i=n-1; const close=bundle.closes[i];
    const ema200 = bundle.ema[200]?.[i]; if (!ema200) return [];
    if (!(close < ema200)) return [];
    // rally tags ema200 within last 3 bars then reversal close back down (close < prior close and prior bar high >= ema200)
    let tagged=false; for (let k=i-3;k<=i;k++){ if (k>=0 && bundle.highs[k] >= bundle.ema[200][k]) { tagged=true; break; } }
    if (!tagged) return [];
    const prior = candles[i-1]; if (!prior) return [];
    const reversal = close < prior.close;
    if (!reversal) return [];
    const atr=bundle.atr14[i]||0;
    const stop = Math.max(...bundle.highs.slice(i-5,i+1)) + 0.2*atr;
    const firstTarget = close - 2*atr;
    return [{ id:'ema200RejectionShort', kind:'short', name:'200EMA Rejection Short', side:'SHORT', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['ema200RejectionShort'], reasons:['ema200Reject','reversal'], strategyFactors:[{ name:'upperWickFail', hit: (prior.high - Math.max(prior.close, prior.open))/((prior.high-prior.low)||1) > 0.4 }, { name:'macdHistUp', hit: bundle.macd.hist[i] < bundle.macd.hist[i-1] }, { name:'volumeSpike', hit: bundle.volumes[i] >= 1.3*(bundle.volMA20[i]||1) }], notes:'EMA200 rejection short'}];
  }
};
