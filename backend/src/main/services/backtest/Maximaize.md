Trading Strategy Diagnostic — Agent Prompt
Objective

Diagnose why results vary across symbols and time, and produce actionable changes to improve expectancy, drawdown, and stability.
Answer the questionnaire, verify data integrity, run focused analyses (MAE/MFE, R:R what-ifs, filters), and return clear next steps.

You Have (Context)

Universe: ~40 high-volume Israeli stocks (TA).

Files (1:1 aligned unless stated):

candles.csv: ts_iso, symbol, tf, open, high, low, close, volume, adj_close?, adj_factor?

indicators.csv: indicator series aligned to candles (e.g., ema20, ema50, ema200, atr14, bb_* ...)

trades.csv (if available): ts_entry, ts_exit, symbol, entry, stop, target, exit, reason, R, MAE, MFE, tf, fees, slippage

If a file is missing, state that explicitly and continue with what you can.

Deliverables (What to produce)

Questionnaire answers (A–E) — concise bullets.

Data integrity checks — lookahead, alignment, NaNs, gaps, split/adjust logic.

Core metrics — WinRate, Avg Win R, Avg Loss R, Expectancy (per strategy & per symbol), PF, MaxDD, MAR.

MAE/MFE What-If grid — Stops×Targets sweep with Walk-Forward evaluation; report best stable R:R (not just maximal).

Pre-entry filters tests — volume expansion, proximity to 52-week high, volatility bounds, market/sector trend, index/flow events; quantify lift/drop in:

Trade count, WinRate, PF, MaxDD, Expectancy.

Symbol cohorts — compare Negative, 0–30%, ≥30% performers; identify discriminative features (e.g., vol_ratio_10_65, atr_pct, beta_market, sector).

Position sizing impact — fixed cash vs risk-based; show effect on MaxDD & MAR.

Exit policy comparison — single target vs split exits (e.g., 50% @1R + ATR trail) vs time-stop.

Top 5 concrete changes — ranked by expected improvement and simplicity, with exact parameter values.

Return results as:

Short write-up (+ tables) inside this file,

Plus CSV outputs: metrics_by_symbol.csv, wf_rr_grid.csv, filters_ablation.csv.

Questionnaire (Answer succinctly)
A) Data & Universe

What is the exact stock universe policy (fixed vs rolling, rebalance cadence)?

Backtest dates (from–to). Any IS/OS split or Walk-Forward used?

Corporate actions: are dividends/splits handled (via adj_close/adj_factor) consistently?

B) Candles & Indicators

Active timeframes (Daily / 4H / Hourly). Any symbols missing data on some TFs?

Verify no lookahead: indicators use only information up to previous bar at decision time.

Are MAE/MFE per trade always logged and aligned?

C) Strategies & Triggers

List all entry triggers (e.g., emaBounceBullStack, MA cross, BB squeeze).

Pre-filters used (market trend, sector trend, min volume, volatility bounds, distance to ATH)?

Time filters (e.g., blackout around earnings/holidays/Sundays)?

D) Risk & Exits

Stop logic (fixed %, ATR, swing-low). Is there a time-stop?

Target logic (fixed R:R, ATR multiples, partials + trailing).

Break-even rule (when/how moved to BE).

Position sizing (fixed cash vs risk-based).

Fees, tax, slippage assumptions.

E) Evaluation

Primary KPIs (CAGR, MAR, Expectancy/R, Sharpe, MaxDD, WinRate, PF).

Why do some symbols hit ≥30% cumulative and others ≤0%? Any sector/vol/trigger pattern?

Is there Walk-Forward / rolling train-test, or single global fit?

Do we use MAE/MFE to bound feasible R:R empirically?

Trade frequency & average holding: signs of overtrading or over-holding?

Survivorship bias: is the historical universe time-aware?

Analyses to Run
1) Expectancy Profile

Compute per-trade R: (exit - entry) / stop_distance with sign.

Report by strategy and symbol:

