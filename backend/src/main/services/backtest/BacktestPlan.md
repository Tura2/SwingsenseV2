Backtests Page v1 — Implemented Behavior

Last updated: 2025-10-19

This document captures what the current v1 implementation does for the single-ticker, 1Y daily backtest with one active position at a time. It also lists deferred items for the next iteration.

## Overview

- Scope: Single ticker, last ~1260 trading days (≈5Y) of daily OHLCV.
- Simulation: Day-by-day from oldest → newest.
- Entry timing: Next day’s open after a signal (no look-ahead).
- Exits: Target/stop as defined by the strategy plan; entry-day gaps handled.
- One position per ticker: Ignore new signals while in a position.
- Candidate ranking (same day): R:R desc → confidence desc → signal time asc → static strategy priority.
- Persistence: Saving results to DB; rerun replaces prior ticker run.
- UI: Run/Use Last buttons, Success Rate bar chart (click to filter), Trades table, chart placeholder.

## Data & Engine

- Data: Uses existing market service (Yahoo) to fetch daily candles; simulation uses last ~1260 bars.
- Engine: Strategy engine V2 is used with all strategies enabled for backtests.
	- Score filter OFF: `useAll=true` bypasses per-strategy minScore gating.
	- Signals include `strategyId` to attribute trades and stats.
	- Deterministic per-day evaluation: `evaluateStrategies` called with `now=day.ts`.

## Algorithm

1) Load ≈5Y daily candles; take the last ~1260 bars.
2) Iterate chronologically:
	 - FLAT:
		 - Evaluate strategies on candles up to today.
		 - Validate each candidate has numeric entry/stop/target and correct directional relation.
		 - Compute R:R from first target.
		 - Rank candidates: R:R desc → confidence desc → signal time asc → static `ALL_STRATEGY_IDS` order.
		 - Pick one, enter at next day’s open unless gap across stop/target triggers immediate win/loss.
	 - IN_TRADE:
		 - Each day, check bar range for exit:
			 - Long: high ≥ target → target exit; low ≤ stop → stop exit.
			 - Short: low ≤ target → target exit; high ≥ stop → stop exit.
		 - On exit: record outcome (target=win, stop=loss), R multiple, days held, flip to FLAT.

## Edge Cases

- Entry-day gaps (day after signal):
	- Long: nextOpen ≥ target → `gap_target` (win), nextOpen ≤ stop → `gap_stop` (loss).
	- Short: nextOpen ≤ target → `gap_target` (win), nextOpen ≥ stop → `gap_stop` (loss).
- Invalid plans: Discard (non-finite or invalid directional relationships).
- Determinism: Static tie-breaker with `ALL_STRATEGY_IDS` and day-scoped `now`.

## Exits (v1)

- Implemented: Target/stop exits and entry-day gap handling.
- Deferred: Strategy-specific trailing/management; MAE/MFE tracking.

## Persistence (DB)

SQLite tables (created in `src/main/db.ts`):

- `bt_runs`
	- Columns: `id INTEGER PK`, `ticker TEXT`, `lookback_start INTEGER`, `lookback_end INTEGER`,
		`engine_version TEXT`, `created_at INTEGER`, `updated_at INTEGER`, `status TEXT('completed'|'failed')`,
		`summary TEXT(JSON)`, `meta TEXT(JSON)`.
	- Behavior: On Run, prior runs for the ticker are deleted, then a new run is inserted.

- `bt_trades`
	- Columns: `id INTEGER PK`, `run_id INTEGER FK(bt_runs)`, `seq INTEGER`, `strategy_id TEXT`, `signal_date INTEGER`,
		`entry_date INTEGER`, `entry_price REAL`, `stop_at_entry REAL`, `target_at_entry REAL`,
		`exit_date INTEGER`, `exit_price REAL`, `exit_reason TEXT('target'|'stop'|'gap_target'|'gap_stop')`,
		`result TEXT('win'|'loss')`, `r_multiple REAL`, `days_held INTEGER`, `confidence REAL`, `reasons TEXT`, `factors TEXT(JSON)`.

