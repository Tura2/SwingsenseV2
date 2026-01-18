# TSMOM — Scripts & Tests Summary (2026-01-12)

This document summarizes the current TSMOM script layout, the latest expanded Turbo backtest run, and the current smoke test results.

## Structure cleanup (prep for "TSMOM Command Center")

### Scripts

- Canonical entrypoints: `scripts/tsmom/cli/`
- Shared helpers: `scripts/tsmom/lib/`
- Backward-compatible wrappers: `scripts/tsmom/*.mjs` (each wrapper forwards into `scripts/tsmom/cli/`)

Notable de-duplication:
- Expanded-universe config flattening is shared via `scripts/tsmom/lib/expandedUniverse.mjs` and reused by:
  - `scripts/tsmom/cli/run_tsmom_turbo_expanded_universe_electron.mjs`
  - `scripts/tsmom/cli/check_expanded_universe_symbols.mjs`

### Tests

- Canonical smoke tests: `tests/smoke/`
- Backward-compatible wrappers:
  - `tests/engine.test.mjs` → `tests/smoke/engine.test.mjs`
  - `tests/backtest.test.mjs` → `tests/smoke/backtest.test.mjs`

## Latest expanded Turbo run

### Command

- `npx electron scripts/tsmom/run_tsmom_turbo_expanded_universe_electron.mjs`
  - (Wrapper → runs `scripts/tsmom/cli/run_tsmom_turbo_expanded_universe_electron.mjs`)

### Inputs

- Config: `data/tsmom_turbo_expanded_universe.json`
- Window: 2020-01-01 → 2026-01-12
- Benchmark: `^TA125.TA`

### Outputs

- Record book:
  - `reports/tsmom/turbo/expanded/TSMOM_Turbo_Expanded_Record_Book_2020_2026.md`
- Machine summary:
  - `reports/tsmom/turbo/expanded/TSMOM_Turbo_Expanded_Summary.json`

### Results (from summary JSON)

- Final equity: **318,890.54 NIS**
- Commissions: **2,570 NIS**
- CAGR: **59.29%**
- Sharpe: **1.42**
- Max drawdown: **-38.96%**
- Alpha (ann) vs `^TA125.TA`: **21.70%**
- Beta vs `^TA125.TA`: **0.85**
- Resolved assets: **42**
- Failed assets: **0**

## Smoke test results

### Command(s)

- `node --loader ts-node/esm ./tests/engine.test.mjs`
- `node ./tests/backtest.test.mjs`

### Status

- Engine smoke: PASS
  - `detectFlagPennant returns object`
  - `detectCupHandle returns object`
  - `activeUpLegPivot indexes valid`
  - `inFibZone negative false`
  - `Strategies produce array`
- Backtest smoke: PASS
  - `exports runTickerBacktest`

## Next refactor targets for the Command Center

To make the future "TSMOM Command Center" feature clean and UI-callable, the next high-value steps are:

1. Move the expanded Turbo runner logic into a main-process module under `src/main/services/backtest/` (pure functions + orchestration).
2. Expose a single IPC surface (e.g. `backtests:runTsmomTurboExpanded`) that returns:
   - summary
   - current portfolio snapshot
   - output paths (optional)
3. Keep scripts as thin CLI wrappers that call the same main-process module (to avoid duplicate logic).
4. Add a deterministic unit test around the pure "selection + rebalance" logic using a small synthetic candle set (no network).

Known data-quality note:
- Several symbols in the universe return only **1 bar** on Yahoo (e.g. some sector indices / KSM funds). These are not 404s, but they do limit their usefulness for backtesting.