WinRate, AvgWinR, AvgLossR, Expectancy = p*AvgWinR − (1−p)*|AvgLossR|, PF, MaxDD, MAR.

2) MAE/MFE → R:R What-If (with Walk-Forward)

Grid search:

Targets: 0.8R … 4.0R (step 0.2R)

Stops: 0.7R … 1.5R (step 0.1R)

For each window (e.g., quarterly WF): find top stable pairs (penalize instability across windows).

Output: wf_rr_grid.csv with columns: window, stopR, targetR, winrate, expectancy, trades, pf.

3) Pre-Entry Filters (Strong-Gain profile)

Create these features (per symbol/day) and test as AND filters:

vol_ratio_10_65 = sma(volume,10)/sma(volume,65) ≥ 1.2

near_52w_high = (highest(close,252)-close)/highest(close,252) ≤ 3%

atr_pct = atr14/close within [p20, p80] of its history

market_trend = TA-35 close > ema200

sector_top_quartile_20d (stock’s 20D return in top 25% of its sector)

Run ablation:

Baseline vs each single filter vs combos.

Output filters_ablation.csv: filter_set, trades, winrate, expectancy, pf, maxdd, mar, delta_expectancy.

4) Position Sizing & Exits

Compare fixed cash vs risk-based sizing (e.g., 0.5%–1% equity risk per trade).

Compare exits:

Single target (best WF R:R),

Split: 50% at 1R + ATR(14) trailing for remainder,

Time-stop: exit if < +0.5R after N bars (choose N via WF).

Report effect on MaxDD, MAR, Expectancy.

5) Cohort Discrimination (Why ≥30% winners?)

Split symbols into: Negative, 0–30%, ≥30% (by cumulative P&L).

For each group, compute medians of: vol_ratio_10_65, atr_pct, avg_turnover, beta_market, sector, %days_up, gap_rate, distance_to_52wh.

Return the top 3 features that separate groups with simple rules (if/then). No overfitting.

Required Outputs (Tables/CSV + Short Notes)

metrics_by_symbol.csv

wf_rr_grid.csv

filters_ablation.csv

A bulleted “Top 5 Changes” list with exact parameters (e.g., “Require vol_ratio_10_65 ≥ 1.2 and near_52w_high ≤ 3%; set stop=0.9R,target=1.8R; position risk=0.7%/trade; time-stop=10 bars; split exit 50% @1R + ATR trail”).

Answer Template (fill this)

A) Data & Universe:

- Universe policy: Currently a manually curated, fixed list (e.g., BEST SIGNALS; ~40 TA high‑volume stocks). Not time‑aware; symbols remain until user edits the watchlist.
- Backtest dates: Daily data over the most recent ~5 years (~1260 trading days). No explicit IS/OS split; single contiguous window. No Walk‑Forward yet.
- Corporate actions: We rely on the data provider’s adjusted series. No explicit in‑house dividend/tax processing. Splits/dividends are implicitly reflected if the provider adjusts OHLC; otherwise not corrected.

B) Candles & Indicators (incl. lookahead check):

- Active TFs: Daily is active for the backtest. Lower TFs (e.g., 4h) are available but not used here.
- Lookahead: Entry logic evaluates signals using history up to the decision bar and enters at the next bar’s open. Trailing rules (EMA/BB mid) use prior day values. This prevents lookahead.
- Alignment: Indicators are computed on the same sliced window; warm‑up NaNs exist at the very start but are naturally excluded by the lookback and truncation. Trades store `entry_index/exit_index` aligned to the candle window.
- MAE/MFE: Logged per trade in R units (`mae_r`, `mfe_r`).

C) Strategies & Triggers (incl. pre-filters):

- Entry triggers (examples): emaBounceBullStack, emaPullback, ema200Reclaim/Reject, rsiPositiveReversal, macdZeroLineUp, squeezeBreakout/Breakdown, rangeBreakout/Breakdown w/ volume, bbMeanRevertTrend, vcpContraction, mtfAlignment, patternFlag/Pennant, cup‑and‑handle.
- Existing pre‑filters: Strategy‑specific conditions (stacked EMAs, squeeze, volume vs MA) embedded in each trigger. No global market/sector trend filter yet.
- Time filters: None globally (no earnings/holiday blackout rules today).

