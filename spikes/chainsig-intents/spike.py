"""Spike: can a NEAR contract authorize a NEAR Intents swap through Chain Signatures?

Testnet transactions only; mainnet view calls only; no funds at risk.
 1. create a fresh testnet subaccount, deploy the signer contract, init it, then DELETE its only key
 2. the contract derives its own MPC address (refresh_signer_id); cross-check against the MPC view
 3. the agent asks for a compliant swap -> the contract checks policy, builds the intent, the MPC signs it
 4. the agent asks for two violating swaps -> refused, no MPC call
 5. recover the signer of the returned ERC-191 payload locally
 6. mainnet intents.near simulate_intents (view): the contract-signed intent, plus controls
 7. solver relay: probe quote; try publish (expected to be rejected: the signer holds no funds)
"""
import base64, json, os, sys, time, urllib.request, struct, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "chainsig-hyperliquid"))
import spike as cs  # noqa: E402  (testnet account, borsh tx, RPC helpers from the Hyperliquid spike)
import nacl.signing  # noqa: E402
from eth_account import Account  # noqa: E402
from eth_account.messages import encode_defunct  # noqa: E402
from eth_utils import keccak  # noqa: E402

MPC = "v1.signer-prod.testnet"
PATH = "iron-trade/intents-1"
WASM = os.path.join(HERE, "signer-contract", "target", "near", "intents_signer.wasm")
MAINNET_RPC = "https://rpc.mainnet.fastnear.com"
RELAY = "https://solver-relay-v2.chaindefuser.com/rpc"
WNEAR = "nep141:wrap.near"
USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
E24 = 10 ** 24


def tx(signer, sk, receiver, actions):
    """Signed transaction with arbitrary pre-encoded actions."""
    pub = bytes(sk.verify_key)
    for _ in range(30):  # a key added a moment ago becomes visible a block or two later
        try:
            ak = cs.rpc("query", {"request_type": "view_access_key", "finality": "optimistic", "account_id": signer,
                                  "public_key": "ed25519:" + cs.b58enc(pub)})
            if "nonce" in ak: break
        except RuntimeError:
            pass
        time.sleep(1)
    body = (cs.bstr(signer) + b"\x00" + pub + struct.pack("<Q", ak["nonce"] + 1) + cs.bstr(receiver)
            + cs.b58dec(ak["block_hash"]) + struct.pack("<I", len(actions)) + b"".join(actions))
    sig = sk.sign(hashlib.sha256(body).digest()).signature
    return cs.rpc("send_tx", {"signed_tx_base64": base64.b64encode(body + b"\x00" + sig).decode(),
                              "wait_until": "EXECUTED_OPTIMISTIC"})


def a_create(): return b"\x00"
def a_deploy(code): return b"\x01" + struct.pack("<I", len(code)) + code
def a_transfer(yocto): return b"\x03" + yocto.to_bytes(16, "little")
def a_addkey(pub): return b"\x05" + b"\x00" + pub + struct.pack("<Q", 0) + b"\x01"     # full access
def a_delkey(pub): return b"\x06" + b"\x00" + pub
def a_call(method, args, tgas, yocto=0):
    a = json.dumps(args).encode()
    return b"\x02" + cs.bstr(method) + struct.pack("<I", len(a)) + a + struct.pack("<Q", tgas * 10**12) + yocto.to_bytes(16, "little")


def outcome(res):
    st = res.get("status", {})
    val = None
    if "SuccessValue" in st:
        raw = base64.b64decode(st["SuccessValue"])
        val = json.loads(raw) if raw else None
    logs = [l for r in res.get("receipts_outcome", []) for l in r["outcome"]["logs"]]
    gas = sum(r["outcome"]["gas_burnt"] for r in res.get("receipts_outcome", [])) + res["transaction_outcome"]["outcome"]["gas_burnt"]
    executors = sorted({r["outcome"]["executor_id"] for r in res.get("receipts_outcome", [])})
    return st, val, logs, gas, executors


def mainnet_simulate(multi_payloads):
    args = base64.b64encode(json.dumps({"signed": multi_payloads}).encode()).decode()
    body = {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"request_type": "call_function", "finality": "final",
            "account_id": "intents.near", "method_name": "simulate_intents", "args_base64": args}}
    r = json.load(urllib.request.urlopen(urllib.request.Request(MAINNET_RPC, json.dumps(body).encode(),
                  {"Content-Type": "application/json", "User-Agent": "sledgit-spike/0.1"}), timeout=60))
    if "result" in r and "result" in r["result"]:
        return {"ok": json.loads(bytes(r["result"]["result"]))}
    err = r.get("result", {}).get("error") or json.dumps(r.get("error"))[:600]
    return {"error": err}


