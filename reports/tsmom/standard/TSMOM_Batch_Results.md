# TSMOM Batch Results

Date range: **2021-01-13 → 2026-01-09** (daily)

Strategy: 12-month sign (12-1), monthly rebalance, EWMA vol (60D center-of-mass), target vol 40% per asset.

## Per-Stock Summary
| Symbol | Sharpe | CAGR | MaxDD | Alpha (ann) | Beta | Final Eq | Buy&Hold Eq | Avg |pos| |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| LUMI.TA | 0.86 | 26.5% | -44.0% | 20.6% | 0.36 | 3.2375 | 3.7034 | 1.14 |
| POLI.TA | 0.82 | 24.8% | -44.0% | 7.9% | 0.79 | 3.0179 | 3.2633 | 1.18 |
| DSCT.TA | 0.27 | 3.1% | -49.5% | -3.6% | 0.54 | 1.1624 | 2.7243 | 1.08 |
| MZTF.TA | 0.31 | 4.3% | -48.9% | -13.8% | 0.93 | 1.2336 | 2.9991 | 1.11 |
| PHOE.TA | 0.90 | 29.0% | -41.4% | 12.1% | 0.54 | 3.5596 | 5.4394 | 0.99 |
| HARL.TA | 0.56 | 14.0% | -64.3% | 8.8% | 0.34 | 1.9207 | 4.2102 | 0.94 |
| NICE.TA | 0.03 | -5.8% | -60.9% | -3.9% | -0.43 | 0.7440 | 0.4252 | 0.85 |
| TSEM.TA | 0.06 | -4.0% | -68.6% | -2.6% | 0.13 | 0.8146 | 4.2931 | 0.95 |
| NVMI.TA | 0.77 | 22.3% | -50.9% | 3.3% | 0.58 | 2.7296 | 4.9384 | 0.76 |
| CAMT.TA | -0.11 | -9.7% | -76.4% | -11.4% | 0.15 | 0.6023 | 5.6663 | 0.67 |
| ESLT.TA | 0.54 | 13.5% | -63.8% | -10.0% | 0.78 | 1.8786 | 4.9539 | 1.09 |
| TEVA.TA | -0.07 | -8.8% | -67.6% | -6.9% | 0.14 | 0.6324 | 2.8108 | 0.78 |
| AZRG.TA | 0.43 | 9.0% | -49.0% | 10.4% | 0.31 | 1.5355 | 1.8911 | 1.04 |
| AMOT.TA | -0.01 | -6.6% | -65.4% | 2.4% | -0.25 | 0.7106 | 1.4504 | 1.12 |
| DLEKG.TA | -0.29 | -14.2% | -81.3% | -30.8% | 0.38 | 0.4651 | 7.9739 | 0.82 |
| NWMD.TA | -0.34 | -19.4% | -86.6% | -19.0% | 0.13 | 0.3418 | 4.8383 | 0.94 |
| ICL.TA | -0.24 | -14.0% | -65.3% | -8.9% | -0.01 | 0.4701 | 1.0363 | 0.95 |
| STRS.TA | 0.17 | -0.3% | -57.0% | 8.5% | -0.42 | 0.9836 | 1.1004 | 1.23 |
| SAE.TA | 0.10 | -2.7% | -62.7% | 2.8% | 0.06 | 0.8726 | 1.6800 | 1.14 |
| RMLI.TA | -0.09 | -9.2% | -72.8% | -6.9% | 0.26 | 0.6180 | 1.6607 | 1.36 |

## Portfolio Summary (Equal-Weight)
The portfolio is computed by equal-weighting **daily strategy returns** across the 20 assets (using available data per day).
Benchmark is equal-weight **buy & hold** (equal-weight daily asset returns).

| Metric | TSMOM Portfolio | Equal-Weight Buy & Hold |
|---|---:|---:|
| Sharpe | 0.81 | n/a |
| CAGR | 10.4% | n/a |
| Vol (ann) | 14.1% | n/a |
| MaxDD | -25.7% | n/a |
| Alpha (ann) | 2.5% | n/a |
| Beta | 0.30 | n/a |
| Final Equity | 1.6403 | 3.7456 |

## Notes / Interpretation
- If a stock trends cleanly, TSMOM tends to stay on the right side (long in uptrends, short in downtrends).
- In choppy/mean-reverting periods, the binary sign signal can flip often and hurt Sharpe (whipsaw).
- Vol targeting equalizes risk contribution, but it can increase leverage in low-vol regimes; `maxLeverage` caps extremes.
