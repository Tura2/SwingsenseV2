import type { Candle } from "../../../shared/types.js";
import type { PrecomputedIndicatorBundle } from "../indicatorService.js";

export interface EngineRuntimeConfig {
  enabledStrategies: string[];
  dedupeMode: 'none' | 'byStrategy';
  minHistoryBars: number;
  volumeThresholdUSD: number;
  indicatorParams: any;
  scoring: { weights: Record<string, number> };
  strategies: Record<string, { minScore?: number; enabled?: boolean }>;
  logging?: { verboseStrategyEval?: boolean };
}

export interface StrategyContext {
  symbol: string;
  candles: Candle[];
  bundle: PrecomputedIndicatorBundle;
  config: EngineRuntimeConfig;
  now: number;
}

export interface GeneratedSignal {
  id: string; // strategy id
  kind: 'long' | 'short';
  name: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  firstTarget?: number;
  timestamp: number;
  tags: string[];
  notes?: string;
  reasons?: string[]; // required condition hits
  strategyFactors?: { name: string; hit: boolean }[]; // raw factors prior to weighting
  qualityScore?: number; // optional pre-computed score (else engine computes)
  stopHint?: number;
  firstTargetHint?: number;
}

export interface StrategyModule { id: string; kind: 'long' | 'short'; evaluate(ctx: StrategyContext): GeneratedSignal[]; }

// Import individual strategies
import { strategy as emaPullback } from "./impl/emaPullback.js";
import { strategy as squeezeBreakout } from "./impl/squeezeBreakout.js";
import { strategy as rangeBreakoutVolume } from "./impl/rangeBreakoutVolume.js";
import { strategy as emaPopFailShort } from "./impl/emaPopFailShort.js";
import { strategy as squeezeBreakdown } from "./impl/squeezeBreakdown.js";
// Hooks (stubs)
import { strategy as fibConfluencePullback } from "./impl/fibConfluencePullback.js";
import { strategy as vcpContraction } from "./impl/vcpContraction.js";
// Newly added advanced strategies
import { strategy as ema200Reclaim } from "./impl/ema200Reclaim.js";
import { strategy as macdZeroLineUp } from "./impl/macdZeroLineUp.js";
import { strategy as emaBounceBullStack } from "./impl/emaBounceBullStack.js";
import { strategy as bbMeanRevertTrend } from "./impl/bbMeanRevertTrend.js";
import { strategy as rsiPositiveReversal } from "./impl/rsiPositiveReversal.js";
import { strategy as patternFlagPennant } from "./impl/patternFlagPennant.js";
import { strategy as patternCupHandle } from "./impl/patternCupHandle.js";
import { strategy as mtfAlignment } from "./impl/mtfAlignment.js";
import { strategy as rangeBreakdownVolume } from "./impl/rangeBreakdownVolume.js";
import { strategy as ema200RejectionShort } from "./impl/ema200RejectionShort.js";
import { strategy as swingRangeSupportBounce } from "./impl/swingRangeSupportBounce.js";

const ALL: StrategyModule[] = [
  emaPullback,
  squeezeBreakout,
  rangeBreakoutVolume, // existing short breakout long variant naming
  emaPopFailShort,
  squeezeBreakdown,
  fibConfluencePullback,
  vcpContraction,
  ema200Reclaim,
  macdZeroLineUp,
  emaBounceBullStack,
  bbMeanRevertTrend,
  rsiPositiveReversal,
  patternFlagPennant,
  patternCupHandle,
  mtfAlignment,
  rangeBreakdownVolume, // new short breakdown
  ema200RejectionShort,
  swingRangeSupportBounce
];

export function getEnabledStrategies(cfg: EngineRuntimeConfig): StrategyModule[] {
  const set = new Set(cfg.enabledStrategies);
  return ALL.filter(s => set.has(s.id) && (cfg.strategies?.[s.id]?.enabled !== false));
}

export const ALL_STRATEGY_IDS = ALL.map(s => s.id);
