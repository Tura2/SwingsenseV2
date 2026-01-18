import { getCandlesByInterval } from "../market.js";
import { evaluateStrategies } from "../strategies.js";
import { buildIndicatorBundle } from "../indicatorService.js";
import { ALL_STRATEGY_IDS } from '../strategies/index.js';
import { detectSupportResistance } from "../strategies/supportResistanceUtils.js";
import { loadEngineConfig } from "../config/engineConfig.js";
import type { Candle, StrategySignal } from "../../../shared/types.js";

type Direction = 'LONG'|'SHORT';
type ExitReason = 'target'|'stop'|'gap_target'|'gap_stop'|'time_stop';

export type BacktestRunSummary = {
	perStrategy: Record<string, {
		trades: number;
		wins: number;
		losses: number;
		successPct: number;
		avgR: number;
		medianR: number;
		expectancy: number; // avgR
		avgHoldDays: number;
	}>
};

type Candidate = StrategySignal & { rr: number; strategyId: string; signalTs: number };

type TradeRow = {
	seq: number;
	strategy_id: string;
	signal_date: number;
	entry_date: number;
	entry_price: number;
	stop_at_entry: number;
	target_at_entry: number;
	exit_date: number;
	exit_price: number;
	exit_reason: ExitReason;
	result: 'win'|'loss';
	r_multiple: number;
	days_held: number;
	confidence?: number | null;
	reasons?: string | null;
	factors?: string | null;
	mae_r?: number | null;
	mfe_r?: number | null;
	trail_used?: number | null;
	exit_trail_level?: number | null;
	time_stop_days?: number | null;
	entry_index?: number | null;
	exit_index?: number | null;
	pnl_pct?: number | null;
};

type CachedRun = { runId: number; summary: BacktestRunSummary; trades: TradeRow[]; meta: any };
const LATEST_BY_TICKER = new Map<string, CachedRun>();
let NEXT_RUN_ID = 1;

function computeRR(sig: StrategySignal): number | null {
	const entry = sig.entryPrice; const stop = sig.stopPrice; const tgt = sig.targets?.[0];
	if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(tgt)) return null;
	if (entry <= 0) return null;
	const isLong = sig.side === 'LONG';
	const risk = isLong ? (entry - stop) : (stop - entry);
	const reward = isLong ? (tgt - entry) : (entry - tgt);
	if (risk <= 0 || reward <= 0) return null;
	return reward / risk;
}

function rankCandidates(cands: Candidate[], strategyPriority: string[]): Candidate[] {
	const priIndex = new Map(strategyPriority.map((id, i) => [id, i] as const));
	return cands.slice().sort((a,b) => {
		// 1) R:R desc
		if (b.rr !== a.rr) return b.rr - a.rr;
		// 2) confidence desc
		const ac = a.confidence ?? a.qualityScore ?? 0;
		const bc = b.confidence ?? b.qualityScore ?? 0;
		if (bc !== ac) return bc - ac;
		// 3) earliest signal time
		if (a.signalTs !== b.signalTs) return a.signalTs - b.signalTs;
		// 4) static priority order
		const ai = priIndex.get(a.strategyId) ?? 9999;
		const bi = priIndex.get(b.strategyId) ?? 9999;
		return ai - bi;
	});
}

