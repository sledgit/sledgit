"""Build a clean NEARUSDT 5m series from Binance's archive and audit it.

- normalise timestamps (the archive switched from ms to µs in 2025), dedupe, sort
- drop the first 14 days after listing (price discovery, not a market a bot could trade)
- audit gaps against a full 5m index and flag suspicious wicks (range > 25% of close on low volume)
- cross-check daily closes against Coinbase NEAR-USD
Writes clean.json: [[t_ms, open, high, low, close, volume, gap_before]] and prints the audit.
"""
import glob, io, json, statistics, urllib.request, zipfile

rows = {}
for f in sorted(glob.glob("data/NEARUSDT-5m-*.zip")):
    with zipfile.ZipFile(f) as z:
        for line in io.TextIOWrapper(z.open(z.namelist()[0])):
            c = line.split(",")
            if not c[0].isdigit(): continue
            t = int(c[0]); t = t // 1000 if t > 10**14 else t
            rows[t] = [t, float(c[1]), float(c[2]), float(c[3]), float(c[4]), float(c[5])]
bars = [rows[t] for t in sorted(rows)]
bars = [b for b in bars if b[0] >= bars[0][0] + 14 * 86400_000]

STEP = 300_000
gaps, missing, out = [], 0, []
for i, b in enumerate(bars):
    gap = 0 if i == 0 else (b[0] - bars[i - 1][0]) // STEP - 1
    if gap > 0: missing += gap; gaps.append((bars[i - 1][0], gap))
    out.append(b + [gap])
vol_med = statistics.median(b[5] for b in bars)
wicks = [b for b in bars if (b[2] - b[3]) / b[4] > 0.25 and b[5] < vol_med]

print(f"bars {len(bars):,} from {bars[0][0]} to {bars[-1][0]} · missing {missing:,} bars ({missing/(len(bars)+missing):.3%}) in {len(gaps)} gaps")
for t, g in sorted(gaps, key=lambda x: -x[1])[:5]:
    print(f"  gap of {g*5/60:.1f} h after {t}")
print(f"suspicious low-volume wicks (>25% range): {len(wicks)}")

# Coinbase cross-check on daily closes (UTC days)
day_close = {}
for b in bars: day_close[b[0] // 86400_000] = b[4]
diffs, start = [], bars[0][0] // 1000
UA = {"User-Agent": "sledgit-backtest/0.1"}
while start < bars[-1][0] // 1000:
    end = min(start + 290 * 86400, bars[-1][0] // 1000)
    u = f"https://api.exchange.coinbase.com/products/NEAR-USD/candles?granularity=86400&start={start}&end={end}"
    try:
        for t, lo, hi, op, cl, v in json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30)):
            d = t // 86400
            if d - 1 in day_close: diffs.append(abs(cl / day_close[d] - 1) if d in day_close else 0)
    except Exception as e:
        print("coinbase:", e); break
    start = end
if diffs:
    diffs.sort()
    print(f"Coinbase vs Binance daily close: {len(diffs)} days, median diff {diffs[len(diffs)//2]:.3%}, 99th pct {diffs[int(len(diffs)*.99)]:.3%}, max {diffs[-1]:.2%}")
json.dump(out, open("clean.json", "w"))
