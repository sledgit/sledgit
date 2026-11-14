# Backtest: house strategies on real NEAR/USDC history

**Current method: `bt.py` (below). The 180-day `backtest.py` results further down are superseded.**

`fetch.py` pulls Binance NEARUSDT 5m candles and Hyperliquid NEAR hourly funding; `backtest.py` replays every
14-day window (stepped weekly) under season-1 vault rules: 15 bps per trade, $0.01 gas, capped trade size.
Copycat and Vibes are not modelled (they need historical wallet data and live LLM calls).

```
python3 -I fetch.py 180
python3 -I backtest.py                      # $10 vault, $1 cap
START=1000 CAP=100 python3 -I backtest.py   # $1,000 vault, $100 cap
```

## Result (2026-10-28: 180 days, NEAR 1.30 -> 4.71, 24 windows, window moves -23% to +92%)

| Bot | $10: median / beat hold | $1,000: median / beat hold | Trades per 2 weeks |
|---|---|---|---|
| Baseline (hold 50/50) | -0.5% / - | -0.5% / - | 0 |
| Trend 5m | -99.5% / 0 of 24 | -33.5% / 0 of 24 | 870-1950 |
| Trend 1h | -12.3% / 1 of 24 | +2.2% / 5 of 24 | ~160 |
| Trend 4h | -3.5% / 7 of 24 | -0.5% / 12 of 24 (best +72%) | ~35 |
| Rebalancer (10-point drift) | -0.5% / 1 of 24 | -0.5% / 1 of 24 | ~0 |
| LiNEAR holder | -0.6% / 0 of 24 | -0.5% / 24 of 24 (by ~0.1%) | 1 |
| Carry (spot + Hyperliquid short) | -3.2% / 7 of 24 | 0.0% / 12 of 24 | ~30 |
| Arbitrageur (no gaps found) | 0.0% / 12 of 24 | 0.0% / 12 of 24 | 0 |

Hyperliquid NEAR funding averaged 13.5% APR, negative in 4% of hours.

Takeaways: at $10, gas ($0.01 = 0.1% of the vault per trade) sinks anything that trades often. Trend on 5m
candles loses everything at any size. Only the LiNEAR holder beats holding reliably, and only at size. One
strongly trending period; treat as indicative, not predictive.

## bt.py: six years, professional checklist (2026-10-28)

Data: Binance's official archive (data.binance.vision), NEARUSDT 5m since listing, SHA-256 verified
(`get_archive.sh`), cleaned by `clean.py`: the archive's switch from ms to µs timestamps handled, first 14 days after
listing dropped, 0.045% of bars missing (10 outages, longest 4.7 h), no low-volume wicks, daily closes match Coinbase
(median 0.06%, max 0.68%). Funding: Binance NEARUSDT 8h archive since 2020.

Method: signals at bar close, fills at next open; 20 bps per trade (measured today: best of Rhea and Intents vs
Binance mid, $10–$1,000) plus $0.01 gas; every vault starts in USDC. In-sample 2020-11 to 2024-12, out-of-sample
2025-01 to 2026-10. Full trend grid (26 configs) reported in `results.txt`. Stationary block bootstrap p-values vs
hold 50/50, Deflated Sharpe and PBO (CSCV, 16 blocks) for the trend family, regime split on NEAR's 200-day average.

Highlights, $100 vault (NEAR 0.70 → 4.68; hold 50/50 max drawdown −92%):

| Strategy | In-sample CAGR / MaxDD | Out-of-sample CAGR / MaxDD | Trades/yr | p vs hold |
|---|---|---|---|---|
| Hold 50/50 (benchmark) | 39% / −92% | −6% / −75% | 0 | - |
| LiNEAR holder | 51% / −91% | 0% / −77% | 0 | 0.00 |
| Rebalancer 10pt | 54% / −72% | +13% / −54% | 7 | 0.23 |
| **Staked rebalancer 10pt** | **61% / −70%** | **+16% / −53%** | 7 | 0.16 |
| Staked Donchian 55/20d | 64% / −68% | +18% / −49% | 4 | 0.30 |
| Trend 1d SMA50 (best in-sample) | 120% / −57% | +13% / −64% | 18 | 0.07 |
| Trend 1h / 4h, short lookbacks | mostly −30% to −98% | mostly negative | 100–600 | ~1.0 |
| Carry (staked spot + short perp) | 11% / −2% | 4% / −0.1% | 43 | 0.62 |

- Only staking beats holding with statistical confidence, and by a small, certain margin.
- Rebalancing and slow trend rules improve return and cut drawdown in and out of sample, but p = 0.07–0.30:
  plausible, not proven. Trend family Deflated Sharpe 0.01–0.09, PBO 30–40%: the best config is likely overfit.
- Intraday trend loses at every size. Gas ($0.002 vs $0.02) barely matters at $100 for slow strategies; the 20 bps
  trading cost does.
- Carry earns 4–11%/yr market-neutral, compressing recently, consistent with the literature. Its Sharpe is overstated:
  the model ignores spot/perp basis noise and liquidation risk, and the perp leg sits off NEAR.
