import type { StrategyModule } from "../index.js";
import { detectFlagPennant, isTight } from "../../utils/patternUtils.js";

export const strategy: StrategyModule = {
  id: 'patternFlagPennant',
  kind: 'long',
  evaluate(ctx){
    const { candles, bundle } = ctx; const n=candles.length; if (n<30) return [];
    const i=n-1; const res = detectFlagPennant(bundle.closes, bundle.highs, bundle.lows, bundle.ema[20]);
    if (!res.isFlag) return [];
    // prior strong leg: RSI 60-80 recently
    const recentRsi = bundle.rsi14.slice(-10);
    const strong = recentRsi.some(r=>r>=60 && r<=80);
    if (!strong) return [];
  // Break of flag high (pivotIdx high) -> exclude current bar in the high computation
  const hiWindowStart = Math.max(res.pivotIdx, 0);
  const hiWindowEnd = Math.max(i, hiWindowStart + 1);
  const flagHigh = Math.max(...bundle.highs.slice(hiWindowStart, hiWindowEnd));
  const close = bundle.closes[i]; if (!(close > flagHigh)) return [];
  // Consolidation quality: compression + volume profile
  const atrRank20 = (bundle as any).bb?.widthRank120?.[i] ?? undefined;
  if (atrRank20 != null && atrRank20 > 40) return [];
  const prevVol = bundle.volumes[i-1] ?? 0; const prevMA = bundle.volMA20[i-1] || 1;
  if (!(prevVol < prevMA)) return [];
  const vol = bundle.volumes[i] ?? 0; const volMA = bundle.volMA20[i] || 1;
  if (!(vol >= 1.4 * volMA)) return [];
    const atr = bundle.atr14[i]||0;
    const stop = close - 1.2*atr;
    const firstTarget = close + 2.4*atr;
    return [{ id:'patternFlagPennant', kind:'long', name:'Flag/Pennant', side:'LONG', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['patternFlagPennant'], reasons:['flagBreak'], strategyFactors:[{ name:'patternTightness', hit: isTight(res.widthPct) }, { name:'volumeSpike', hit: bundle.volumes[i] >= 1.5*(bundle.volMA20[i]||1) }, { name:'macdAboveZero', hit: bundle.macd.hist[i] >= 0 }], notes:'Flag/pennant breakout with EMA20 confluence'}];
  }
};
