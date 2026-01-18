import type { StrategyModule } from "../index.js";

/**
 * mtfAlignment (LONG)
 * - Uses CLOSED bars only (i = n-1)
 * - LTF trend: ema20 > ema50 > ema200 (evaluated at t-1)
 * - Optional HTF filter (if bundle.htf.ema50 exists) => close > htf ema50 (t-1)
 * - Breakout trigger: close > recentHigh(20) excluding current bar (no look-ahead)
 * - Guardrails: ATR% cap, liquidity floor, optional BB width rank & volume expansion
 * - Stop: min(structureLow(20), close - 1·ATR)
 * - First target: close + 2R (price units)
 * - Emits one signal per symbol/bar
 */
export const strategy: StrategyModule = {
  id: "mtfAlignment",
  kind: "long",

  evaluate(ctx) {
    const { candles, bundle } = ctx;

    // Runtime knobs (all optional; defaults are safe/sensible)
    const runtime = (ctx as {
      runtime?: {
        volumeThresholdUSD?: number;
        maxAtrPct?: number;
        priceTick?: number;
        minHistoryBars?: number;
        donchianLen?: number;
        breakoutAtrBuffer?: number;   // additional ATR buffer above recentHigh (e.g., 0.2)
        bbWidthRankMax?: number;      // e.g., <= 60
        requireVolExpansion?: boolean;
      };
    }).runtime ?? {};

    const n = candles.length;
    const minBars = runtime.minHistoryBars ?? 220;
    if (n < minBars) return [];

    // ---------- index policy: CLOSED bar only ----------
    const i  = n - 1;      // last fully CLOSED bar
    const i1 = i - 1;      // previous closed bar

    // ---------- accessors ----------
    const closes = bundle.closes as number[];
    const highs  = bundle.highs as number[];
    const lows   = bundle.lows as number[];
    const vols   = bundle.volumes as number[];

    const ema20   = bundle.ema?.[20];
    const ema50   = bundle.ema?.[50];
    const ema200  = bundle.ema?.[200];
    const macdH   = bundle.macd?.hist;
    const atrSeries = (bundle as typeof bundle & { atr?: Record<number, number[]> }).atr;
    const atr14   = atrSeries?.[14];
    const volMA20 = bundle.volMA20;
    const bbWR120 = bundle.bb?.widthRank120;

    // ---------- basic presence checks ----------
    if (!closes?.length || !highs?.length || !lows?.length || !vols?.length) return [];
    if (!ema20?.length || !ema50?.length || !ema200?.length) return [];
    if (!atr14?.length) return [];

    const close = closes[i];
    const high  = highs[i];
    const low   = lows[i];
    const atr   = atr14[i];

    // ---------- HTF filter if available (t-1) ----------
    const htfOK = (() => {
      const htf = (bundle as any).htf;
      const htfEma50: number[] | undefined = htf?.ema50;
      if (!htfEma50?.length) return true;
      const htf50 = htfEma50[i1];
      return htf50 != null ? close > htf50 : true;
    })();

    // ---------- trend filters at t-1 ----------
    const ema20_1  = ema20[i1];
    const ema50_1  = ema50[i1];
    const ema200_1 = ema200[i1];
    const uptrend  = (ema20_1 != null && ema50_1 != null && ema200_1 != null) &&
                     (ema20_1 > ema50_1 && ema50_1 > ema200_1);

    const macdUpOK = (() => {
      if (!macdH?.length || i1 - 1 < 0) return true; // optional
      const a = macdH[i1 - 1];
      const b = macdH[i1];
      return (a != null && b != null) ? b > a : true;
    })();

    // ---------- structure (exclude current bar from windows) ----------
    const donLen = Math.max(5, runtime.donchianLen ?? 20);
    const start  = Math.max(0, i - donLen);
    const end    = i;  // exclusive of i
    const recentHigh = maxSlice(highs, start, end);
    const recentLow  = minSlice(lows,  start, end);

    // Optional breakout ATR buffer (avoid buying right at resistance)
    const atrBuf = Math.max(0, runtime.breakoutAtrBuffer ?? 0);
    const breakoutOK = close > (recentHigh + atrBuf * atr);

    // ---------- guardrails ----------
    const dollarVol = close * vols[i];
    const volUSDmin = runtime.volumeThresholdUSD ?? 5_000_000;
    if (!(dollarVol >= volUSDmin)) return [];

    const atrPct    = atr / close;
    const maxAtrPct = runtime.maxAtrPct ?? 0.05;
    if (!(Number.isFinite(atrPct) && atrPct <= maxAtrPct)) return [];

    const bbWidthRankOK = (() => {
      if (!bbWR120?.length) return true; // optional
      const wr = bbWR120[i1];
      const cap = runtime.bbWidthRankMax ?? 60;
      return wr != null ? (wr <= cap) : true;
    })();

    const volExpandOK = (() => {
      if (!volMA20?.length) return true; // optional
      const ma = volMA20[i1];
      return ma != null ? (vols[i] > ma) : true;
    })();

    if (runtime.requireVolExpansion === true && !volExpandOK) return [];

    // ---------- stop & first target (price units) ----------
    const structureLow = recentLow;
    const stop = Math.min(structureLow, close - 1 * atr);
    if (!(stop < close)) return [];

    const risk = close - stop;
    const firstTarget = close + 2 * risk;

    // ---------- combined gates ----------
    if (!(uptrend && htfOK && breakoutOK && macdUpOK && bbWidthRankOK)) return [];

    // ---------- emit one signal ----------
    return [{
      id: `mtfAlignment:${candles[i].ts}`,
      kind: "long",
      name: "mtfAlignment",
      side: "LONG",
      entry: roundToTick(close, runtime.priceTick),
      stop: roundToTick(stop, runtime.priceTick),
      target: roundToTick(firstTarget, runtime.priceTick),
      timestamp: candles[i].ts,
      tags: ["mtfAlignment"],
      reasons: [
        "EMA20>50>200 (t-1)",
        "HTF ok",
        `Breakout>Donchian${donLen}${atrBuf>0 ? ` + ${atrBuf}·ATR` : ""}`,
        "MACD rising (t-1)",
        `ATR%<=${(maxAtrPct*100).toFixed(1)} & $Vol>=${fmtUSD(volUSDmin)}`
      ],
      strategyFactors: [
        { name: "bbWidthLow",  hit: bbWidthRankOK },
        { name: "volumeSpike", hit: volExpandOK },
        { name: "macdHistUp",  hit: macdUpOK }
      ]
    }];
  }
};

/** Helpers (kept local to avoid new imports) */
function maxSlice(arr: number[], from: number, to: number): number {
  let m = -Infinity;
  for (let k = from; k < to; k++) if (arr[k] > m) m = arr[k];
  return m;
}
function minSlice(arr: number[], from: number, to: number): number {
  let m = Infinity;
  for (let k = from; k < to; k++) if (arr[k] < m) m = arr[k];
  return m;
}
function roundToTick(px: number, tick?: number): number {
  if (!tick || tick <= 0) return px;
  const k = Math.round(px / tick);
  return +(k * tick).toFixed(10);
}
function fmtUSD(n: number): string {
  if (!Number.isFinite(n)) return `${n}`;
  if (n >= 1e9)  return `$${(n/1e9 ).toFixed(1)}B`;
  if (n >= 1e6)  return `$${(n/1e6 ).toFixed(1)}M`;
  if (n >= 1e3)  return `$${(n/1e3 ).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
