// Clean replacement of strategy engine (legacy code fully removed)
import type { Candle, StrategySignal } from "../../shared/types.js";
import { buildIndicatorBundle } from "./indicatorService.js";
import { getEnabledStrategies, ALL_STRATEGY_IDS, type EngineRuntimeConfig, type GeneratedSignal } from "./strategies/index.js";
import { loadEngineConfig } from "./config/engineConfig.js";

// Legacy placeholders (no-op) to preserve any external references
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function generateRawSignalsDaily(): any[] { return []; }
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function applyRiskFiltersAndScore(): StrategySignal[] { return []; }

interface FactorResult { name: string; hit: boolean; weight: number; contribution: number }

function scoreFactors(g: GeneratedSignal, bundle: any, cfg: EngineRuntimeConfig) {
  const i = bundle.closes.length - 1;
  const W = (k: string) => cfg.scoring?.weights?.[k] ?? 0;
  const add = (arr: FactorResult[], name: string, hit: boolean) => arr.push({ name, hit, weight: W(name), contribution: hit ? W(name) : 0 });
  const factors: FactorResult[] = [];
  const close = bundle.closes[i];
  const vol = bundle.volumes[i];
  const volMA20 = bundle.volMA20[i] || 0;
  const rsi = bundle.rsi14[i];
  const macdHist = bundle.macd.hist[i];
  const bbRank = bundle.bb.widthRank120[i];
  const ema20 = bundle.ema[20][i];
  const ema50 = bundle.ema[50][i];
  const ema100 = bundle.ema[100][i];
  const hi20 = Math.max(...bundle.closes.slice(-20));
  const lo20 = Math.min(...bundle.closes.slice(-20));
  const high = bundle.highs[i];
  const low = bundle.lows[i];
  const prevClose = bundle.closes[i-1] ?? close;
  const range = Math.max(1e-9, high - low);
  const upperWick = high - Math.max(prevClose, close);
  add(factors, 'volumeSpike', vol >= 1.2 * volMA20);
  add(factors, 'rsiBullRange', rsi >= 40 && rsi <= 60);
  add(factors, 'macdAboveZero', g.side === 'LONG' ? macdHist >= 0 : macdHist <= 0);
  add(factors, 'macdHistUp', g.side === 'LONG' ? macdHist > (bundle.macd.hist[i-1] ?? macdHist) : macdHist < (bundle.macd.hist[i-1] ?? macdHist));
  add(factors, 'bbWidthLow', bbRank <= 40);
  add(factors, 'trendAlignment', g.side === 'LONG' ? (ema20 > ema50 && ema50 > ema100) : (ema20 < ema50 && ema50 < ema100));
  add(factors, 'newHigh', g.side === 'LONG' ? close >= hi20 : false);
  add(factors, 'newLow', g.side === 'SHORT' ? close <= lo20 : false);
  add(factors, 'upperWickFail', g.side === 'SHORT' ? (upperWick / range) >= 0.4 : false);
  const base = 50;
  // Merge any pre-attached raw strategy factors (unweighted hints) by name if present
  if (Array.isArray((g as any).strategyFactors)) {
    for (const raw of (g as any).strategyFactors) {
      if (!factors.find(f=>f.name===raw.name)) {
        add(factors, raw.name, !!raw.hit);
      }
    }
  }
  const qualityScore = Math.min(100, Math.max(0, Math.round(base + factors.reduce((a,f)=>a+f.contribution,0))));
  return { factors, qualityScore };
}

export function evaluateStrategies(candles: Candle[], opts?: { symbol?: string; useAll?: boolean; now?: number }): StrategySignal[] {
  if (!candles?.length) return [];
  let cfg: EngineRuntimeConfig;
  try { cfg = loadEngineConfig() as EngineRuntimeConfig; } catch { return []; }
  if (candles.length < (cfg.minHistoryBars || 120)) return [];
  const bundle = buildIndicatorBundle(candles, cfg.indicatorParams);
  // Optionally force all strategies (for diagnostic / backtest completeness)
  let enabled = getEnabledStrategies(cfg);
    if (opts?.useAll) {
      // Force enabling all strategy IDs by bypassing config filtering
      enabled = getEnabledStrategies({ ...cfg, enabledStrategies: ALL_STRATEGY_IDS });
    }
  // If config accidentally omits all, fallback to ALL
  if (!enabled.length) {
    // fallback: enable all modules present in registry disregarding config gating
    enabled = getEnabledStrategies({ ...cfg, enabledStrategies: ALL_STRATEGY_IDS });
  }
  const generated: GeneratedSignal[] = [];
  const nowTs = opts?.now ?? Date.now();
  for (const strat of enabled) {
    try { generated.push(...(strat.evaluate({ symbol: opts?.symbol || 'UNKNOWN', candles, bundle, config: cfg, now: nowTs }) || [])); }
    catch (e) { if (cfg.logging?.verboseStrategyEval) console.warn('[strategy-error]', strat.id, (e as any)?.message || e); }
  }
  const signals: StrategySignal[] = generated.map(g => {
    const risk = Math.max(1e-9, g.side === 'LONG' ? g.entry - g.stop : g.stop - g.entry);
    const reward = g.firstTarget ? (g.side === 'LONG' ? g.firstTarget - g.entry : g.entry - g.firstTarget) : 0;
    const rMult = reward / risk;
    const { factors, qualityScore } = scoreFactors(g, bundle, cfg);
    const sig: StrategySignal = {
      strategyId: g.id,
      name: g.name,
      side: g.side,
      entryPrice: g.entry,
      stopPrice: g.stop,
      targets: g.firstTarget ? [g.firstTarget] : [],
      rationale: g.notes || g.name,
      timestamp: g.timestamp,
      rMultipleFirst: Number.isFinite(rMult) ? rMult : undefined,
      rrTargets: Number.isFinite(rMult) ? [rMult] : [],
      reasons: g.reasons || g.tags,
      tags: g.tags,
      factors,
      qualityScore,
      confidence: qualityScore,
      // Pass through exit profile if strategy provided one
      exitProfile: (g as any).exitProfile
    };
    return sig;
  });
  // Apply per-strategy minScore gating (skip when useAll=true to act as "score filter OFF" for backtests)
  const gated = opts?.useAll ? signals : signals.filter(s => {
    const stratId = generated.find(g => g.name === s.name)?.id; // naive map by name
    if (!stratId) return true;
    const minScore = cfg.strategies?.[stratId]?.minScore;
    return minScore == null || (s.qualityScore ?? 0) >= minScore;
  });
  if (cfg.logging?.verboseStrategyEval) {
    for (const s of gated) {
      console.log('[engine:signal]', JSON.stringify({ name: s.name, qualityScore: s.qualityScore, reasons: s.reasons, factors: s.factors?.map(f=>({ n:f.name, hit:f.hit, w:f.weight })) }));
    }
  }
  if (cfg.dedupeMode === 'byStrategy') {
    const seen = new Set<string>();
    return gated.filter(s => { if (seen.has(s.name)) return false; seen.add(s.name); return true; });
  }
  return gated;
}
