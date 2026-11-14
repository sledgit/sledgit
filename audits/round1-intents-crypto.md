# Round 1 audit: NEAR Intents path, signatures and intent semantics

Scope: `contracts/vault/src/intents.rs` (whole file); the parts of `contracts/vault/src/lib.rs` it uses (`check`,
`reserve`, `release`, `floor`, `rolled`, `assert_owner`/`assert_agent`, `freeze`, `clear_stuck`, `new`, the `Vault` fields);
`contracts/mock-mpc/src/lib.rs`; tests `contracts/vault/tests/sandbox.rs::intents` and `src/tests.rs::intents_path`;
`spikes/chainsig-intents/README.md`.

Reference: `near/intents` (defuse) at **16d04f6**, the mainnet v0.4.5 commit (history fetched and checked out for this
review). Between 16d04f6 and d340060 the `contracts/defuse` tree differs only in a test-only `near-kit` import
(`core/src/public_key.rs`). `crates/crypto` gains a compressed secp256k1 key type and async signer refactors. Nothing
that changes verification, nonces, token_diff or fees for this vault. All semantics below come from 16d04f6.

No code was changed.

## Summary

| ID | Severity | Title |
|---|---|---|
| H-1 | High | The price floor is a one-receipt Rhea snapshot that stays signed for 300 s, so an agent with its own solver can buy the vault's input at a manipulated price |
| M-1 | Medium | `token_diff` is exact: the vault gets exactly `min_out`, never more, so the slippage allowance always goes to the filler |
| M-2 | Medium | An intent stuck in `Quote`/`Sign`/`Cancelling` blocks both venues forever (no recovery path), and `on_cancel_signed` has about 5 Tgas of its own (needs verification) |
| M-3 | Medium | The vault uses legacy random nonces, which intents.near says it will prohibit; the vault cannot be upgraded |
| L-1 | Low | If the MPC signs but the reply fails to parse, the cap is released while a valid signature is public, which lets the agent get round the cap |
| L-2 | Low | `freeze` does not withdraw a signed intent; it stays fillable until its deadline |
| L-3 | Low | A 300 s TTL gives every solver a free option against the vault |
| L-4 | Low | `mpc_id` is not checked at init; the mock MPC's keys can be computed by anyone |
| I-x | Info | Trust assumptions and minor edge cases (see end) |

No Critical findings. Nobody outside the vault's code can get the MPC to sign under the vault's path, and the vault
never signs anything except a policy-checked `token_diff` or an empty cancel with an existing nonce.

---

## H-1. Price floor manipulation, made worse by a signed offer that outlives the snapshot

**Where:** `intents.rs:218-219` (agent-chosen `pool_id` → `get_return`), `intents.rs:230-233` (floor from that one quote),
`intents.rs:19,238` (300 s validity).

**Mechanism.** `min_out = max(agent_min, floor(quote))`, where `quote` is a single `get_return` on a pool the agent
picks from `policy.pools`. The quote only has to be wrong in the one block where the `get_return` receipt runs. After
that the signed intent is fixed and valid for 300 s whatever happens to the pool. On the Rhea path the vault's own swap
runs against that same pool several receipts later, so a manipulator has to hold the price across several blocks
against arbitrage. On the intents path it does not.

**Exploit (agent compromised or malicious, plus a solver it controls):**
1. Pick the thinnest pool in `policy.pools` that holds the pair.
2. Block N: sell a large amount of `token_in` into that pool, so `token_in → token_out` returns little. In the
   same block, call `request_intent_swap(amount_in = max_per_trade, min_amount_out = 1)`.
3. Block N+1: `get_return` reads the skewed pool, and `floor = quote × (1 − slippage)` is far below fair value.
4. As soon as `intent_authorized` is emitted, reverse the pool trade. In a constant-product pool the round trip
   costs roughly 2 × pool fee on the manipulation size if nobody arbitrages in between.
5. The attacker's solver fills the vault's intent at that low `min_out` at any point in the next 300 s.
   intents.near checks only the vault's signature, deadline and nonce. The pool's current price plays no part.

