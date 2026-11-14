# Round 3 contract audit (final, pre-mainnet), part A: on-chain code and deploy scripts

Scope: `contracts/vault/src/{lib.rs,policy.rs,intents.rs}`, `contracts/factory/src/lib.rs`,
`contracts/vault/examples/{deploy_mainnet.rs,deploy_and_lock.rs}` and `contracts/vault/tests/sandbox.rs`. near-sdk
5.29.1, release profile with `overflow-checks = true`. Reference code: intents.near source on GitHub (`near/intents`,
`contracts/defuse/src/contract/{garbage_collector.rs,salts.rs}`), the pinned `intents_mainnet.wasm` and
`rhea_exchange_mainnet.wasm` (strings checked). I formed this view from the code first and read the round 1 and 2
reports afterwards, only to check for regressions.

Build under test: vault wasm sha256 `450329c4…a9aa9`, factory wasm sha256 `e4f53957…0390b7`. These are
`cargo near build non-reproducible-wasm` outputs from the current sources.

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 5 |
| Info | 10 |

No finding lets the agent, a third party, a token or an exchange take funds. Only the owner can withdraw, and only to
itself. The one Medium finding comes from an incomplete round 2 fix (H-2): an intent that was really filled can still
be recorded as `intent_expired`, which releases its cap. It needs intents.near's own operators to invalidate a salt and
run garbage collection before the vault settles. A sandbox test against the real mainnet intents.near binary
reproduces it.

## Test runs

| Run | Result |
|---|---|
| `cargo test -p irontrade-vault --lib` | 54 passed |
| `cargo test -p irontrade-factory --lib` | 4 passed |
| `cargo test --example deploy_and_lock --example deploy_mainnet --example arena_setup` | 2 + 3 + 3 passed |
| `cargo clippy --target wasm32-unknown-unknown -p irontrade-vault -p irontrade-factory -- -D warnings` | clean |
| Sandbox, `NEAR_SANDBOX_VERSION=2.13.4`, 20 tests (real Rhea and intents.near mainnet binaries) | 20 passed, 343 s |
| Round 3 PoCs (copies of the crate in a scratch directory; repo files untouched) | see the findings |

Receipt ordering seen in the sandbox (`failed_creation_with_no_float…`, `--nocapture`):
`factory_balance_in_callback = 5.6087 NEAR` (start 2.6 + the 3 NEAR runtime refund), `pending = 0`. The runtime refund
reached the factory before `on_created`, so the "record and claim later" branch never runs in the sandbox.

---

## Findings

