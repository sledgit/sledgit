# Spike: a NEAR contract authorizes NEAR Intents swaps through Chain Signatures

**Question:** can a contract, rather than a person's key, authorize a NEAR Intents swap, by having the Chain Signatures
MPC network sign the intent only after the contract's own rule check, in a form `intents.near` accepts?

**Answer:** yes, in simulation on real mainnet `intents.near` and on the live solver relay. 15/15 checks pass.
Settlement with real funds is not tested yet (see "Not proven").

## How it works

`signer-contract/` (Rust, near-sdk 5.29), deployed on NEAR testnet:

1. `refresh_signer_id()` asks the MPC contract (`v1.signer-prod.testnet`) for the secp256k1 key derived for
   (this contract, path `iron-trade/intents-1`). It stores the key's Ethereum-style address, e.g. `0xee8e…ab42`.
   On `intents.near` that address is an implicit account: no key registration is needed
   (`has_public_key`: signer_id == keccak(pubkey)[12:]).
2. `authorize_swap(token_in, amount_in, token_out, min_amount_out)`, callable by the agent only:
   - checks a fixed policy: allowed pair, per-swap cap, worst accepted price. A breach is refused and the MPC is never called.
   - builds the whole intent itself: signer_id, `verifying_contract: intents.near`, a deadline 5 minutes ahead, and a nonce from
     sha256(account, counter, random_seed). The agent cannot pick, replay or extend these.
   - hashes the exact JSON per ERC-191 (`keccak("\x19Ethereum Signed Message:\n" + len + payload)`) and calls the MPC's
     `sign`. A callback turns (big_r, s, recovery_id) into the `erc191` `MultiPayload` that `intents.near` takes.
3. After deploy and init, the contract account's only key is deleted. Only the contract's code can ask the MPC to sign
   for its path, so no person's key can authorize anything for it.

`spike.py` (Python; testnet transactions, mainnet view calls only) runs all of this end to end. `vector.py` is an
independent ERC-191 test vector (eth_account) that the contract's unit test must match byte for byte.

```
cd signer-contract && cargo test && cargo near build non-reproducible-wasm && cd ..
python spike.py          # needs pynacl, eth_account; a faucet-funded testnet account is created on first run
```

## Results (2026-10-28)

| Check | Result |
|---|---|
| The contract account has no access keys after deploy | PASS |
| The on-chain derived signer_id equals the MPC view's address (`0xee8e6dfd3f7ea9caadb8ed06bd5fcd04ffb7ab42`) | PASS |
| A compliant request (1 wNEAR → ≥ 4.00 USDC, floor 3.50) returns a signed `erc191` MultiPayload | PASS (6.5 s, tx `GKVPNumzStbDHpuPkrRfnM3LYxJSsuJLFf22R4zNePzi`) |
| The MPC signer was called for that request | PASS |
| Refused with no MPC call: price below the floor / amount above the cap / pair not allowed | PASS ×3 (txs `6gwqFzSv…`, `ATNRXRc9…`, `FriLeuQr…`) |
| The signature recovers locally to the contract's signer_id | PASS |
| The payload is bound to `intents.near` and to exactly the token_diff the policy allowed | PASS |
| **Mainnet `intents.near` `simulate_intents`:** the contract-signed intent passes the signature and key checks and stops only at `insufficient balance or overflow` (the address holds nothing) | PASS |
| Control: a normal key signing as itself stops at the same stage | PASS |
| Control: payload tampered (min_out +1) → `public key … doesn't exist for account 0xee8e…` | PASS |
| Control: another key signs claiming the contract's signer_id → same rejection | PASS |
| Solver relay `quote` (wNEAR → USDC, 1 NEAR) returns a live quote (4.578 USDC) | PASS |
| Solver relay `publish_intent` with the contract-signed intent → `FAILED: insufficient balance or overflow` (balance only, not signature or format) | PASS |

Contract: `signer-1793199188.irontrade-1793199142.testnet` (deploy `AzhVmnoS…`, key deleted `5EMpyefJ…`).
Full evidence: `result.json`.

## What this proves

- A NEAR contract can be the only authority over a NEAR Intents account: it alone decides what the MPC signs, and
  `intents.near` treats that signature like any wallet's.
- The rule check runs on chain before signing. The agent proposes, the contract disposes, and nobody holds a key.
- The intent format, signature encoding and implicit-account identity are exactly what mainnet `intents.near` and the
  production solver relay expect.

## Not proven yet

- **Settlement with real funds.** The derived address held no balance, so simulation and the relay stopped at the balance
  check. Next: fund it with a few dollars on mainnet and publish once against a live quote.
- **Mainnet MPC** (`v1.signer`): its fee and latency, and the fact that it derives a different address from testnet's.
  Here a testnet MPC signature was checked against mainnet `intents.near`, which only does ecrecover, so the format
  result carries over.
- **Funding and withdrawal paths.** Deposit to `intents.near` for the 0x address (`ft_transfer_call` with a receiver
  message), and withdrawal back to the vault or owner, which must also be a contract-signed intent (`ft_withdraw`).
- **Accounting for open authorizations.** A signed intent is an open offer until its deadline, so a vault must count
  outstanding authorizations against its caps and invalidate nonces it no longer wants filled.
- Gas: the authorize transaction burned about 13 Tgas in the receipts we read. The MPC yield/resume cost on mainnet is not measured.
