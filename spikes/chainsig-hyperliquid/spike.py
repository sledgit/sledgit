"""Spike: can a NEAR account sign Hyperliquid orders through Chain Signatures?

Testnet only, no funds at risk:
1. create (or reuse) a NEAR testnet account from the faucet; its key is stored in KEY_FILE
2. ask v1.signer-prod.testnet for the secp256k1 key derived for (account, PATH) and turn it into an EVM address
3. build a Hyperliquid testnet order and its EIP-712 digest (same scheme as the official Python SDK)
4. have Chain Signatures sign the digest (a NEAR function call), timing it
5. recover the signer locally, then POST the order to Hyperliquid testnet: its reply names the address it recovered

PASS if the locally recovered address and Hyperliquid's recovered address both equal the derived address.
"""
import base64, hashlib, json, os, struct, sys, time, urllib.error, urllib.request

import nacl.signing
from eth_account.messages import encode_typed_data
from eth_keys import keys
from eth_utils import keccak, to_checksum_address

RPC = "https://rpc.testnet.fastnear.com"
SIGNER = "v1.signer-prod.testnet"
PATH = "iron-trade/hyperliquid-1"
HL = "https://api.hyperliquid-testnet.xyz"
KEY_FILE = os.environ.get("KEY_FILE", os.path.expanduser("~/.config/sledgit/testnet-chainsig.json"))
UA = {"Content-Type": "application/json", "User-Agent": "sledgit-spike/0.1"}
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58enc(b):
    n = int.from_bytes(b, "big"); out = ""
    while n: n, r = divmod(n, 58); out = B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out


def b58dec(s):
    n = 0
    for ch in s: n = n * 58 + B58.index(ch)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + body


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=UA)
    try:
        return json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:500]}


