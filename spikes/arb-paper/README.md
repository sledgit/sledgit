# Spike: paper arbitrage on NEAR Intents and Rhea

Prices round trips with dry quotes (no funds move) and takes a paper trade only when a loop clears estimated
gas plus 5 bps. Loops: wNEAR/USDC Rhea→Intents and Intents→Rhea, USDC NEAR→Base→NEAR, ETH Ethereum→Arbitrum→Ethereum,
at $10 and $100. Binance NEAR/USDT mid is logged as a reference.

```
INTERVAL=30 DURATION=1200 python3 -I paper.py   # writes ticks.csv, prints a summary
```

## Result (2026-10-28, 20 min, 40 ticks per loop, NEAR 4.72–4.75)

No loop was ever positive, before or after gas. 0 paper trades.

| Loop | Gross bps (range) |
|---|---|
| Rhea→Intents $10 / $100 | −73 to −14 / −75 to −36 |
| Intents→Rhea $10 / $100 | −62 to −11 / −61 to −26 |
| USDC NEAR→Base→NEAR $10 / $100 | −6 to −4 / −4 to −2 |
| ETH Ethereum→Arbitrum→Ethereum $10 / $100 | −89 / −12 |

A quiet 20-minute window; a volatile day could differ, so a longer run is worth doing before ruling it out.
