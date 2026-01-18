# SwingSense V2: Swing Trading Research & Backtesting Platform

> 📹 **[Watch the 90-sec demo](https://youtu.be/YOUR_VIDEO_ID)**  
[![Demo thumbnail](assets/demo.gif)](https://youtu.be/YOUR_VIDEO_ID)

## Tech Stack

| Layer | Key Components |
| :--- | :--- |
| **Platform** | **Electron**, **Vite** (bundler) + **TypeScript** |
| **Frontend** | **React 18**, **lightweight-charts** (charting) |
| **State/Data** | **Zustand** (state management), **SQLite** (embedded DB via `better-sqlite3`), **Zod** (validation) |
| **APIs/Utils** | `yahoo-finance2` (market data), `fflate` (ZIP export) |

## Overview

A modular **desktop research app** (built with **Electron/React/TypeScript**) for running multi-year backtests with a plug-in strategy engine. It calculates **entry/exit decisions** with safety thresholds and supports both single-ticker and experiments. The platform features **one-click ZIP exports** (bars, indicators, trades, equity, config) for fully reproducible analysis.

## Key Capabilities

  * **Modular Strategy Engine:** JSON-configurable rules, scoring, and guardrails to gate entries.
  * **Realistic Backtesting:** Runs **5-year daily backtests** with next-bar entries and robust exit logic (target/stop, optional trailing and time-stop).
  * **Trade Analytics:** Calculates **R-multiple, percent PnL, MAE/MFE in R**, and provides global/per-strategy minimum R:R overrides.
  * **Yearly Results View:** Trades grouped by year, showing per-year success rate and cumulative % profit.
  * **Artifacts:** One-click ZIP export of all data (bars, indicators, trades, equity, config) **for deeper analysis and comparison**.

## TSMOM Command Center

This repo also includes an early **TSMOM Command Center** (local-first, SQLite-backed) for monthly portfolio rebalancing.

- UI: navigate to `/tsmom` inside the Electron app
- Data model: `assets` (seeded once from JSON), `candles` (daily), `capital_ledger` (cash flows), `portfolio_trades` (trade journal)
- Workflow: compute plan → enter executed fill prices → record trades to journal

-----

## What’s Inside

  * **5Y Daily backtests** (single position at a time)
  * **Exits:** target/stop, optional trailing (EMA20 / BB mid), optional time-stop
  * **Trade analytics:** R multiple, percent PnL, MAE/MFE in R
  * **Min R:R control:** Global setting with **per-strategy overrides**
  * **Side filter:** BOTH / LONG / SHORT
  * **One-click export:** ZIP with bars, indicators, trades, equity, and runtime config

-----

## Quick Start

### Development (Vite + Electron):

```bash
npm install
npm run dev
Build:
bash
Copy code
npm run build
Tasks are also available from VS Code (see workspace tasks).

Using the Backtest Page
Run: Enter ticker, set Min R:R and Side. Use "Advanced overrides" to set per-strategy minimum R:R. Click Run.

Review:

Chart (5Y daily) with trades overlay.

Per-strategy success bars (filterable by year).

Trades table grouped by year.

Per-year success rate and cumulative % profit.

Export:

"Export" downloads a ZIP with all run artifacts.

Strategies & Scoring
Enabled by Default (Tier-1 + selected advanced):
emaPullback, squeezeBreakout, rangeBreakoutVolume (long), emaPopFailShort (short), squeezeBreakdown (short), ema200Reclaim (advanced long), bbMeanRevertTrend (advanced long)

Available (disabled by default):
macdZeroLineUp, emaBounceBullStack, rsiPositiveReversal, fibConfluencePullback, mtfAlignment, rangeBreakdownVolume (short), ema200RejectionShort

Pattern Detection: patternFlagPennant, patternCupHandle, vcpContraction

Strategy Scoring
Base Score: 50 + sum(weights of hit factors).

Entry Gate: Entries are gated per strategy using strategies.<id>.minScore.

Configuration: Weights are configured in backend/src/main/services/config/default-engine-config.json under scoring.weights.

Exports — File Shapes (JSON)
File Name	Description	Key Fields (Excerpt)
bars	Last 1260 daily bars.	{ ts, iso, o, h, l, c, v, tf }[]
indicators	Full set of calculated indicators.	ema20, rsi14, macd, bb:{upper,middle,lower,width,widthRank120}, atr14, donchian20, volMA20
trades	Normalized trade log.	{ seq, symbol, strategy, side, entry, exit_price, exit_reason, R, pct, mae_R, mfe_R, confidence? }[]
equity	Step equity, drawdown, and exposure per bar.	{ ts, ts_iso, equity, drawdown, exposure_pct }[]
config	Runtime engine configuration.	{ generatedAt, symbol, engineConfig, minRR:{global,overrides}, side? }

Developer Notes
Engine Core: backend/src/main/services/backtest/backtestRunner.ts

Strategies: backend/src/main/services/strategies/impl/*

Config Override: Set ENGINE_CONFIG_PATH to a JSON file (deep-merged with defaults).

Pattern Utilities: patternUtils.ts (flag/pennant, cup-handle, contraction detection), fibUtils.ts (fib zone membership).

Renderer APIs (preload): backtests.runTicker(), backtests.getLatestForTicker(), getIndicatorBundle().

Contact
offir.tura@gmail.com · LinkedIn

License
MIT License (c) You