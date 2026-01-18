# TSMOM Command Center — Progress (2026-01-12)

This document summarizes the work completed so far for the **TSMOM Command Center** foundation inside swingsenseV2.

## Scope & Architecture Choices (as implemented)
- **Price history** uses the existing `candles` table as source of truth.
- **Universe** is seeded once from `data/tsmom_turbo_expanded_universe.json` into a DB-owned `assets` table.
- **Trades** are journaled into `portfolio_trades` (extended with extra fields for strategy + notes).
- **Cash flows** are stored in a new `capital_ledger` table.
- **Plan vs Apply workflow** via IPC:
  - `compute-plan` returns deltas/targets (does not write trades)
  - `execute-trades` persists executed trades (and optional cash flows)
- **Sync** runs on startup and is scheduled daily (main process).

---

## Phase 1 — DB Schema (Done)
### Added tables
- `assets`
  - Primary key: `ticker`
  - Fields: `name`, `category`, `status`, `yahoo_symbol`, `price_multiplier`, timestamps, `meta`
- `capital_ledger`
  - Fields: `ts`, `amount`, `type` (DEPOSIT/WITHDRAWAL/ADJUSTMENT), `description`, `meta`

### Extended existing table
- `portfolio_trades` lightweight migrations add nullable fields (if missing):
  - `fee`, `strategy_tag`, `notes`, `meta`

Implementation location:
- `src/main/db.ts`

---

## Phase 2 — Sync Manager + Seeding + Scheduler (Done)
### Universe seeding
- Seeds `assets` from `data/tsmom_turbo_expanded_universe.json` only once.
- Idempotency is controlled via a DB meta flag (seed runs are skipped once flagged).
- Infers `price_multiplier` (includes default handling for `.TA` and optional overrides).

Implementation location:
- `src/main/services/tsmom/universeSeeder.ts`

### Daily candles sync
- Loads active universe from `assets`.
- Fetches daily candles via Yahoo chart provider.
- Upserts into `candles` with `symbol=ticker`, `timeframe='1d'`.
- Applies a sanity check and returns warnings when daily moves exceed a configured threshold.

Implementation location:
- `src/main/services/tsmom/syncManager.ts`

### Scheduler
- Runs an immediate sync on app start.
- Schedules a daily sync at a configured local time (default 06:00).

Implementation location:
- `src/main/services/tsmom/syncScheduler.ts`
- Wired on startup in `electron/main.ts`

---

## Phase 3 — IPC Bridge (Done)
### New IPC handlers
- `tsmom:get-universe`
- `tsmom:compute-plan`
- `tsmom:execute-trades`

Implementation location:
- `src/main/ipc.ts`

### Preload exposure
Exposed under `window.api.tsmom`:
- `getUniverse()`
- `computePlan()`
- `executeTrades(payload)`

Implementation location:
- `electron/preload.cts`

---

## Turbo v2 Planning (Initial Implementation Done)
A first implementation of the plan computation exists and is now callable via IPC:
- Momentum: lookback 63 trading days, skip 10
- Volatility: EWMA variance (COM=20), annualized
- Universe selection: Top-5 positive momentum, long-only
- Target volatility: 0.9 (annual)
- Leverage cap: 1
- Sizing: whole-share `floor`

Implementation location:
- `src/main/services/tsmom/planner.ts`

---

## Validation
- `npm run build` passes.
- `npm test` passes (engine + backtest ad-hoc tests).

---

## Notes / Known Gaps (Next steps)
- UI/Rebalance Wizard is not started yet.
- No persistence of sync run status/warnings yet (currently returned/logged only).
- No explicit overlap protection for scheduled sync runs (basic scheduling only).
- `execute-trades` currently expects renderer to supply executed fills (qty/price/side); no broker integration.

Recommended next work items:
1. Add a small renderer page/widget to display `computePlan()` output + warnings.
2. Add a “last sync status” table (optional) to persist sync runs and surface in UI.
3. Add overlap protection + last-run timestamp guard in scheduler.

## Update (later on 2026-01-12)

- Added weekly SQLite DB backup scheduler (writes to `userData/backups/`).
- Added monthly rebalance reminder (1st of month, 09:00 local) deduped via DB `meta`.
- Extended `/tsmom` UI with Capital Ledger + Trade Record Book export.

## Update (even later on 2026-01-12)

- Persist sync runs to `tsmom_sync_runs` and outlier flags to `tsmom_price_flags`.
- Added IPC + UI to view sync status and acknowledge outlier flags.
- Added overlap protection so scheduled sync runs do not overlap.

## Update (end of day 2026-01-12)

- Added split/reverse-split detection heuristics; persisted as `CORP_ACTION_SUSPECT` flags.
- Added one-click "Apply" action to rescale historical candles before the event date.
- Extended trade execution recording to optionally include a cash flow entry in the same transaction.

## Update (Phase 4 UI polish, 2026-01-12)

- Added Portfolio Pulse top bar (Equity/Cash/Holdings + monthly return estimate + risk gauge).
- Added Signal Matrix table (ranked momentum across full universe; Top K highlighted).
- Added Performance Analytics chart (normalized portfolio vs benchmark).

## Update (Phase 7 Sandbox + UI spacing, 2026-01-12)

- Added Backtesting Sandbox in `/tsmom` (parameterized simulation + comparison table).
- Improved `/tsmom` page spacing via a shared `stack` layout utility.
- Added a guide document: `reports/tsmom/TSMOM_Page_Guide.md`.
