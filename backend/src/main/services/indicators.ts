import type { Candle, IndicatorsSnapshot, Overlays } from "../../shared/types.js";

export function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function slope(arr: number[], n = 3): number {
  const len = arr.length;
  if (len < 2) return 0;
  const a = arr[len - 1];
  const b = arr[Math.max(0, len - 1 - n)];
  return a - b;
}

export function rsiSeries(values: number[], period = 14): number[] {
  if (values.length === 0) return [];
  if (values.length < period + 1) return Array(values.length).fill(50);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i-1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const out: number[] = [];
  let avgG = gains / period, avgL = losses / period;
  out[period] = 100 - 100 / (1 + (avgG / (avgL || 1e-9)));
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i-1];
    const g = Math.max(0, d), l = Math.max(0, -d);
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + (avgG / (avgL || 1e-9)));
  }
  return out.map((v) => v ?? out[out.length - 1] ?? 50);
}

export function macdSeries(values: number[], fast=12, slow=26, signalP=9) {
  const emaF = emaSeries(values, fast);
  const emaS = emaSeries(values, slow);
  const macd = values.map((_, i) => (emaF[i] ?? 0) - (emaS[i] ?? 0));
  const signal = emaSeries(macd, signalP);
  const hist = macd.map((v, i) => v - (signal[i] ?? 0));
  return { macd, signal, hist };
}

export function donchian(valuesHigh: number[], valuesLow: number[], period = 20) {
  const hi: number[] = [], lo: number[] = [];
  for (let i = 0; i < valuesHigh.length; i++) {
    const start = Math.max(0, i - period + 1);
    let max = -Infinity, min = Infinity;
    for (let j = start; j <= i; j++) {
      if (valuesHigh[j] !== undefined) max = Math.max(max, valuesHigh[j]);
      if (valuesLow[j] !== undefined) min = Math.min(min, valuesLow[j]);
    }
    hi[i] = max;
    lo[i] = min;
  }
  return { hi, lo };
}

export function findSwings(candles: Candle[], lookback = 10, pct = 3) {
  // Very light zigzag-like pivots: high among neighborhood or low among neighborhood
  const swings: { idx: number; type: 'H'|'L'; price: number }[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isH = true, isL = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (candles[j].high > c.high) isH = false;
      if (candles[j].low < c.low) isL = false;
      if (!isH && !isL) break;
    }
    const last = candles[candles.length - 1].close;
    // Require swing separation via percentage to reduce noise
    if (isH && Math.abs((c.high - last) / last) * 100 >= pct) swings.push({ idx: i, type: 'H', price: c.high });
    if (isL && Math.abs((last - c.low) / last) * 100 >= pct) swings.push({ idx: i, type: 'L', price: c.low });
  }
  swings.sort((a,b)=>a.idx-b.idx);
  return swings;
}

export function computeOverlaysAndSnapshot(candles: Candle[]): { overlays: Overlays; snapshot: IndicatorsSnapshot } {
  const closes = candles.map(c=>c.close);
  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);

  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const ema200 = emaSeries(closes, 200);
  const rsi14 = rsiSeries(closes, 14);
  const macd = macdSeries(closes, 12, 26, 9);
  const dc20 = donchian(highs, lows, 20);

  // swings and fib leg
  const swings = findSwings(candles, 8, 3);
  let fibLeg: IndicatorsSnapshot['fib']['leg'] = null;
  if (swings.length >= 2) {
    const a = swings[swings.length - 2];
    const b = swings[swings.length - 1];
    if (a.type === 'L' && b.type === 'H') fibLeg = { from: a.price, to: b.price, direction: 'up' };
    if (a.type === 'H' && b.type === 'L') fibLeg = { from: a.price, to: b.price, direction: 'down' };
  }
  let fibLevels: IndicatorsSnapshot['fib']['levels'] = null;
  let fibRegion: IndicatorsSnapshot['fib']['region'] | undefined = undefined;
  const lastClose = closes[closes.length - 1] ?? 0;
  if (fibLeg) {
    const range = fibLeg.to - fibLeg.from;
    const abs = Math.abs(range);
    if (abs > 1e-8) {
      const up = fibLeg.direction === 'up';
      const base = up ? fibLeg.to : fibLeg.from;
      const from = up ? fibLeg.from : fibLeg.to;
      const l382 = base - 0.382 * (base - from);
      const l50  = base - 0.5   * (base - from);
      const l618 = base - 0.618 * (base - from);
      fibLevels = { '38.2': l382, '50': l50, '61.8': l618 };
      fibRegion = lastClose > l382 ? 'above' : lastClose > l50 ? '38-50' : lastClose > l618 ? '50-61.8' : 'below';
    }
  }

  const snapshot: IndicatorsSnapshot = {
    ema20: ema20[ema20.length - 1] ?? 0,
    ema50: ema50[ema50.length - 1] ?? 0,
    ema200: ema200[ema200.length - 1] ?? 0,
    ema20Slope: slope(ema20),
    ema50Slope: slope(ema50),
    ema200Slope: slope(ema200),
    rsi14: rsi14[rsi14.length - 1] ?? 50,
    macd: {
      line: macd.macd[macd.macd.length - 1] ?? 0,
      signal: macd.signal[macd.signal.length - 1] ?? 0,
      hist: macd.hist[macd.hist.length - 1] ?? 0,
    },
    donchian20: {
      high: dc20.hi[dc20.hi.length - 1] ?? 0,
      low: dc20.lo[dc20.lo.length - 1] ?? 0
    },
    fib: { leg: fibLeg, levels: fibLevels, region: fibRegion }
  };

  return { overlays: { ema20, ema50, ema200 }, snapshot };
}