**Impact:** each day the vault can sell up to `max_per_day(token_in)` for close to nothing, repeated up to
`max_trades_per_hour`. The only limits are the caps and how deep the chosen pool is. Owner and agent can cancel, but
they are not the ones attacking.

**Minimal fix (combine):**
- Check the Rhea quote against a source that is hard to manipulate before signing (e.g. a Pyth or `priceoracle.near`
  price), and refuse if they differ by more than N bps.
- Or require `min_out ≥ max(quote, oracle_out)` and drop the slippage discount on this venue (see M-1).
- Cut `INTENT_TTL_SEC` to what solvers actually need (tens of seconds).
- Optionally pin one reference pool per pair in the policy, so the agent cannot choose the thinnest.

**Test to add:** a sandbox test where a third account moves the Rhea pool in the block before the request. Assert
that the request is refused, or that the signed `min_out` stays within N bps of the pre-manipulation quote.

## M-1. Exact `token_diff`: the slippage allowance goes to the filler every time

**Where:** `intents.rs:110-114`, `intents.rs:232-233` (comment: "A solver may beat Rhea…").

**Verified semantics (defuse 16d04f6, `core/src/intents/token_diff.rs:42-100`, `engine/mod.rs`):**
`internal_apply_deltas(signer, delta)` applies each delta **exactly**. The vault's balance changes by exactly
`-amount_in` and `+min_out`. At `finalize` all deltas must sum to zero, so any surplus a solver has must land in another
signer's intent, never the vault's. Fees are charged only on negative deltas and paid to the fee collector from the
batch's net (the counterparty receives `amount_in − fee`). **Fees therefore do not reduce the vault's `min_out`**, which is
correct. Partial fills are impossible.

**Consequence:** a solver that "beats Rhea" keeps the whole improvement. With `min_amount_out = 1` (the sandbox tests do
this, `sandbox.rs:358`), the vault always receives exactly `quote × (1 − max_slippage_bps)`. That is a guaranteed loss
against Rhea's own price on every intent trade. The Rhea path executes at the real pool output, which is usually above
the floor. An agent colluding with a solver captures `max_slippage_bps` (up to 5% by `policy.rs:6`) of the daily volume,
with no manipulation needed.

**Minimal fix:** on the intents venue, sign `min_out ≥ quote` (or a separate `intents_max_discount_bps`, default 0).
Expect the agent to supply the solver-relay quote as `min_amount_out` when it is better. Fix the comment at
`intents.rs:232`.

## M-2. A stage other than `Open` never expires, and nothing clears it

**Where:** `intents.rs:70-72` (`live()` is true for every stage except `Open`, whatever the time); `lib.rs:480` (`check`
returns `busy` for **both** venues while the intent is live); `lib.rs:427-433` (`clear_stuck` only touches `in_flight`);
`intents.rs:286` (`Cancelling` set before the async chain); `intents.rs:289` and `301-302` (`on_cancel_signed` gets 65
Tgas static and immediately reserves 50 + 10 Tgas for its own promises).

**Scenario:** if any callback in the chain panics, the stage stays put for good: `Quote` (`on_intent_quote`), `Sign`
(`on_intent_signed`) or `Cancelling` (`on_cancel_signed`, `on_cancelled`). Every later `request_swap` and
`request_intent_swap` is refused as `busy`. The contract has no keys and cannot be upgraded, so trading is bricked for
good. Funds can still be withdrawn, because `withdraw` and `intents_withdraw` do not check `open_intent`.

The narrowest point is `on_cancel_signed`. It has 65 Tgas static plus a share of the caller's leftover gas, and it must
reserve 60 Tgas for `execute_intents` and `on_cancelled`. That leaves about 5 Tgas for its own work: loading the
contract, reading state, parsing the MPC reply, base58 and JSON. The **agent** picks the gas for `intents_cancel` and
only has to attach the minimum of 240 Tgas (`intents.rs:279`). The sandbox test attaches 300 (`sandbox.rs:408`), so the
minimum is never tested. With 300 attached, the default weight spreads roughly 80 Tgas of leftover across the two
promises. With 240, almost nothing is spread.

