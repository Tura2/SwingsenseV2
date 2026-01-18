# Indicator Bundle Builder

## Purpose

`src/main/services/indicatorService.ts` builds a comprehensive indicator bundle (EMA/BB/RSI/MACD/ATR/etc.) used for debugging, export, and strategies.

## Key API

- `buildIndicatorBundle(candles, params)`

## Dependencies

**Imports**
- indicator math helpers

**Imported by**
- `src/main/ipc.ts` (`indicators:bundle`)

## Constraints

- Parameter defaults should be stable across releases.
- Keep bundle shape backward-compatible when possible.
