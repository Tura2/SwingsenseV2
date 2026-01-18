<!-- markdownlint-disable -->

# TSMOM Wealth/Portfolio Module — Refined Plan (Performance + Accuracy + Currency)

This file is the execution plan for implementing the Wealth/Portfolio module described in `tsmomSRS.md`, with additional hardening requirements:

- Performance: avoid full-history “replay” on every snapshot.
- Execution accuracy: persist *actual* fills (qty/price/cost in base currency).
- Multi-currency: consistent NAV/cash/P&L display by `base_currency`.
- Universe integrity: preflight validate tickers before adding.
- Structure: separate **Raw Strategy Output** vs **Portfolio Instructions**.

The plan keeps a strict separation:

- **Research/Dev** surface area lives under `tsmom:*` and the TSMOM Command Center.
- **Client/Wealth** surface area lives under `portfolios:*` (and later `wealth:*` if needed) and the Wealth UI.

---

## 0) Current state (important constraints)

- `backend/src/main/services/tsmom/planner.ts` produces a rebalance plan, but must be portfolio-scoped.
- `backend/src/main/services/tsmom/performance.ts` must be portfolio-scoped and base-currency aware.
- Renderer uses Electron IPC via `backend/electron/preload.cts`.

---

## 1) Data model (non-negotiables)

### 1.1 Portfolios

- `portfolios`
  - `id`, `name`, `base_currency` (`USD|ILS`), `strategy_ref`, `created_at`, `meta`

### 1.2 Current State Cache (performance requirement)

Instead of re-playing full history to compute “cash + positions”, store and maintain a last-known state:

- `portfolio_states`
  - `portfolio_id` (PK)
  - `cash_base` (cash in portfolio base currency)
  - `positions_json` (ticker→qty)
  - `updated_at`

Update this table only when:

- a ledger entry is added/removed
- a trade execution is confirmed/removed

### 1.3 Trades (execution reality sync + currency)

Persist what actually happened at the broker:

- `portfolio_trades` additions
  - `portfolio_id`
  - `trade_currency` (`USD|ILS`)
  - `notional_base` (gross cost/proceeds in base currency)
  - `fx_rate` (optional, used only when `trade_currency != base_currency`)
  - `fee_base`

Rule: the engine should rely on `notional_base` and `fee_base` (not estimated values).

### 1.4 Ledger (base currency)

- `capital_ledger` additions
  - `portfolio_id`
  - `currency` (should match portfolio base currency)
  - `fx_rate` (nullable; reserved)

### 1.5 Portfolio Universe (integrity)

- `portfolio_universe`
  - `portfolio_id`, `ticker`
  - preflight validate on insert

---

## 2) Contracts (IPC boundaries)

### 2.1 Client/Wealth IPC (`portfolios:*`)

- `portfolios:list/create/update/delete`
- `portfolios:getSnapshot({ portfolioId })`
  - reads `portfolio_states` (fast)
  - computes holdings value/NAV using latest candles + FX if available
- `portfolios:universe:list/addTicker/removeTicker`
  - `addTicker` runs preflight check using existing market data fetchers

### 2.2 Research/Dev IPC (`tsmom:*`)

- `tsmom:compute-plan({ portfolioId })`
  - returns BOTH:
    - `raw` = raw strategy output (momentum/vol/weights)
    - `items` = portfolio instructions (action/targetQty/deltaQty), derived from cached state
- `tsmom:execute-trades({ portfolioId, trades[], cashFlows[] })`
  - trades are *actual fills* (qty/price + `notionalBase` when FX required)
  - updates `portfolio_states`

---

## 3) Step plan (each step includes a generic agent prompt)

### Step 1 — DB migrations + one-time cache initialization

Acceptance:

- All new tables exist on fresh DB.
- Existing DB migrates safely.
- One-time cache bootstrap runs and records a meta flag.

Generic agent prompt:
> Add multi-portfolio tables and a `portfolio_states` cache.
>
> In `backend/src/main/db.ts`, create: `portfolios`, `portfolio_states`, `portfolio_universe`, `portfolio_nav_history`.
> Add columns to `portfolio_trades` and `capital_ledger` with safe defaults.
> Seed default portfolio id=1.
> Add a one-time migration step that backfills `portfolio_states` by replaying history once, then sets a meta flag so future startups don’t replay.

---

### Step 2 — Implement cached snapshot API (fast UI)

Acceptance:

- `portfolios:getSnapshot` does not replay full history.
- Snapshot includes base currency + NAV/cash/holdings.

Generic agent prompt:
> Implement `portfolios:getSnapshot` reading from `portfolio_states` and valuing holdings via latest candles.
> Add minimal FX conversion using `USDILS=X` if present.

---

### Step 3 — Execution confirmation feedback loop

Acceptance:

- UI collects actual price + actual quantity for each instruction.
- For FX-required trades (ILS portfolio trading USD), UI collects `Cost (ILS)`.
- DB writes actuals into `portfolio_trades`.

Generic agent prompt:
> Modify confirm-execution flow so that for each instruction we capture actual qty and actual price.
> Persist those actual values into `portfolio_trades`.
> If base currency is ILS and the asset currency is USD, require the user to provide `notionalBase` (cost in ILS) OR a valid fxRate.

---

### Step 4 — Planner integrity: raw vs instructions + portfolio scoping

Acceptance:

- Raw strategy output does not depend on cash/positions.
- Instructions do depend on cached cash/positions.
- No cross-portfolio leakage.

Generic agent prompt:
> Refactor `backend/src/main/services/tsmom/planner.ts` so:
> - `raw` strategy output is computed from candles/universe only.
> - `items` instructions are computed by applying raw weights to the selected portfolio’s cached state.
> - All reads are scoped by `portfolioId`.

---

### Step 5 — Universe preflight validation (broken universe prevention)

Acceptance:

- Adding a ticker to a portfolio universe triggers a data fetch.
- If fetch fails or candles are missing, insertion is blocked with:
  - `Error: Could not fetch data for [Ticker]. Please verify the symbol.`

Generic agent prompt:
> Implement `portfolios:universe:addTicker` that calls the existing market data fetcher.
> If candles cannot be fetched, throw the exact error string required.
> Add minimal UI to add/remove tickers from the portfolio universe.

---

### Step 6 — Multi-currency hardening

Acceptance:

- All displayed amounts are in portfolio base currency.
- For ILS portfolios trading USD assets, conversion uses either user-provided `notionalBase` for executions and `USDILS=X` for mark-to-market.

Generic agent prompt:
> Ensure cash/NAV/holdings are displayed in base currency (USD or ILS).
> Add a warning when FX candles are missing.

---

### Step 7 — Client-facing Wealth UI (optional next)

Acceptance:

- Simple Portfolio selector.
- Snapshot cards.
- Action Center instructions with actual execution inputs.

Generic agent prompt:
> Add `frontend/pages/Wealth.tsx` and a route, using only `portfolios:*` and a minimal `tsmom:*` instruction call.
> Keep advanced controls in TSMOM Command Center.

---

### Step 8 — Tests

Acceptance:

- Two portfolios isolation tests.
- portfolio_states update tests (ledger + trade).
- FX-required execution validation test.

Generic agent prompt:
> Add focused tests verifying:
> - portfolio_states updates incrementally on ledger/trades
> - snapshots are fast and isolated
> - execution requires base-cost for FX cases

---

## 4) Guardrails

- Do not reintroduce backtest persistence.
- Prefer additive IPC (`portfolios:*`) over mutating `tsmom:*` contracts for client-facing needs.
- Deletions (ledger/trades) are admin ops; correctness > speed (rebuild state if needed).