**Needs verification:** a sandbox test that calls `intents_cancel` with exactly 240 Tgas, then asserts the cancel
completes and `open_intent` is `None`. Also print `gas_burnt` for the `on_cancel_signed` receipt and check there is
headroom of at least 2×.

**Minimal fix:**
1. Bound liveness by time for every stage, e.g. `live = now < max(deadline_ns, started_at + STUCK_NS)`, with
   `deadline_ns` set at Quote time to `started_at + TTL + margin`.
2. Add an owner `intents_clear_stuck` that resets a non-`Open` stage after `STUCK_NS`. It should keep the cap reserved,
   because a signature may exist.
3. Give `on_cancel_signed` `TG_EXECUTE + 10 + 15` static and raise the prepaid gas `intents_cancel` requires to match.

## M-3. Legacy nonces are scheduled for removal; the vault cannot follow

**Where:** `intents.rs:234-237`.

**Verified (16d04f6):** `core/src/nonce/versioned.rs:20`: *"Legacy nonces can still be used at this time, but will be
prohibited out in the near future."* Today `engine/mod.rs:84-110` (`verify_intent_nonce`) accepts any nonce without the
`5628f6c6` magic prefix as legacy. The vault's sha256 nonce is therefore valid on v0.4.5. The same applies to the cancel,
which reuses the nonce.

**Impact:** when intents.near stops accepting legacy nonces, every intent the vault signs, including cancels, is
rejected. The account has no keys, so the code cannot change, and the intents venue stops for good. Balances are still
safe: `ft_withdraw` is authenticated by predecessor, not by signature. There is also a 2⁻³² chance per intent that the
random nonce starts with the magic prefix and is rejected (`InvalidSalt` or a bad decode). That only costs liveness.

**Minimal fix:** build a V1 versioned nonce:
`5628f6c6 ‖ 0x00 ‖ salt(4) ‖ deadline_ns(i64 LE) ‖ 15 random bytes`. Here `salt` is from intents.near
`current_salt()`, read in the same chain as the quote, and `deadline_ns` ≥ the intent deadline (`DeadlineGreaterThanNonce`).
That needs one extra view hop before signing. A nonce built this way is also cleanable by the GC after expiry, which is
harmless because it has expired.

## L-1. Sign reply that fails to parse releases the cap while the signature may exist

**Where:** `intents.rs:260-262` → `intent_fail` (`intents.rs:327-333`) releases the reservation and clears `open_intent`.

If the MPC returns `Successful` but `signature_from_mpc` returns `None`, a valid signature over `payload` may still be
public in the MPC receipt's return value. That can happen after a reply-format change, a `recovery_id` outside 0 or 1,
or a reply over 512 bytes. The payload itself is in `on_intent_signed`'s arguments. Anyone can put the two together into
a fillable `MultiPayload` for the next 300 s, while the vault has released the cap and accepts a new request. Repeated,
this lets the agent exceed `max_per_day`. It is limited only by `max_trades_per_hour` (not released) and the vault's
intents.near balance.

**Minimal fix:** release only when the promise result is `Failed`. If the result is `Successful` but cannot be parsed,
keep the reservation and set `stage = Open` with the stored deadline, so it ends by itself.

## L-2. `freeze` leaves a signed intent live

**Where:** `lib.rs:329-335`. `freeze` blocks new requests only. A signed intent stays fillable until its deadline, up
to 300 s, which does not match "Stop all trading at once". **Fix:** if an intent is `Open`, make `freeze` also start
`intents_cancel` (return the promise when gas allows), or document that freeze plus cancel is the brake.

## L-3. A 300 s open offer is a free option for solvers

**Where:** `intents.rs:19`. The intent is public (`intent_authorized`) and any solver may fill it. Solvers fill only when
the market has moved toward the vault's offer, so the vault is adversely selected for the full TTL. Together with M-1,
the vault never gains from that window. **Fix:** a shorter TTL (e.g. 30-60 s), sized to the relay's quote/publish
latency.

