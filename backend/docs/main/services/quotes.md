# Quotes Service

## Purpose

`src/main/services/quotes.ts` returns `QuoteLite[]` for watchlists and UI lists.

## Key APIs

- `getQuoteSafe(symbol)`
  - Resolves canonical Yahoo symbol.
  - Fetches `QuoteLite` from chart meta.
  - Returns a null-filled object on failure (does not throw to IPC).

- `getQuotes(symbols)`
  - Sequentially fetches quote-lite per symbol.
  - (Can be parallelized later, but must respect the throttler.)

## Dependencies

**Imports**
- `src/main/services/symbols.ts` (canonical symbol resolution)
- `src/main/services/yahooChartApi.ts` (Yahoo provider shim)

**Imported by**
- `src/main/ipc.ts`

## Constraints

- Do not use Yahoo quote endpoints; prefer chart/meta.
- Keep failures non-fatal and avoid log spam.
