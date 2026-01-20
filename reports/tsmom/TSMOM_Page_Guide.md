# TSMOM Page Guide (`/tsmom`)

This document explains each section of the **TSMOM Command Center** page and how to use it safely.

---

## 1) Portfolio Pulse

Purpose: quick status at a glance before you rebalance.

What it shows:
- **Equity / Cash / Holdings**: computed from your local `capital_ledger` and `portfolio_trades` (via the current plan calculation).
- **Monthly P&L (approx)**: estimated from the performance series using ~21 trading days.
- **Risk gauge**: gross target exposure (sum of absolute target weights).
- **Open flags**: count of unacknowledged data-integrity flags.

Use it for:
- sanity check your database is seeded and you have a deposit
- verify you don’t have outstanding integrity issues before acting

---

## 2) Data Integrity / Sync

Purpose: make data quality visible (this protects you from acting on corrupted price history).

What it shows:
- **Last sync status** and counts
- **Open Price Flags**: anomalies detected during sync
  - `SANITY_MOVE`: large day-over-day moves
  - `CORP_ACTION_SUSPECT`: likely split/reverse-split event

Actions:
- **Ack**: acknowledges the flag (you reviewed it).
- **Apply (corp action)**: rescales historical candles *before* the flagged date to match the post-event price scale.
  - Use this when you are confident it was a split/reverse split.
  - After applying: recompute plan.

---

## 3) Signal Matrix

Purpose: see the entire universe ranked by momentum.

What it shows:
- All active universe assets ranked by Turbo v2 momentum
- Top-K positive momentum assets highlighted

Use it for:
- quick “why are these in the Top 5?” checks
- spotting when too many assets have negative momentum

---

## 4) Performance Analytics

Purpose: compare normalized portfolio equity vs a benchmark.

What it shows:
- Normalized equity curve for your local portfolio journal
- Normalized benchmark equity (tries ^TA125.TA / TA35.TA / SPY)

Notes:
- If you have no benchmark candles in the DB, the chart may be empty.

---

## 5) Backtesting Sandbox

Purpose: safely experiment with parameters *before* applying changes to real trades.

What it does:
- Runs a simplified Turbo-style backtest over the last N years.
- Rebalances roughly every ~21 trading days.
- Produces summary metrics:
  - CAGR
  - annualized volatility
  - Sharpe (CAGR / vol)
  - max drawdown
  - benchmark CAGR

How to use it:
1. Set years + parameters.
2. Click **Run**.
3. Review the chart + metrics.
4. Click **Add to comparison** to keep a short list of configs.

Important:
- This is a sandbox tool. It’s for directional guidance, not a broker-grade backtest.

---

## 6) Universe

Purpose: view the DB-owned universe used by sync and ranking.

What it shows:
- Ticker, name/category, Yahoo symbol mapping, and any multiplier overrides.

---

## 7) Turbo Plan + Execution

Purpose: compute the current rebalance plan and record what you executed.

Flow:
1. Compute plan.
2. Fill actual execution prices from your bank.
3. Confirm you executed trades.
4. Record executed trades (and optionally record a cash flow in the same transaction).

---

## 8) Capital Ledger + Trade Record Book

Purpose:
- Ledger: keep your cash movements in sync with the real account.
- Trade book: an audit trail of what you executed.

---

## Safety checklist

Before recording trades:
- No unacknowledged `CORP_ACTION_SUSPECT` flags.
- You have a starting DEPOSIT in the ledger.
- Plan warnings look reasonable.
