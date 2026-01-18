# Yahoo Provider

## Purpose

Provides a stable, throttled interface to Yahoo Finance endpoints.

Implementation:
- `src/main/services/providers/yahoo/yahooApi.ts`
- Compatibility shim: `src/main/services/yahooChartApi.ts` re-exports provider APIs.

## Endpoints used

- Chart: `GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}`
- Search: `GET https://query1.finance.yahoo.com/v1/finance/search?q={query}`

## Key functions

- `fetchYahooChartResult(symbol, query)`
  - Fetches chart JSON and returns `chart.result[0]`.

- `chartResultToCandles(result)`
  - Converts Yahoo timestamps + OHLCV arrays to `Candle[]`.
  - Sorts and de-dupes by timestamp.

- `fetchYahooCandlesByPeriod(symbol, interval, startMs, endMs, includePrePost)`
- `fetchYahooCandlesByRange(symbol, interval, range, includePrePost)`

- `fetchQuoteLiteFromChart(symbol)`
  - Derives `QuoteLite` from chart `meta` + last candle fallback.

- `fetchYahooSearchQuotes(query)`
  - Returns raw quote candidates from the Yahoo search endpoint.

## Dependencies

**Imports**
- `src/main/services/http/throttledHttpClient.ts`
- `src/shared/types.ts`

**Imported by**
- `src/main/services/market.ts`
- `src/main/services/quotes.ts`
- `src/main/services/symbols.ts`

## Constraints

- Yahoo may throttle aggressively; always keep throttling enabled.
- Prefer chart/meta for quotes (quote endpoints are more frequently blocked).
