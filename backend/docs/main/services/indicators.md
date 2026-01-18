# Indicators Service

## Purpose

`src/main/services/indicators.ts` computes overlays and snapshots from candle arrays.

## Key APIs

- `computeOverlaysAndSnapshot(candles)`
  - Produces derived indicator series for chart display.

## Dependencies

**Imports**
- shared types (`Candle` etc.)

**Imported by**
- `src/main/ipc.ts` (`indicators:get`)

## Constraints

- Must tolerate missing/partial candles.
- Should remain deterministic: same candles → same outputs.
