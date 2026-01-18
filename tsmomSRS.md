
---

# SRS: Swingsense Portfolio & Wealth Management Module

## 1. Overview & Objective

The goal is to evolve **Swingsense** from a strategy research tool into a production-ready trading product. This module adds a "Client-Facing" layer that abstracts the complex TSMOM (Time Series Momentum) configurations, allowing the user to manage capital, multiple portfolios, and execute trades based on system-generated signals.

**Key Philosophy:** Abstract the math. The user acts as a "Client" who provides capital and executes orders, while the system acts as the "Fund Manager" providing instructions.

## 2. System Context

* **Existing Infrastructure:** TSMOM calculation engine, data scrapers, and basic UI (Electron/React/ASP.NET Core).
* **New Feature Scope:** State management for multiple portfolios, cash flow logic (Deposits/Withdrawals), a simplified Action Center, and a persistent Record Book.

---

## 3. Functional Requirements

### 3.1 Portfolio Management (Multi-Instance)

* **FR1:** The system shall support creating multiple independent portfolios.
* **FR2:** Each portfolio must have a unique ID, Name, and associated Strategy Configuration (e.g., "US Turbo", "IL Mid-Cap").
* **FR3:** The system must track the "Total Net Asset Value" (NAV) per portfolio, including cash and current position values.

### 3.2 Cash Management (Flow Logic)

* **FR4 (Deposit):** When cash is added, the system shall calculate how to allocate it among current "Long" positions to maintain the target volatility and strategy weights.
* **FR5 (Withdrawal):** When a withdrawal is requested, the system shall generate "Sell" orders across all current holdings proportionally (Pro-rata) to free up the requested cash while maintaining the strategy’s balance.
* **FR6:** The system must distinguish between "Total Cash" (available for withdrawal) and "Invested Capital."

### 3.3 The "Action Center" (UI/UX)

* **FR7:** The system shall present a simplified "Instruction List" for rebalancing.
* **FR8:** Instructions must be binary and actionable:
* **BUY [Ticker]: [Quantity] units**
* **SELL [Ticker]: [Quantity/All] units**
* **HOLD [Ticker]**


* **FR9:** A "Confirm Execution" trigger must exist to update the internal state once the user performs the trade in the external broker.

### 3.4 Record Book (Audit & Performance)

* **FR10:** Every transaction (Trade, Deposit, Withdrawal, Dividend) must be logged with a timestamp, price, and currency.
* **FR11:** The system shall maintain a historical "Equity Curve" for each portfolio.

---

## 4. Technical Specifications & Logic

### 4.1 State Management (The "Engine" vs. "Client")

* The **Engine** calculates the "Ideal State" based on TSMOM math.
* The **Portfolio Module** maintains the "Current State" (what is actually held).
* The **Difference (Delta)** between the Ideal State and Current State is what generates the instructions in the Action Center.

### 4.2 Handling Capital Changes

* **Logic for Deposits:** 
* **Logic for Withdrawals:**


---

## 5. Data Model (Entity-Relationship)

* **Portfolio Table:** `Id, Name, StrategyRef, CreatedAt, TotalInitialCapital`
* **Positions Table:** `PortfolioId, Ticker, Quantity, AverageEntryPrice, LastUpdated`
* **Transactions Table (Record Book):** `Id, PortfolioId, Type (Trade/Cash), Ticker, Quantity, Price, Timestamp`
* **CashLedger:** `PortfolioId, CurrentBalance, Currency`

---

## 6. Non-Functional Requirements

* **Usability:** The "Client" view must hide all , volatility calculations, and raw data unless explicitly toggled (Dev Mode).
* **Consistency:** The system must ensure that "Cash" + "Market Value" always equals the "Total NAV" recorded in the history.
* **Performance:** Rebalance calculations should trigger within <2 seconds after data fetching is complete.

---
