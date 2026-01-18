import type { StrategyModule } from "../index.js";
import { detectCupHandle } from "../../utils/patternUtils.js";

export const strategy: StrategyModule = {
  id: 'patternCupHandle',
  kind: 'long',
  evaluate(ctx){
    const { candles, bundle } = ctx; const n=candles.length; if (n<80) return [];
    const i=n-1; const res = detectCupHandle(bundle.closes);
    if (!res.isCup) return [];
    // Break of handle pivot (exclude current bar from lookback)
    const look = Math.min(10, i);
    const handleHigh = Math.max(...bundle.closes.slice(i - look, i));
    const close = bundle.closes[i];
    if (close <= handleHigh) return [];
    // Optional quality: enforce reasonable handle depth and breakout volume
    try {
      const winStart = Math.max(0, i - 60);
      const peak = Math.max(...bundle.closes.slice(winStart, i));
      const trough = Math.min(...bundle.closes.slice(winStart, i));
      const handleDepthPct = peak ? ((peak - trough) / peak * 100) : 0;
      if (!(handleDepthPct >= 8 && handleDepthPct <= 33)) return [];
      const vol = bundle.volumes[i] || 0;
      const volMA20 = bundle.volMA20[i] || 1;
      if (!(vol >= 1.5 * volMA20)) return [];
    } catch {}
    const atr = bundle.atr14[i]||0;
    const stop = close - 1.3*atr;
    const firstTarget = close + 2.6*atr;
    return [{ id:'patternCupHandle', kind:'long', name:'Cup & Handle', side:'LONG', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['patternCupHandle'], reasons:['cupHandleBreak'], strategyFactors:[{ name:'volumeSpike', hit: bundle.volumes[i] >= 1.5*(bundle.volMA20[i]||1) }, { name:'rsiBullRange', hit: bundle.rsi14[i] >= 55 }, { name:'trendAlignment', hit: bundle.ema[20][i] > bundle.ema[50][i] }], notes:'Cup and handle breakout'}];
  }
};