| # | Sev | Location | Issue | PoC | Fix |
|---|---|---|---|---|---|
| M-1 | Medium | `vault/src/intents.rs:364-416` | Salt invalidation followed by GC turns a fill into `intent_expired` and releases the cap. Round 2 H-2 was only partly fixed | Sandbox, real intents.near | Check `is_valid_salt` **after** `is_nonce_used`; unused with an invalid salt counts as unresolved |
| L-1 | Low | `vault/src/lib.rs:343-362`, no claim method | Rhea's lostfound path is confirmed in the real binary. The vault can't claim from it, and `on_verify` would report "returned" (round 2 L-1, still open) | Binary strings | Add an owner-only `exchange_claim_lostfound` passthrough before the code is frozen, or document the loss path |
| L-2 | Low | `intents.rs:364-393`, `lib.rs:597-602` | If intents.near stops answering `is_nonce_used` in a form the vault can parse, both venues are blocked for up to 30 days, and the owner has no way out | Code reading | Owner-only `intents_abandon` after the deadline: emit `intent_unresolved`, keep the cap |
| L-3 | Low | `deploy_mainnet.rs:334-362` | Anyone can call `create_vault` between the factory deploy and the canary, or take the name `canary`. The lock checks then fail permanently, so that factory name is lost | Code reading | Accept other vaults whose code and parent check out; give the canary a random suffix; or deploy, canary and lock back to back after a pre-check |
| L-4 | Low | `vault/Cargo.toml` (reproducible_build), `deploy_mainnet.rs:207-211` | The repo has no commits, so a reproducible build is impossible. The pinned mainnet hashes can't be tied to published source, and the script doesn't check `contract_source_metadata` | `git log` | Commit, run `cargo near build reproducible-wasm`, and have the script compare the canary's `contract_source_metadata` |
| L-5 | Low | `factory/src/lib.rs:9-13,113-136`, `deploy_mainnet.rs:15` | "No float is needed" is not quite true. A recorded refund adds about 0.0013 NEAR of storage, and `claim_refund` succeeds only while free float ≥ the storage of all open records. Enough simultaneous records deadlock every claim until someone donates NEAR | Arithmetic below. The unit test can't show it because `LookupMap` writes aren't flushed in unit tests | Count record storage in the check, e.g. reserve `owed + records × 0.002 NEAR`, or have `on_created` keep LISTING_FEE as that record's storage; fix the comment |
| I-1 | Info | `lib.rs:106-155` | Hourly buckets: 2× `max_per_day` within 23 h 00 m 01 s, and 2× `max_trades_per_hour` within 2 s. Known since round 2 I-2 and still holds. The test `caps_roll_over_24_hours_not_at_midnight` says "24 hours after it was spent", which is wrong | Unit PoC | Document it as "23 to 24 h"; correct the test comment |
| I-2 | Info | `lib.rs:506-540` | `exchange_withdraw` blocks only swaps already in flight at entry. The agent can start a Rhea swap while it runs, and `on_exchange_after` then measures the swap's deposit or withdraw too, so the recorded amount is wrong (records only, no funds) | Code reading | A flag that `check()` treats as busy until `on_exchange_after` |
| I-3 | Info | `lib.rs:487-493` | `exchange_storage_deposit(registration_only=false)` parks all attached NEAR on Rhea, and the vault has no `storage_withdraw`, so any excess is lost to the owner | Code reading | Use `registration_only: true`, or document "attach the minimum" |
| I-4 | Info | `lib.rs:30,394` | `NEAR_RESERVE` is 0.5 NEAR, but a factory vault starts with `min_deposit - 0.01` (0.09 NEAR by default), so `withdraw_near` is unusable for small vaults | Arithmetic | Fine; document it |
| I-5 | Info | `deploy_mainnet.rs:359` | The "canary answers preview_swap" check passes when the preview says `ok:false`. It's a liveness probe, not a policy check. The canary's `agent_id` and policy are never compared with `IT_CANARY_POLICY` | Code reading | Assert `ok == true` for a 1-unit preview, compare `get_policy` |
| I-6 | Info | `deploy_mainnet.rs:74-82` | `names_ok` doesn't refuse `IT_OWNER == IT_FACTORY` (a canary owned by the keyless factory: its deposit is stranded) | Code reading | Add `owner != factory` |
| I-7 | Info | `deploy_mainnet.rs:167-181` | Rhea and intents.near hashes are pinned only at deploy time. Both are upgradeable by their governance, and the vaults trust them for life (immutable `exchange_id`/`intents_id`) | n/a | Monitoring and a documented response (freeze, withdraw) |
| I-8 | Info | `factory/src/lib.rs:110,133` | A refund to a creator whose account has since been deleted bounces back to the factory as untracked float. The creator loses it | n/a | Accept |
| I-9 | Info | `sandbox.rs` (`failed_creation_*`) | "Owner made whole" uses `before.saturating_sub(after) < …`, which also passes if the owner was over-refunded. Over-refund is ruled out here only by the separate float assertion | n/a | Also assert `after <= before` |
| I-10 | Info | `intents.rs:441-451` | If MPC returns a cancel signature the vault can't parse, a third party can rebuild it from the receipt and burn the nonce. A later settle then records `trade` for a non-trade. The cap is kept, so this is conservative | n/a | Accept |

---

### M-1. A salt invalidation followed by garbage collection records a real fill as an expiry and releases the cap

`intents.rs:364-416`. Round 2 H-2 noted that intents.near GC deletes used nonces. The fix gave the V1 nonce a deadline
30 days out, but intents.near has a **second** way to clean a nonce
(`contracts/defuse/src/contract/garbage_collector.rs`):

```rust
VersionedNonce::V1(SaltedNonce { salt, nonce: ExpirableNonce { deadline, .. } })
    => deadline < Timestamp::now() || !self.is_valid_salt(salt),
```

`invalidate_salts` (role DAO or SaltManager) marks a salt invalid. After that, `cleanup_nonces` (DAO or
GarbageCollector) may delete every nonce under that salt, used ones included. Once that happens, `is_nonce_used`
returns `false` for a nonce that was filled. If this lands between the fill and `intents_settle`, the vault emits
`intent_expired`, releases `amount_in` back into the 24 h window, and the public record leaves out a real trade. The
vault is immutable, and intents.near's salt and GC policy may change at any time during the vault's life.