## L-4. `mpc_id` is unchecked; the test double's keys are public

**Where:** `lib.rs:161-171` (any `mpc_id`); `mock-mpc/src/lib.rs:14-17`. The mock's key is
`sha256("mock-mpc:{predecessor}:{path}")`, which anyone can compute. If a real vault were initialised against a
mock-mpc deployment, anyone could sign as the vault on intents.near: an `ft_withdraw` to themselves,
`add_public_key`, or `SetAuthByPredecessorId{false}`. Every guarantee would be gone. The same holds for any `mpc_id`
other than the real MPC. **Fix:** in `new`, require `mpc_id ∈ {v1.signer, v1.signer-prod.testnet}` unless a
`sandbox` cargo feature is on. Have the deploy script also assert that `view_access_key_list(vault)` is empty.

---

## Checked and found safe

**Who can make the MPC sign for the vault's path.** MPC derivation uses (predecessor, path). The vault calls `sign`
only from `on_intent_quote` (`#[private]`, stage-gated) and `intents_cancel` (owner with 1 yocto, or agent). It signs only
a payload the vault builds itself: `token_diff` after `check`, or `[]` with the stored nonce and deadline. No method
takes a hash, a payload or a path from a caller. The callbacks are `#[private]` (the sandbox test confirms this from
`eve`). The design holds as long as the vault account has no access keys (see L-4).

**Payload construction.** All strings come from `AccountId`, which near-sdk validates (`[a-z0-9._-]`, no quotes or
backslashes), and `serde_json::json!` escapes anyway. The signed and the submitted payload are the same `String`, so key
order is irrelevant. `serde_json` sorts the keys, and intents.near parses the string. The ERC-191 length is the byte
length, and the hash matches an independent `eth_account` vector. `signer_id = current_account_id`, and
`verifying_contract = intents_id`, which intents.near checks (`WrongVerifyingContract`). `token_in ≠ token_out`
(`lib.rs:486`), so the diff keys are distinct. Neither delta can be zero: `amount_in > 0`, and `min_out ≥ agent_min ≥ 1`
even when `floor` rounds to 0. Values above `i128::MAX` simply fail to parse (Info).

**Nonce.** The nonce is `sha256(account ‖ seq ‖ random_seed)` with `seq` strictly increasing, so it is unique per
request. Predictability does not matter: only a signature from the vault's key can commit a nonce for the vault's
account, and the DAO GC cannot clean legacy nonces (`garbage_collector.rs:31-34`). A cancel reuses the nonce on purpose.
No two different non-empty payloads ever share a nonce.

**Deadline.** RFC 3339 with whole seconds and a `Z` suffix, which intents.near parses (shown by the sandbox).
intents.near rejects only when `deadline < now`, while the vault treats the intent as not live once `now ≥ deadline_ns`.
That leaves a window of one nanosecond, negligible.

**Cancel semantics.** defuse documents an empty `intents` array as valid and as consuming the nonce
(`core/src/intents/mod.rs:31-34`). Verification order is signature → verifying_contract → deadline → key →
commit_nonce → execute. Any error panics the whole `execute_intents`, so batches are atomic.
- Fill first: the cancel fails with `NonceUsed`, the stage goes back to `Open`, and the cap stays reserved (correct).
- Cancel first: the fill fails with `NonceUsed`, and the cap is released (correct).
- Deadline passes while the MPC is signing: the cancel fails, the stage is `Open`, the intent has expired, and the cap
  stays reserved (conservative).
- If the cancel's own `execute_intents` fails, the signed empty payload may be public, and anyone can only burn that
  nonce. That is the outcome the vault wanted.
- The cap release in `on_cancelled` updates the stored day's usage. No `rolled()` runs in between, because the vault is
  `busy`.

**Fees.** Charged only on negative deltas and paid by the batch's counterparty, not the vault (see M-1). A fee change
by the DAO affects only whether solvers will fill.