function median(arr: number[]): number { if (!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; }

export async function runTickerBacktest(params: { ticker: string; minRRGlobal?: number; minRROverrides?: Record<string, number>; side?: 'BOTH'|'LONG'|'SHORT' }): Promise<{ runId: number }> {
	const { ticker } = params;
	const DIAG = ticker === 'GNRS';
	const minRRGlobal = Number.isFinite(params.minRRGlobal as number) ? Math.max(0, Math.min(5, params.minRRGlobal as number)) : 0;
	const minRROverrides: Record<string, number> = Object.fromEntries(Object.entries(params.minRROverrides || {}).filter(([_, v]) => Number.isFinite(v)).map(([k, v]) => [k, Math.max(0, Math.min(5, v as number))]));
	const sideFilter = params.side === 'LONG' || params.side === 'SHORT' ? params.side : 'BOTH';
	console.log('[Backtest][MinRR] run params', { ticker, minRRGlobal, minRROverrides, side: sideFilter });
	// Load daily candles
	const { candles } = await getCandlesByInterval(ticker, '1d');
	if (!candles?.length) throw new Error(`No candles for ${ticker}`);
		// Trim to last ~1260 trading days (~5 years)
		const MAX = 1260;
	const arr = candles.slice(-MAX);
	const lookbackStart = arr[0]?.ts ?? 0; const lookbackEnd = arr.at(-1)?.ts ?? 0;

	// Load engine config for optional verbose logging and future param usage
	let cfg: any = {};
	try { cfg = loadEngineConfig(); } catch {}
	// Diagnostics: track first trade of DIAG ticker until exit
	let diagFirstTradeActive = false;
	// Precompute: we reuse evaluateStrategies which builds indicators internally
	// Simulation state
	let state: 'FLAT'|'IN_TRADE' = 'FLAT';
		let openTrade: null | {
		strategyId: string;
		signalTs: number;
		entryDate: number; entryPrice: number; stopAtEntry: number; targetAtEntry: number; side: Direction; confidence?: number; reasons?: string[]; factors?: any;
			exitProfile?: any; // stored exit profile from entry to avoid re-evaluating strategy mid-trade
			initialRiskPerShare: number; // fixed 1R at entry based on actual entry price and initial stop
			entryIndex?: number;
			timeStopDays?: number; // reserved for v1.1
			trailUsed?: boolean;
			// Range checkpoint trailing context
			rcEnabled?: boolean;
			rcSup?: number;
			rcRes?: number;
			rcCheckpoints?: number[]; // ascending price levels
			rcStopLevels?: number[]; // corresponding stop levels
			rcStage?: number; // -1 none, 0..3 stages achieved
		} = null;

				 type TradeRec = {
					 strategyId: string; signalDate: number; entryDate: number; entryPrice: number; stopAtEntry: number; targetAtEntry: number; exitDate: number; exitPrice: number; exitReason: ExitReason; result: 'win'|'loss'; rMultiple: number; daysHeld: number; confidence?: number; reasons?: string; factors?: string; maeR?: number; mfeR?: number; trailUsed?: number; exitTrailLevel?: number | null; timeStopDays?: number | null; entryIndex?: number; exitIndex?: number; pnlPct?: number;
				 };
	const trades: TradeRec[] = [];

	// Strategy static priority for determinism
		const strategyPriority: string[] = ALL_STRATEGY_IDS;

	// Iterate day by day (by index)
		// Precompute indicators once
		const bundle = buildIndicatorBundle(arr as Candle[], { emaPeriods: [20,50,100,200], bb: { period: 20, mult: 2 }, rsiPeriod: 14, macd: { fast: 12, slow: 26, signal: 9 }, atrPeriod: 14, donchianPeriod: 20, bbWidthRankLookback: 120 });
		// Transparency counters
		let candidatesTotal = 0;
		let candidatesDiscardedByMinRR = 0;
		const discardedByMinRRByStrategy: Record<string, number> = {};

		for (let i = 0; i < arr.length; i++) {
		const day = arr[i];
		if (state === 'FLAT') {
			// Generate candidates using data up to this day (inclusive)
			const cSlice = arr.slice(0, i + 1);
			const sigs = evaluateStrategies(cSlice, { symbol: ticker, useAll: true, now: day.ts }) || [];
			const valid: Candidate[] = [];
			for (const s of sigs) {
				// Side filter
				if (sideFilter !== 'BOTH' && s.side !== sideFilter) continue;
				const rr = computeRR(s);
				if (rr == null) continue; // invalid
				const sid = s.strategyId || s.name; // fallback to name
				// basic sanity: stop vs entry directional
				const isLong = s.side === 'LONG';
				const ok = isLong ? (s.stopPrice < s.entryPrice && (s.targets?.[0] ?? Infinity) > s.entryPrice)
													: (s.stopPrice > s.entryPrice && (s.targets?.[0] ?? -Infinity) < s.entryPrice);
					if (!ok) continue;
					// Min R:R filtering
					candidatesTotal++;
					const eff = (sid && Number.isFinite(minRROverrides[sid])) ? (minRROverrides[sid] as number) : minRRGlobal;
				const riskDbg = isLong ? (s.entryPrice - s.stopPrice) : (s.stopPrice - s.entryPrice);
				const rewardDbg = isLong ? ((s.targets?.[0] ?? NaN) - s.entryPrice) : (s.entryPrice - (s.targets?.[0] ?? NaN));
				console.log('[Backtest][MinRR] candidate', {
					day: new Date(day.ts).toISOString().slice(0,10),
					symbol: ticker,
					strategyId: sid,
					side: s.side,
					entry: s.entryPrice,
					stop: s.stopPrice,
					target: s.targets?.[0],
					risk: riskDbg,
					reward: rewardDbg,
					rr,
					effectiveMinRR: eff
				});
					if (rr < eff) {
						candidatesDiscardedByMinRR++;
						discardedByMinRRByStrategy[sid] = (discardedByMinRRByStrategy[sid] || 0) + 1;
					console.log('[Backtest][MinRR] discard_by_minRR', { strategyId: sid, rr, effectiveMinRR: eff });
						continue;
					}
					valid.push({ ...(s as any), rr, strategyId: sid, signalTs: s.timestamp });
			}
			if (!valid.length) continue;
			const ranked = rankCandidates(valid, strategyPriority);
			const picked = ranked[0];
			console.log('[Backtest][MinRR] picked', { day: new Date(day.ts).toISOString().slice(0,10), symbol: ticker, strategyId: picked.strategyId, rr: picked.rr });
			// Entry at next day's open (if exists)
			if (i + 1 >= arr.length) break; // cannot enter on last day
			const nextOpen = arr[i + 1].open;
			const entryDate = arr[i + 1].ts;
			const entryIndex = i + 1;
			const isLong = picked.side === 'LONG';
			const stop = picked.stopPrice;
			const target = picked.targets[0];
			// Gap logic at entry: if open beyond stop/target
			// For longs: if nextOpen >= target => gap_target; if nextOpen <= stop => gap_stop
			if (isLong && nextOpen >= target) {
				const risk = picked.entryPrice - stop;
				const r = (nextOpen - picked.entryPrice) / (risk || 1e-9);
												 const pnlPct = (picked.side === 'LONG') ? ((nextOpen / picked.entryPrice - 1) * 100) : ((picked.entryPrice / nextOpen - 1) * 100);
												 trades.push({ strategyId: picked.strategyId, signalDate: picked.timestamp, entryDate, entryPrice: nextOpen, stopAtEntry: stop, targetAtEntry: target, exitDate: entryDate, exitPrice: nextOpen, exitReason: 'gap_target', result: 'win', rMultiple: r, daysHeld: 0, confidence: picked.confidence, reasons: picked.reasons?.join('\n'), factors: picked.factors ? JSON.stringify(picked.factors) : undefined, maeR: 0, mfeR: r, trailUsed: 0, exitTrailLevel: null, timeStopDays: null, entryIndex, exitIndex: entryIndex, pnlPct });
				state = 'FLAT';
				continue;
			}
			if (isLong && nextOpen <= stop) {
				const risk = picked.entryPrice - stop;
				const r = (nextOpen - picked.entryPrice) / (risk || 1e-9);
												 const pnlPct = (picked.side === 'LONG') ? ((nextOpen / picked.entryPrice - 1) * 100) : ((picked.entryPrice / nextOpen - 1) * 100);
												 trades.push({ strategyId: picked.strategyId, signalDate: picked.timestamp, entryDate, entryPrice: nextOpen, stopAtEntry: stop, targetAtEntry: target, exitDate: entryDate, exitPrice: nextOpen, exitReason: 'gap_stop', result: 'loss', rMultiple: r, daysHeld: 0, confidence: picked.confidence, reasons: picked.reasons?.join('\n'), factors: picked.factors ? JSON.stringify(picked.factors) : undefined, maeR: r, mfeR: 0, trailUsed: 0, exitTrailLevel: null, timeStopDays: null, entryIndex, exitIndex: entryIndex, pnlPct });
				state = 'FLAT';
				continue;
			}
			if (!isLong && nextOpen <= target) {
				const risk = stop - picked.entryPrice;
				const r = (picked.entryPrice - nextOpen) / (risk || 1e-9);
												 const pnlPct = (picked.side === 'LONG') ? ((nextOpen / picked.entryPrice - 1) * 100) : ((picked.entryPrice / nextOpen - 1) * 100);
												 trades.push({ strategyId: picked.strategyId, signalDate: picked.timestamp, entryDate, entryPrice: nextOpen, stopAtEntry: stop, targetAtEntry: target, exitDate: entryDate, exitPrice: nextOpen, exitReason: 'gap_target', result: 'win', rMultiple: r, daysHeld: 0, confidence: picked.confidence, reasons: picked.reasons?.join('\n'), factors: picked.factors ? JSON.stringify(picked.factors) : undefined, maeR: 0, mfeR: r, trailUsed: 0, exitTrailLevel: null, timeStopDays: null, entryIndex, exitIndex: entryIndex, pnlPct });
				state = 'FLAT';
				continue;
			}
			if (!isLong && nextOpen >= stop) {
				const risk = stop - picked.entryPrice;
				const r = (picked.entryPrice - nextOpen) / (risk || 1e-9);
												 const pnlPct = (picked.side === 'LONG') ? ((nextOpen / picked.entryPrice - 1) * 100) : ((picked.entryPrice / nextOpen - 1) * 100);
												 trades.push({ strategyId: picked.strategyId, signalDate: picked.timestamp, entryDate, entryPrice: nextOpen, stopAtEntry: stop, targetAtEntry: target, exitDate: entryDate, exitPrice: nextOpen, exitReason: 'gap_stop', result: 'loss', rMultiple: r, daysHeld: 0, confidence: picked.confidence, reasons: picked.reasons?.join('\n'), factors: picked.factors ? JSON.stringify(picked.factors) : undefined, maeR: r, mfeR: 0, trailUsed: 0, exitTrailLevel: null, timeStopDays: null, entryIndex, exitIndex: entryIndex, pnlPct });
				state = 'FLAT';
				continue;
			}
						// Otherwise open position
														// Capture timeStopDays and flags from exitProfile if present
														const ep: any = (picked as any).exitProfile || {};
														const timeStopDays = ep?.timeStopDays as number | undefined;
														const rcWants = ep?.trailType === 'rangeCheckpoint' || (Array.isArray(ep?.trailingRules) && ep.trailingRules.some((r: any) => r?.type === 'rangeCheckpoint'));
														// Precompute range checkpoints at entry if requested
														let rcEnabled = false, rcSup: number | undefined, rcRes: number | undefined, rcCheckpoints: number[] | undefined, rcStopLevels: number[] | undefined;
														if (rcWants) {
															const det = detectSupportResistance(arr.slice(0, i + 1) as Candle[], 60);
															if (Number.isFinite(det.majorSupport) && Number.isFinite(det.majorResistance) && (det.majorResistance as number) > (det.majorSupport as number)) {
																rcSup = det.majorSupport as number; rcRes = det.majorResistance as number;
																const range = rcRes - rcSup;
																const steps = Array.isArray(ep?.checkpointSteps) && ep.checkpointSteps.length ? ep.checkpointSteps : [0.10, 0.25, 0.50, 0.75, 1.00];
																const stopOffsets = Array.isArray(ep?.checkpointStopOffsets) && ep.checkpointStopOffsets.length ? ep.checkpointStopOffsets : [0.00, 0.10, 0.25, 0.50, 0.75];
																rcCheckpoints = steps.map((p: number) => rcSup! + range * p);
																const baseStops = stopOffsets.map((p: number) => rcSup! + range * p);
																// First stop level is breakeven at first checkpoint by spec
																if (baseStops.length > 0) baseStops[0] = nextOpen;
																rcStopLevels = baseStops;
																rcEnabled = true;
															}
														}
														// Calculate and store fixed 1R risk at entry
														const initialRiskPerShare = isLong ? (nextOpen - stop) : (stop - nextOpen);
														openTrade = { strategyId: picked.strategyId, signalTs: picked.timestamp, entryDate, entryPrice: nextOpen, stopAtEntry: stop, targetAtEntry: target, side: picked.side, confidence: picked.confidence, reasons: picked.reasons, factors: picked.factors, exitProfile: ep, entryIndex, timeStopDays, initialRiskPerShare, trailUsed: false, rcEnabled, rcSup, rcRes, rcCheckpoints, rcStopLevels, rcStage: -1 };
														if (DIAG && trades.length === 0) {
															diagFirstTradeActive = true;
															try { console.log(`[TrailDiag][${ticker}] entry: ${new Date(entryDate).toISOString().slice(0,10)} entry=${nextOpen.toFixed(2)} stop=${stop.toFixed(2)} target=${target.toFixed(2)} 1R=${initialRiskPerShare.toFixed(4)}`); } catch {}
														}
			state = 'IN_TRADE';
		} else if (state === 'IN_TRADE' && openTrade) {
			// Evaluate exit on current day's range: hit target or stop
			const isLong = openTrade.side === 'LONG';
			const bar = arr[i];
					let exit: { price: number; reason: ExitReason } | null = null;
						// Track MAE/MFE in R units (risk fixed at entry)
						const risk = openTrade.initialRiskPerShare;
					const dayMin = bar.low;
					const dayMax = bar.high;
					let maeRDelta = 0, mfeRDelta = 0;
					if (isLong) {
						// adverse: move toward stop; favorable: move toward target
						maeRDelta = Math.min(0, (dayMin - openTrade.entryPrice) / (risk || 1e-9));
						mfeRDelta = Math.max(0, (dayMax - openTrade.entryPrice) / (risk || 1e-9));
					} else {
						maeRDelta = Math.min(0, (openTrade.entryPrice - dayMax) / (risk || 1e-9));
						mfeRDelta = Math.max(0, (openTrade.entryPrice - dayMin) / (risk || 1e-9));
					}
					// temp accumulate as properties on openTrade for simplicity
					(openTrade as any)._maeR = Math.min((openTrade as any)._maeR ?? 0, maeRDelta);
					(openTrade as any)._mfeR = Math.max((openTrade as any)._mfeR ?? 0, mfeRDelta);
					// Apply trailing rules (if any) before checking exits
					let dynamicStop = openTrade.stopAtEntry;
						const chosenExitProfile = (openTrade as any).exitProfile;
						if (DIAG && diagFirstTradeActive && !chosenExitProfile) {
							try { console.log(`[TrailDiag][${ticker}] no exitProfile found during IN_TRADE`); } catch {}
						}
					const trailing = chosenExitProfile?.trailingRules as any[] | undefined;
					const mode = chosenExitProfile?.mode as 'fixed'|'trailing'|'mixed' | undefined;
					const tickBuf = 0; // daily; can add a small buffer later
							if (mode && (mode === 'trailing' || mode === 'mixed') && Array.isArray(trailing)) {
						// moveStopToBEAtR first if present
								const risk0 = openTrade.initialRiskPerShare;
								const rNowHigh = isLong ? (bar.high - openTrade.entryPrice) / (risk0 || 1e-9) : (openTrade.entryPrice - bar.low) / (risk0 || 1e-9);
								if (DIAG && diagFirstTradeActive) {
									try { console.log(`[TrailDiag][${ticker}] day=${new Date(bar.ts).toISOString().slice(0,10)} high=${bar.high.toFixed(2)} low=${bar.low.toFixed(2)} close=${bar.close.toFixed(2)} rNowHigh=${(rNowHigh||0).toFixed(3)} mode=${mode} rules=${trailing.length}`); } catch {}
								}
							for (const rule of trailing) {
							if (rule?.type === 'moveStopToBEAtR' && Number.isFinite(rule.k) && rNowHigh >= rule.k) {
								dynamicStop = openTrade.entryPrice; openTrade.trailUsed = true;
										if (DIAG && diagFirstTradeActive) { try { console.log(`[TrailDiag][${ticker}] BE trigger: k=${rule.k} set dynamicStop=${openTrade.entryPrice.toFixed(2)}`); } catch {} }
							}
						}
						// EMA20 / Mid BB trails use previous day values for trailing level
						const prevIdx = Math.max(0, i - 1);
							for (const rule of trailing) {
							if (rule?.type === 'trailUnderEMA20') {
								const ema20 = bundle.ema[20]?.[prevIdx];
								if (Number.isFinite(ema20)) dynamicStop = isLong ? Math.max(dynamicStop, ema20 - tickBuf) : dynamicStop;
							} else if (rule?.type === 'trailOverEMA20') {
								const ema20 = bundle.ema[20]?.[prevIdx];
								if (Number.isFinite(ema20)) dynamicStop = !isLong ? Math.min(dynamicStop, ema20 + tickBuf) : dynamicStop;
							} else if (rule?.type === 'trailMidBollinger') {
								const mid = bundle.bb.middle?.[prevIdx];
								if (Number.isFinite(mid)) dynamicStop = isLong ? Math.max(dynamicStop, mid - tickBuf) : Math.min(dynamicStop, mid + tickBuf);
								} else if (rule?.type === 'rangeCheckpoint' && openTrade.rcEnabled && isLong) {
								const chks = openTrade.rcCheckpoints || [];
								const stops = openTrade.rcStopLevels || [];
								// Advance stage if today's high reaches next checkpoints
								let stage = (openTrade.rcStage ?? -1);
									for (let k = (stage + 1); k < chks.length; k++) {
									const hitByHigh = bar.high >= chks[k];
									const hitByClose = !hitByHigh && bar.close >= chks[k];
										// Gate stage 0 by BE threshold if configured: do not move to breakeven until rNowHigh >= BE k
										const beRule = trailing.find(r => r?.type === 'moveStopToBEAtR');
										const beK = Number.isFinite(beRule?.k) ? (beRule as any).k as number : 0.5; // default 0.5R gate
										if ((hitByHigh || hitByClose) && !(k === 0 && (rNowHigh < beK))) {
										stage = k;
										const priorStopLocal = dynamicStop;
										// Raise the working stop and also ratchet the persisted stop immediately (monotonic, capped by target)
										dynamicStop = Math.max(dynamicStop, stops[k] ?? dynamicStop);
										const intended = Math.min(Math.max(openTrade.stopAtEntry, stops[k] ?? openTrade.stopAtEntry), openTrade.targetAtEntry);
										if (intended > openTrade.stopAtEntry) openTrade.stopAtEntry = intended;
										openTrade.trailUsed = true;
										if (hitByClose && cfg?.logging?.verboseStrategyEval) {
											try { console.log(`[Trail][${ticker}] checkpoint hit by close @ ${bar.close.toFixed(2)} (stage ${k})`); } catch {}
										}
									} else { break; }
								}
								if (stage !== (openTrade.rcStage ?? -1)) openTrade.rcStage = stage;
							}
						}
					}
					// Persist ratcheted stop across days (generic for any trailing mode)
					{
						const prior = openTrade.stopAtEntry;
						let candidate = Number.isFinite(dynamicStop as any) ? (dynamicStop as number) : prior;
						if (isLong) {
							// Longs: stop should only move up and never exceed target
							candidate = Math.max(prior, Math.min(candidate, openTrade.targetAtEntry));
							if (candidate > prior) {
								openTrade.stopAtEntry = candidate;
								openTrade.trailUsed = true;
								if (cfg?.logging?.verboseStrategyEval) {
									try {
										console.log(`[Trail][${ticker}] stage=${openTrade.rcStage ?? '–'} stop advanced to ${candidate.toFixed(2)} (prev ${prior.toFixed(2)})`);
									} catch {}
								}
							}
						} else {
							// Shorts: stop should only move down and never go below target
							candidate = Math.min(prior, Math.max(candidate, openTrade.targetAtEntry));
							if (candidate < prior) {
								openTrade.stopAtEntry = candidate;
								openTrade.trailUsed = true;
								if (cfg?.logging?.verboseStrategyEval) {
									try {
										console.log(`[Trail][${ticker}] stage=${openTrade.rcStage ?? '–'} stop advanced to ${candidate.toFixed(2)} (prev ${prior.toFixed(2)})`);
									} catch {}
								}
							}
						}
					}

					if (isLong) {
						// Pre-exit diagnostics: log daily bar vs stop/target before deciding exit
						if (DIAG && diagFirstTradeActive) {
							const willTarget = bar.high >= openTrade.targetAtEntry;
							const workingStop = (dynamicStop ?? openTrade.stopAtEntry);
							const willStop = bar.low <= workingStop;
							try {
								console.log(`[TrailDiag][${ticker}] preExit day=${new Date(bar.ts).toISOString().slice(0,10)} high=${bar.high.toFixed(2)} low=${bar.low.toFixed(2)} close=${bar.close.toFixed(2)} stopAtEntry=${openTrade.stopAtEntry.toFixed(2)} dynStop=${workingStop.toFixed(2)} target=${openTrade.targetAtEntry.toFixed(2)} willStop=${willStop} willTarget=${willTarget}`);
							} catch {}
						}
				if (bar.high >= openTrade.targetAtEntry) exit = { price: openTrade.targetAtEntry, reason: 'target' };
						else if (bar.low <= (dynamicStop ?? openTrade.stopAtEntry)) { exit = { price: (dynamicStop ?? openTrade.stopAtEntry), reason: 'stop' }; openTrade.trailUsed = openTrade.trailUsed || (dynamicStop !== openTrade.stopAtEntry); }
			} else {
						// Pre-exit diagnostics for SHORT path
						if (DIAG && diagFirstTradeActive) {
							const willTarget = bar.low <= openTrade.targetAtEntry;
							const workingStop = (dynamicStop ?? openTrade.stopAtEntry);
							const willStop = bar.high >= workingStop;
							try {
								console.log(`[TrailDiag][${ticker}] preExit day=${new Date(bar.ts).toISOString().slice(0,10)} high=${bar.high.toFixed(2)} low=${bar.low.toFixed(2)} close=${bar.close.toFixed(2)} stopAtEntry=${openTrade.stopAtEntry.toFixed(2)} dynStop=${workingStop.toFixed(2)} target=${openTrade.targetAtEntry.toFixed(2)} willStop=${willStop} willTarget=${willTarget}`);
							} catch {}
						}
						if (bar.low <= openTrade.targetAtEntry) exit = { price: openTrade.targetAtEntry, reason: 'target' };
						else if (bar.high >= (dynamicStop ?? openTrade.stopAtEntry)) { exit = { price: (dynamicStop ?? openTrade.stopAtEntry), reason: 'stop' }; openTrade.trailUsed = openTrade.trailUsed || (dynamicStop !== openTrade.stopAtEntry); }
			}
					// Time stop: if defined and exceeded, exit at close
					if (!exit && openTrade.timeStopDays != null && openTrade.timeStopDays >= 0) {
						const heldDays = Math.max(0, Math.round((arr[i].ts - openTrade.entryDate) / (24*60*60*1000)));
						if (heldDays >= openTrade.timeStopDays) exit = { price: bar.close, reason: 'time_stop' };
					}
						if (exit) {
				const r = isLong ? (exit.price - openTrade.entryPrice) / (risk || 1e-9) : (openTrade.entryPrice - exit.price) / (risk || 1e-9);
				const daysHeld = Math.max(0, Math.round((arr[i].ts - openTrade.entryDate) / (24*60*60*1000)));
									 if (DIAG && diagFirstTradeActive) {
									 	try { console.log(`[TrailDiag][${ticker}] EXIT day=${new Date(arr[i].ts).toISOString().slice(0,10)} reason=${exit.reason} price=${exit.price.toFixed(2)} stopAtEntry=${openTrade.stopAtEntry.toFixed(2)} r=${r.toFixed(3)}`); } catch {}
									 	diagFirstTradeActive = false;
									 }
													 const pnlPct = isLong ? ((exit.price / openTrade.entryPrice - 1) * 100) : ((openTrade.entryPrice / exit.price - 1) * 100);
													 trades.push({ strategyId: openTrade.strategyId, signalDate: openTrade.signalTs, entryDate: openTrade.entryDate, entryPrice: openTrade.entryPrice, stopAtEntry: openTrade.stopAtEntry, targetAtEntry: openTrade.targetAtEntry, exitDate: arr[i].ts, exitPrice: exit.price, exitReason: exit.reason, result: exit.reason === 'target' ? 'win' : (exit.reason === 'time_stop' ? 'loss' : 'loss'), rMultiple: r, daysHeld, confidence: openTrade.confidence, reasons: openTrade.reasons?.join('\n'), factors: openTrade.factors ? JSON.stringify(openTrade.factors) : undefined, maeR: (openTrade as any)._maeR ?? 0, mfeR: (openTrade as any)._mfeR ?? 0, trailUsed: openTrade.trailUsed ? 1 : 0, exitTrailLevel: (openTrade.trailUsed ? (dynamicStop ?? openTrade.stopAtEntry) : null), timeStopDays: openTrade.timeStopDays ?? null, entryIndex: openTrade.entryIndex, exitIndex: i, pnlPct });
				openTrade = null; state = 'FLAT';
			}
		}
	}

	// Compute per-strategy stats
	const by: Record<string, number[]> = {};
	const hold: Record<string, number[]> = {};
	const wins: Record<string, number> = {};
	const counts: Record<string, number> = {};
	for (const t of trades) {
		by[t.strategyId] = by[t.strategyId] || [];
		hold[t.strategyId] = hold[t.strategyId] || [];
		by[t.strategyId].push(t.rMultiple);
		hold[t.strategyId].push(t.daysHeld);
		counts[t.strategyId] = (counts[t.strategyId] || 0) + 1;
		if (t.result === 'win') wins[t.strategyId] = (wins[t.strategyId] || 0) + 1;
	}
	const perStrategy: BacktestRunSummary['perStrategy'] = {} as any;
	for (const sid of Object.keys(counts)) {
		const arrR = by[sid] || [];
		const n = counts[sid] || 0;
		const w = wins[sid] || 0;
		const avgR = arrR.length ? arrR.reduce((a,b)=>a+b,0)/arrR.length : 0;
		const medR = median(arrR);
		const avgHold = (hold[sid]?.length ? hold[sid].reduce((a,b)=>a+b,0)/hold[sid].length : 0) as number;
		perStrategy[sid] = { trades: n, wins: w, losses: n - w, successPct: n? Math.round((w/n)*1000)/10 : 0, avgR: round2(avgR), medianR: round2(medR), expectancy: round2(avgR), avgHoldDays: round2(avgHold) };
	}
	const summary: BacktestRunSummary = { perStrategy };

	// Cache run in-memory (no DB persistence)
	const now = Date.now();
	const overridesCount = Object.keys(minRROverrides || {}).length;
	const meta = { strategiesUsed: 'ALL', params: 'engineConfig.default', minRRGlobal, minRROverrides, side: sideFilter, candidatesTotal, candidatesDiscardedByMinRR, discardedByMinRRByStrategy, overridesCount };
	const runId = NEXT_RUN_ID++;
	const rows: TradeRow[] = trades.map((t, i) => ({
		seq: i + 1,
		strategy_id: t.strategyId,
		signal_date: t.signalDate,
		entry_date: t.entryDate,
		entry_price: t.entryPrice,
		stop_at_entry: t.stopAtEntry,
		target_at_entry: t.targetAtEntry,
		exit_date: t.exitDate,
		exit_price: t.exitPrice,
		exit_reason: t.exitReason,
		result: t.result,
		r_multiple: t.rMultiple,
		days_held: t.daysHeld,
		confidence: t.confidence ?? null,
		reasons: t.reasons ?? null,
		factors: t.factors ?? null,
		mae_r: t.maeR ?? null,
		mfe_r: t.mfeR ?? null,
		trail_used: t.trailUsed ?? 0,
		exit_trail_level: t.exitTrailLevel ?? null,
		time_stop_days: t.timeStopDays ?? null,
		entry_index: t.entryIndex ?? null,
		exit_index: t.exitIndex ?? null,
		pnl_pct: t.pnlPct ?? null,
	}));

	LATEST_BY_TICKER.set(ticker, { runId, summary, trades: rows, meta: { ...meta, lookbackStart, lookbackEnd, computedAt: now } });
	return { runId };
}

export function getLatestForTicker(ticker: string): { runId: number; summary: BacktestRunSummary; trades: any[]; meta: any } | null {
	return LATEST_BY_TICKER.get(ticker) || null;
}

function round2(n: number) { return Math.round(n * 100) / 100; }

export type { Candidate };

// (cleanup) removed unused helper
