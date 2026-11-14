"""Backtest the house strategies on six years of clean NEAR/USDC history, to the usual professional checklist.

- No lookahead: signals use bar closes up to i, trades fill at the open of bar i+1.
- Costs: COST_BPS per trade (measured: best of Rhea and Intents vs Binance mid, $10-$1,000) plus GAS per transaction.
- Every vault starts in USDC and pays to build its first position.
- Benchmarks: hold 50/50 (the season benchmark), 100% NEAR, 100% USDC.
- Full parameter grid for the trend family is reported, not just the best.
- In-sample 2020-11 to 2024-12; out-of-sample 2025-01 to now, untouched while choosing parameters.
- Significance: stationary block bootstrap of daily excess returns vs hold 50/50.
- Overfitting: Deflated Sharpe Ratio for the best in-sample trend config, and PBO by CSCV (16 blocks).
- Regimes: NEAR above / below its 200-day average (known at the prior close).
Copycat and Vibes are not modelled: they need historical wallet data and live LLM calls.
"""
import glob, io, itertools, json, math, os, statistics, zipfile
from datetime import datetime, timezone
import numpy as np

COST_BPS = float(os.environ.get("COST_BPS", 20))
GAS = float(os.environ.get("GAS", 0.01))
SIZES = [float(x) for x in os.environ.get("SIZES", "10,100,1000").split(",")]
MIN_TRADE = 0.02                      # ignore target changes under 2% of equity
OOS_START = datetime(2025, 1, 1, tzinfo=timezone.utc).timestamp() * 1000
INFLATION_CUT = datetime(2025, 10, 30, tzinfo=timezone.utc).timestamp() * 1000
DAY = 86_400_000
rng = np.random.default_rng(7)

# ---------- data ----------
raw = np.array(json.load(open("clean.json")))
T5, O5, H5, L5, C5 = raw[:, 0], raw[:, 1], raw[:, 2], raw[:, 3], raw[:, 4]