**PoC.** This sandbox test runs against the real `intents_mainnet.wasm`, with `lp` granted DAO in the verifier's init
`roles`. File: scratchpad copy of `contracts/vault/tests/sandbox.rs`, test
`intents::poc_salt_invalidation_turns_a_fill_into_an_expiry`:

```
authorize 46 USDC -> solver fills (vault intents balance 100 -> 54 USDC)
usage after fill:   spent usdc = 46000000
lp: invalidate_salts([current_salt]); cleanup_nonces([[vault, [nonce]]])
is_nonce_used after cleanup: false
intents_settle (after deadline): intent_expired {seq 1, amount_in 46000000}   trades = []
usage after settle: spent usdc = 0
next request_intent_swap(50 USDC): authorized   <- a full extra cap in the same window
```

**Impact.** The cap is bypassed by up to one `max_per_trade` per affected intent, and the record is wrong. No funds
are lost. The attacker can't make it happen; intents.near's operators have to act. But "rotate and GC" is exactly what
salts exist for, and a malicious or simply slow settler (settling is permissionless and normally done by the runner)
widens the window.

**Fix.** Settle in sequence: `is_nonce_used`, **then** `is_valid_salt(salt)`, then `on_settle(seq, may_expire, …)`.
Salts never become valid again once invalidated. So if the salt is still valid after the nonce read, no salt-based
cleanup can have happened before it, and nonces can't be deadline-GC'd for 30 days, which makes `used == false` a
genuine expiry. If the salt is invalid and the nonce is unused, emit `intent_unresolved` and keep the cap. Store the
salt in `OpenIntent`, or parse it out of the stored nonce (bytes 5..9). A unit test should cover all four combinations
of used and valid.

### L-1. Rhea lostfound (round 2 L-1, still open, now partly confirmed)

The pinned Rhea binary contains `claim_lostfound`, `get_lostfound_token`, `list_lostfound_tokens` and the log strings
`" has not enough storage. Depositing to owner or user lostfound account."` and `"Depositing to user lostfound
account."`. So a payout that fails to transfer can be parked in a per-user lostfound instead of being re-credited.
`on_verify` (`held < amount`) would then report `returned: true`, and in the failed-swap path release the cap. The
vault has no way to call `claim_lostfound`. The trigger needs a failed `ft_transfer` to the vault (unregistered on
`token_out`) **and** a vault account on Rhea that lacks storage to take the re-credit. The vault never unregisters
tokens, so this is unlikely, but the loss would be permanent because the vault is immutable. Fix before freezing the
code: add an owner-only, 1-yocto `exchange_claim_lostfound(token)` that forwards to Rhea (confirm the argument shape
against the binary in the sandbox), or document the residual.

### L-2. No escape hatch for an unsettleable intent

Once an intent is past its deadline, `check()` refuses **both** venues with `unsettled` until `intents_settle` records
an outcome (`lib.rs:600-602`). `on_settle` does nothing if the `is_nonce_used` reply is missing or not a bool
(`intents.rs:393`). An intents.near upgrade that renames the view or changes its reply would stall trading for up to
`NONCE_TTL_SEC` (30 days), after which settle records `intent_unresolved` without asking. `clear_stuck` covers only
Rhea. Fix: an owner-only `intents_abandon()`, allowed only when `!live(now)`, that emits `intent_unresolved` and keeps
the cap. That is safe because it never releases caps.

### L-3. Deploy front-running makes the factory name unusable

The factory can be called by anyone as soon as `deploy factory + new` lands (`deploy_mainnet.rs:310-318`). Two cheap
griefs, each costing 0.1 NEAR:
- `create_vault("canary", owner=attacker)`: the script's canary fails ("canary not created"). On resume,
  `has_canary = true` → `Plan::Lock` → the `canary config ids` check fails on `owner_id` → refused every time.
- `create_vault("anything")` before the canary: `factory lists exactly the canary` fails every time.

Either way the script never deletes the key. That is fail-closed, so no funds are at risk, but this factory name is
spent. The operator has to `DeleteAccount` the factory to get the 3 NEAR back and start over under another name. Fix:
accept extra listed vaults whose parent and code hash check out, and use an unguessable canary name such as
`canary-<random>`.

### L-4. The mainnet hashes can't be reproduced from public source yet

