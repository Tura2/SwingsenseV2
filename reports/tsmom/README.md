# TSMOM — Scripts, Reports, and Tests

This folder contains **all TSMOM outputs** (record books + batch reports) and a quick reference for how to regenerate them.

## Layout

- `reports/tsmom/standard/`
  - Long-only TSMOM (12-1) record books and summaries
  - Batch portfolio report
- `reports/tsmom/turbo/`
  - Turbo TSMOM (Top-5, 3-1, 80% target vol) record books and summaries

- `TSMOM Command Center` (in-app)
  - UI route: `/tsmom`
  - Uses local-first DB tables: `assets`, `capital_ledger`, `portfolio_trades`, and `candles`
  - Workflow: compute plan → enter executed fill prices → record to journal

TSMOM scripts live under `scripts/tsmom/cli/`.

> For backward compatibility, thin wrapper entrypoints remain in `scripts/tsmom/` and forward into `scripts/tsmom/cli/`.

## Backtest / Report Scripts

> Most scripts load compiled modules from `dist-electron`, so if you changed TS code, run `npm run build:electron` first.

### Standard (12-1) — Record Books

- Full-history record book (single run):
  - `npx electron scripts/tsmom/cli/generate_full_tsmom_record_book_electron.mjs`
  - Output: `reports/tsmom/standard/Full_TSMOM_Record_Book.md`

- Yearly reset record books (each year starts at 50,000 NIS):
  - `npx electron scripts/tsmom/cli/generate_tsmom_record_book_yearly_electron.mjs`
  - Outputs:
    - `reports/tsmom/standard/Full_TSMOM_Record_Book_2020.md` …
    - `reports/tsmom/standard/Full_TSMOM_Record_Book_2026_YTD.md`
    - `reports/tsmom/standard/TSMOM_Yearly_Summary_2020_2026.md`

### Standard (12-1) — Batch Portfolio Report

- Portfolio batch report (20-symbol universe):
  - `npx electron scripts/tsmom/cli/run_tsmom_batch_report_electron.mjs`
  - Output: `reports/tsmom/standard/TSMOM_Batch_Results.md`

### Turbo (Top-5, 3-1, 80% vol)

- Turbo comparison report + last-24-month trade log:
  - `npx electron scripts/tsmom/cli/run_tsmom_turbo_report_electron.mjs`
  - Output: `reports/tsmom/turbo/TSMOM_Turbo_Results.md`

- Turbo yearly reset record books + yearly summary:
  - `npx electron scripts/tsmom/cli/generate_tsmom_turbo_record_book_yearly_electron.mjs`
  - Outputs:
    - `reports/tsmom/turbo/TSMOM_Turbo_Record_Book_2020.md` …
    - `reports/tsmom/turbo/TSMOM_Turbo_Record_Book_2026_YTD.md`
    - `reports/tsmom/turbo/TSMOM_Turbo_Yearly_Summary_2020_2026.md`
    - `reports/tsmom/turbo/TSMOM_Turbo_Report_2020_2026.md`

- Turbo continuous (no reset) record book + summary report:
  - Same command as above; it also writes:
    - `reports/tsmom/turbo/TSMOM_Turbo_Record_Book_2020_2026_NoReset.md`
    - `reports/tsmom/turbo/TSMOM_Turbo_Report_2020_2026_NoReset.md`

### Notes

- All record-book scripts assume Yahoo `.TA` prices are returned in **agorot** and convert to **NIS** by dividing by 100.
- Trades execute at the daily close on rebalance day (or next available trading day in the same month).

## Tests

Ad-hoc tests live in `tests/smoke/`.

> For backward compatibility, `tests/engine.test.mjs` and `tests/backtest.test.mjs` remain as wrappers.

- Run all:
  - `npm test`
- Engine/unit-ish smoke:
  - `npm run test:engine`
- Backtest module API smoke:
  - `npm run test:backtest`

### Latest test run (2026-01-11)

```text
> npm test

> swingsense-v2@0.1.0 test
> npm run test:engine && npm run test:backtest

> swingsense-v2@0.1.0 test:engine
> node --loader ts-node/esm ./tests/engine.test.mjs

PASS: detectFlagPennant returns object
PASS: detectCupHandle returns object
PASS: activeUpLegPivot indexes valid
PASS: inFibZone negative false
PASS: Strategies produce array

All ad-hoc tests completed.

> swingsense-v2@0.1.0 test:backtest
> node ./tests/backtest.test.mjs

[backtest.test] start
PASS: exports runTickerBacktest
[backtest.test] done
```

## TSMOM Command Center (UI)

The Command Center is an in-app workflow (Electron renderer) intended for monthly rebalance execution.

- Open the app and navigate to **TSMOM** (`/tsmom`).
- **Universe** is seeded once from `data/tsmom_turbo_expanded_universe.json` into the DB `assets` table.
- **Capital Ledger** lets you add deposits/withdrawals (stored in `capital_ledger`).
- **Turbo v2 Plan** computes targets + deltas from `candles` + `portfolio_trades` + `capital_ledger`.
- **Record Executed Trades** writes fills into `portfolio_trades` (with `fee`, `strategy_tag`, `notes`).

Notes:
- This does **not** place orders with a broker; it only records what you executed in your bank.

Safety:
- Weekly SQLite DB backups are written under `userData/backups/`.
- A monthly reminder is scheduled for the 1st of the month (deduped via DB `meta`).

Data integrity:
- Daily sync runs are persisted (and viewable in `/tsmom`).
- Large day-over-day moves are stored as "price flags" and can be acknowledged in the UI.
- Likely splits/reverse-splits are flagged as `CORP_ACTION_SUSPECT` and can be applied (rescales history before the event).

Execution:
- Recording executed trades can optionally include a matching cash flow entry (saved in the same DB transaction).
