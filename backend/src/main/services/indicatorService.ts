// Simple indicator bundle builder for new swing momentum engine
import type { Candle } from "../../shared/types.js";
import { emaSeries, rsiSeries, macdSeries, bollingerBands, atrSeries, donchian, volumeMA } from "./indicators.js";

export interface PrecomputedIndicatorBundle {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  ema: Record<number, number[]>; // keyed by period
  rsi14: number[];
  macd: { macd: number[]; signal: number[]; hist: number[] };
  bb: { upper: number[]; middle: number[]; lower: number[]; width: number[]; widthRank120: number[] };
  atr14: number[];
  volMA20: number[];
  donchian20: { hi: number[]; lo: number[] };
}

export interface IndicatorParams {
  emaPeriods: number[];
  bb: { period: number; mult: number };
  rsiPeriod: number;
  macd: { fast: number; slow: number; signal: number };
  atrPeriod: number;
  donchianPeriod: number;
  bbWidthRankLookback: number;
}

export function buildIndicatorBundle(candles: Candle[], params: IndicatorParams): PrecomputedIndicatorBundle {
  const closes = candles.map(c=>c.close);
  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);
  const volumes = candles.map(c=>c.volume);

  const ema: Record<number, number[]> = {};
  for (const p of params.emaPeriods) ema[p] = emaSeries(closes, p);
  const rsiArr = rsiSeries(closes, params.rsiPeriod);
  const macd = macdSeries(closes, params.macd.fast, params.macd.slow, params.macd.signal);
  const bbRaw = bollingerBands(closes, params.bb.period, params.bb.mult);
  const width = bbRaw.upper.map((u,i)=> (u - (bbRaw.lower[i]||0)) / (bbRaw.middle[i]||1));
  const widthRank120: number[] = [];
  const look = params.bbWidthRankLookback;
  for (let i=0;i<width.length;i++) {
    const start = Math.max(0, i - look + 1);
    const win = width.slice(start, i+1);
    const last = width[i]||0;
    const rank = win.filter(w=>w <= last).length / win.length;
    widthRank120.push(Math.round(rank*100));
  }
  const atr14 = atrSeries(candles, params.atrPeriod);
  const volMA20 = volumeMA(volumes, 20);
  const dc20 = donchian(highs, lows, params.donchianPeriod);

  return { closes, highs, lows, volumes, ema, rsi14: rsiArr, macd, bb: { ...bbRaw, width, widthRank120 }, atr14, volMA20, donchian20: dc20 };
}
