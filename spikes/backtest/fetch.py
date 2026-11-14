"""Fetch real history: Binance NEARUSDT 5m candles and Hyperliquid NEAR hourly funding. Writes JSON files."""
import json, sys, time, urllib.request

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 180
UA = {"User-Agent": "sledgit-backtest/0.1", "Content-Type": "application/json"}
now = int(time.time() * 1000)
start = now - DAYS * 86400 * 1000


def get(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers=UA)
    return json.load(urllib.request.urlopen(req, timeout=30))


candles, t = [], start
while t < now:
    batch = get(f"https://api.binance.com/api/v3/klines?symbol=NEARUSDT&interval=5m&startTime={t}&limit=1000")
    if not batch: break
    candles += [[b[0], float(b[1]), float(b[2]), float(b[3]), float(b[4])] for b in batch]
    t = batch[-1][0] + 1
json.dump(candles, open("candles.json", "w"))
print(f"{len(candles)} candles, {candles[0][4]} -> {candles[-1][4]}")

funding, t = [], start
while t < now:
    batch = get("https://api.hyperliquid.xyz/info", {"type": "fundingHistory", "coin": "NEAR", "startTime": t})
    if not batch: break
    funding += [[f["time"], float(f["fundingRate"])] for f in batch]
    if batch[-1]["time"] + 1 <= t: break
    t = batch[-1]["time"] + 1
    if len(batch) < 2: break
json.dump(funding, open("funding.json", "w"))
print(f"{len(funding)} funding points, mean hourly {sum(f[1] for f in funding)/max(1,len(funding)):.6%}")
