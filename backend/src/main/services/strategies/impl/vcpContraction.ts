import type { StrategyModule } from "../index.js";
import { detectContractions, isTight } from "../../utils/patternUtils.js";

export const strategy: StrategyModule = {
  id: 'vcpContraction',
  kind: 'long',
  evaluate(ctx) {
    if (ctx.config.strategies?.vcpContraction?.enabled === false) return [];
    const { candles, bundle } = ctx; const n=candles.length; if (n<60) return [];
    const i=n-1;
    // ATR5 proxy (EMA style smoothing of ATR14)
    const atr5:number[]=[]; for (let k=0;k<bundle.atr14.length;k++){ const a=bundle.atr14[k]; atr5.push(k===0?a: (atr5[k-1]*4 + a)/5); }
    const { peaks, descending } = detectContractions(atr5);
    if (!descending) return [];
    const look=Math.min(100,n); const seg=bundle.closes.slice(n-look); const min=Math.min(...seg); const max=Math.max(...seg);
    const close=bundle.closes[i]; if (close < (min + (max-min)/2)) return [];
    const lastPeak = peaks[peaks.length-1]; if (lastPeak == null) return [];
    const pivotHigh = Math.max(...bundle.highs.slice(lastPeak));
    if (!(close > pivotHigh)) return [];
    const atr=bundle.atr14[i]||0;
    const stop = close - 1.4*atr;
    const firstTarget = close + 2.8*atr;
    return [{ id:'vcpContraction', kind:'long', name:'VCP Contraction', side:'LONG', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['vcpContraction'], reasons:['contractions','pivotBreak'], strategyFactors:[{ name:'patternTightness', hit: isTight(((atr5[i]||1)/(close||1))*100,6) }, { name:'volumeSpike', hit: bundle.volumes[i] >= 2*(bundle.volMA20[i]||1) }, { name:'rsiBullRange', hit: bundle.rsi14[i] >= 55 }], notes:'VCP breakout'}];
  }
};
