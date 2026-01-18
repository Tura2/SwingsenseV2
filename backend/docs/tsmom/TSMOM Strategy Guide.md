# Time Series Momentum (TSMOM) Implementation Guide

## 1. Overview
This strategy is based on **"Time Series Momentum"** by Moskowitz, Ooi, and Pedersen (2012). Unlike cross-sectional momentum (ranking assets against each other), **Time Series Momentum (TSMOM)** uses each asset’s own past returns.

## 2. Theoretical Foundation
The research documents trend effects across equity indexes, currencies, commodities, and bond futures.
* **Core finding**: Past 12-month excess returns help predict future returns.
* **Performance**: A diversified TSMOM portfolio can deliver abnormal returns (alpha) with limited exposure to standard asset pricing factors.
* **Market regimes**: TSMOM tends to perform best during extreme market moves (large up or down), acting as a potential tail-risk hedge.

## 3. Mathematical Calculations

### A. The Signal (Trend)
Go **Long** if the past return is positive and **Short** if it is negative.
$$r_{t,t+1}^{TSMOM,s} = \text{sign}(r_{t-12,t}^s) \cdot \frac{\text{Target Volatility}}{\sigma_t^s} \cdot r_{t,t+1}^s$$
* **Look-back period ($k$)**: 12 months.
* **Holding period ($h$)**: 1 month.

### B. Volatility Scaling (Ex-ante Volatility)
To balance risk across assets, scale returns by inverse volatility.

Compute variance $\sigma_{t}^{2}$ with an exponentially weighted model of lagged squared daily returns:
$$\sigma_{t}^{2} = 261 \sum_{i=0}^{\infty} (1-\delta) \delta^{i} (r_{t-1-i} - \bar{r}_{t})^{2}$$
* **Scalar 261**: scales daily variance to annual.
* **Parameter $\delta$**: chosen so the effective weight center is ~60 days.
* **Target volatility**: often set to ~40% per asset (stock-like risk).

## 4. Implementation Logic for Swingsense

### Step 1: Universe Selection
Select a liquid universe (e.g., S&P 500 stocks or major futures) to avoid illiquidity effects.

### Step 2: Signal Generation
For each asset in the engine:
1. Calculate the cumulative return over the past 12 months.
2. Take the sign ($+1$ or $-1$).
3. For stocks, consider excluding the most recent month (12–1 momentum) to reduce short-term reversal effects.

### Step 3: Risk Management (The "Vol-Scaler")
1. Compute daily volatility $\sigma_t$ using the EWMA formula above.
2. Adjust position size: $Size = \frac{\text{Target}}{\sigma_t}$.

### Step 4: Rebalancing
Rebalance monthly based on the updated 12-month sign and updated volatility estimates.

## 5. Expected Results
* **Sharpe ratio**: diversified TSMOM can achieve Sharpe > 1.0 in some studies.
* **Correlation**: often low correlation to passive long benchmarks.