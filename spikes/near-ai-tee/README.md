# Spike: TEE-attested trade decision (NEAR AI Cloud)

Proves one trade decision came from a named model running inside an Intel TDX enclave, bound to this exact
request and response by a nonce we choose.

## Run

Needs a NEAR AI Cloud API key with a little credit (cloud.near.ai). One decision costs well under a cent.

```
git clone --depth 1 https://github.com/nearai/nearai-cloud-verifier.git verifier
python3 -m venv venv
venv/bin/pip install -r verifier/requirements.txt
set -a; . ~/.config/sledgit/near-ai.env; set +a   # API_KEY=sk-..., chmod 600, never commit
VERIFIER_DIR=$PWD/verifier venv/bin/python spike.py
```

`MODELS=a,b,c` overrides the candidate models. Only models NEAR AI Cloud serves inside a TEE return a TDX
quote; the script tries each and uses the first that does.

## What passes means

| Check | Proves |
|---|---|
| signature names the model | The signed text is `model:sha256(request):sha256(response)` |
| signature covers sha256(request/response) | The enclave signed exactly this prompt and this answer |
| signature recovers to enclave signer | The signing key is the one in the attestation |
| Intel TDX quote verifies | Genuine Intel TDX hardware, via Intel's certificate chain |
| report_data binds the signer | That signing key lives inside this enclave |
| report_data embeds our nonce | The quote was made for this receipt, not replayed |
| GPU evidence / NVIDIA verdict | The model ran on an attested confidential GPU |

What it does not prove: that the decision is good, or that the bot acted on it. The vault contract and the
on-chain trade cover the second part.

## Result (2026-10-28)

9/9 checks pass with `Qwen/Qwen3.6-35B-A3B-FP8`. Qwen3 needs `enable_thinking: false`, or it spends
the whole token budget reasoning and returns empty content.
