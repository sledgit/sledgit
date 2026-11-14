# Audit round 1: economic attacks and policy logic

Scope: `contracts/vault/src/{lib.rs, policy.rs, intents.rs}` (near-sdk 5.29.1), with `src/tests.rs` and `tests/sandbox.rs` read for evidence. This was a static review. No code was changed.

Threat model: the agent key or box is fully compromised; strangers can call any public method; the owner is honest but may be careless; Rhea pools can be moved within a block; NEAR Intents solvers are adversarial. Bot owners are also competitors on the leaderboard, so they have a reason to inflate their own score.

## Summary

| ID | Severity | Title |
|---|---|---|
| H-1 | High | The price floor comes from a spot quote that the agent picks and can move. On the intents path, the vault always receives exactly the floor. |
| H-2 | High | Owner fund-movement events are emitted before the transfer runs, so the owner can record withdrawals of any size without moving anything |
| M-1 | Medium | Unrecorded inflows (plain `ft_transfer`, intents.near deposits) raise equity without any event |
| M-2 | Medium | Intent fills and expiries are never recorded; the caps for expired intents are never reconciled |
| M-3 | Medium | `freeze` does not revoke a signed intent and does not stop a Rhea swap already in flight |
| M-4 | Medium | An MPC reply that succeeded but could not be parsed releases the cap, while a valid signature may be public on chain (needs verification) |
| M-5 | Medium | An open intent stuck in Quote, Sign or Cancelling blocks trading for good, and the contract cannot be upgraded (needs verification) |
| M-6 | Medium | The caps reset on UTC calendar boundaries and apply per token, so the real bound is about 2 × Σ(daily caps) in minutes |
| L-1 | Low | `accept_owner` does not re-check owner ≠ agent |
| L-2 | Low | Tightening the policy also waits 24 h |
| L-3 | Low | `receipt_hash` is not unique and not bound to anything; skip and refuse counts can be inflated |
| L-4 | Low | A malicious token on the allowlist can forge `deposit` events |
| I-* | Info | See the end of this report |

## Worst-case loss per day: $100 vault, USDC 50/trade and 100/day, 1% slippage

Assumptions: all $100 starts in USDC. wNEAR is also allowed, with caps worth about $50 per trade and $100 per day. The agent key is compromised.

| Scenario | Mechanism | Loss |
|---|---|---|
| A. Deep pools only (e.g. the sandbox pool, $200k TVL), the agent acts alone | The agent fills its own intents as solver at the floor, 1% below Rhea's quote (H-1). On Rhea, it churns USDC↔wNEAR and burns the pool fee on each leg. Self-sandwiching a deep pool inside the 1% band costs more in fees than it earns. | About 1% plus fees on each leg: ≈ $1.0–1.3 per $100 of turnover. USDC leg plus wNEAR leg ≈ **$2–2.6 per day (2–2.6%)**, compounding to roughly 45–55% over 30 days |
| B. Deep pools, plus one thin or off-market pool on the allowlist that contains the pair | For intents, the agent names the worst-priced allowed pool as the quote source. If that pool sits x% off market, the floor sits (x+1)% below market. | (x+1)% of turnover. For a 5%-off pool: **≈ $6 per $100 per leg** |
| C. A thin pool can be manipulated (reserves below about 70× the trade size, e.g. under $3.5k for a $50 trade at a 0.3% fee) | Sandwich: move the pool before the quote receipt, the vault trades or signs at the moved price, then move it back. The floor is relative to the moved quote, so it gives no protection. | Up to about 90% of each trade. **≈ $90 of the $100 in two trades, about 10–20 s apart** |
| D. As C, timed across UTC midnight | `rolled()` resets `spent` at `now / DAY_NS` (M-6) | 100 USDC at 23:59 plus 100 at 00:00: **the whole vault, both tokens, within about a minute** |

Conclusion: for a vault whose daily cap is at least its balance, the cap does not limit a compromised agent that can reach any manipulable or off-market allowed pool. In the best case (deep pools only), the steady leak is about 2% per day. The design note's line "a compromised agent can lose at most the daily cap per day" is too optimistic: the real bound is per token, and up to twice that within minutes (M-6).