def relay(method, params):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": [params]}
    try:
        return json.load(urllib.request.urlopen(urllib.request.Request(RELAY, json.dumps(body).encode(),
                         {"Content-Type": "application/json", "User-Agent": "sledgit-spike/0.1"}), timeout=30))
    except Exception as e:  # noqa: BLE001  (record what the relay said, whatever it was)
        return {"exception": f"{type(e).__name__}: {getattr(e, 'read', lambda: b'')().decode()[:400] or e}"}


def recover(multi):
    raw = cs.b58dec(multi["signature"].split(":", 1)[1])
    r, s, v = raw[:32], raw[32:64], raw[64]
    sig = r + s + bytes([v + 27])
    return Account.recover_message(encode_defunct(text=multi["payload"]), signature=sig)


def main():
    checks, ev = {}, {}
    parent, psk = cs.account()
    print("1. testnet subaccount + deploy + lock")
    sub = f"signer-{int(time.time())}.{parent}"
    tsk = nacl.signing.SigningKey.generate()
    code = open(WASM, "rb").read()
    r = tx(parent, psk, sub, [a_create(), a_transfer(2 * E24), a_addkey(bytes(tsk.verify_key))])
    assert "SuccessValue" in r["status"], r["status"]
    pairs = [{"token_in": WNEAR, "token_out": USDC, "max_in": str(2 * E24), "min_out_num": "3500000", "min_out_den": str(E24)}]
    r = tx(sub, tsk, sub, [a_deploy(code), a_call("new", {"agent": parent, "mpc": MPC, "verifying_contract": "intents.near", "pairs": pairs}, 50)])
    assert "SuccessValue" in r["status"], r["status"]
    ev["deploy_tx"] = r["transaction"]["hash"]
    r = tx(sub, tsk, sub, [a_delkey(bytes(tsk.verify_key))])
    for _ in range(15):  # the deletion reaches "final" a block or two after the transaction executes
        keys = cs.rpc("query", {"request_type": "view_access_key_list", "finality": "final", "account_id": sub})["keys"]
        if not keys: break
        time.sleep(1)
    checks["vault account has no access keys after deploy (nobody can sign as it)"] = keys == []
    ev["contract"], ev["lock_tx"] = sub, r["transaction"]["hash"]
    print("  ", sub, "keys:", keys)

    print("2. contract derives its own MPC address")
    r = tx(parent, psk, sub, [a_call("refresh_signer_id", {}, 50)])
    st, val, logs, gas, _ = outcome(r)
    pk = cs.view(MPC, "derived_public_key", {"path": PATH, "predecessor": sub, "domain_id": 0})
    raw = cs.b58dec(pk.split(":")[1])
    expected = "0x" + keccak(raw[-64:])[-20:].hex()
    for _ in range(15):  # the callback's state reaches "final" a block or two later
        signer_id = cs.view(sub, "get_config", {})["signer_id"]
        if signer_id: break
        time.sleep(1)
    checks["on-chain derived signer_id equals the MPC view's address"] = signer_id == expected
    ev["signer_id"] = signer_id
    print("  ", signer_id)

    print("3. compliant swap: 1 wNEAR -> at least 4.00 USDC (policy floor 3.50)")
    t0 = time.time()
    r = tx(parent, psk, sub, [a_call("authorize_swap", {"token_in": WNEAR, "amount_in": str(E24), "token_out": USDC, "min_amount_out": "4000000"}, 300)])
    took = time.time() - t0
    st, multi, logs, gas, ex = outcome(r)
    ev["authorize_tx"], ev["authorize_seconds"], ev["authorize_gas_tgas"] = r["transaction"]["hash"], round(took, 1), round(gas / 1e12, 1)
    ok = isinstance(multi, dict) and multi.get("standard") == "erc191"
    checks["compliant request returns a signed erc191 MultiPayload"] = ok
    checks["the MPC signer was called for the compliant request"] = MPC in ex
    print(f"   {took:.1f}s, {gas/1e12:.0f} Tgas, executors {ex}")
    if not ok: sys.exit("no MultiPayload: " + json.dumps(st)[:800] + "\n" + "\n".join(logs))
    ev["multi_payload"] = multi

    print("4. violating requests")
    for name, args in [("price below floor", {"token_in": WNEAR, "amount_in": str(E24), "token_out": USDC, "min_amount_out": "1000000"}),
                       ("amount above cap", {"token_in": WNEAR, "amount_in": str(3 * E24), "token_out": USDC, "min_amount_out": "20000000"}),
                       ("pair not allowed", {"token_in": USDC, "amount_in": "1000000", "token_out": WNEAR, "min_amount_out": "1"})]:
        r = tx(parent, psk, sub, [a_call("authorize_swap", args, 300)])
        st, val, logs, gas, ex = outcome(r)
        checks[f"refused without an MPC call: {name}"] = isinstance(val, dict) and "refused" in val and MPC not in ex
        ev[f"refuse_{name}"] = {"tx": r["transaction"]["hash"], "value": val}
        print("  ", name, "->", val)

    print("5. local signature recovery")
    rec = recover(multi).lower()
    checks["ERC-191 signature recovers to the contract's signer_id"] = rec == signer_id
    payload = json.loads(multi["payload"])
    checks["payload is bound to intents.near and a token_diff the policy allowed"] = (
        payload["verifying_contract"] == "intents.near" and payload["intents"][0]["diff"] == {WNEAR: f"-{E24}", USDC: "4000000"})
    print("   recovered", rec)

    print("6. mainnet intents.near simulate_intents (view)")
    sims = {}
    sims["contract-signed intent"] = mainnet_simulate([multi])
    tampered = dict(multi, payload=multi["payload"].replace('"4000000"', '"4000001"'))
    sims["control: payload tampered (min_out +1)"] = mainnet_simulate([tampered])
    imp = Account.create()
    forged_payload = multi["payload"]
    fs = Account.sign_message(encode_defunct(text=forged_payload), imp.key)
    forged = {"standard": "erc191", "payload": forged_payload,
              "signature": "secp256k1:" + cs.b58enc(fs.r.to_bytes(32, "big") + fs.s.to_bytes(32, "big") + bytes([fs.v - 27]))}
    sims["control: another key signs as the contract's signer_id"] = mainnet_simulate([forged])
    own = forged_payload.replace(signer_id, imp.address.lower())
    os_ = Account.sign_message(encode_defunct(text=own), imp.key)
    sims["control: a local key signing as itself (same stage as the contract's)"] = mainnet_simulate([{"standard": "erc191", "payload": own,
        "signature": "secp256k1:" + cs.b58enc(os_.r.to_bytes(32, "big") + os_.s.to_bytes(32, "big") + bytes([os_.v - 27]))}])
    for k, v in sims.items(): print(f"   {k}: {json.dumps(v)[:300]}")
    ev["simulate_intents"] = sims
    txt = {k: json.dumps(v) for k, v in sims.items()}
    def stage(k):
        t = txt[k].lower()
        return "sig" if "invalid signature" in t else "key" if "doesn't exist for account" in t else "balance" if "insufficient balance" in t else "other"
    checks["intents.near accepts the contract's signature: it passes signature and key checks, stops only at balance"] = stage("contract-signed intent") == "balance"
    checks["control: a normal key signing as itself stops at the same stage"] = stage("control: a local key signing as itself (same stage as the contract's)") == "balance"
    checks["control: tampered payload is rejected at the key check"] = stage("control: payload tampered (min_out +1)") == "key"
    checks["control: another key cannot sign as the contract"] = stage("control: another key signs as the contract's signer_id") == "key"

    print("7. solver relay")
    q = relay("quote", {"defuse_asset_identifier_in": WNEAR, "defuse_asset_identifier_out": USDC, "exact_amount_in": str(E24), "min_deadline_ms": 60000})
    ev["relay_quote"] = q
    quotes = (q.get("result") or []) if isinstance(q, dict) else []
    print("   quote:", json.dumps(q)[:300])
    if quotes:
        qh = quotes[0].get("quote_hash")
        p = relay("publish_intent", {"quote_hashes": [qh], "signed_data": multi})
        ev["relay_publish"] = p
        print("   publish:", json.dumps(p)[:300])
        reason = json.dumps(p).lower()
        checks["solver relay takes the contract-signed intent and rejects it only for balance"] = "insufficient balance" in reason and "signature" not in reason
    checks["solver relay returns quotes for wNEAR -> USDC"] = bool(quotes)

    for k, ok in checks.items(): print(f"   {'PASS' if ok else 'FAIL'}  {k}")
    json.dump({"checks": checks, "evidence": ev}, open(os.path.join(HERE, "result.json"), "w"), indent=2)
    sys.exit(0 if all(checks.values()) else 1)


if __name__ == "__main__":
    main()
