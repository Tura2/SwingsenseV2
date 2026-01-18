import type { StrategyModule } from "../index.js";

export const strategy: StrategyModule = {
  id: 'ema200Reclaim',
  kind: 'long',
  evaluate(ctx) {
    const { candles, bundle } = ctx;
    const n = candles.length; if (n < 60) return [];
    const i = n-1;
    const close = bundle.closes[i];
    const ema200 = bundle.ema[200]?.[i]; if (!ema200) return [];
    // Required: base >= 2 weeks (>=10 bars) hugging/below ema200 then reclaim with higher low pivot
    let belowCount = 0; for (let k=i-15;k<i;k++){ if (k>=0 && bundle.closes[k] <= bundle.ema[200][k]) belowCount++; }
    if (belowCount < 5) return [];
    // find higher low above ema200: pivot low then subsequent higher low
    let pivots:number[] = [];
    for (let k=i-15;k<i;k++) {
      const c = candles[k]; if (!c) continue;
      if (k>0 && k<n-1) {
        if (candles[k].low < candles[k-1].low && candles[k].low < candles[k+1].low) pivots.push(k);
      }
    }
    if (pivots.length < 2) return [];
    const lastTwo = pivots.slice(-2);
    const higherLow = candles[lastTwo[1]].low > candles[lastTwo[0]].low && candles[lastTwo[1]].low > bundle.ema[200][lastTwo[1]];
    if (!higherLow) return [];
    // Break of that pivot high (use high of second pivot bar) with expanding volume
    const vol = bundle.volumes[i];
    const volMA = bundle.volMA20[i] || 1;
    const expanding = vol >= 1.2 * volMA;
    const pivotHigh = candles[lastTwo[1]].high;
    if (!(close > ema200 && close > pivotHigh && expanding)) return [];
    const atr = bundle.atr14[i] || 0;
    const stop = Math.min(...candles.slice(lastTwo[1]).map(c=>c.low), candles[lastTwo[1]].low) - 0.1*atr;
    const firstTarget = close + 2*atr;
    return [{ id:'ema200Reclaim', kind:'long', name:'200EMA Reclaim', side:'LONG', entry:close, stop, firstTarget, timestamp:candles[i].ts, tags:['ema200Reclaim'], reasons:['reclaim','higherLow','expVol'], strategyFactors:[{ name:'volumeSpike', hit: vol >= 1.3*volMA }, { name:'macdAboveZero', hit: bundle.macd.hist[i] >= 0 }, { name:'rsiBullRange', hit: bundle.rsi14[i] >= 55 }, { name:'trendAlignment', hit: (bundle.ema[20][i] > bundle.ema[50][i]) }], notes:'EMA200 reclaim with higher low'}];
  }
};