Manipulation cost model for a constant-product pool. To take a fraction f of a trade of size A from a pool with one-side reserve R, the attacker must trade Δ ≈ R(1/√(1−f) − 1) twice and pays about 2·fee·Δ. At f = 0.9 and a 0.3% fee, the attack pays off when R < ~69·A.

---

## H-1 High: the price floor uses an agent-chosen, manipulable spot quote; intents always settle at the floor

**Where:**
- `lib.rs:215-223` (`on_quote`: `floor(quote)`, `min_out = max(agent_min, floor)`)
- `intents.rs:226-233` (`on_intent_quote`)
- `lib.rs:476-495` (`check`: the pool only has to be on the allowlist; nothing ties it to the pair or to a reference)

**The problem:**
- The quote comes from `get_return` on the `pool_id` the agent supplies, in a receipt the agent can time.
- The floor is relative to that quote, so it only protects against movement between the quote and the swap. It does not protect against a pool that has already been moved or is off market.
- On the intents path it is worse:
  1. `token_diff` is exact. The vault receives exactly `min_out`, and the solver keeps any surplus. The sandbox test `swap_settles_against_a_solver_and_withdraws` confirms the vault receives exactly the floor.
  2. The agent can be the solver.
  3. The quote pool does not need to be where the trade happens. Any allowed pool containing the pair works, so the agent picks the cheapest one to move or the most off-market one.
  4. The quote only has to be wrong for one receipt. After that, the attacker can restore the pool and fill the intent at leisure during the 300 s TTL. There is no back-run race.

**Attack (intents, thin allowed pool P containing USDC/wNEAR):**
1. Block N: the attacker sells wNEAR into P, so P's USDC→wNEAR `get_return` is about 50% low.
2. Block N: the agent calls `request_intent_swap(P, usdc, wnear, 50e6, 1, h)`. The `get_return` receipt executes in N+1 and sees the moved price. `min_out` is the floor, about 49.5% of fair value.
3. Block N+2: the attacker buys back on P and recovers its capital, minus fees.
4. Within 300 s: the attacker, acting as solver, fills the published `multi_payload` and gets 50 USDC for about $24.75 of wNEAR.
5. The attacker repeats once more, up to the 100 USDC daily cap.

**The Rhea path:** a classic sandwich around `request_swap` on a thin allowed pool works the same way. The attacker has to back-run after the swap receipt.

**Impact:** see the table above. Without any manipulation, scenario A still leaks about 1% of turnover on every intent, because the vault never gets price improvement.

**Minimal fix (any one of these helps; the first two together close it):**
1. Add an owner-set price band per pair to the policy, for example `min_out_per_unit_in` (scaled integer). Refuse when `min_out < amount_in × band`. Changes to it are timelocked like any other policy change. This needs no oracle and bounds loss to the band.
2. For intents, set `min_out = max(agent_min, quote)`, with no discount below the quote. Alternatively, use a separate and much smaller `intent_slippage_bps`, since a solver should beat Rhea, not undercut it. Pin the quote pool per pair (`reference_pool[pair]`) instead of letting the agent name it.
3. Later: an oracle deviation check (Pyth or priceoracle.near), as the design note already plans.

---

## H-2 High: owner events are emitted before the transfer, so withdrawals can be recorded that never happen

**Where:**
- `lib.rs:311` (`withdraw`)
- `lib.rs:420` (`exchange_withdraw`)
- `intents.rs:178` (`intents_deposit`)
- `intents.rs:189` (`intents_withdraw`)

**The problem:** each method logs its event in the outer receipt and then makes an unchecked cross-contract call. If that call fails, the outer receipt has still succeeded and the event stays on chain. Examples of failure: the amount is above the balance, the owner is not registered on the token, or the token does not exist.

**Attack (an owner gaming the leaderboard):**
1. Call `withdraw(usdc, 1_000_000_000_000)` (1,000,000 USDC) with 1 yocto. The event `withdraw {amount: 1e12, to: owner}` is emitted, then `ft_transfer` panics because the balance is too low. Nothing moves.
2. Any P&L of the form `equity + Σwithdrawals − Σdeposits` now shows +$1,000,000.

