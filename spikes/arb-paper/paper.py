"""Paper-trade arbitrage: NEAR Intents (1Click) vs Rhea, plus cross-chain round trips inside Intents.

Every INTERVAL seconds, price each loop with dry quotes, subtract estimated gas, and take a paper trade
when the loop clears MIN_EDGE_BPS. Fills are assumed at the quoted price: optimistic, since real legs
settle seconds to minutes apart. Writes ticks.csv and prints a summary. No funds move.
"""
import csv, json, os, sys, time, urllib.error, urllib.request
from quote import quote

INTERVAL = int(os.environ.get("INTERVAL", 30))
DURATION = int(os.environ.get("DURATION", 1200))
MIN_EDGE_BPS = 5
NEAR_GAS_USD = 0.02   # one NEAR transaction, generous
ETH_GAS_USD = 0.50    # an Ethereum L1 deposit; Arbitrum and Base are near zero
USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
UA = {"User-Agent": "sledgit-paper/0.1"}


def get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20))


def rhea(token_in, token_out, amount_raw):
    d = get(f"https://smartrouter.ref.finance/findPath?amountIn={amount_raw}&tokenIn={token_in}&tokenOut={token_out}&pathDeep=3&slippage=0.005")
    return int(d["result_data"]["amount_out"])


def binance_mid():
    t = get("https://api.binance.com/api/v3/ticker/bookTicker?symbol=NEARUSDT")
    return (float(t["bidPrice"]) + float(t["askPrice"])) / 2


def loops(usd):
    """Yield (name, usd_in, usd_out, gas_usd) for each round trip starting with `usd` dollars."""
    # Buy wNEAR on Rhea, sell it on Intents
    near = rhea(USDC, "wrap.near", int(usd * 1e6)) / 1e24
    back, _ = quote("wNEAR@near", "USDC@near", near)
    yield f"rhea>intents ${usd}", usd, back, 2 * NEAR_GAS_USD
    # Buy wNEAR on Intents, sell it on Rhea
    near, _ = quote("USDC@near", "wNEAR@near", usd)
    back = rhea("wrap.near", USDC, int(near * 1e24)) / 1e6
    yield f"intents>rhea ${usd}", usd, back, 2 * NEAR_GAS_USD
    # USDC: NEAR -> Base -> NEAR
    mid, _ = quote("USDC@near", "USDC@base", usd)
    back, _ = quote("USDC@base", "USDC@near", mid)
    yield f"usdc near>base>near ${usd}", usd, back, 2 * NEAR_GAS_USD
    # ETH: Ethereum -> Arbitrum -> Ethereum, sized in ETH at the reference price
    eth = usd / 2368.0
    mid, _ = quote("ETH@eth", "ETH@arb", eth)
    back, _ = quote("ETH@arb", "ETH@eth", mid)
    yield f"eth eth>arb>eth ${usd}", usd, back / eth * usd, ETH_GAS_USD


def main():
    out = open("ticks.csv", "a", newline="")
    w = csv.writer(out)
    if out.tell() == 0:
        w.writerow(["t", "loop", "usd_in", "usd_out", "gross_bps", "gas_usd", "net_usd", "net_bps", "trade", "binance_mid"])
    stats, end = {}, time.time() + DURATION
    while time.time() < end:
        t0 = time.time()
        try:
            ref = binance_mid()
        except Exception as e:  # reference only; keep scanning
            print("binance:", e, file=sys.stderr); ref = ""
        for usd in (10, 100):
            try:
                for name, i, o, gas in loops(usd):
                    gross = (o - i) / i * 1e4
                    net = o - i - gas
                    net_bps = net / i * 1e4
                    trade = net_bps >= MIN_EDGE_BPS
                    w.writerow([int(t0), name, i, round(o, 6), round(gross, 2), gas, round(net, 6), round(net_bps, 2), int(trade), ref])
                    s = stats.setdefault(name, {"n": 0, "best": -1e9, "sum": 0.0, "trades": 0, "pnl": 0.0})
                    s["n"] += 1; s["best"] = max(s["best"], net_bps); s["sum"] += gross
                    if trade: s["trades"] += 1; s["pnl"] += net
            except (urllib.error.URLError, KeyError, ValueError) as e:
                print(f"tick {int(t0)} ${usd}: {e}", file=sys.stderr)
        out.flush()
        print(f"{time.strftime('%H:%M:%S')} tick done, NEAR ref {ref}", flush=True)
        time.sleep(max(0, INTERVAL - (time.time() - t0)))
    print(f"\n{'loop':<28}{'ticks':>6}{'avg gross bps':>15}{'best net bps':>14}{'trades':>8}{'paper pnl $':>13}")
    for k, s in stats.items():
        print(f"{k:<28}{s['n']:>6}{s['sum']/s['n']:>15.1f}{s['best']:>14.1f}{s['trades']:>8}{s['pnl']:>13.4f}")


if __name__ == "__main__":
    main()
