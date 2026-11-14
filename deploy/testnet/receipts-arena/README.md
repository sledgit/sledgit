# Testnet arena evidence

Receipts and TEE evidence from the arena vaults of the locked factory `arena.irontrade.testnet` (testnet only).

| Vault | Agent | Model | Tier |
|---|---|---|---|
| `qwen36-tee.arena.irontrade.testnet` | `agent2-qwen36-tee.it1793205219-owner.testnet` | `Qwen/Qwen3.6-35B-A3B-FP8` via NEAR AI Cloud | Attested model (TEE) |
| `llama32-local.arena.irontrade.testnet` | `agent2-llama32-local.it1793205219-owner.testnet` | `llama3.2:3b` (local) | Self-reported |

Check them yourself (from `agent/`, no keys needed):

```sh
node bin/sledgit.mjs verify ../deploy/testnet/receipts-arena/qwen36-tee/receipts.jsonl                    # 2 of 2 on chain
node bin/sledgit.mjs verify-attestation ../deploy/testnet/receipts-arena/qwen36-tee/receipts.jsonl --from-seq 2  # tee_pill: true
node bin/sledgit.mjs verify-attestation ../deploy/testnet/receipts-arena/qwen36-tee/receipts.jsonl              # tee_pill: false (seq 1 is pre-binding)
node bin/sledgit.mjs verify ../deploy/testnet/receipts-arena/llama32-local/receipts.jsonl
node bin/sledgit.mjs verify-attestation ../deploy/testnet/receipts-arena/llama32-local/receipts.jsonl     # tee_pill: false
```

`verify-attestation` on a receipts file checks the season against the chain: the vault must be a genuine Sledgit
vault, every decision it recorded from `--from-seq` on must have a receipt here, each attested against its own on-chain
event and block time, and no evidence may back two receipts.

| Seq | Tx | Decision | Attestation under policy v2 |
|---|---|---|---|
| 1 | `H1JLa3EJMgSygtVanU82iks6kLBegvoVKcDeUzorxvxP` | sell 0.125 wNEAR (Rhea) | Pre-binding format (bundle v1): every evidence check passes, but the vault, salt and a chain anchor weren't inside the signed request, so no badge |
| 2 | `8RhTCrzynmsx9mMhrJVGe2wkD9pkU6ZBPGx1TXQfUqZC` | hold (skip) | Attested: 54 of 54 checks, bundle `d9220ec1…`; anchor block testnet #275262213, reply 8 s after it, decision on chain 21 s after the reply |

`qwen36-tee/unsent.jsonl` holds two attested decisions that were made but never sent: the first agent key had a
0.25 NEAR allowance, which near-api-js's gas pre-check rejects for a 300 Tgas call. The vault was re-keyed to a new
agent account (owner `set_agent`) and the third decision went on chain. Their TEE bundles are in `attestations/`.