D) Risk & Exits:

- Stop logic: Fixed initial stop provided by the signal (swing/structure based). Optional trailing via exit profile rules: move to BE at kR, trail under EMA20 or BB mid. Time‑stop supported (days) but only applied when a strategy’s exit profile sets it.
- Target logic: Single initial target (first target from the signal). No partial exits currently.
- Break‑even: Optional rule (moveStopToBEAtR) when enabled by a strategy profile.
- Position sizing: Single position, sequential. Equity curve updates by per‑trade percentage return at each exit (effectively 100% notional in each trade). No risk‑based position sizing yet.
- Fees/slippage/taxes: Not modeled.

E) Evaluation Setup:

- KPIs in place: Per‑strategy WinRate, AvgR, MedianR, Expectancy (AvgR), Avg hold days. UI shows overall success rate and cumulative % profit.
- KPIs missing/recommended: Profit Factor, Max Drawdown, MAR, Sharpe. Equity series is available (via export) to compute MaxDD/MAR; not yet persisted as run metrics.
- Why symbol dispersion? Likely driven by trend strength, volatility regime, and liquidity differences. Breakout‑style triggers prefer sustained trends (near 52W highs, strong volume), whereas mean‑reversion patterns break under trending markets. No sector/market filter currently, so symbols more sensitive to index regime will vary more.
- Walk‑Forward: Not used yet (single global fit/window). MAE/MFE captured but not yet used for a systematic R:R sweep.
- Trade frequency/holding: Daily system with single‑position constraint; holding varies by exit policy; no signs of over‑trading in engine (max one active position), but over‑holding can happen without time‑stop.
- Survivorship bias: Universe not time‑aware; potential bias if watchlist contains current winners only.

Integrity Findings:

- Lookahead: Avoided by design (entries at next open; trailing uses prior bar). PASS.
- Indicator alignment: Bundles aligned to the sliced candle window; early warm‑up values can be undefined but are not used for decisions. PASS with note to explicitly guard NaNs in any new indicators.
- Candle gaps/holidays: Daily gaps exist (weekends/holidays); logic is robust (uses timestamps; no assumptions on contiguous days).
- Corporate actions: No explicit in‑house adjust; reliance on provider may cause inconsistencies across symbols. Suggest normalizing to adjusted OHLC where available and flagging large split gaps.
- Data completeness: 5‑year slice per symbol; ensure minimum bar count threshold (e.g., >800 bars) and flag symbols below threshold.

Key Metrics (by strategy & symbol):

- Currently available from runs: per‑strategy trades, wins, losses, successPct, avgR, medianR, expectancy, avgHoldDays. Not yet broken out by symbol in a single CSV.
- Top observation pattern (qualitative):
	- Breakout strategies tend to do better when price is within ~3% of 52W high and volume ≥ 1.2× its 65‑day average.
	- Mean‑reversion strategies perform better outside high‑momentum periods and degrade when market trend is strongly up or down.
- To produce `metrics_by_symbol.csv`: run batch backtests across the universe and aggregate per symbol and per strategy; compute PF, MaxDD, MAR from the equity series for each.

WF R:R Summary:

- Not yet run. Recommended setup:
	- Grid: Stops 0.7R…1.5R (step 0.1), Targets 0.8R…4.0R (step 0.2).
	- Windows: Quarterly Walk‑Forward across the 5‑year period (20 windows). Score each pair by expectancy with a stability penalty (e.g., −λ·stdev(expectancy)).
	- Initial baseline to validate: stop ≈ 0.9R, target ≈ 1.8R for breakout‑style entries; stop ≈ 1.1R, target ≈ 1.2–1.6R for mean‑reversion.
- Output: `wf_rr_grid.csv` with window, stopR, targetR, winrate, expectancy, trades, pf. Requires a dedicated analysis pass; not produced yet.

