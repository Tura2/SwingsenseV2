import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'rsiPositiveReversal',
  kind: 'long',
  evaluate(ctx){
    const { candles, bundle } = ctx; const n=candles.length; if (n<30) return [];
    const i=n-1; const close=bundle.closes[i];
    const ema50=bundle.ema[50]?.[i]; if (!ema50) return [];
    if (close < ema50) return [];
    // Higher price low with lower RSI low (hidden bullish divergence)
    const rsi = bundle.rsi14;
    if (rsi.length < 10) return [];
    const pLow1 = Math.min(...bundle.closes.slice(i-12,i-6));
    const pLow2 = Math.min(...bundle.closes.slice(i-6,i));
    const rsiLow1 = Math.min(...rsi.slice(i-12,i-6));
    const rsiLow2 = Math.min(...rsi.slice(i-6,i));
    const priceHigherLow = pLow2 > pLow1;
    const rsiLowerLow = rsiLow2 < rsiLow1;
    if (!(priceHigherLow && rsiLowerLow)) return [];
    const histUp = bundle.macd.hist[i] > bundle.macd.hist[i-1];
    const atr = bundle.atr14[i]||0;
    const stop = pLow2 - 0.8*atr;
    const firstTarget = close + 1.6*atr;
    return [{ id:'rsiPositiveReversal', kind:'long', name:'RSI Positive Reversal', side:'LONG', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['rsiPositiveReversal'], reasons:['hiddenBullDiv'], strategyFactors:[{ name:'macdHistUp', hit: histUp }, { name:'rsiBullRange', hit: bundle.rsi14[i] >= 50 }, { name:'patternTightness', hit: (bundle.atr14[i]||1) < (bundle.atr14[i-5]||2) }], notes:'Hidden bullish RSI reversal'}];
  }
};
