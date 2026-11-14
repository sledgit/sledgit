"""Dry quotes from NEAR Intents 1Click. No funds move; dry=true only prices the swap."""
import datetime, json, urllib.request

URL = "https://1click.chaindefuser.com/v0/quote"
EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"  # any valid address; dry quotes send nothing
ASSETS = {  # name: (assetId, decimals, address used for recipient/refund)
    "USDC@near": ("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", 6, "near"),
    "wNEAR@near": ("nep141:wrap.near", 24, "near"),
    "USDC@base": ("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", 6, EVM),
    "USDC@arb": ("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", 6, EVM),
    "ETH@eth": ("nep141:eth.omft.near", 18, EVM),
    "ETH@arb": ("nep141:arb.omft.near", 18, EVM),
    "ETH@base": ("nep141:base.omft.near", 18, EVM),
}


def quote(src, dst, amount):
    """Return (amount_out, seconds_estimate) for swapping `amount` of src into dst."""
    sa, sd, saddr = ASSETS[src]
    da, dd, daddr = ASSETS[dst]
    body = {
        "dry": True, "swapType": "EXACT_INPUT", "slippageTolerance": 50,
        "originAsset": sa, "depositType": "ORIGIN_CHAIN", "destinationAsset": da,
        "amount": str(int(round(amount * 10**sd))),
        "refundTo": saddr, "refundType": "ORIGIN_CHAIN", "recipient": daddr, "recipientType": "DESTINATION_CHAIN",
        "deadline": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    }
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "sledgit-paper/0.1"})
    q = json.load(urllib.request.urlopen(req, timeout=30))["quote"]
    return int(q["amountOut"]) / 10**dd, q.get("timeEstimate")