Filters Ablation (lift vs baseline):

- Candidate AND filters to test:
	1) vol_ratio_10_65 = SMA(vol,10)/SMA(vol,65) ≥ 1.2
	2) near_52w_high = (HHV(close,252)−close)/HHV(close,252) ≤ 3% (for breakout‑style strategies)
	3) atr_pct = ATR14/close within [p20, p80] of its symbol history
	4) market_trend = index (TA‑35) close > EMA200 for long‑biased strategies
	5) sector_top_quartile_20d
- Expected effects (qualitative):
	- Filters (1)+(2) reduce trade count, increase WinRate and PF; lower MaxDD via fewer low‑quality trades.
	- atr_pct banding improves stability by avoiding extreme regimes.
	- market_trend filter improves long‑biased strategies in adverse markets.
- Output `filters_ablation.csv` to be generated after running the ablation grid.

Cohort Insights (≥30% vs others):

- Likely separating features:
	1) vol_ratio_10_65 (liquidity/interest proxy)
	2) near_52w_high (trend persistence proxy)
	3) atr_pct (volatility regime proxy)
- Simple rules (to validate):
	- If vol_ratio_10_65 ≥ 1.2 AND near_52w_high ≤ 3% THEN favor breakout entries; expect ≥30% cohort behavior.
	- If atr_pct ∉ [p20,p80] THEN reduce size or skip; outlier regimes degrade expectancy.
	- For mean‑reversion, require market_trend not strongly up (index close ≤ EMA200) to avoid fighting trend.

Top 5 Changes (with exact params):

1) Pre‑entry filters (global):
	 - Require vol_ratio_10_65 ≥ 1.2 and atr_pct ∈ [p20, p80].
	 - For breakout strategies also require near_52w_high ≤ 3%; for short/breakdown ≤ −3% from 52W low analog.

2) Min R:R defaults with overrides:
	 - Global min R:R = 1.5.
	 - Overrides: squeezeBreakout=1.8, rangeBreakoutVolume=1.6, emaBounceBullStack=1.2, rsiPositiveReversal=1.2, macdZeroLineUp=1.4.

3) Exit policy standardization:
	 - Move to BE at 0.8R; use BB mid trailing thereafter (daily; prior‑bar level).
	 - Time‑stop at 20 bars if PnL < +0.5R; otherwise continue trailing.

4) Market regime filter (long bias):
	 - Only allow long entries when TA‑35 > EMA200 (or loosen with > EMA100) and symbol’s EMA20 > EMA50.

5) Position sizing (risk‑based):
	 - Risk 0.7% equity per trade using entry/stop distance; cap simultaneous exposure to 1 open position (unchanged), or allow 2 with max 1.2% aggregate risk.

Notes: Items 1, 4, and 5 require additional features (index data, sector data, volume averages, per‑trade sizing). Items 2–3 are partially supported by current engine (min R:R, BE/trailing/time‑stop via exit profiles) but may need standardization across strategies.

Notes

If any step can’t run due to missing fields, state the requirement and skip gracefully.

Prefer stability over peak performance; penalize solutions that vary wildly across WF windows.





Immediate Tasks (execute in order)
0) Fail-Fast Integrity Checks (required)

Verify no lookahead on all strategies: decisions use t-1 info; entries at t open.

Guard NaNs: drop warm-up bars until every used indicator is valid.

Confirm adjusted OHLC availability per symbol; if absent, flag symbol and continue.

Enforce min bars per symbol ≥ 800; list any excluded symbols.

Output: integrity_report.md (bullets with PASS/FAIL per check).

1) Core Metrics by Strategy × Symbol

Compute for each (strategy, symbol):

Trades, WinRate, AvgWinR, AvgLossR, ExpectancyR, ProfitFactor, MaxDD, MAR (CAGR/MaxDD), Sharpe (daily equity).

Require an equity curve per (strategy, symbol) to derive MaxDD/MAR.

