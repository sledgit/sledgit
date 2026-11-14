"""Independent ERC-191 test vector for the signer contract's payload builder (eth_account, not our code)."""
import base64, json, datetime
from eth_account.messages import encode_defunct, _hash_eip191_message

payload = json.dumps({
    "signer_id": "0x0000000000000000000000000000000000000001",
    "verifying_contract": "intents.near",
    "deadline": "2026-10-28T13:29:05Z",
    "nonce": base64.b64encode(bytes([7] * 32)).decode(),
    "intents": [{"intent": "token_diff", "diff": {"nep141:wrap.near": "-1000", "nep141:usdc.near": "4"}}],
}, separators=(",", ":"))  # insertion order, as near-sdk serde_json (preserve_order) emits
h = _hash_eip191_message(encode_defunct(text=payload)).hex()
open("vector_payload.txt", "w").write(payload + "\n")
open("vector_hash.txt", "w").write(h.removeprefix("0x") + "\n")
print(payload); print(h)
print(datetime.datetime.fromtimestamp(1_793_198_645, datetime.UTC).isoformat())
