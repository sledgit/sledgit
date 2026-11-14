"""Kronos forecast for demo-trader: hourly candles on stdin (JSON), a forecast summary on stdout (JSON).

Run in its own venv with -I, Kronos source and weights passed as paths:
  python -I forecast.py --kronos-src DIR --model DIR --tokenizer DIR < request.json

Request: {"candles": [[open_ms, open, high, low, close, volume], ...], "pred_len": 24, "paths": 8, "seed": 0, "T": 1.0, "top_p": 0.9}
Reply:   {"last_close", "median_close", "change_pct", "up_share", "paths", "pred_len"}
Nothing here trades or touches the network (HF_HUB_OFFLINE=1). A forecast is a signal to test, not a prediction
anyone should rely on.
"""
import argparse
import contextlib
import json
import os
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kronos-src", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--tokenizer", required=True)
    a = ap.parse_args()
    req = json.load(sys.stdin)
    candles = req["candles"]
    pred_len, paths, seed = int(req.get("pred_len", 24)), int(req.get("paths", 8)), int(req.get("seed", 0))
    temp, top_p = float(req.get("T", 1.0)), float(req.get("top_p", 0.9))
    if not (64 <= len(candles) <= 512 and 1 <= pred_len <= 96 and 1 <= paths <= 32):
        raise SystemExit("bad request: 64..512 candles, pred_len 1..96, paths 1..32")

    sys.path.insert(0, a.kronos_src)
    import numpy as np
    import pandas as pd
    import torch
    from model import Kronos, KronosTokenizer, KronosPredictor

    torch.manual_seed(seed)
    np.random.seed(seed)
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    with contextlib.redirect_stdout(sys.stderr):  # the loaders print progress; stdout carries only the reply
        tok = KronosTokenizer.from_pretrained(a.tokenizer)
        mdl = Kronos.from_pretrained(a.model)
        pred = KronosPredictor(mdl, tok, device="cpu", max_context=512)

    df = pd.DataFrame([[float(c[i]) for i in range(1, 6)] for c in candles], columns=["open", "high", "low", "close", "volume"])
    df["amount"] = df["close"] * df["volume"]
    ts = pd.Series(pd.to_datetime([int(c[0]) for c in candles], unit="ms"))
    step = ts.iloc[-1] - ts.iloc[-2]
    future = pd.Series([ts.iloc[-1] + step * (i + 1) for i in range(pred_len)])
    # One independent sample path per copy, so the spread across paths is visible (sample_count averages them away).
    with contextlib.redirect_stdout(sys.stderr):
        outs = pred.predict_batch([df] * paths, [ts] * paths, [future] * paths, pred_len=pred_len,
                                  T=temp, top_p=top_p, sample_count=1, verbose=False)
    last = float(df["close"].iloc[-1])
    ends = sorted(float(o["close"].iloc[-1]) for o in outs)
    med = ends[len(ends) // 2] if len(ends) % 2 else (ends[len(ends) // 2 - 1] + ends[len(ends) // 2]) / 2
    json.dump({"last_close": last, "median_close": round(med, 6), "change_pct": round((med / last - 1) * 100, 4),
               "up_share": round(sum(e > last for e in ends) / len(ends), 4), "paths": paths, "pred_len": pred_len}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