Output: metrics_by_symbol.csv
Schema:
strategy,symbol,trades,winrate,avg_win_r,avg_loss_r,expectancy_r,pf,maxdd,mar,sharpe,avg_hold_days,start,end

Acceptance criteria: no empty columns; MaxDD < 0; PF = gross wins / gross losses.

2) MAE/MFE → R:R What-If (with Walk-Forward)

Use logged mae_r, mfe_r to simulate exits without re-running signals.

Grid:

stopR ∈ {0.7, 0.8, …, 1.5}

targetR ∈ {0.8, 1.0, …, 4.0}

Walk-Forward windows: rolling quarterly across 5 years (≈20 windows).

For each window and pair (stopR, targetR) compute: trades, WinRate, ExpectancyR, PF.

Score with stability penalty: score = expectancy_r − λ * stdev(expectancy_r across windows), with λ = 0.25.

Outputs:

wf_rr_grid.csv — window_id,start,end,stopR,targetR,trades,winrate,expectancy_r,pf,score

wf_rr_best.csv — top 5 pairs by score (global and per strategy).

Acceptance criteria: at least 12 windows populated; no pair reported with < 30 trades total (across symbols) unless noted.

3) Pre-Entry Filters Ablation (Strong-Gain profile)

Create features (daily, per symbol):

vol_ratio_10_65 = sma(vol,10)/sma(vol,65) (threshold ≥ 1.2)

near_52w_high = (HHV(close,252)-close)/HHV(close,252) (threshold ≤ 3% for breakout styles)

atr_pct = atr14/close and compute rolling percentiles; band to [p20, p80]

market_trend = (TA-35 close > ema200) — use index series provided or request it

sector_top_quartile_20d = stock 20-day return is top 25% within its sector

Run ablation vs current baseline:

Single filters: (1), (2), (3), (4), (5)

Combos: (1)+(2), (1)+(3), (1)+(2)+(3), (1)+(2)+(3)+(4)

Report delta vs baseline in trades, WinRate, ExpectancyR, PF, MaxDD, MAR.

Output: filters_ablation.csv
filter_set,trades,winrate,expectancy_r,pf,maxdd,mar,delta_trades,delta_expectancy,delta_pf,delta_maxdd,delta_mar

Acceptance criteria: clearly mark baseline row; at least 3 combos reported.

4) Exit Policy Comparisons

Compare three exit policies on the same entries:

Single target using the WF-best R:R per strategy.

Split exit: 50% at 1.0R, remainder ATR(14) trailing (Chandelier stop, daily, prior-bar).

Time-stop overlay: if PnL < +0.5R after 20 bars, exit (or half-exit if split is used).

Output: exit_policies_comparison.csv
strategy,policy,trades,winrate,expectancy_r,pf,maxdd,mar,median_hold_days

Acceptance criteria: same entry set across policies; only the exit rules differ.

5) Position Sizing Impact (risk-based vs notional)

Re-simulate at portfolio level:

Baseline: current 100% notional, single concurrent position.

Risk-based: risk 0.7% equity per trade, position = risk / (entry−stop); cap concurrent positions at 2, max aggregate risk 1.2%.

Outputs:

sizing_portfolio_curves.csv — daily equity for both policies

sizing_summary.csv — policy,cagr,maxdd,mar,sharpe,stdev,ulcer_index,avg_exposure

Acceptance criteria: same entry timestamps; differences due only to sizing/scaling.

6) Cohort Split (Symbol Performance Buckets)

Split symbols by cumulative P&L into 3 buckets: Negative, 0–30%, ≥30%.

For each bucket, report medians of:

vol_ratio_10_65, atr_pct, avg_turnover, beta_market, %days_up, gap_rate, distance_to_52wh

Fit simple rules (non-ML if/then) to separate ≥30% from others (e.g., thresholds on vol_ratio & distance_to_52wh & atr_pct band).

Output: cohort_features.csv and short cohort_rules.md.

Acceptance criteria: at least 3 features with clear monotonic separation.