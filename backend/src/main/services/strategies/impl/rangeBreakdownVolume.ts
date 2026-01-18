import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'rangeBreakdownVolume',
  kind: 'short',
  evaluate(ctx){
    const { candles, bundle } = ctx; const n=candles.length; if (n<25) return [];
    const i=n-1; const close=bundle.closes[i];
    const dcLow = bundle.donchian20.lo[i];
    if (!(close < dcLow)) return [];
    const ema100 = bundle.ema[100]?.[i]; if (!ema100 || !(close < ema100)) return [];
    const vol = bundle.volumes[i]; const volMA = bundle.volMA20[i]||1;
    if (!(vol >= 1.25*volMA)) return [];
    const atr=bundle.atr14[i]||0;
    const stop = close + 1.2*atr;
    const firstTarget = close - 2.4*atr;
    const newLow = close <= Math.min(...bundle.closes.slice(-20));
    return [{ id:'rangeBreakdownVolume', kind:'short', name:'Range Breakdown Volume', side:'SHORT', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['rangeBreakdownVolume'], reasons:['dcBreak','volConfirm'], strategyFactors:[{ name:'newLow', hit:newLow }, { name:'preBreakTightness', hit: bundle.bb.widthRank120[i] <= 35 }, { name:'volumeSpike', hit: vol >= 1.4*volMA }], notes:'Range breakdown with volume'}];
  }
};