**Combining with other intents / partial fills.** The vault's diff is exact and nets to zero at `finalize`. Nothing in
any batch can make the vault give more or receive less than it signed. Only one non-empty vault intent is live at a time
(but see L-1).

**Other intents.near powers.** `add_public_key`, `remove_public_key`, `disable_auth_by_predecessor_id` and `ft_withdraw`
all use `ensure_auth_predecessor_id()`, so only the vault contract can call them for its account. The vault calls only
`add_public_key` (the MPC key) and `ft_withdraw(receiver = self, msg = None, storage_deposit = None)`. The signed-intent
equivalents (AddPublicKey, Transfer, FtWithdraw to others, StorageDeposit, SetAuthByPredecessorId, MtWithdraw, AuthCall)
would need a vault signature the code never produces. Someone else registering the vault's public key on their own
account gives them nothing, because `signer_id` is inside the signed payload. Deposit-message `execute_intents` adds no
new power.

**Signature encoding.** r is `affine_point[1..]` (the x coordinate), and s is 32 bytes. Only `recovery_id ∈ {0,1}` is
accepted; 2 and 3 occur with negligible probability. intents.near calls `ecrecover(…, malleability_flag = true)`, which
rejects high-s (`crates/crypto/src/secp256k1.rs:74-81`). The vault does not normalise s, and neither does defuse's own
MPC adapter (`crates/mpc/signer/src/secp256k1.rs:31-46`), which relies on the MPC to return low-s with a matching
`recovery_id`. The spike verified this once against mainnet `simulate_intents` (Info: re-check on ≥ 20 mainnet MPC
signatures before going live). Malleability cannot be exploited anyway, because the nonce stops replay, not the
signature bytes.

**`normalize_key`.** Accepts 64 bytes, or 65 with `0x04`, and rejects compressed or other forms. It does not check that
the point is on the curve, but the key comes from the trusted `mpc_id` (see L-4). The format matches v0.4.5's
`secp256k1:<base58 64B>`. Domain 0 is secp256k1 on the MPC.

**Deposits/withdrawals.** `intents_deposit` sends `ft_transfer_call` with `msg = ""`, which credits the sender (the
vault). Refunds come back to the vault. `intents_withdraw` always pays the vault. intents.near refunds failed payouts in
`ft_resolve_withdraw`.

## Info

- **I-1 DAO trust:** intents.near roles can pause `execute_intents` (cancel then fails safely), `force_lock_account`,
  `force_disable_auth_by_predecessor_ids` (the vault could then no longer withdraw directly, and it cannot sign an
  FtWithdraw intent as a fallback), force-withdraw, `force_add_public_keys`, and upgrade. All of this is outside the
  vault's control. Worth stating in the user-facing trust model. A vault-built `ft_withdraw` intent to self only would
  give a fallback.
- **I-2:** the MPC-derived key also controls the implicit account `0x<keccak(pk)[12:]>` on intents.near, which is the
  identity the spike README uses. The production vault signs only as its named account. Anything sent to the 0x
  account is stranded. Correct the spike README if it is reused as a guide.
- **I-3:** the MPC `sign` fee is assumed to be 1 yoctoNEAR (`intents.rs:250,287`). If the fee rises, signing fails
  safely, but cancel then becomes impossible (the cap stays reserved until the deadline).
- **I-4:** `on_intents_key` stores `intents_key` before `add_public_key` is confirmed (`intents.rs:167`). If registration
  fails, requests pass the "set up" check, but every signature is rejected. Re-running `intents_setup` fixes it.
- **I-5:** `on_cancelled` treats a reply over 64 bytes as failure (`intents.rs:309`). If a future `execute_intents`
  returns data, cancels are recorded as failed even though the nonce was burned (conservative: the cap stays reserved
  until the deadline).
- **I-6:** an intent that expires unfilled keeps its cap reservation for the rest of the day (conservative). Document it,
  so agents do not read a refusal from caps as a bug.
- **I-7:** the agent can set `min_amount_out` above any fillable price to burn the day's cap with unfillable intents.
  That is griefing by the party the caps already bound.