`exchange_withdraw` has no `amount > 0` check either. The `intents_*` events are vault-internal moves, so they are P&L-neutral, but they still mislead anyone reconciling balances across the three locations.

**Impact:** anyone who computes the leaderboard from events can be given arbitrary P&L by any owner. A careless owner can also produce this by accident, for example when the account is not registered on the token.

**Minimal fix:** move each emit into a `#[private]` callback after the transfer. Emit only when `promise_result_checked(0, _)` succeeded, and for `ft_transfer_call` emit the amount actually used. The alternative is to emit a `*_failed` event in the callback, but the first option is cleaner.

---

## M-1 Medium: unrecorded inflows raise equity

**Where:** `lib.rs:294-302`. Only `ft_on_transfer` from the owner emits `deposit`.

**The problem:**
- A plain `ft_transfer` to the vault, from the owner or from a second account, never calls `ft_on_transfer`. It cannot be refused, and it produces no event.
- The same is true of `ft_transfer_call` to intents.near with `msg` naming the vault account, and of intents.near `transfer` intents into the vault's account.

**Attack:** the owner gifts 20 USDC from an alt account with plain `ft_transfer`. Any score built on balances counts it as a 20% return. The decision timeline shows no matching trade.

**Impact:** equity and return are inflated by any amount at the cost of the gift, which the owner can later withdraw. This is High if the leaderboard reads balances (`site/src/lib/feed/near.ts` is still a stub, so this is still open).

**Minimal fix:** keep book balances in the contract, per token and per venue. Credit them only from owner deposits (in callbacks) and settled trades. Expose them as a view, and have the leaderboard use them. Alternatively, the indexer treats any balance increase not explained by events as a deposit.

---

## M-2 Medium: intent outcomes are never recorded

**Where:**
- `intents.rs:258-270`: `intent_authorized` is the last event for a filled or expired intent.
- `intents.rs:70-72`: an expired intent is simply overwritten by the next request.

**The problem:**
- No `trade` event is emitted for an intent fill. An observer cannot tell from vault events whether intent #n filled or expired. It would have to index intents.near's own events by nonce.
- An expired, unfilled intent keeps its cap reserved for the rest of the day. That is safe, but it is never reconciled.
- There is also no `request` event for the intents path, unlike `lib.rs:191`. A later `failed` event therefore references a seq that has no request.

**Impact:** a P&L built from vault events alone either misses intent trades or must assume every authorized intent filled at `min_amount_out`. Either way, the leaderboard can be wrong in both directions.

**Minimal fix:** add a permissionless `intents_settle()`. After the deadline, or at any time, it views intents.near `is_nonce_used(vault, nonce)`:
- If used, it emits `trade {venue: "intents", amount_out: min_amount_out}`.
- If the deadline has passed and the nonce is unused, it emits `intent_expired` and releases the cap.

Also emit `request` in `request_intent_swap`.

---

## M-3 Medium: `freeze` leaves a signed intent fillable

**Where:**
- `lib.rs:329-335`: freeze only sets the flag.
- `lib.rs:479`: the flag is checked only in `check`.
- `intents.rs:226-255`: the intent callbacks do not re-check `frozen`.

**The problem:**
- After the owner freezes, an `Open` intent stays fillable until its deadline (up to 300 s). An intent in `Quote` or `Sign` still goes on to be signed and authorized.
- A Rhea swap in flight also completes.

**Attack:**
1. The compromised agent gets a bad intent signed (H-1).
2. The owner notices and calls `freeze`.
3. The attacker's solver fills the intent anyway.

**Impact:** the panic button does not stop the one trade that is about to hurt. That is at most one per-trade cap (50 USDC).

**Minimal fix:**
- In `on_intent_quote`, if `frozen`, call `intent_fail`.
- Document the emergency runbook: `freeze`, then `intents_withdraw` of the full intents balance. This is one direct call, faster than the MPC-based `intents_cancel`, and the intent becomes unfillable for lack of balance.
- Optionally, have the owner's `freeze` start `intents_cancel` automatically.

---

## M-4 Medium (needs verification): an unparsable but successful MPC reply releases the cap

