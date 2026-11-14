"""Backtest the house strategies on real NEAR/USDC history under season-1 vault rules.

Each 14-day window starts with $10. Trades pay COST (pool + solver) plus GAS, and move at most CAP USD.
Scores each strategy against simply holding 50/50 in every window. Copycat and Vibes are not modelled:
copycat needs historical wallet data, vibes needs live LLM calls.
"""
import json, statistics

import os
COST = 0.0015          # per trade, measured ~9-15 bps one way
GAS = 0.01             # USD per NEAR transaction
CAP = float(os.environ.get("CAP", 1.0))      # USD per trade (vault rule)
START = float(os.environ.get("START", 10.0))
STAKE_APR = 0.045      # LiNEAR, approx
WINDOW = 14 * 288      # 14 days of 5m candles
STEP = 7 * 288

C = json.load(open("candles.json"))
F = {f[0] // 3_600_000: f[1] for f in json.load(open("funding.json"))}
close = [c[4] for c in C]
hour = [c[0] // 3_600_000 for c in C]


class Vault:
    def __init__(self, p, w=0.5):
        self.usd, self.near, self.trades = START * (1 - w), START * w / p, 0

    def value(self, p): return self.usd + self.near * p

    def move(self, p, usd):  # +usd buys NEAR, -usd sells; capped and costed
        usd = max(-CAP, min(CAP, usd))
        if usd > 0: usd = min(usd, self.usd - GAS)
        else: usd = max(usd, -self.near * p)
        if abs(usd) < 0.05: return
        self.usd -= usd + abs(usd) * COST + GAS
        self.near += usd / p
        self.trades += 1


def hold(a, b):
    v = Vault(close[a]); return v.value(close[b]) / START - 1, 0


def trend(tf):  # tf in 5m candles; all-in above the 20-period average, out below, $1 a step
    def run(a, b):
        v = Vault(close[a])
        for i in range(a + tf * 20, b + 1, tf):
            sma = sum(close[i - k * tf] for k in range(20)) / 20
            p = close[i]
            target = v.value(p) if p > sma else 0.0
            v.move(p, target - v.near * p)
        return v.value(close[b]) / START - 1, v.trades
    return run


def rebal(a, b):  # hourly, back toward 50/50 when NEAR weight drifts more than 10 points
    v = Vault(close[a])
    for i in range(a, b + 1, 12):
        p = close[i]; val = v.value(p); w = v.near * p / val
        if abs(w - 0.5) > 0.10: v.move(p, (0.5 - w) * val)
    return v.value(close[b]) / START - 1, v.trades


def linear(a, b):  # 50/50 with the NEAR half staked as LiNEAR; one entry swap
    p0, p1 = close[a], close[b]
    days = (b - a) / 288
    near_half = (START / 2) * (1 - COST) / p0 * (1 + STAKE_APR * days / 365)
    return (START / 2 - GAS + near_half * p1) / START - 1, 1


def carry(a, b):  # long spot (staked) + equal short perp on Hyperliquid; rebalanced daily
    eq, cost = START, 0.0
    eq -= START / 2 * (COST + 0.0005 + 0.0005) + 3 * GAS      # spot swap, bridge, perp taker
    for i in range(a, b, 12):                                   # hourly funding on the short
        eq += (eq / 2) * F.get(hour[i], 0.0)
        eq += (eq / 2) * STAKE_APR / (365 * 24)
    for d in range(a + 288, b, 288):                            # daily hedge rebalance: move half the day's PnL
        moved = (eq / 2) * abs(close[d] / close[d - 288] - 1)
        eq -= moved * (COST + 0.0005) + 2 * GAS
    eq -= START / 2 * (COST + 0.0005 + 0.0005) + 3 * GAS      # exit
    return eq / START - 1, 2 + 2 * ((b - a) // 288)


def arb(a, b):  # holds USDC; 0 profitable gaps in the paper run, so no trades
    return 0.0, 0


BOTS = {"Baseline (hold 50/50)": hold, "Trend 5m": trend(1), "Trend 1h": trend(12), "Trend 4h": trend(48),
        "Rebalancer": rebal, "LiNEAR holder": linear, "Carry (spot+short)": carry, "Arbitrageur": arb}

windows = [(a, a + WINDOW) for a in range(20 * 48, len(close) - WINDOW, STEP)]
res = {k: [f(a, b) for a, b in windows] for k, f in BOTS.items()}
base = [r[0] for r in res["Baseline (hold 50/50)"]]
mkt = [close[b] / close[a] - 1 for a, b in windows]
print(f"{len(windows)} windows of 14 days · NEAR {close[0]:.2f} -> {close[-1]:.2f} · window NEAR moves {min(mkt):+.0%} to {max(mkt):+.0%}")
print(f"{'bot':<24}{'median':>8}{'best':>8}{'worst':>8}{'made $':>8}{'beat hold':>10}{'trades/2wk':>11}")
for k, rs in res.items():
    r = [x[0] for x in rs]; t = [x[1] for x in rs]
    made = sum(1 for x in r if x > 0)
    beat = sum(1 for x, y in zip(r, base) if x > y + 1e-9)
    print(f"{k:<24}{statistics.median(r):>8.1%}{max(r):>8.1%}{min(r):>8.1%}{made:>5}/{len(r):<2}{beat:>7}/{len(r):<2}{statistics.mean(t):>11.0f}")
fund = [F[h] for h in sorted(F)]
print(f"Hyperliquid NEAR funding: mean {statistics.mean(fund)*24*365:.1%} APR, negative {sum(f<0 for f in fund)/len(fund):.0%} of hours")