## Outputs

- Per-strategy stats (for 1Y window): Success %, #Trades, Avg R, Median R, Expectancy (avg R), Avg holding days.
- Trades list (chronological): Open/Close dates, strategy_id, Entry/Stop/Target, Exit reason, Result, R, Days, Confidence, Reasons/Factors.
- Equity curve: Not implemented in v1 (optional).

## IPC & Renderer

- Main-process handlers (`src/main/ipc.ts`):
	- `backtests:runTicker` → `{ ticker }` → runs simulation, persists, returns `{ runId }`.
	- `backtests:getLatestForTicker` → `{ ticker }` → returns `{ runId, summary, trades } | null`.

- Preload (`electron/preload.ts`):
	- `window.api.backtests.runTicker(ticker)`
	- `window.api.backtests.getLatestForTicker(ticker)`

- UI (`frontend/pages/Backtest.tsx`):
	- Ticker input; Run/Use Last; last loaded timestamp; Success Rate bar chart (click to filter), Trades table; chart placeholder.

## Metrics

- Per strategy: Success %, #Trades, Avg R, Median R, Expectancy (avg R), Avg holding days.

## Min R:R to Start (v2)

- Purpose: Require a minimum initial Risk:Reward (R:R) for entering a trade.
- Global threshold (minRRGlobal) with optional per-strategy overrides (minRROverrides) that take precedence.
- R:R definitions at entry decision time:
	- Long: (target - entry) / (entry - stop)
	- Short: (entry - target) / (stop - entry)
- Validation and filtering:
	- Discard candidates with invalid numbers or non-positive risk (e.g., stop >= entry for longs, stop <= entry for shorts).
	- Apply effectiveMinRR = overrides[strategyId] ?? minRRGlobal; discard if rr < effectiveMinRR.
	- Perform filtering before same-day ranking; ranking rule remains: R:R desc → confidence desc → signal time asc → strategyPriority.
- Simulation semantics unchanged for exits (trailing/time-stop unaffected by threshold).

### IPC/Engine

- Run single ticker: `backtests:runTicker` now accepts `{ ticker, minRRGlobal?: number, minRROverrides?: Record<string, number> }`.
- Getter: `backtests:getLatestForTicker` returns `{ runId, summary, trades, meta }` where `meta` includes:
	- `minRRGlobal`, `minRROverrides`, `candidatesTotal`, `candidatesDiscardedByMinRR`, `discardedByMinRRByStrategy`, `overridesCount`.

### Renderer UI

- Control in header: “Min R:R to start” (step 0.1, min 0.0, max 5.0; default 0.0) + tooltip.
- Advanced (collapsible): Per-strategy overrides table; blank uses global.
- Result badge shows applied minRR and overrides count. If controls differ from saved meta, show a note to re-run.

## Known Gaps / Next Iteration

- Apply per-strategy trailing/management if defined on signals.
- Capture MAE/MFE per trade.
- Add equity curve for single-position process.
- Link trades to a plotted daily chart with hover sync (table ↔ chart).
- Optionally mark previous runs as superseded instead of delete.
- Engine version hashing based on config + strategies instead of a static string.

## Tests (Planned)

- Unit: ranking tie-breakers; exit evaluation (target/stop/gap) on synthetic series.
- Integration: 1Y AAPL sample ensuring non-zero trades and persistence update behavior.

## Acceptance (v1)

- User selects a ticker and clicks Run → 1Y daily simulation runs with single active trade, deterministic candidate selection, and saved results.
- Page shows Success Rate chart, Trades table, and loads last saved result when requested.
- Re-running same ticker updates the saved result; no exports; results are persisted in DB.



---

Backtests v1.1 — Trailing, Chart Linking, MAE/MFE, Tests (In Progress)

Goal
Finish the Backtests page by adding strategy-specific trailing exits, chart↔table linking, MAE/MFE, and tests, keeping single-position logic and ranking rules.