**Where:**
- `intents.rs:260-263`: `mpc_result().and_then(signature_from_mpc)` returning `None` leads to `intent_fail`, which releases the cap and clears `open_intent`.
- `intents.rs:21`: `MAX_MPC_RESULT = 512`.

**The problem:** the MPC's signature is part of its receipt outcome, which is public. If the MPC succeeds but the vault cannot parse the reply, the vault releases the cap and allows a new intent, while the agent can rebuild the old signed intent from chain data. Ways this could happen:
- the reply schema changes (for example, a wrapper or a different field name);
- the reply grows past 512 bytes;
- the recovery id is greater than 1.

Repeating this gives several fillable intents of 50 USDC each, with the cap released every time. That removes the daily cap entirely.

**Test that settles it:** a mock-mpc variant that returns a valid signature in a slightly different JSON shape. Assert that the cap stays reserved, and that the signature taken from the receipt still settles on intents.near in the sandbox.

**Minimal fix:**
- Release only when the promise result is `Failed`.
- On an unparsable success, keep the intent `Open` until the deadline, without releasing. Reconcile through M-2's `intents_settle`.

---

## M-5 Medium (needs verification): an intent stuck mid-flow blocks trading for good

**Where:**
- `intents.rs:70-72`: `live()` is `true` for every stage except `Open`, with no time limit.
- `lib.rs:427-433`: `clear_stuck` handles only `in_flight`.

**The problem:**
- A callback that panics, for example by running out of gas, rolls back its own state changes. The intent then stays in `Quote`, `Sign` or `Cancelling` for good.
- While it is stuck, both venues return `busy`.
- The vault has no keys and cannot be upgraded, so trading is permanently dead. Funds stay withdrawable.

**How tight the gas is:**
- `on_intent_quote` gets 175 Tgas and attaches 165 Tgas to its children, which leaves 10 Tgas for JSON, hashing and receipt creation.
- `on_cancel_signed` gets 65 Tgas and attaches 60 Tgas, which leaves 5 Tgas.

**Test that settles it:** a mainnet-equivalent gas profile on testnet with the real `v1.signer-prod.testnet`. Also a sandbox test that forces an out-of-gas in `on_cancel_signed`, for example with a padded payload, and asserts the vault can recover.

**Minimal fix:**
- Extend `clear_stuck` to `open_intent` once `STUCK_NS` has passed since `started_at`.
- Clearing must not release the cap unless intents.near `is_nonce_used` is false and the deadline has passed.
- Also make `live()` false once `now ≥ deadline_ns` for `Cancelling`.

---

## M-6 Medium: caps are per token and per calendar window

**Where:**
- `lib.rs:467-473`: `rolled()` uses `now / DAY_NS` and `now / HOUR_NS`.
- `lib.rs:489-492`: `spent` is tracked per `token_in`.

**The problem:**
- Day and hour windows are fixed UTC buckets, not rolling windows. Any 24 h span can contain 2× `max_per_day`.
- In the same way, two trades can straddle an hour boundary even with `max_trades_per_hour = 1`. Trades must run one after another (`busy`), but each Rhea chain takes only about 6–8 blocks.
- Caps are in `token_in` units and apply to each token separately. Value turnover per day is therefore Σ over tokens of `max_per_day × price`, and the value of a non-stable cap moves with the price.

**Attack:**
1. 23:59:40: two 50 USDC trades.
2. 00:00:05: two more.
3. Then wNEAR trades on the same schedule.

**Impact:** see table row D. The documented bound understates the risk by 2× per token.

**Minimal fix:** either document the real bound, or use a rolling window. A cheap option is two half-day buckets, `spent = prev × (remaining fraction) + current`, which keeps state fixed. Optionally add a value cap across all tokens, which needs the price band from H-1.

---

## L-1 Low: `accept_owner` does not re-check owner ≠ agent

**Where:** `lib.rs:371-376` and `lib.rs:388-395`

**Sequence:**
1. `propose_owner(X)` passes, because X ≠ agent at that time.
2. `set_agent(X)` passes, because it only checks against the current owner.
3. X calls `accept_owner`, and now owner == agent.

**Impact:** if the agent account's full-access key lives on the bot box, compromising the box now means compromising the owner, which allows `withdraw`. This needs a careless owner.

