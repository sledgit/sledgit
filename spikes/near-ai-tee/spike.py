"""Spike: one TEE-attested trade decision from NEAR AI Cloud.

1. Find a model that NEAR AI Cloud serves inside a TEE (its attestation report has a TDX quote).
2. Ask it for a trade decision (JSON).
3. Fetch the response signature; check it covers sha256(request) and sha256(response) and recovers
   to the enclave's signing address.
4. Build the receipt core and set nonce = sha256(core).
5. Fetch an attestation report for that signer with that nonce, and verify it with NEAR's verifier:
   Intel TDX quote, report_data binds signer + nonce, NVIDIA GPU evidence.
6. Write receipt.json.

Needs: API_KEY (cloud.near.ai), VERIFIER_DIR (a clone of nearai/nearai-cloud-verifier).
"""
import asyncio
import hashlib
import json
import os
import secrets
import sys
import time

import requests
from eth_account import Account
from eth_account.messages import encode_defunct

sys.path.insert(0, os.path.join(os.environ["VERIFIER_DIR"], "py"))
import model_verifier as mv  # noqa: E402  (NEAR's verifier, MIT)

BASE = os.environ.get("BASE_URL", "https://cloud-api.near.ai")
KEY = os.environ["API_KEY"]
CANDIDATES = os.environ.get("MODELS", "Qwen/Qwen3.6-35B-A3B-FP8,z-ai/glm-5.3-flash,deepseek/deepseek-v3.2,qwen/qwen3.5-397b-a17b").split(",")
AUTH = {"Authorization": f"Bearer {KEY}"}
sha = lambda s: hashlib.sha256(s.encode()).hexdigest()


def find_tee_model():
    for m in CANDIDATES:
        r = requests.get(f"{BASE}/v1/attestation/report", params={"model": m, "nonce": secrets.token_hex(32), "signing_algo": "ecdsa"}, headers=AUTH, timeout=30)
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        atts = body.get("model_attestations") or ([body] if body.get("intel_quote") else [])
        print(f"  {m}: HTTP {r.status_code}, {len(atts)} model attestation(s)")
        if atts and atts[0].get("intel_quote"):
            return m
    sys.exit("No candidate model returned a TDX attestation. Set MODELS=... to try others.")


def decide(model):
    market = {"pair": "wNEAR/USDC", "price": 4.7311, "sma20": 4.6980, "change_1h_pct": 0.8, "cash_usdc": 5.0, "max_trade_usdc": 1.0}
    body = json.dumps({
        "model": model, "stream": False, "temperature": 0, "max_tokens": 1000,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [
            {"role": "system", "content": "You are a cautious trading bot. Reply with JSON only: {\"action\":\"buy|sell|hold\",\"size_usdc\":number,\"reason\":string}. Never exceed max_trade_usdc."},
            {"role": "user", "content": json.dumps(market)},
        ],
    })
    r = requests.post(f"{BASE}/v1/chat/completions", data=body, headers={**AUTH, "Content-Type": "application/json"}, timeout=120)
    r.raise_for_status()
    return body, r.text, r.json()


async def main():
    print("1. Finding a TEE-served model")
    model = find_tee_model()
    print(f"   using {model}\n2. Asking for a decision")
    req_body, resp_text, resp = decide(model)
    choice = resp["choices"][0]
    decision = choice["message"].get("content")
    if not decision:
        sys.exit(f"Empty content (finish_reason={choice.get('finish_reason')}); raise max_tokens or pick a non-reasoning model")
    print("   decision:", decision.strip()[:200])

    print("3. Checking the response signature")
    sig = requests.get(f"{BASE}/v1/signature/{resp['id']}", params={"model": model, "signing_algo": "ecdsa"}, headers=AUTH, timeout=30).json()
    signed_model, req_hash, resp_hash = sig["text"].rsplit(":", 2)
    signer = sig["signing_address"]
    checks = {
        "signature names the model": signed_model == model,
        "signature covers sha256(request)": req_hash == sha(req_body),
        "signature covers sha256(response)": resp_hash == sha(resp_text),
        "signature recovers to enclave signer": Account.recover_message(encode_defunct(text=sig["text"]), signature=sig["signature"]).lower() == signer.lower(),
    }

    core = {"model": model, "chat_id": resp["id"], "request_sha256": sha(req_body), "response_sha256": sha(resp_text),
            "signed_text": sig["text"], "signature": sig["signature"], "signer": signer, "decision": decision, "at": int(time.time())}
    nonce = sha(json.dumps(core, sort_keys=True))
    print(f"4. Receipt nonce = sha256(receipt core) = {nonce}")

    print("5. Fetching and verifying the attestation for this signer and nonce")
    report = mv.fetch_report(model, nonce, signing_algo="ecdsa", signing_address=signer)
    atts = report.get("model_attestations") or [report]
    att = next((a for a in atts if a.get("signing_address", "").lower() == signer.lower()), None)
    if att is None:
        sys.exit(f"No attestation for signer {signer}: {json.dumps(report)[:300]}")
    intel = await mv.check_tdx_quote(att)
    rd = mv.check_report_data(att, nonce, intel)
    gpu = mv.check_gpu(att, nonce)
    checks.update({
        "Intel TDX quote verifies": intel is not None,
        "TDX report_data binds the signer": bool(rd and rd["binds_address"]),
        "TDX report_data embeds our nonce": bool(rd and rd["embeds_nonce"]),
        "GPU evidence uses our nonce": bool(gpu["nonce_matches"]),
        "NVIDIA verdict": bool(gpu["verdict"]),
    })

    receipt = {"core": core, "nonce": nonce, "attestation": att, "checks": checks}
    with open("receipt.json", "w") as f:
        json.dump(receipt, f, indent=2)
    print("\n6. Results")
    for k, v in checks.items():
        print(f"   {'PASS' if v else 'FAIL'}  {k}")
    print(f"\n{sum(checks.values())}/{len(checks)} checks pass · receipt.json written")
    sys.exit(0 if all(checks.values()) else 1)


if __name__ == "__main__":
    asyncio.run(main())
