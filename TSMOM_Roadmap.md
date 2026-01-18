# Swingsense: TSMOM Command Center - Full Implementation Roadmap

This roadmap outlines the complete end-to-end development of the Time Series Momentum (TSMOM) 
module, moving from research backtests to a local-first production environment.

---

## Phase 1: Persistence & Local Data Schema (SQLite)
Goal: Establish a robust, local-first relational structure for assets, prices, and personal holdings.

- [x] **Database Setup**: Initialize `better-sqlite3` within the Electron main process.
- [x] **Schema Definition**:
    - `assets`: Store the 60+ asset universe (Ticker, Name, Category).
    - `price_history`: Implemented by reusing existing `candles` (daily timeframe) as the price store.
    - `portfolio_holdings`: Not implemented as a table; holdings are computed from the trade journal.
    - `capital_ledger`: Transactional log for cash deposits/withdrawals.
    - `trade_journal`: Implemented by extending existing `portfolio_trades` (adds fee/notes/strategy_tag/meta).
- [x] **Auto-Backup Service**: Weekly automated copy of the SQLite DB into `userData/backups/`.



## Phase 2: Market Data & Integrity (API Layer)
Goal: Automate data retrieval while ensuring the quality and accuracy of the numbers.

- [x] **API Integration**: Connect to Yahoo Finance API for batch-fetching 60+ tickers.
- [x] **Sync Manager**: Daily background sync for price updates and 5-year historical backfill.
- [x] **Sanity Validation**: Flag outlier prices (e.g., >20% daily move) as warnings during sync.
- [x] **Sanity Validation (Persisted)**: Store sync runs + flagged outliers in SQLite and surface them in the UI.
- [x] **Corporate Actions Handler (Splits Heuristic)**: Detect likely splits/reverse-splits from large price gaps, persist flags, and allow applying a one-click historical rescale.



## Phase 3: Core TSMOM "Turbo" Engine (The Brain)
Goal: Implement the mathematical framework optimized for the Israeli market.

- [x] **Volatility Calculator**: Implement EWMA variance (COM parameterized; currently COM=20 in Turbo v2).
- [x] **Momentum Ranker**: 
    - Implement Turbo v2 lookback (63 trading days, skipping the last 10).
    - Rank the Universe and isolate the **Top 5** positive momentum assets.
- [x] **Position Sizer**: Calculate target units based on target volatility and current total equity (currently 0.9 target vol, max leverage 1).

## Phase 4: UI/UX Design Specifications
Goal: Provide a professional, high-clarity dashboard for quick monthly decisions.

- [x] **The Portfolio Pulse (Top Bar)**: Live display of Total Equity, Monthly P&L (approx), and a "Risk Gauge" (gross target exposure).
- [x] **The Signal Matrix (Ranking Table)**: Full list of assets ranked by momentum with Top 5 highlighted.
- [x] **Performance Analytics**: Equity chart comparing normalized portfolio vs. a benchmark (prefers TA125.TA/TA35.TA/SPY).



## Phase 5: The Rebalance Wizard (Production Workflow)
Goal: Translate algorithm signals into clear bank instructions with manual price tracking.

- [x] **Delta Calculation Engine**: Compute how many units to Buy/Sell based on computed targets vs. current holdings.
- [x] **Execution Input Module**: 
    - Display "Task List" for the month.
    - Manual input fields for "Actual Execution Price" (captured from the bank).
    - Confirm button: Records into `capital_ledger` (optional) and the trade journal (`portfolio_trades`) in one transaction.

## Phase 6: Capital Management & Ledger
Goal: Real-time tracking of the actual 50,000 NIS account and its growth.

- [x] **Cash Flow Tracker**: UI to add/remove cash (Deposits/Withdrawals) to synchronize with the bank.
- [x] **Trade Record Book**: View historical TSMOM trades and export as Markdown (copy-to-clipboard).
- [x] **Monthly Notifications**: System reminder on the 1st of each month to trigger the rebalance.

## Phase 7: Backtesting Sandbox
Goal: Allow safe experimentation with parameters before applying them to the live portfolio.

- [x] **Simulation Runner**: Run a simplified Turbo-style backtest over the last N years with adjustable parameters.
- [x] **Strategy Comparison**: Side-by-side metrics (CAGR/Vol/Sharpe/MaxDD) + chart per run.