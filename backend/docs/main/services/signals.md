# Signals Service

## Purpose

`src/main/services/signals.ts` scans symbols/watchlists and persists signals to SQLite.

## Key APIs

- `scanAllSymbols()`
- `scanGoldenCrossForSymbol(symbol)`
- `scanWatchlistsSignals(filters)`

## Dependencies

**Imports**
- market service (candles)
- strategies evaluation
- SQLite via `getDB()`

**Imported by**
- `src/main/ipc.ts` (`signals:*`)

## Constraints

- Scans must be bounded (avoid unbounded parallelism).
- Writes should be idempotent where possible.
