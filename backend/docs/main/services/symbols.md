# Symbols Service

## Purpose

`src/main/services/symbols.ts` normalizes user symbols and resolves them to Yahoo-compatible symbols.

## Key functions

- `normalizeInputSymbol(input)`
  - uppercases and trims.

- `yahooCandidatesForSymbol(input)`
  - conservative candidate list (does not append `.TA` blindly).

- `resolveCanonicalYahooSymbol(input)`
  - resolves the best Yahoo symbol + exchange hint.
  - uses Yahoo search endpoint (throttled)
  - caches results for 24h.

- `resolveYahooSymbolViaSearch(input)`
  - search-only resolution used when you want the "best match".

## Dependencies

**Imports**
- Yahoo provider search (`src/main/services/yahooChartApi.ts` shim)

**Imported by**
- `src/main/services/market.ts`
- `src/main/services/quotes.ts`

## Constraints

- Exchange hints are heuristic; prefer explicit `.TA` or `TASE:` when the user knows it.
- Cache TTL is 24h to reduce repeated lookups.
