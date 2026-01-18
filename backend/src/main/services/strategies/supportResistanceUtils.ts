import type { Candle } from "../../../shared/types.js";

// Detect major horizontal support/resistance from recent history
// Percentile-based: ~10th percentile (support) of lows, ~90th percentile (resistance) of highs.
// Pure, synchronous, no I/O.
export function detectSupportResistance(candles: Candle[], lookback = 60): {
  majorSupport?: number;
  majorResistance?: number;
  sampleCount: number;
} {
  if (!Array.isArray(candles) || candles.length === 0) return { sampleCount: 0 };
  const n = candles.length;
  const start = Math.max(0, n - Math.max(1, Math.floor(lookback)));
  const slice = candles.slice(start);

  // Collect lows and highs with basic validation
  const lows: number[] = [];
  const highs: number[] = [];
  for (const c of slice) {
    const lo = c?.low;
    const hi = c?.high;
    if (Number.isFinite(lo)) lows.push(lo as number);
    if (Number.isFinite(hi)) highs.push(hi as number);
  }
  const sampleCount = Math.min(lows.length, highs.length);
  if (sampleCount < 10) return { sampleCount };

  // Percentile helper (inclusive, nearest-rank style)
  function percentile(arr: number[], p: number): { value?: number; idx: number; sorted: number[] } | undefined {
    if (!arr.length) return undefined;
    const sorted = arr.slice().sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return { value: sorted[rank], idx: rank, sorted };
  }

  // Compute base percentiles
  const supP = percentile(lows, 0.10);
  const resP = percentile(highs, 0.90);
  if (!supP || !resP || !Number.isFinite(supP.value!) || !Number.isFinite(resP.value!)) return { sampleCount };

  // Smooth by averaging with neighboring 5 values (clamp edges)
  function smoothAround(sorted: number[], idx: number, neighbors = 5): number {
    const startIdx = Math.max(0, idx - neighbors);
    const endIdx = Math.min(sorted.length - 1, idx + neighbors);
    let sum = 0, count = 0;
    for (let k = startIdx; k <= endIdx; k++) { const v = sorted[k]; if (Number.isFinite(v)) { sum += v; count++; } }
    return count > 0 ? sum / count : sorted[idx] ?? NaN;
  }

  let support = smoothAround(supP.sorted, supP.idx, 5);
  let resistance = smoothAround(resP.sorted, resP.idx, 5);

  // Optional recency bias: blend with recent-half percentile (closer to last 2-3 months)
  const recentLen = Math.max(10, Math.floor(Math.min(lows.length, highs.length, Math.max(1, Math.floor(lookback / 2)))));
  const lowsRecent = lows.slice(-recentLen);
  const highsRecent = highs.slice(-recentLen);
  const pctSimple = (arr: number[], p: number): number | undefined => {
    if (!arr.length) return undefined;
    const s = arr.slice().sort((a,b)=>a-b);
    const rank = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
    return s[rank];
  };
  const supRecent = pctSimple(lowsRecent, 0.10);
  const resRecent = pctSimple(highsRecent, 0.90);
  if (Number.isFinite(supRecent) && Number.isFinite(resRecent)) {
    // 30% weight to recent percentile
    support = 0.7 * support + 0.3 * (supRecent as number);
    resistance = 0.7 * resistance + 0.3 * (resRecent as number);
  }

  if (!Number.isFinite(support) || !Number.isFinite(resistance)) return { sampleCount };
  if (support <= 0 || resistance <= support) return { sampleCount };
  const width = (resistance - support) / Math.max(1e-9, support);
  // Guard: too narrow (<1.5%) or too wide (>30%)
  if (width < 0.015) return { sampleCount };
  if (width > 0.30) return { sampleCount };

  return { majorSupport: support, majorResistance: resistance, sampleCount };
}
