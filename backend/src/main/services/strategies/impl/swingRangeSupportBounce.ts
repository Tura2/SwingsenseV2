import type { StrategyModule } from "../index.js";
import { detectSupportResistance } from "../supportResistanceUtils.js";

// Swing Range - Support Bounce (LONG)
// Pure, synchronous, last-candle evaluation. Uses precomputed indicator bundle.
export const strategy: StrategyModule = {
  id: "swingRangeSupportBounce",
  kind: "long",
  evaluate(ctx) {
    const { candles } = ctx;
    const n = candles.length;
    if (n < 120) return [];
    const i = n - 1;

    // Extract indicators and prices
    const b = ctx.bundle as any;
    const closes: number[] = b?.closes || [];
    const lows: number[] = b?.lows || [];
    const highs: number[] = b?.highs || [];
    const bb = b?.bb as { upper: number[]; middle: number[]; lower: number[]; width: number[] };
    const rsi14: number[] = b?.rsi14 || [];
    const atr14: number[] = b?.atr14 || [];

    // Guard array access
    if (
      !Array.isArray(closes) || !Array.isArray(lows) || !Array.isArray(highs) ||
      !bb || !Array.isArray(bb.lower) || !Array.isArray(bb.width) ||
      !Array.isArray(rsi14) || !Array.isArray(atr14) ||
      i <= 0 ||
      closes[i] == null || lows[i] == null || highs[i] == null ||
      bb.lower[i] == null || bb.width[i] == null || bb.width[i - 1] == null ||
      rsi14[i] == null || atr14[i] == null
    ) {
      return [];
    }

    const openI = candles[i]?.open;
    const closeI = closes[i];
    const lowI = lows[i];
    const highI = highs[i];

    // Engine parameters (typed as any to avoid coupling; optional in config)
    const { majorSupport, majorResistance } = ((ctx.config as any)?.engineParams ?? {}) as {
      majorSupport?: number;
      majorResistance?: number;
    };
    // Fallback to detected horizontal levels when not provided
    let sup: number | undefined = Number.isFinite(majorSupport) ? (majorSupport as number) : undefined;
    let res: number | undefined = Number.isFinite(majorResistance) ? (majorResistance as number) : undefined;
    if (!Number.isFinite(sup) || !Number.isFinite(res)) {
      const det = detectSupportResistance(candles, 60);
      if (!Number.isFinite(sup)) sup = det.majorSupport;
      if (!Number.isFinite(res)) res = det.majorResistance;
    }
    if (!Number.isFinite(sup) || !Number.isFinite(res)) return [];
    if (!(sup! > 0) || !(res! > sup!)) return [];

    // Range width must be at least 5%
  const rangeWidth = (res! - sup!) / Math.max(1e-9, sup!);
  if (!(rangeWidth >= 0.015)) return [];
  if (rangeWidth > 0.30) return []; // skip unrealistic >30%

    // Skip when BB width is expanding (prefer compression before bounce)
  if ((bb.width[i] ?? Infinity) > (1.15 * (bb.width[i - 1] ?? Infinity))) return [];

    // Bullish reversal heuristic
  const body = (closeI - openI) as number;
  const range = Math.max(1e-9, highI - lowI);
  const isBullishReversal = closeI > openI && body / range > 0.3;

    // Entry conditions
  const touchedSupport = lowI <= sup! * 1.01; // 1% tolerance
  const closedAboveSupport = closeI > sup!;
  const momentumOk = (rsi14[i] as number) < 50 || lowI <= bb.lower[i]!;

    if (!(touchedSupport && closedAboveSupport && isBullishReversal && momentumOk)) return [];

    // Trade levels
  const entry = closeI;
  const atrNow = atr14[i] as number;
  if (!(Number.isFinite(atrNow) && atrNow > 0)) return [];
  const stop = Math.max(0, lowI - 1.8 * atrNow);
  const firstTarget = res!;

    // Reasons
    const reasons = [
      "Touched major support",
      "Closed above support",
      "Bullish reversal candle",
      (rsi14[i] as number) < 35 ? "RSI oversold" : undefined,
      lowI <= bb.lower[i]! ? "BB lower touch" : undefined,
    ].filter(Boolean) as string[];

    return [
      {
        id: "swingRangeSupportBounce",
        kind: "long",
        name: "Swing Range - Support Bounce",
        side: "LONG",
        entry,
        stop,
        firstTarget,
        timestamp: candles[i].ts,
        tags: ["rangeTrade", "supportBounce", "reversal", "swing"],
        reasons,
        // Attach exitProfile for propagation into StrategySignal
        exitProfile: {
          mode: 'trailing',
          trailType: 'rangeCheckpoint',
          checkpointSteps: [0.10, 0.25, 0.50, 0.75, 1.00],
          checkpointStopOffsets: [0.00, 0.10, 0.25, 0.50, 0.75],
          trailingRules: [
            { type: 'rangeCheckpoint' }
          ]
        }
      },
    ];
  },
};
