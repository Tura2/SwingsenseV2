import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'emaBounceBullStack',
  kind: 'long',
  evaluate(ctx){
    const { candles, bundle } = ctx; const n=candles.length; if (n<40) return [];
    const i=n-1; const close=bundle.closes[i];
    const e20=bundle.ema[20]?.[i]; const e50=bundle.ema[50]?.[i]; const e200=bundle.ema[200]?.[i];
    if (!(e20 && e50 && e200)) return [];
    const stack = e20 > e50 && e50 > e200;
    if (!stack) return [];
    // touch/undercut & reclaim of EMA20 in last 5 bars
    let touched=false; for (let k=i-5;k<=i;k++){ if (k>=0 && bundle.lows[k] <= bundle.ema[20][k]) { touched=true; break; } }
    if (!(touched && close >= e20)) return [];
    const atr = bundle.atr14[i]||0;
    const stop = close - 1.1*atr;
    const firstTarget = close + 2*atr;
    return [{ id:'emaBounceBullStack', kind:'long', name:'EMA Bounce Bull Stack', side:'LONG', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['emaBounceBullStack'], reasons:['bullStack','reclaim20'], strategyFactors:[{ name:'rsiBullRange', hit: bundle.rsi14[i] >= 55 }, { name:'volumeSpike', hit: bundle.volumes[i] >= 1.2*(bundle.volMA20[i]||1) }, { name:'macdHistUp', hit: bundle.macd.hist[i] > bundle.macd.hist[i-1] }], notes:'20>50>200 rising bounce'}];
  }
};