Status
- Implemented in code now:
	- DB migration to add mae_r, mfe_r, trail_used, exit_trail_level, time_stop_days, entry_index, exit_index.
	- MAE/MFE tracking during trades; values persisted.
	- Trailing primitives enforced (BE at R, EMA20, BB mid) with trailUsed + exitTrailLevel captured.
	- Time-stop respected when configured (exit at close, reason time_stop).
	- IPC includes new trade fields for renderer overlays and details.
	- UI: Daily chart overlays for trades, markers, table↔chart hover linking, details drawer.
- Next to implement:
	- Unit + integration tests.

Strategy plan contract (v1.1)
- Each signal may include `exitProfile`:
	- `mode`: 'fixed' | 'trailing' | 'mixed'
	- `trailingRules`: ordered rules among:
		- `{ type: 'moveStopToBEAtR', k: number }`
		- `{ type: 'trailUnderEMA20' }` / `{ type: 'trailOverEMA20' }`
		- `{ type: 'trailMidBollinger' }`
	- `timeStopDays?`: optional time stop
	- `notes?`

Simulation upgrades
- Before daily exit checks, compute a dynamic stop from trailing rules using previous-day indicator values and current unrealized R.
- Exit priority (longs): target → stop (dynamic or fixed) → time_stop; shorts mirrored.
- Gap handling at entry remains unchanged.

Persistence delta
- `bt_trades` new columns described above; backfilled as NULL for earlier runs.

UI upgrades
- Overlays on the daily chart for each trade (entryIndex→exitIndex), color-coded by outcome, with entry/exit markers.
- Hover table row ↔ highlight overlay; crosshair over overlay ↔ focus row.
- Details drawer showing R, MAE/MFE, confidence, exit reason/profile, time stop, and prices.

Tests
- Unit: ranking, fixed exits (target/stop/gap), trailing (BE move/EMA/BB), MAE/MFE math.
- Integration: sample 1Y, non-overlapping trades, MAE/MFE present, trailing recorded, rerun replacement.

Acceptance
- Trailing enforced when defined; MAE/MFE visible; chart/table linked; success rate interactive; rerun replaces prior; Use Last loads cached.




Prompt for Agent — “Backtests v1.1 Finish: Trailing Exits, Chart Linking, MAE/MFE, Tests (Single Ticker, 1Y Daily)”

Goal
Complete the Backtests page by adding strategy-specific trailing exits, chart↔table linking, MAE/MFE, and tests. Keep existing behavior: single position per ticker, entry at next day’s open, success = target hit, fail = stop hit, ranking by best R:R → best confidence → earliest signal time. Persist results; rerun only when user clicks Run.

A) Strategy plan contract (enforce this shape now, no code changes to UI)

Every candidate/plan produced by the strategy engine must provide at least:

strategyId (string)

signalTime (date/time on the signal bar)

entry, stop, target (numbers at entry decision time)

confidence (number, your qualityScore/0–100)

exitProfile (object) with:

mode: "fixed" or "trailing" (or "mixed" if both)

trailingRules?: ordered list of rules (e.g., trailUnderEMA20, trailMidBollinger, moveStopToBEAtR=1.5, each with parameters)

timeStopDays? (number) if defined by the strategy

notes? (string)

If a strategy doesn’t define trailing, set mode: "fixed" and omit trailingRules. The backtest must honor the profile exactly.

B) Simulation engine upgrades

Trailing support (per strategy)

Extend the day-by-day loop to update stop dynamically when exitProfile.mode is "trailing" or "mixed".

Supported trailing primitives for v1.1:

moveStopToBEAtR=K → when unrealized R ≥ K, set stop = entry (breakeven).

trailUnderEMA20 (long) / trailOverEMA20 (short) → daily trailing level is previous day EMA20 minus/plus a small tick buffer.

trailMidBollinger → daily trailing level is BB mid; apply same tick buffer.

Evaluation order per day (longs):

Target hit? (if high ≥ target) → win at target.

Stop (trailing or fixed) hit? (if low ≤ stop) → loss at stop.

Time-stop (if defined by the strategy) → exit at close with reason time_stop.
(For shorts, mirror high/low checks.)

