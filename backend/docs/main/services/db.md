# Database (SQLite)

## Purpose

`src/main/db.ts` owns the local SQLite database used by the app for:
- candles cache
- watchlists
- portfolio trades
- signals
- backtest results (if enabled)

## Key logic

- Initializes/open the DB.
- Ensures schema exists (tables + indexes).
- Exposes `getDB()` used by IPC + services.

## Dependencies

**Imports**
- SQLite driver (see implementation in `src/main/db.ts`)

**Imported by**
- `src/main/ipc.ts`
- services that cache candles/signals

## Constraints

- This DB is local-first; there is no remote DB (Firebase is not currently used).
- Keep writes batched when possible (candles inserts can be large).
