# Strategies

## Purpose

Strategies evaluate candle history + indicators and emit trade setup signals.

Code layout:
- `src/main/services/strategies/index.ts`: registry / exports
- `src/main/services/strategies/impl/*`: individual strategy implementations
- `src/main/services/strategies.ts`: higher-level orchestration

## Key API

- `evaluateStrategies(candles, opts?)`

## Dependencies

**Imports**
- indicator bundles and strategy utils

**Imported by**
- `src/main/ipc.ts` (`strategies:get`, `strategies:diagnostics`)
- signals scanning

## Constraints

- Strategies should be pure functions of candle history (no network, no DB).
- Strategy IDs must remain stable; add new IDs via the registry.