**Fix:** in `accept_owner`, require `who != self.agent_id`. In `set_agent`, also reject `proposed_owner`.

## L-2 Low: tightening the policy is also timelocked

**Where:** `lib.rs:346-361`

**The problem:** an owner who sees abuse cannot lower the caps or delist a thin pool for 24 h. The only immediate option is `freeze`, which stops all trading. Also, `propose_policy` silently replaces any pending proposal; there is no `replaced` marker, so observers have to infer it.

**Fix:** apply a policy at once if it is strictly tighter: tokens and pools are subsets, every cap is ≤ the current one, slippage is ≤, and the rate is ≤. Otherwise keep the timelock. Emit `policy_proposed {replaces: bool}`.

## L-3 Low: receipt hashes are not unique or bound, and decision counts can be spammed

**Where:**
- `lib.rs:139-141`: only the format is checked.
- `lib.rs:204-210`: `log_skip` has no limit.
- refusals are also unlimited.

**The problem:** an agent, or a cheating owner using the agent key, can reuse one receipt for many trades, attach hashes that point at nothing, and inflate `decisions` and `refused` counts for the cost of gas. The binding between a receipt and a trade is enforceable only off chain.

**Fix:**
- Off chain: the indexer verifies that each receipt's preimage commits to `(vault, seq-1 state, pool, tokens, amount, min_out)`, and flags duplicates.
- On chain, optionally keep a bloom filter or the last N hashes.

## L-4 Low: an allowlisted malicious token can forge `deposit` events

**Where:** `lib.rs:294-302`

**The problem:** the method trusts `predecessor ∈ allowlist` and the `sender_id` the token reports. A careless owner who allowlists a hostile contract lets it call `ft_on_transfer(owner, X)` without moving anything. That produces fake deposits, which lower that bot's return, so this is griefing only. A stranger calling directly is refunded and emits nothing, which is safe.

**Fix:** record the deposit only after confirming the balance. Simpler: rely on the book balances from M-1.

---

## Info

- **I-1:** owner events (`deposit`, `withdraw`, `policy_*`, `agent_set`, `freeze`) carry no `seq`. Ordering against decisions needs the block height and receipt index. `pool_id` and `seq` are JSON numbers (u64), so JS indexers lose precision above 2^53. This does not matter at today's sizes.
- **I-2:** indexers must accept `EVENT_JSON {"standard":"irontrade"}` only when the receipt executor is a registered vault. The vault's code hash must equal the audited build, and its account must have no access keys. Any contract can emit the same JSON. The sandbox proves the vault cannot be redeployed; the leaderboard must check the other two conditions.
- **I-3:** `set_agent` takes effect at once. The contract cannot prove an AI made the decisions: an owner can switch to a hand-run key, and `agent_set` is the only trace. A leaderboard should show agent changes.
- **I-4:** expiry boundary. The vault treats an intent as dead at `now ≥ deadline_ns`. If intents.near accepts `now == deadline`, two intents could be fillable in one instant. The caps still hold because expired intents are never released. Verify intents.near's comparison.
- **I-5:** intents.near protocol fee on `token_diff`. The sandbox shows the vault receives exactly the floor, but sandbox fee settings may differ from mainnet. Verify against mainnet `fee()` whether the vault's credit is net of the fee. If it is, the effective floor is lower again.
- **I-6:** with a leftover exchange balance ≥ the trade amount, `on_verify` (`lib.rs:287`) reports `returned:false` when the tokens did arrive. This is already documented. It is conservative for the caps but misleading in the record.
- **I-7:** if Rhea `swap` succeeded but returned something unparsable, `on_swap` (`lib.rs:257-261`) would take the failure branch and withdraw `token_in`, which would fail. The record would then show "swap failed" for a trade that happened. This is theoretical, since Rhea returns `U128`.
- **I-8:** if `apply_policy` lands between `request_*` and its quote callback, the new `max_slippage_bps` applies to that in-flight trade. The policy was public for 24 h, so this is acceptable.
- **I-9:** a leaderboard computing returns with deposits and withdrawals mid-season should use time-weighted returns (Modified Dietz or TWR). Otherwise, timing the flows changes the percentage.

## Checked and found safe