// --- Advanced indicator utilities for swing engine ---

export function smaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    out[i] = i >= period - 1 ? sum / period : (out[i-1] ?? values[i] ?? 0);
  }
  return out;
}

export function stdDevSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - period + 1);
    const window = values.slice(start, i + 1);
    const mean = window.reduce((a,b)=>a+(b??0),0) / window.length;
    const variance = window.reduce((a,b)=>a+Math.pow((b??0)-mean,2),0) / window.length;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

export function atrSeries(candles: Candle[], period = 14): number[] {
  const out: number[] = [];
  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);
  const closes = candles.map(c=>c.close);
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { tr.push(highs[i] - lows[i]); continue; }
    const h = highs[i], l = lows[i], pc = closes[i-1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let prev = tr.slice(0, Math.min(period, tr.length)).reduce((a,b)=>a+b,0) / Math.min(period, tr.length || 1);
  for (let i = 0; i < tr.length; i++) {
    if (i === 0) { out[i] = prev; continue; }
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function adxSeries(candles: Candle[], period = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);
  const closes = candles.map(c=>c.close);
  const len = candles.length;
  const plusDM: number[] = [], minusDM: number[] = [], tr: number[] = [];
  for (let i = 0; i < len; i++) {
    if (i === 0) { plusDM.push(0); minusDM.push(0); tr.push(highs[i] - lows[i]); continue; }
    const upMove = highs[i] - highs[i-1];
    const downMove = lows[i-1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const h = highs[i], l = lows[i], pc = closes[i-1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  function smooth(arr: number[]): number[] {
    const out: number[] = [];
    let prev = arr.slice(0, period).reduce((a,b)=>a+b,0);
    for (let i = 0; i < arr.length; i++) {
      if (i < period) { out[i] = arr[i]; continue; }
      prev = prev - (arr[i - period] ?? 0) + (arr[i] ?? 0);
      out[i] = prev;
    }
    return out;
  }
  const atrN = atrSeries(candles, period); // already smoothed
  const plusDI: number[] = plusDM.map((v, i) => 100 * (emaSeries(plusDM, period)[i] ?? 0) / Math.max(1e-9, atrN[i] ?? 1));
  const minusDI: number[] = minusDM.map((v, i) => 100 * (emaSeries(minusDM, period)[i] ?? 0) / Math.max(1e-9, atrN[i] ?? 1));
  const dx: number[] = plusDI.map((p, i) => {
    const m = minusDI[i] ?? 0;
    const denom = p + m;
    return denom === 0 ? 0 : (100 * Math.abs(p - m) / denom);
  });
  const adx = emaSeries(dx, period);
  return { adx, plusDI, minusDI };
}

export function bollingerBands(values: number[], period = 20, mult = 2) {
  const mid = smaSeries(values, period);
  const sd = stdDevSeries(values, period);
  const upper = values.map((_, i) => (mid[i] ?? 0) + mult * (sd[i] ?? 0));
  const lower = values.map((_, i) => (mid[i] ?? 0) - mult * (sd[i] ?? 0));
  return { upper, middle: mid, lower };
}

export function keltnerChannels(candles: Candle[], period = 20, atrMult = 1.5) {
  const closes = candles.map(c=>c.close);
  const basis = emaSeries(closes, period);
  const atrN = atrSeries(candles, period);
  const upper = basis.map((b, i) => (b ?? 0) + atrMult * (atrN[i] ?? 0));
  const lower = basis.map((b, i) => (b ?? 0) - atrMult * (atrN[i] ?? 0));
  return { upper, basis, lower };
}

export function volumeMA(volumes: number[], period = 20): number[] {
  return smaSeries(volumes, period);
}

export function chandelierExit(candles: Candle[], period = 22, atrMult = 3) {
  const atrN = atrSeries(candles, Math.max(1, Math.min(period, 14)));
  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);
  const long: number[] = [];
  const short: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - period + 1);
    const hh = Math.max(...highs.slice(start, i + 1));
    const ll = Math.min(...lows.slice(start, i + 1));
    long[i] = hh - atrMult * (atrN[i] ?? 0);
    short[i] = ll + atrMult * (atrN[i] ?? 0);
  }
  return { long, short };
}

export function atrPercentile(atr: number[], lookback = 100): number {
  if (!atr.length) return 0;
  const last = atr[atr.length - 1] ?? 0;
  const start = Math.max(0, atr.length - lookback);
  const window = atr.slice(start);
  const count = window.filter(v => v <= last).length;
  return Math.round(100 * count / window.length);
}

// Relative Strength slope using ratio of closes aligned by timestamp
export function relativeStrengthSlope(symbol1D: Candle[], bench1D: Candle[], period = 20): number {
  if (!symbol1D.length || !bench1D.length) return 0;
  const benchMap = new Map<number, number>();
  for (const b of bench1D) benchMap.set(b.ts, b.close);
  const pairs: number[] = [];
  for (const c of symbol1D) {
    const bc = benchMap.get(c.ts);
    if (bc && bc > 0) pairs.push(c.close / bc);
  }
  if (pairs.length < period + 1) return 0;
  const rsEma = emaSeries(pairs, period);
  return slope(rsEma, period);
}

// Aggregate daily candles into weekly by ISO week (Mon-Sun)
export function aggregateWeeklyFromDaily(candles: Candle[]): Candle[] {
  if (!candles.length) return [];
  function isoWeekKey(ts: number) {
    const d = new Date(ts);
    const day = (d.getUTCDay() + 6) % 7; // 0=Mon
    const thurs = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
    const yearStart = new Date(Date.UTC(thurs.getUTCFullYear(), 0, 1));
    const week = Math.floor((Number(thurs) - Number(yearStart)) / (7 * 86400000)) + 1;
    return `${thurs.getUTCFullYear()}-W${week}`;
  }
  const groups = new Map<string, Candle[]>();
  for (const c of candles) {
    const k = isoWeekKey(c.ts);
    const arr = groups.get(k) ?? [];
    arr.push(c);
    groups.set(k, arr);
  }
  const out: Candle[] = [];
  const keys = Array.from(groups.keys()).sort();
  for (const k of keys) {
    const arr = groups.get(k)!;
    arr.sort((a,b)=>a.ts-b.ts);
    const open = arr[0].open;
    const close = arr[arr.length - 1].close;
    let high = -Infinity, low = Infinity, vol = 0;
    let ts = arr[0].ts;
    for (const c of arr) { high = Math.max(high, c.high); low = Math.min(low, c.low); vol += c.volume; ts = Math.max(ts, c.ts); }
    out.push({ ts, open, high, low, close, volume: vol });
  }
  return out;
}

export function aggregateMonthlyFromDaily(candles: Candle[]): Candle[] {
  if (!candles.length) return [];
  const groups = new Map<string, Candle[]>();
  for (const c of candles) {
    const d = new Date(c.ts);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    const arr = groups.get(k) ?? [];
    arr.push(c);
    groups.set(k, arr);
  }
  const out: Candle[] = [];
  const keys = Array.from(groups.keys()).sort();
  for (const k of keys) {
    const arr = groups.get(k)!;
    arr.sort((a,b)=>a.ts-b.ts);
    const open = arr[0].open;
    const close = arr[arr.length - 1].close;
    let high = -Infinity, low = Infinity, vol = 0;
    let ts = arr[0].ts;
    for (const c of arr) { high = Math.max(high, c.high); low = Math.min(low, c.low); vol += c.volume; ts = Math.max(ts, c.ts); }
    out.push({ ts, open, high, low, close, volume: vol });
  }
  return out;
}