def resample(minutes):
    key = (T5 // (minutes * 60_000)).astype(np.int64)
    idx = np.flatnonzero(np.diff(key)) + 1
    starts, ends = np.r_[0, idx], np.r_[idx - 1, len(key) - 1]
    hi = np.maximum.reduceat(H5, starts); lo = np.minimum.reduceat(L5, starts)
    return {"t": key[starts] * minutes * 60_000, "o": O5[starts], "h": hi, "l": lo, "c": C5[ends]}


BARS = {"1h": resample(60), "4h": resample(240), "1d": resample(1440)}
D = BARS["1d"]
NDAYS = len(D["t"])


def funding_series():
    out = []
    for f in sorted(glob.glob("data/NEARUSDT-fundingRate-*.zip")):
        with zipfile.ZipFile(f) as z:
            for line in io.TextIOWrapper(z.open(z.namelist()[0])):
                c = line.strip().split(",")
                if c[0].isdigit(): out.append((int(c[0]), float(c[2])))
    out.sort()
    return np.array(out)


FUND = funding_series()

# ---------- simulation ----------


def simulate(tf, target, start, stake=None):
    """Trade toward target[i] (decided at close of bar i) at the open of bar i+1.
    target: array of weights in NEAR, np.nan = no change. stake: callable(t_ms)->APR on NEAR held, or None.
    Returns daily equity (aligned to D) and stats."""
    B = BARS[tf]; t, o, c = B["t"], B["o"], B["c"]
    usd, near, trades, costs = start, 0.0, 0, 0.0
    eq_bar = np.empty(len(t))
    pending = np.nan
    for i in range(len(t)):
        if not np.isnan(pending):
            p = o[i]; val = usd + near * p
            delta = pending * val - near * p
            if abs(delta) >= MIN_TRADE * val and val > GAS:
                fee = abs(delta) * COST_BPS / 1e4 + GAS
                if delta > 0:
                    delta = min(delta, usd - fee)
                near += delta / p; usd -= delta + fee
                trades += 1; costs += fee
        if stake is not None and near > 0 and i > 0:
            near *= 1 + stake(t[i]) * (t[i] - t[i - 1]) / (365 * DAY)
        eq_bar[i] = usd + near * c[i]
        pending = target[i]
    day = (t // DAY).astype(np.int64)
    last = np.r_[np.flatnonzero(np.diff(day)), len(day) - 1]
    eq = np.interp(D["t"] // DAY, day[last], eq_bar[last])
    return eq, trades, costs


def sma(x, n):
    out = np.full(len(x), np.nan); cs = np.cumsum(np.r_[0, x])
    out[n - 1:] = (cs[n:] - cs[:-n]) / n
    return out


def trend_target(tf, n, band):
    c = BARS[tf]["c"]; s = sma(c, n); w = np.full(len(c), np.nan); state = 0.0
    for i in range(len(c)):
        if np.isnan(s[i]): continue
        if c[i] > s[i] * (1 + band): state = 1.0
        elif c[i] < s[i] * (1 - band): state = 0.0
        w[i] = state
    return w


def donchian_target(n_in, n_out):
    h, l, c = D["h"], D["l"], D["c"]; w = np.full(len(c), np.nan); state = 0.0
    for i in range(n_in, len(c)):
        if c[i] > h[i - n_in:i].max(): state = 1.0
        elif c[i] < l[i - n_out:i].min(): state = 0.0
        w[i] = state
    return w


def const_target(tf, wt):
    w = np.full(len(BARS[tf]["c"]), np.nan); w[0] = wt; return w


def rebal_target(thr):
    """Back to 50/50 when NEAR's weight drifts past thr; weight tracked from prices since the last rebalance."""
    c = D["c"]; w = np.full(len(c), np.nan); w[0] = 0.5; base = c[0]; wt = 0.5
    for i in range(1, len(c)):
        g = c[i] / base; cur = wt * g / (wt * g + 1 - wt)
        if abs(cur - 0.5) > thr: w[i] = 0.5; base = c[i]; wt = 0.5
    return w


def stake_apr(t_ms):
    return 0.09 if t_ms < INFLATION_CUT else 0.045


def carry(start):
    """Long spot NEAR (staked) + equal short perp; collect funding; re-hedge when price moves 20% from the last hedge."""
    c = D["c"]; t = D["t"]; spot_fee = COST_BPS / 1e4; perp_fee = 0.0005
    eq = np.empty(NDAYS); E = start; trades = 0; costs = 0.0
    entry = start / 2 * (spot_fee + perp_fee + 0.0005) + 3 * GAS
    E -= entry; costs += entry; trades += 2
    q = (E / 2) / c[0]; anchor = c[0]; fi = np.searchsorted(FUND[:, 0], t[0])
    for i in range(NDAYS):
        while fi < len(FUND) and FUND[fi, 0] < t[i] + DAY:
            E += q * c[i] * FUND[fi, 1]; fi += 1
        E += q * c[i] * stake_apr(t[i]) / 365
        if abs(c[i] / anchor - 1) > 0.20:
            moved = abs(E / 2 - q * c[i])
            fee = moved * (spot_fee + perp_fee) + 2 * GAS
            E -= fee; costs += fee; trades += 2
            q = (E / 2) / c[i]; anchor = c[i]
        eq[i] = E
    return eq, trades, costs


def strategies():
    s = {"Hold 50/50 (benchmark)": ("1d", const_target("1d", 0.5), None),
         "Hold 100% NEAR": ("1d", const_target("1d", 1.0), None),
         "Hold 100% USDC": ("1d", const_target("1d", 0.0), None),
         "LiNEAR holder (50/50, staked)": ("1d", const_target("1d", 0.5), stake_apr)}
    for thr in (0.05, 0.10, 0.20):
        s[f"Rebalancer {int(thr*100)}pt"] = ("1d", rebal_target(thr), None)
    s["Staked rebalancer 10pt"] = ("1d", rebal_target(0.10), stake_apr)
    s["Staked Donchian 55/20d"] = ("1d", donchian_target(55, 20), stake_apr)
    grid = {}
    for tf, n, band in itertools.product(("1h", "4h", "1d"), (10, 20, 50, 100), (0.0, 0.02)):
        grid[f"Trend {tf} SMA{n}{' band2%' if band else ''}"] = (tf, trend_target(tf, n, band), None)
    for a, b in ((20, 10), (55, 20)):
        grid[f"Donchian {a}/{b}d"] = ("1d", donchian_target(a, b), None)
    return s, grid


# ---------- statistics ----------


def metrics(eq, mask=None):
    e = eq if mask is None else eq[mask]
    r = np.diff(np.log(e)); days = len(e) - 1
    cagr = (e[-1] / e[0]) ** (365 / days) - 1
    sd = r.std(ddof=1); dn = r[r < 0].std(ddof=1) if (r < 0).sum() > 2 else np.nan
    peak = np.maximum.accumulate(e); mdd = (e / peak - 1).min()
    return {"cagr": cagr, "vol": sd * math.sqrt(365), "sharpe": r.mean() / sd * math.sqrt(365) if sd else 0,
            "sortino": r.mean() / dn * math.sqrt(365) if dn else 0, "mdd": mdd, "calmar": cagr / abs(mdd) if mdd else 0}


def bootstrap_p(diff, reps=1000, block=20):
    """Stationary bootstrap (Politis & Romano) p-value for H0: mean daily excess <= 0."""
    n = len(diff); obs = diff.mean(); centred = diff - obs
    pos = np.arange(n)
    new = rng.random((reps, n)) < 1 / block; new[:, 0] = True
    start_pos = np.maximum.accumulate(np.where(new, pos, 0), axis=1)
    starts = rng.integers(n, size=(reps, n))
    idx = (np.take_along_axis(starts, start_pos, axis=1) + pos - start_pos) % n
    return float((centred[idx].mean(1) >= obs).mean())


def deflated_sharpe(r_best, sr_trials):
    """Bailey & López de Prado DSR with daily (non-annualised) Sharpe ratios."""
    nd = statistics.NormalDist(); n = len(sr_trials); T = len(r_best)
    sr = r_best.mean() / r_best.std(ddof=1)
    g = 0.5772156649
    sr0 = math.sqrt(np.var(sr_trials, ddof=1)) * ((1 - g) * nd.inv_cdf(1 - 1 / n) + g * nd.inv_cdf(1 - 1 / (n * math.e)))
    z = (r_best - r_best.mean()) / r_best.std(ddof=1)
    skew, kurt = (z ** 3).mean(), (z ** 4).mean()
    return nd.cdf((sr - sr0) * math.sqrt(T - 1) / math.sqrt(1 - skew * sr + (kurt - 1) / 4 * sr ** 2))


def pbo(R, S=16):
    """Probability of backtest overfitting by CSCV. R: days x configs daily returns."""
    blocks = np.array_split(np.arange(len(R)), S); logits = []
    for ins in itertools.combinations(range(S), S // 2):
        i_idx = np.concatenate([blocks[k] for k in ins])
        o_idx = np.concatenate([blocks[k] for k in range(S) if k not in ins])
        sr_i = R[i_idx].mean(0) / R[i_idx].std(0); sr_o = R[o_idx].mean(0) / R[o_idx].std(0)
        best = np.argmax(sr_i); rank = (sr_o < sr_o[best]).sum() + 1
        w = rank / (R.shape[1] + 1); logits.append(math.log(w / (1 - w)))
    return float(np.mean(np.array(logits) <= 0))


# ---------- run ----------


def run(start):
    base, grid = strategies()
    curves, info = {}, {}
    for name, (tf, tgt, st) in {**base, **grid}.items():
        curves[name], tr, co = simulate(tf, tgt, start, st)
        info[name] = (tr, co)
    curves["Carry (staked spot + short perp)"], tr, co = carry(start)
    info["Carry (staked spot + short perp)"] = (tr, co)
    return curves, info, list(grid)


def fmt(m):
    return f"{m['cagr']:>8.1%}{m['sharpe']:>7.2f}{m['mdd']:>8.1%}"


if __name__ == "__main__":
    years = (D["t"][-1] - D["t"][0]) / (365 * DAY)
    oos = D["t"] >= OOS_START; ins = ~oos
    above = np.r_[False, (D["c"] > sma(D["c"], 200))[:-1]]
    print(f"NEAR daily bars {NDAYS} ({years:.1f} y) {datetime.fromtimestamp(D['t'][0]/1000, timezone.utc):%Y-%m-%d} -> "
          f"{datetime.fromtimestamp(D['t'][-1]/1000, timezone.utc):%Y-%m-%d} · price {D['c'][0]:.2f} -> {D['c'][-1]:.2f}")
    print(f"costs: {COST_BPS:.0f} bps per trade + ${GAS} gas · funding points {len(FUND)} · bull days {above.mean():.0%}\n")
    for start in SIZES:
        curves, info, grid = run(start)
        bench = curves["Hold 50/50 (benchmark)"]
        print(f"=== ${start:,.0f} vault ===")
        print(f"{'strategy':<34}{'--- in-sample 2020-24 ---':>23}{'--- out-of-sample 2025-26 ---':>26}{'trades/y':>9}{'cost/y':>8}{'beat14d':>8}{'p(full)':>8}")
        print(f"{'':<34}{'CAGR':>8}{'Sharpe':>7}{'MaxDD':>8}{'CAGR':>9}{'Sharpe':>7}{'MaxDD':>8}")
        ex_ret = np.diff(np.log(bench))
        w14 = np.arange(0, NDAYS - 14, 1)
        b14 = bench[w14 + 14] / bench[w14]
        for name, eq in curves.items():
            tr, co = info[name]
            m_i, m_o = metrics(eq, ins), metrics(eq, oos)
            s14 = eq[w14 + 14] / eq[w14]
            beat = (s14 > b14 + 1e-12).mean()
            p = bootstrap_p(np.diff(np.log(eq)) - ex_ret) if "benchmark" not in name else float("nan")
            print(f"{name:<34}{fmt(m_i)} {fmt(m_o)}{tr/years:>9.0f}{co/years/start:>8.1%}{beat:>8.0%}{p:>8.2f}")
        # overfitting checks on the trend family
        R = np.column_stack([np.diff(np.log(curves[g])) for g in grid])
        r_ins = R[ins[1:]]
        sr_ins = r_ins.mean(0) / r_ins.std(0)
        best = grid[int(np.argmax(sr_ins))]
        eq_b = curves[best]
        print(f"\ntrend family: {len(grid)} configs · best in-sample: {best}")
        print(f"  out-of-sample: {fmt(metrics(eq_b, oos))} vs hold 50/50 {fmt(metrics(bench, oos))}")
        print(f"  Deflated Sharpe (in-sample, {len(grid)} trials): {deflated_sharpe(r_ins[:, grid.index(best)], sr_ins):.2f}"
              f"   PBO (CSCV, 16 blocks): {pbo(R):.0%}")
        bull, bear = above[1:], ~above[1:]
        rb = np.diff(np.log(eq_b)); rh = np.diff(np.log(bench))
        print(f"  regimes (annualised log return) bull: {rb[bull].mean()*365:+.0%} vs hold {rh[bull].mean()*365:+.0%}"
              f" · bear: {rb[bear].mean()*365:+.0%} vs hold {rh[bear].mean()*365:+.0%}\n")
