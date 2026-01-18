# Market Service

## Purpose

`src/main/services/market.ts` fetches and caches candles in SQLite.

## Key APIs

- `getCandles(symbol, range)`
  - Convenience API (range-based).

- `getCandlesByInterval(symbol, interval)`
  - Primary API used by IPC.
  - Uses canonical Yahoo symbol resolution.
  - Fetches candles via Yahoo chart endpoint.
  - Persists candles into SQLite for reuse.

## Key logic

- **Symbol resolution**: uses `resolveCanonicalYahooSymbol()`.
- **Candidate fallback**: tries multiple Yahoo symbol candidates when needed.
- **Intervals**:
  - `4h` prefers intraday (1h/60m) data when available; falls back to `1d`.
  - `1d/1wk/1mo` pulls ~5y of history.

## Dependencies

**Imports**
- `src/main/db.ts` (SQLite)
- `src/main/services/providers/yahoo/*` (via `yahooChartApi.ts` shim)
- `src/main/services/symbols.ts`

**Imported by**
- `src/main/ipc.ts`
- indicators/strategies pipeline via IPC

## Constraints

- Candle arrays can be large; write to DB in batches.
- All network calls go through the Yahoo provider (which is throttled).
