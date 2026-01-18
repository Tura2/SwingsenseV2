# Backtest Engine

## Purpose

Backtests evaluate strategies historically and store results.

Code layout:
- `src/main/services/backtest/backtestRunner.ts`: orchestrates a run
- `src/main/services/backtest/metrics.ts`: computes performance metrics
- `src/main/services/backtest/profiles.ts`: risk/position sizing profiles
- `src/main/services/backtest/discretionaryState.ts`: state handling

## Key APIs

- `runTickerBacktest(params)`
- `getLatestForTicker(ticker)`

## Dependencies

**Imports**
- market candles
- strategies
- SQLite for persistence

**Imported by**
- `src/main/ipc.ts` (`backtests:*`)

## Constraints

- Runs can be expensive; keep them out of the UI thread (main process is OK, but avoid blocking IPC too long).