`git log` → "your current branch 'master' does not have any commits yet". The Cargo metadata declares a reproducible
build (sourcescan image), but `deploy_and_lock.rs:265` records `non-reproducible-wasm`, and `deploy_mainnet.rs` accepts
any local build whose hash matches `IT_EXPECT_*`. Because the vaults are keyless forever, third parties have to be able
to rebuild the exact bytes. Fix: commit and tag, build with `cargo near build reproducible-wasm`, set `IT_EXPECT_*`
from that output, and add a check that the canary's `contract_source_metadata` names that commit.

### L-5. Recorded refunds need a float for their own storage

The new design is correct for every order of receipts. The cases I checked:
- Immediate pay: paid only when `spendable ≥ deposit`. Each payment's transfer is deducted at the end of the receipt,
  so later callbacks see it.
- Recorded: the runtime later restores `deposit - fee`, and the fee is already present.
- Double claim: the record is removed before the transfer.
- Someone else's claim: the money goes to `account_id`.
- Claim before the refund arrives: allowed only if the float covers it, and the late refund then replenishes the
  float.
- `owed` never underflows. It is saturating, but `claim` subtracts exactly the recorded amount.

The one gap is storage. Let F be the free float when a record is made (balance - storage - owed), and s ≈ 125 bytes ≈
0.00125 NEAR the storage of one record (key `r` + borsh(AccountId ≤ 64) + 16 B + 40 B overhead). After the runtime
refund lands, a claim needs `F ≥ Σ s` over all open records. With the deploy defaults (fund 3 NEAR, factory code about
1.68 NEAR) F is about 1.3 NEAR, so roughly 1,000 simultaneous records would deadlock all claims until someone donates.
Records also only appear when the runtime refund is late, which the sandbox didn't show. Practical risk is low. The
module comment ("No float is needed and no deposit can be stranded") and `IT_FACTORY_FUND`'s note ("refunds don't need
a float") should say "a small float covers record storage". The unit test
`refund_is_recorded_when_the_runtime_refund_is_late` can't show the effect: `store::LookupMap` writes are not flushed in
unit tests, so `storage_usage()` never grows there.

### Unit PoC for I-1

The scratchpad copy of `vault/src/tests.rs` adds the module `poc_round3`:
- `two_daily_caps_inside_24_hours`: 100 at 23:59:59 and 100 at 47:00:00. That is 200 against a cap of 100, 82,801 s
  apart. Passes.
- `double_rate_across_hour_boundary`: 6 trades within about 1 s with `max_trades_per_hour = 3`. Passes.

---

## Verified to hold

- **Access.** Every callback is `#[private]` (sandbox: `private_methods_cannot_be_called_from_outside`,
  `only_the_owner_moves_funds…`). Owner methods require exactly 1 yocto, which proves a full-access key. The agent can
  only request trades, log skips, freeze and cancel. Withdrawals go to the owner, or to the vault itself
  (`intents_withdraw`, `exchange_withdraw`). Owner and agent stay separate through `new`, `set_agent`, `propose_owner`
  and `accept_owner`. `ft_on_transfer` accepts only from the owner and in listed tokens.
- **Caps.** Caps are reserved in the same receipt as the check, before any async call. One Rhea swap or one intent at a
  time, mutually exclusive, so there can't be several open intents. Caps are released only when the input is provably
  safe: quote, band or freeze failure; deposit used == 0; a verified return; a successful burn; or an expiry decided at
  check time (round 2 H-1 fix holds). `clear_stuck`, partial or held cases, `intent_unsigned`, `intent_closed` and
  `intent_unresolved` all keep the cap. `release` rolls first and skips buckets that have been reused. Everything is
  checked arithmetic.
- **Pricing.** `min_out = max(agent, quote·(1 - slippage), band)` on Rhea, enforced on-chain through the swap's
  `min_amount_out`. Intents are signed at `max(agent, quote, band)`. The band is computed with ceil and a checked mul,
  and an overflow is refused. The residual is economic: the agent can push the pool towards the band and fill its own
  intent or sandwich the swap. That loss is bounded by the owner's band times the caps (round 1 #1 residual).
- **Promise handling.** State is written before every cross-contract call, every callback re-checks `seq` (and the
  stage for intents), and replies are read with size limits. Static gas per callback with `unused_gas_weight(0)`:
  205/135/95/25 Tgas on Rhea, 190 and 85 Tgas on intents, and minimums of 235/230/255 Tgas enforced up front. Running a
  callback out of gas leaves the vault stuck but conservative: `clear_stuck` after 15 minutes for Rhea, and settle after
  the deadline for intents.
