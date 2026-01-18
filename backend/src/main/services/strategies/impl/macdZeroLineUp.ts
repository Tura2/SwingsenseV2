import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'macdZeroLineUp',
  kind: 'long',
  evaluate(ctx){
    const { candles, bundle } = ctx; const n=candles.length; if (n<35) return [];
    const i=n-1; const close=bundle.closes[i];
    const ema50 = bundle.ema[50]?.[i]; if (!ema50) return [];
    if (!(close > ema50)) return [];
    // MACD zero line cross (hist turns positive today while negative yesterday)
    const hist = bundle.macd.hist; if (hist[i] == null) return [];
    const zeroCross = hist[i] > 0 && hist[i-1] <= 0;
    if (!zeroCross) return [];
    const vol = bundle.volumes[i]; const volMA = bundle.volMA20[i]||1;
    const atr = bundle.atr14[i]||0;
    const stop = close - 1.2*atr;
    const firstTarget = close + 1.8*atr;
    return [{ id:'macdZeroLineUp', kind:'long', name:'MACD Zero-Line Turn', side:'LONG', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['macdZeroLine'], reasons:['macdZeroCross'], strategyFactors:[{ name:'volumeSpike', hit: vol >= 1.25*volMA }, { name:'rsiBullRange', hit: bundle.rsi14[i] >= 52 }, { name:'bbWidthLow', hit: bundle.bb.widthRank120[i] <= 40 }, { name:'macdHistUp', hit: hist[i] > hist[i-1] }], notes:'MACD histogram turned positive above EMA50'}];
  }
};
