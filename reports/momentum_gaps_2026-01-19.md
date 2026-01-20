# Momentum Diagnostics (2026-01-19)

- dbPath: C:\Users\offir\AppData\Roaming\Electron\swingsense.db
- assets: 73 (ok=67, missing=6)
- lookback=63, skip=10, requiredCandles>=75

## Missing By Reason

- INSUFFICIENT_VALID_CLOSES(valid=2, total=2, need>=75): 4
- INSUFFICIENT_VALID_CLOSES(valid=1, total=1, need>=75): 1
- INSUFFICIENT_VALID_CLOSES(valid=0, total=0, need>=75): 1

## Missing Details

| ticker | status | candles_1d | valid_1d | last_candle | reason | resolved_yahoo | multiplier | category | name |
|---|---:|---:|---|---|---|---:|---|---|
| OIL_ETF_TASE | active | 1 | 1 | 2022-09-01 | INSUFFICIENT_VALID_CLOSES(valid=1, total=1, need>=75) | KSM-F44.TA | 0.01 | Commodities & Safe Havens | Oil ETF |
| MSCI_WORLD_TASE | active | 0 | 0 |  | INSUFFICIENT_VALID_CLOSES(valid=0, total=0, need>=75) | KSM-F71.TA | 0.01 | Global Anchors (ETFs) | MSCI World |
| ESTATE15.TA | active | 2 | 2 | 2026-01-19 | INSUFFICIENT_VALID_CLOSES(valid=2, total=2, need>=75) | ESTATE15.TA | 0.01 | Sector Indices | TA-RealEstate |
| TA-BANKS.TA | active | 2 | 2 | 2026-01-19 | INSUFFICIENT_VALID_CLOSES(valid=2, total=2, need>=75) | TA-BANKS.TA | 0.01 | Sector Indices | TA-Banks |
| TA-TECH.TA | active | 2 | 2 | 2026-01-19 | INSUFFICIENT_VALID_CLOSES(valid=2, total=2, need>=75) | TA-TECH.TA | 0.01 | Sector Indices | TA-Tech |
| 195.TA | active | 2 | 2 | 2026-01-19 | INSUFFICIENT_VALID_CLOSES(valid=2, total=2, need>=75) | 195.TA | 1 | portfolio |  |