- **Factory.** The batch (`CreateAccount + Transfer + UseGlobalContract(hash) + new`) is atomic, and the vault never
  gets a key. `#[init]` blocks re-initialisation, and `new` only accepts the account itself or its direct parent.
  Deposits are bounded `min ≤ deposit ≤ max ≤ 100 NEAR`, and the bound applies to the NEAR deposit only. Token deposits
  are the owner's own and uncapped by design. Every refund ordering is analysed under L-5.
- **Intents signing.** The vault builds the payload itself from validated AccountIds and u128s, so there is no JSON
  injection. The verifying contract and signer are fixed, and the nonce is V1 with the live salt and a deadline 30 days
  out. intents.near takes `token_diff` fees from the negative side's counterparty, so the vault pays exactly
  `amount_in` and receives exactly `min_out` (checked in source). Replay of a used nonce and tampered payloads are
  refused (sandbox).
- **Deploy script (`deploy_mainnet.rs`).**
  - It refuses a target/chain mismatch, using `status.chain_id` from the same RPC. The sandbox target can never reach
    mainnet or testnet.
  - Sending needs `IRON_TRADE_MAINNET_CONFIRM == IT_FACTORY` and both `IT_EXPECT_*` hashes equal to the local build.
  - Plan mode signs nothing.
  - The key file is written 0600 with `create_new` before the account exists, and secrets are never printed (checked
    every `fail(...)` and `println!`).
  - The key is deleted only after the factory checks (code hash, pinned vault hash, ids, deposit bounds, `owed == 0`)
    and the canary checks (exists, 0 keys, pinned global hash, ids, listing) pass.
  - It confirms exactly one key, ours, before deleting, and verifies 0 keys after. `IT_RESUME` refuses when the
    on-chain key doesn't match the pending file.
  - `Debug`-string hash checks print `CryptoHash` as base58. They could only misfire if a hash happened to contain
    "None", and then they fail closed.
  - The whole script runs end to end in the sandbox (`mainnet_script_runs_end_to_end_in_sandbox`).
- **`deploy_and_lock.rs`** is testnet-only (RPC, `.testnet` and signer checks) and fails closed. It doesn't pass
  `max_deposit`, so testnet gets the 100 NEAR ceiling. That is fine for testnet.

## Earlier dispositions: did they hold?

| Earlier item | Status in round 3 |
|---|---|
| R2 H-1 (expiry decided at callback time) | **Holds.** `may_expire` is computed in `intents_settle` |
| R2 H-2 (GC deletes used nonces) | **Regressed / incomplete.** The deadline branch is fixed. The salt-invalidation branch of `is_nonce_cleanable` is not (M-1) |
| R2 M-1 (`exchange_withdraw` false success) | **Holds.** Balance before and after. Concurrency mis-record noted as I-2 |
| R2 L-1 (lostfound) | **Still open.** Lostfound and claim are present in the real binary (L-1) |
| R2 L-2 (setup bricking) | **Holds.** `has_public_key` fallback |
| R2 L-3 (burn recorded as trade) | **Holds.** `burn_attempted` → `intent_closed` |
| R2 L-4 (name impersonation) | **Holds.** `owner_id == predecessor`. A deploy-time variant is L-3 |
| R2 L-5 (refund ordering) | **Resolved by redesign.** Correct under both orderings. The sandbox shows refund-first. Storage caveat in L-5 |
| R2 Info (2× in about 23 h) | **Holds as documented.** PoC re-confirms (I-1) |
| R1 #20 (`mpc_id` guard) | **Holds.** The factory fixes `mpc_id`, and the script checks it against `v1.signer` |
| R1 #21 (MPC low-s, fee, gas) | The testnet results record the low-s check. Mainnet `v1.signer` gas and deposit still need one live canary trade after lock (not run here: no real transactions) |

## Before mainnet

1. Fix M-1 (sequential nonce-then-salt check) and add L-2's `intents_abandon`. Both are small and only make the vault
   more conservative.
2. Decide on L-1: add a lostfound claim passthrough now (the code is frozen afterwards), or record the residual.
3. Commit the repo, build reproducibly, and pin `IT_EXPECT_*` from that build (L-4). Harden the canary checks (L-3,
   I-5, I-6).
4. Re-run the sandbox on 2.13.4 and 2.14.0 after these changes (only 2.13.4 was run for this report).