- **`floor()`** (`lib.rs:45-48`): `⌊q/10⁴⌋·k + ⌊(q mod 10⁴)·k/10⁴⌋` equals `⌊q·k/10⁴⌋` exactly, because the first term is an integer. There is no overflow for any u128, since k ≤ 10⁴ and the second term is below 10⁸. `validate` bounds `slippage_bps` at 500, so `10_000 − bps` cannot underflow.
- **Cap arithmetic:** `reserve` adds only after `spent.saturating_add(amount) ≤ max_per_day`, so `a.0 += amount` cannot overflow. `trades` is bounded at 60. `release` saturates. `deadline_s × 1e9` fits in u64 until the year 2554.
- **Reserve and release pairing:**
  - Refusals never reserve.
  - Rhea releases only on quote failure, min above quote, deposit refused (`used == 0`), or failed swap with the input verified back.
  - Partial deposit, an unverified return, and `clear_stuck` keep the cap.
  - Intents release only on quote or sign failure (but see M-4) and on a proven nonce burn.
  - The trades counter is never decremented.
- **Cross-midnight release:** a release can land in a later day bucket only if no new reservation could have happened in between. Both venues are `busy` until the earlier operation ends, and an expired intent cannot be cancelled. So a release never subtracts from another day's real spend.
- **Venue interplay:** one `busy` check covers `in_flight` and any live intent, so the Rhea and intents paths cannot run at once. Both paths share caps and the rate limit.
- **Alternating tokens or directions** gives no more than the per-token caps. Each leg is charged to its own `token_in`. A round trip uses both caps and cannot exceed either.
- **Cancel race:** the burn and a fill are mutually exclusive through the intents.near nonce. A failed burn (filled, expired or past the deadline) keeps the cap. The sandbox test `cancel_burns_the_nonce_and_releases_the_cap` proves an empty intent with the same nonce burns it and that the cancelled intent cannot settle afterwards.
- **`min_amount_out`:** zero is refused. The agent's minimum is raised to the floor and never lowered. On Rhea, a minimum above the quote fails before funds move. Rhea enforces the minimum on chain.
- **Timelock:** only one pending policy at a time, and a new proposal resets the timer. `apply_policy` checks the time before changing anything. A stranger can apply only what the owner proposed and left pending for 24 h. There is no ordering that bypasses the timelock.
- **Stranger surface:**
  - All callbacks are `#[private]`, proven in the sandbox.
  - `ft_on_transfer` from a non-token refunds and emits nothing.
  - `apply_policy` and `accept_owner` are gated.
  - Strangers cannot grow state or emit events.
  - State is fixed-size: `usage.spent` holds at most the policy's tokens plus any delisted tokens until the day rolls over.
- **NEAR balance:** the vault spends only 1 yocto per hop, and the caller pays gas. `withdraw_near` keeps the storage stake plus 0.5 NEAR, which covers the largest transient state (pending policy and open intent, under 2 KB, about 0.02 NEAR). No stranger can drain NEAR.
- **`clear_stuck`:** does not release the cap and ignores late callbacks by `seq`. `exchange_withdraw` is blocked while a swap is in flight.
- **Intents signing scope:** the payload is built only from vault state with `json!`, so values are escaped. The derivation path includes the vault as predecessor, so no other contract can get this key's signatures.
- **`assert_owner`** requires 1 yocto, so a function-call key cannot act as the owner.

## Tests recommended

1. M-4: a mock-mpc that returns a valid signature in an altered schema. Assert the cap stays reserved and the signature from the receipt still settles.
2. M-5: force an out-of-gas in `on_intent_quote` and `on_cancel_signed`. Assert the vault can recover. Run on testnet with the real MPC to measure the remaining gas margin.
3. H-1: a sandbox test with a second, thin allowed pool. Move it, call `request_intent_swap` using it as the quote pool, fill as solver, and assert the policy refuses or bounds the result (after the fix).
4. H-2: `withdraw` of more than the balance. Assert that no `withdraw` event survives (after the fix).
5. M-6: a property test that runs over a midnight boundary and asserts the rolling-window bound, or documents the 2× bound.
6. I-4 and I-5: check intents.near v0.4.5's deadline comparison and its mainnet `fee()` against the vault's assumptions.
