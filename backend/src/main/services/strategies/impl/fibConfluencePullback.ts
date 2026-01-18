import type { StrategyModule } from "../index.js";
import { activeUpLegPivot, inFibZone } from "../../utils/fibUtils.js";

export const strategy: StrategyModule = {
  id: 'fibConfluencePullback',
  kind: 'long',
  evaluate(ctx) {
    if (ctx.config.strategies?.fibConfluencePullback?.enabled === false) return [];
    const { candles, bundle } = ctx; const n=candles.length; if (n<40) return [];
    const i=n-1; const { swingLowIdx, swingHighIdx } = activeUpLegPivot(bundle.closes);
    if (swingHighIdx <= swingLowIdx) return [];
    const low = bundle.closes[swingLowIdx]; const high = bundle.closes[swingHighIdx];
    const close = bundle.closes[i];
    if (!inFibZone(close, low, high, 0.382, 0.618)) return [];
    if (!(close > (bundle.ema[50]?.[i]||0))) return [];
    const atr = bundle.atr14[i]||0;
    const stop = close - 1.2*atr;
    const firstTarget = high;
    return [{ id:'fibConfluencePullback', kind:'long', name:'Fib Confluence Pullback', side:'LONG', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['fibConfluencePullback'], reasons:['fibZone','aboveEMA50'], strategyFactors:[{ name:'fibConfluence', hit:true }, { name:'rsiBullRange', hit: bundle.rsi14[i] >= 45 && bundle.rsi14[i] <= 60 }, { name:'volumeSpike', hit: bundle.volumes[i] < 0.9*(bundle.volMA20[i]||1) }], notes:'Pullback into 38.2-61.8 fib confluence'}];
  }
};