def rpc(method, params):
    r = post(RPC, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "error" in r: raise RuntimeError(json.dumps(r["error"])[:600])
    return r["result"]


def view(account, method, args):
    r = rpc("query", {"request_type": "call_function", "finality": "final", "account_id": account,
                      "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode()})
    return json.loads(bytes(r["result"]))


# ---------- 1. testnet account ----------
def account():
    if os.path.exists(KEY_FILE):
        k = json.load(open(KEY_FILE)); return k["account_id"], nacl.signing.SigningKey(base64.b64decode(k["seed"]))
    sk = nacl.signing.SigningKey.generate()
    acct = f"irontrade-{int(time.time())}.testnet"
    pub = "ed25519:" + b58enc(bytes(sk.verify_key))
    r = post("https://helper.testnet.near.org/account", {"newAccountId": acct, "newAccountPublicKey": pub})
    print("  faucet:", str(r)[:200])
    os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)
    with open(KEY_FILE, "w") as f: json.dump({"account_id": acct, "seed": base64.b64encode(bytes(sk)).decode(), "network": "testnet"}, f)
    os.chmod(KEY_FILE, 0o600)
    for _ in range(20):
        try: rpc("query", {"request_type": "view_account", "finality": "final", "account_id": acct}); break
        except RuntimeError: time.sleep(2)
    return acct, sk


# ---------- NEAR transaction (borsh) ----------
def bstr(s): b = s.encode(); return struct.pack("<I", len(b)) + b


def function_call_tx(acct, sk, receiver, method, args, gas, deposit):
    pub = bytes(sk.verify_key)
    ak = rpc("query", {"request_type": "view_access_key", "finality": "final", "account_id": acct,
                       "public_key": "ed25519:" + b58enc(pub)})
    nonce, block_hash = ak["nonce"] + 1, b58dec(ak["block_hash"])
    a = json.dumps(args).encode()
    action = b"\x02" + bstr(method) + struct.pack("<I", len(a)) + a + struct.pack("<Q", gas) + deposit.to_bytes(16, "little")
    tx = (bstr(acct) + b"\x00" + pub + struct.pack("<Q", nonce) + bstr(receiver) + block_hash
          + struct.pack("<I", 1) + action)
    sig = sk.sign(hashlib.sha256(tx).digest()).signature
    return base64.b64encode(tx + b"\x00" + sig).decode()


# ---------- 3. Hyperliquid order + EIP-712 digest ----------
def msgpack(o):
    if o is None: return b"\xc0"
    if o is True: return b"\xc3"
    if o is False: return b"\xc2"
    if isinstance(o, int):
        if 0 <= o < 128: return bytes([o])
        if 0 <= o < 2**8: return b"\xcc" + bytes([o])
        if 0 <= o < 2**16: return b"\xcd" + struct.pack(">H", o)
        if 0 <= o < 2**32: return b"\xce" + struct.pack(">I", o)
        return b"\xcf" + struct.pack(">Q", o)
    if isinstance(o, str):
        b = o.encode()
        if len(b) < 32: return bytes([0xa0 | len(b)]) + b
        return b"\xd9" + bytes([len(b)]) + b
    if isinstance(o, list):
        assert len(o) < 16; return bytes([0x90 | len(o)]) + b"".join(msgpack(x) for x in o)
    if isinstance(o, dict):
        assert len(o) < 16; return bytes([0x80 | len(o)]) + b"".join(msgpack(k) + msgpack(v) for k, v in o.items())
    raise TypeError(type(o))


def order_digest(action, nonce):
    connection_id = keccak(msgpack(action) + nonce.to_bytes(8, "big") + b"\x00")
    typed = {"domain": {"chainId": 1337, "name": "Exchange", "verifyingContract": "0x" + "00" * 20, "version": "1"},
             "types": {"EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                                        {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
                       "Agent": [{"name": "source", "type": "string"}, {"name": "connectionId", "type": "bytes32"}]},
             "primaryType": "Agent", "message": {"source": "b", "connectionId": connection_id}}  # "b" = testnet
    m = encode_typed_data(full_message=typed)
    return keccak(b"\x19" + m.version + m.header + m.body)


def main():
    checks = {}
    print("1. NEAR testnet account")
    acct, sk = account()
    print("  ", acct)

    print("2. Derived secp256k1 key for", PATH)
    pk = view(SIGNER, "derived_public_key", {"path": PATH, "predecessor": acct, "domain_id": 0})
    raw = b58dec(pk.split(":")[1])
    derived = to_checksum_address(keccak(raw[-64:])[-20:])
    print("   derived EVM address:", derived)

    print("3. Hyperliquid testnet order")
    meta = post(HL + "/info", {"type": "meta"})
    asset = next(i for i, u in enumerate(meta["universe"]) if u["name"] == "ETH")
    mid = float(post(HL + "/info", {"type": "allMids"})["ETH"])
    px = str(round(mid * 0.5))                      # far below market: a resting bid that would never fill
    action = {"type": "order", "orders": [{"a": asset, "b": True, "p": px, "s": "0.01", "r": False,
                                           "t": {"limit": {"tif": "Gtc"}}}], "grouping": "na"}
    nonce = int(time.time() * 1000)
    digest = order_digest(action, nonce)
    print(f"   buy 0.01 ETH @ {px} (mid {mid:.1f}), digest {digest.hex()}")

    # Control: a throwaway local key signs the same kind of order, proving the digest scheme before involving NEAR.
    from eth_account import Account
    ctrl = Account.create(); cn = nonce - 1
    cs = Account.unsafe_sign_hash(order_digest(action, cn), ctrl.key)
    hc = post(HL + "/exchange", {"action": action, "nonce": cn,
                                 "signature": {"r": hex(cs.r), "s": hex(cs.s), "v": cs.v}, "vaultAddress": None})
    print("   control reply:", json.dumps(hc)[:200])
    checks["control: Hyperliquid recovers a local key's address (digest scheme correct)"] = ctrl.address.lower() in json.dumps(hc).lower()

    print("4. Chain Signatures sign (NEAR testnet function call)")
    args = {"request": {"payload_v2": {"Ecdsa": digest.hex()}, "path": PATH, "domain_id": 0}}
    t0 = time.time()
    res = rpc("send_tx", {"signed_tx_base64": function_call_tx(acct, sk, SIGNER, "sign", args, 300 * 10**12, 1),
                          "wait_until": "EXECUTED_OPTIMISTIC"})
    took = time.time() - t0
    status = res.get("status", {})
    if "SuccessValue" not in status:
        sys.exit("sign failed: " + json.dumps(status)[:800])
    out = json.loads(base64.b64decode(status["SuccessValue"]))
    r = int(out["big_r"]["affine_point"][2:], 16); s = int(out["s"]["scalar"], 16); v = out["recovery_id"]
    print(f"   signed in {took:.1f} s · tx {res['transaction']['hash']}")

    print("5. Verify")
    local = keys.Signature(vrs=(v, r, s)).recover_public_key_from_msg_hash(digest).to_checksum_address()
    checks["signature recovers locally to the derived address"] = local == derived
    hl = post(HL + "/exchange", {"action": action, "nonce": nonce,
                                 "signature": {"r": hex(r), "s": hex(s), "v": 27 + v}, "vaultAddress": None})
    print("   Hyperliquid replied:", json.dumps(hl)[:300])
    text = json.dumps(hl).lower()
    checks["Hyperliquid recovered the derived address"] = derived.lower() in text
    checks["signing latency under 30 s"] = took < 30
    for k, ok in checks.items(): print(f"   {'PASS' if ok else 'FAIL'}  {k}")
    json.dump({"account": acct, "path": PATH, "derived": derived, "digest": digest.hex(), "signature": out,
               "sign_seconds": took, "near_tx": res["transaction"]["hash"], "hyperliquid": hl, "checks": checks},
              open("result.json", "w"), indent=2)
    sys.exit(0 if all(checks.values()) else 1)


if __name__ == "__main__":
    main()