Entry-day gap handling remains as you implemented: if next open crosses target/stop, exit immediately with gap_target/gap_stop.

MAE/MFE

Track per trade:

MAE (most adverse excursion) in R units, based on worst price vs entry until exit.

MFE (most favorable excursion) in R units, based on best price vs entry until exit.

Store in DB for each trade.

R:R calculation & ranking guards

Confirm R:R uses the plan’s prices with correct sign for shorts:

Long: RR = (target - entry) / (entry - stop)

Short: RR = (entry - target) / (stop - entry)

Discard invalid candidates (NaN, infinities, non-positive risk leg).

Determinism

Keep current tie-breakers: R:R → confidence → signalTime → static strategyPriority.

C) Persistence / DB delta

bt_trades (add columns if not present):

maeR (real), mfeR (real),

trailUsed (boolean), exitTrailLevel (real, nullable),

timeStopDays (int, nullable),

keep exitReason: target | stop | gap_target | gap_stop | time_stop.

Migration: add columns with defaults (NULL). Don’t drop existing data.

D) UI upgrades

Chart ↔ Table linking

On hover/focus of a Trades table row → highlight the corresponding trade segment on the candle chart (entry bar through exit bar).

On hover of a trade overlay on the chart → focus the row (scroll into view).

Use distinct colors per outcome: green (win), red (loss). Show faint line for the segment and small markers at entry/exit; tooltip shows R, days, exit reason.

Success Rate chart

Keep bar chart; clicking a bar filters the Trades table and highlights matching trade overlays.

Details drawer (lightweight)

Clicking a trade opens a small drawer/panel: strategy name, R, MAE/MFE, confidence, exit profile notes, and the exact prices (entry/stop/target), plus whether trailing rules were triggered.

Timestamps & state

Show Last run time for the ticker.

Button Run recomputes and replaces prior results for that ticker.

Use Last Result loads from DB without recompute.

E) IPC additions

Extend the payload of backtests:getLatestForTicker to include:

trades with new fields (maeR, mfeR, trailUsed, exitTrailLevel, timeStopDays).

overlay data readily usable by the chart: for each trade, { entryIndex, exitIndex } or timestamps to map to candles.

Existing backtests:runTicker stays the same signature; it just produces richer saved data.

F) Tests (add now)

Unit tests

Ranking: three synthetic candidates same day → assert order by R:R → confidence → time → priority.

Exit evaluation:

Fixed stop/target: one case where target hits first, one where stop hits first, one gap case each.

Trailing: a case with moveStopToBEAtR=1.5 (price reaches +1.7R, then reverses to BE stop) and a trailUnderEMA20 case.

MAE/MFE: validate R-based MAE/MFE on synthetic bars.

Integration

AAPL 1Y sample:

Non-zero trades.

“Single position” invariant holds (no overlap for the same ticker).

MAE/MFE saved; success rates computed; trailing exits recorded when relevant.

Re-running replaces previous run for ticker; latest returned via getLatestForTicker.

Keep tests deterministic by seeding candles and using a fixed engine version string for the run.

G) Acceptance criteria

Trailing exits are enforced per strategy when present (BE move and EMA/BB trails supported).

Per-trade MAE/MFE saved and shown in the details drawer.

Chart and table are linked (hover highlight both ways); outcomes color-coded.

Success rate by strategy is computed and interactive (filter on click).

Re-Run replaces prior result; Use Last loads persisted data.

Unit + integration tests pass; build/typecheck pass.

No regressions to Signals, Watchlists, or Ticker pages.

H) Commit plan (suggested)

DB migration for bt_trades new fields.

Engine: trailing primitives + MAE/MFE tracking + guards for shorts R:R.

IPC: enrich getLatestForTicker payload with overlay data.

UI: chart overlays + bidirectional hover + details drawer.

Tests: unit (ranking, exits, MAE/MFE) + integration (AAPL).

Docs update (“Backtests v1.1” section: rules, trailing types supported, MAE/MFE definitions).