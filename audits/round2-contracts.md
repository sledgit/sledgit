# Round 2 contract audit: vault + factory

Scope: `contracts/vault/src/{lib.rs,intents.rs,policy.rs}` and `contracts/factory/src/lib.rs` (near-sdk 5.29.1, workspace
release profile has `overflow-checks = true`). Reference code: intents.near source (checkout d340060; the GC and nonce
code below is the same at mainnet commit 16d04f6, and the pinned `intents_mainnet.wasm` exports `cleanup_nonces`), and
the pinned Rhea binary (`rhea_exchange_mainnet.wasm`, strings checked). This review is based on the code only. Earlier
audit conclusions were not relied on.

Summary: 2 High, 1 Medium, 5 Low, plus Info items. No finding lets a stranger take funds. The two Highs let a
compromised agent, or ordinary timing, record a filled intent as expired. When that happens the vault releases the
daily cap and the public record leaves out a real trade.

---

## H-1: `on_settle` decides "expired" using a nonce check made before the deadline

`intents.rs:346-379` (the decision is at line 374)

`intents_settle` may be called at any time in the Sign or Open stages. It sends `is_nonce_used` to intents.near. Later,
`on_settle` treats `used == false` as an expiry if `o.live(env::block_timestamp())` is false. That timestamp is the
**callback's** block time, which comes after the block where the check ran. A `false` answer only means "not used yet,
as of the block where the check ran". If the deadline falls between that check and the callback, a fill can happen in
the gap.

Exploit (compromised agent, possibly acting as its own solver):
1. The agent gets an intent signed (deadline D). It holds the signed `multi_payload` (from `intent_authorized` or the
   MPC respond tx).
2. Just before D, the agent calls `intents_settle`, timed so the `is_nonce_used` check runs in block k (time < D)
   before the fill. It then submits `execute_intents` with its solver half so the fill lands in block k, after the
   check, or in any block before D. intents.near accepts while `deadline >= now` (`engine/mod.rs:66`, `expirable.rs:29`).
3. `on_settle` runs in block k+1 (time >= D). It sees `used=false` and the intent no longer live, so it emits
   `intent_expired`, calls `release(token_in, amount_in)` and clears `open_intent`.

Impact: the vault paid `amount_in` and received `min_amount_out`, but the record shows an expiry and the cap is
refunded. The agent can repeat this to trade past `max_per_day` (each fill is still at or above the band). The cap is
the main limit on losses from a compromised agent trading at the band edge. The same mis-record can also happen by
accident when an honest settle races a solver.

Fix: decide whether an expiry is possible at **call** time, and pass that to the callback. A check that runs after a
call made at or after D gives a final answer, because intents.near rejects execution after D.
```rust
// intents_settle
let may_expire = !o.live(now);
... .then(Self::ext(..).on_settle(o.seq, may_expire))
// on_settle
if used { /* trade */ }
if !may_expire { return false; }
```
(Also see Info I-1 about the boundary at `now == deadline`.)

Test (unit, existing helpers):
```rust
let seq = authorize(&mut v, 50, 1_000, 1);
let dl = v.get_intents()["open_intent"]["deadline_ns"].as_str().unwrap().parse::<u64>().unwrap();
set(acc("anyone.near"), 0, dl - 1); v.intents_settle();               // check runs before D
set_result(PromiseResult::Successful(b"false".to_vec()), dl + 1);     // callback lands after D
v.on_settle(seq);
assert_eq!(events("intent_expired").len(), 0, "a pre-deadline 'false' is not an expiry");
assert_eq!(v.get_usage().spent[0].1, U128(50));
```

## H-2: intents.near garbage-collects used V1 nonces after their deadline, so a late settle records a fill as an expiry

`intents.rs:299-305` (nonce deadline = intent deadline), `intents.rs:354-376`. Needs verification of how often
mainnet garbage collection runs. The mechanism itself is confirmed in source.

intents.near `cleanup_nonces` (`contracts/defuse/src/contract/garbage_collector.rs`, role `GarbageCollector` or `DAO`)
deletes the nonce bitmap entry of any V1 nonce once `deadline < now` (or once its salt has been invalidated). After
that, `is_nonce_used` returns `false` for a nonce that **was** used. The vault sets the nonce deadline equal to the
120-second intent deadline. From then on, whenever settlement happens after a GC pass, a filled intent is recorded as
`intent_expired` and its cap is released.

Sequence: the intent fills at time t < D. Nobody calls settle right away (a compromised agent has every reason not
to, and `check()` returns "unsettled" only to the agent). The intents.near GC runs after D. Then anyone calls
`intents_settle`, gets `used=false` and a non-live intent, so the vault emits `intent_expired` and releases the cap.
The vault's intents.near balances have changed, but the record shows no trade.

Impact: same as H-1 (cap bypass and a wrong public record). Here the agent needs no timing skill, only patience. An
owner whose agent is simply offline also gets wrong books.

Fix (choose one or both):
- Give the **nonce** a long deadline, for example the intent deadline plus 7 days. intents.near only requires
  `intent_deadline <= nonce_deadline` (`engine/mod.rs:100`), and the 120 s intent deadline still limits when the
  intent can execute. Release the cap on "unused" only if settlement happens before the nonce deadline. After that,
  emit `intent_unknown` and keep the reservation until it rolls out of the window.
- Also call `is_valid_salt(salt)` in settle. If the salt has been invalidated, the nonce may already be cleaned, so
  treat the result as unknown and do not release.
- Alternative: snapshot `mt_balance_of(vault, nep141:token_in)` at quote time (a third `.and`), block
  `intents_deposit`/`intents_withdraw` while `open_intent.is_some()`, and treat a balance drop of `amount_in` as a
  fill.

Test (sandbox with the pinned intents wasm): grant a test account `GarbageCollector` (or use the DAO account from
`setup`), authorize and fill an intent, fast-forward past D, call `cleanup_nonces([(vault, [nonce])])` with 1 yocto,
then call `intents_settle`. Today the result is `intent_expired` and spent=0. With the fix it should be `trade` (balance
method) or `intent_unknown` with the cap kept.

---

## M-1: `exchange_withdraw` records success even when Rhea kept the payout

`lib.rs:503-510` with `on_moved` at `lib.rs:401-407`

Rhea's `withdraw` ends in `exchange_callback_post_withdraw`, which returns nothing and re-credits the vault if the
`ft_transfer` failed. The swap path knows this and checks with `get_deposit` (`lib.rs:341-360`). `exchange_withdraw`
does not. `on_moved` gets `Successful([])`, fails to parse it as U128, falls back to `amount`, and emits
`exchange_withdraw` with `to: vault`.

Realistic sequence: the first swap into a token the vault has no storage registration for. The output is held on Rhea
(correctly reported `returned:false`). The owner calls `exchange_withdraw` before registering. `ft_transfer` fails
again, Rhea re-credits, and the vault emits a success event even though nothing moved. (The sandbox test
`payout_to_unregistered_vault_is_detected_and_recoverable` registers the vault first, so it never exercises this
path.)

Impact: the public record wrongly shows funds back in the vault. No funds are lost. This breaks the stated rule that
withdraw/deposit events are emitted only after success.

Fix: give `exchange_withdraw` the same check as the swap path: `withdraw → get_deposit(vault, token) → on_moved_checked`.
Record success only if `held_after < held_before` (read `held_before` in a first view, or pass the amount and use
`held < amount` the same way `on_verify` does, noting the false negatives below).

Test (sandbox): `setup(false)`, swap, then `exchange_withdraw` **without** registering. Assert no `exchange_withdraw`
event, an `exchange_withdraw_failed` event, and an unchanged Rhea deposit.

---

## L-1: The Rhea lostfound path. The vault cannot claim, and `on_verify` would report "returned" (needs verification)

`lib.rs:356-360`, `lib.rs:501-510`

The pinned Rhea binary contains "has not enough storage. Depositing to owner or user lostfound account." and
`claim_lostfound`. If Rhea's failed-payout re-credit takes that path, the funds leave the vault's `get_deposit` balance.
`on_verify` then sees `held < amount` and records `returned: true`. On the swap-failure path it also releases the cap.
The vault has no method that calls `claim_lostfound`, so those funds can only come back through Rhea's owner.

Preconditions: the vault's Rhea storage is under-covered at re-credit time, or the token was unregistered. The vault
never unregisters, so this is an edge case.

Fix: add an owner-only `exchange_claim_lostfound(token)` with a 1-yocto check, matching Rhea's real signature. In
`on_verify`, treat "returned" as proven only when the vault's own `ft_balance_of` went up. That costs one more view,
but it is the only check that proves the tokens arrived.

Test: sandbox: shrink the vault's Rhea storage (or use a mock exchange that routes to lostfound), force a failed payout,
and assert that `returned` is not `true`.

## L-2: `intents_setup` can be bricked permanently

`intents.rs:189-220`

If intents.near registers the key but `on_key_registered` (5 Tgas static) fails, for example because the owner
attached too little gas, then `intents_key` stays `None`. Every retry then calls `add_public_key` again, and
intents.near panics with `PublicKeyExists` (`engine/state/cached.rs:148`). The result is `None`, so the key is never
stored. The vault has no keys, so the intents path is disabled for good.

Fix: in `on_key_registered`, when the add fails, confirm with a `has_public_key(vault, key)` view before giving up. Or
make the first step a `has_public_key` check and skip `add_public_key` if the key already exists.

Test: unit test: `on_intents_key` → simulate a panicked `on_key_registered` (no state change) → call `intents_setup`
again with `add_public_key` returning `Failed` → assert that the vault can still reach `intents_key = Some`.

## L-3: A nonce burned by a cancel can be recorded as a trade

`intents.rs:362-373`, `intents.rs:416-430`

`is_nonce_used` cannot tell a solver fill from the vault's own empty-intent burn. If `execute_intents` (the cancel)
succeeds but `on_cancelled` fails to run its body (gas), or runs after a settle whose check followed the burn (only
possible once the Cancelling stage has passed the deadline), the vault records `trade` with `amount_out =
min_amount_out` for something that never traded. For caps this errs on the safe side (the reservation is kept), but
the record is wrong.

Fix: in `intents_cancel`, record `burn_attempted = true` on the intent. In `on_settle`, when `used && burn_attempted`,
emit `intent_settled_ambiguous` rather than `trade` (or use the balance check from H-2).

Test: unit test: cancel → `on_cancel_signed` OK → skip `on_cancelled` → advance past the deadline → `intents_settle`
returns `true` → assert no `trade` event.

## L-4: Factory names are first come, first served, and the owner is unrelated to the creator

`factory/src/lib.rs:52-66`

Anyone can see a pending `create_vault(name, ...)` and front-run it with the same name. The victim's batch fails at
`CreateAccount` and the victim is refunded, but the attacker now holds the name, for example `acme.factory`, with an
attacker-chosen owner. The attacker can also create vaults that name any account as `owner_id`. That is harmless for
funds but useful for impersonation.

Fix: namespace vault names by creator (for example, require `owner_id == predecessor`), or make UIs show `owner_id`
prominently and never trust the name.

Test: sandbox: two creators race the same name, and the second is refunded (already covered). A new assertion would
check that `owner_id != predecessor` is rejected, if that rule is adopted.

## L-5: The factory refund depends on the failed batch's deposit refund arriving first (needs verification)

`factory/src/lib.rs:69-79`

On failure, `on_created` sends the creator the full `deposit`. The `deposit - LISTING_FEE` that went to the failed
batch comes back in a separate system refund receipt. nearcore deducts a transfer's deposit when the promise is
created, so if `on_created` runs before that refund is credited and the factory's free balance is below `deposit`,
`on_created` panics with BalanceExceeded. The creator is then never refunded, and the refund ends up stuck in a keyless
factory with no withdraw method. I believe nearcore generates the refund receipt before the outgoing data receipt
(`apply_action_receipt`), so the refund should be applied first, but I did not confirm this against the current
runtime, including congestion-control buffering.

Fix (cheap, removes the dependency): refund only what is certainly present, or keep a factory float of at least
`max_deposit` and cap `deposit` at that value (`require!(deposit <= MAX_DEPOSIT)`).

Test: sandbox: factory with near-zero spare balance, create with a large deposit and a bad policy, then assert the
creator's balance is back to the original minus gas.

---

## Info

- **I-1 Off-by-one at the deadline** (`intents.rs:86`, `intents.rs:389`). The vault's `live()` uses `now < deadline`,
  but intents.near accepts `deadline >= now`. An intent can still fill in a block whose timestamp equals `deadline_ns`
  exactly (deadlines are whole seconds and block times are in nanoseconds, so this is very unlikely). Use
  `now <= deadline_ns` everywhere. With the H-1 fix this stops mattering for settle.
- **I-2 Hour buckets, not a true rolling 24 h** (`lib.rs:104-153`). A trade at H:59 drops out at (H+24):00, so up to
  2 × `max_per_day` can be spent in about 23 h 01 m. `trades` is a calendar-hour counter, so 2 × `max_trades_per_hour`
  can happen within about 2 minutes across an hour boundary. This is documented as a clock hour. Mention it in the
  user docs.
- **I-3 `parse_salt` can panic** (`intents.rs:122-127`) if a reply has 8 bytes but non-ASCII characters (string slicing
  at a non-char boundary). intents.near is fixed by the factory, so this is harmless. Check `s.is_ascii()` first.
  (`from_str_radix` also accepts a leading `+`.)
- **I-4 Same code, any parameters.** Anyone can `use_global_contract` the same hash on their own account (or a child
  account) and initialise it with any `exchange_id`/`intents_id`/`mpc_id`, including a fake signer. Indexers and UIs
  must check that the vault is a direct child of the factory, not just the code hash.
- **I-5 Tightening the policy is also timelocked.** A careless owner who wants to lower caps after a suspected agent
  compromise waits 24 h. The right levers are `freeze` / `set_agent` / `intents_cancel`, so document them.
- **I-6 The factory keeps `LISTING_FEE` forever.** It has no withdraw method and no keys. That is acceptable as a
  storage reserve, but over-collected fees are lost.
- **I-7 `Usage.spent` is never pruned** when tokens leave the policy (24 × 16 bytes per token). Growth is bounded only
  by the owner's policy history.
- **I-8 Gas-dependent mis-records when the owner chooses the gas.** If a token's `ft_resolve_transfer` runs out of gas
  in `intents_deposit`, the deposit is recorded as `_failed` even though it happened. The same applies to Rhea
  `on_deposit`: a "deposit failed" result releases the cap while the tokens are on Rhea. Not exploitable by others,
  because the agent must attach at least 235 Tgas and the 60 Tgas `ft_transfer_call` budget is enough for these
  receivers.
- **I-9 `on_moved` fallback.** Any non-U128 success reply (for example, a non-standard token returning a JSON number
  `0`) is recorded as success at the requested amount. That is fine for NEP-141 tokens.
- **I-10 `on_verify` gives false "not returned" results** when the vault already had a balance of the same token on
  Rhea. This errs on the safe side (caps are kept and the note says "held"), but it can confuse records.

---

## Checked and found safe

- **Callbacks.** All 13 vault callbacks and the factory's `on_created` are `#[private]`. Each one re-checks `seq`, and
  for intents also the stage. Late or stale callbacks after `clear_stuck`, settle or fail are ignored.
- **Access control.** Owner methods require exactly 1 yocto (proving a full-access key). Agent and owner separation
  holds through `new`, `set_agent`, `propose_owner` and `accept_owner`. Withdrawals go only to the owner or to the
  vault itself. `ft_on_transfer` cannot be faked: the predecessor must be an allowed token and `sender_id == owner`.
- **`new` init rule.** `is_sub_account_of` (near-account-id 2.6/3.0) checks the **direct** parent only. `#[init]`
  rejects re-initialisation. The factory only calls `new` inside the same batch as `CreateAccount`, which fails if the
  account exists, so the factory cannot be used to initialise anything else. Only the factory can create its own
  sub-accounts, so a non-factory parent cannot front-run a factory vault. For self-deployed vaults, only the account
  itself or its direct parent can initialise.
- **Usage.** `rolled_to` zeroes exactly hours (old, now], or everything when gap >= 24. `sub` skips buckets that have
  been reused (`hour diff >= 24`), and that matches exactly the case where `rolled_to` reused the bucket. Every `add`
  is capped by `spent + amount <= max_per_day`, so no bucket or sum can overflow u128. The hour never goes backwards
  (block time is monotonic and every write rolls first). The cap is released only when the input is known to be safe.
  `clear_stuck` and partial or held cases keep the reservation.
- **Band.** `band_floor = ceil(amount_in·num/den)` uses checked mul, and an overflow is refused as `unpriceable`. The
  result is never 0. It is enforced both in `on_quote`/`on_intent_quote` and on-chain via the Rhea `min_amount_out`
  (= max(agent, slippage floor, band)). `floor()` cannot overflow.
- **Rhea chain.** State is written before every cross-contract call. One swap at a time, mutually exclusive with
  intents. `exchange_withdraw` is blocked while a swap is in flight. Withdraw success is checked against `get_deposit`,
  and every way that check can be wrong errs on the safe side, except the lostfound path (L-1).
- **V1 nonce.** The byte layout matches `VersionedNonce` borsh: magic `5628f6c6`, variant 0, salt [u8;4], deadline
  i64 LE ns, [u8;15], 32 bytes in total. `Salt` serialises as lowercase hex via Display, which `parse_salt` handles.
  Nonce deadline equals payload deadline, which satisfies `intent_deadline <= nonce_deadline`. The random part is
  unique per (vault, seq, block).
- **Signing scope.** The vault signs only `token_diff` payloads it builds itself, plus the empty cancel payload.
  Account IDs cannot contain JSON metacharacters. The MPC path is fixed and the derived key belongs only to this vault.
  intents.near `token_diff` takes fees from the counterparty side, so the vault pays exactly `amount_in` and receives
  exactly `min_amount_out`.
- **Cancel.** `execute_intents` with an empty intent list commits the nonce, or fails if the nonce is used or expired.
  `on_cancelled` releases the cap only on success, and a successful burn rules out any later fill. A Cancelling stage
  that never returns unblocks at the deadline (settle is allowed once it is no longer live, and `check()` reports
  "unsettled").
- **`on_moved` per kind.** `ft_transfer` (Successful empty → success, Failed → failed). NEAR transfer (same).
  `ft_transfer_call` → intents (`used` U128; refunds give 0 → failed). intents `ft_withdraw` → `ft_resolve_withdraw`
  returns `U128(used)`, 0 on a failed transfer → failed (verified in source). Rhea `withdraw`: see M-1.
- **Factory.** The batch is atomic: if `CreateAccount`, `Transfer`, `UseGlobalContract` or `new` fails, everything
  reverts, including when the global hash is unpublished or `new` rejects the policy. `new` returns no value, so the
  64-byte read cannot misclassify a success. The listing fee is kept only on success, with net-zero accounting on
  failure (subject to L-5). The fee of 0.01 NEAR covers storage for one `Vector` entry. `get_vaults` caps results at
  100. A name that passes `valid_name` but is an invalid AccountId (`a--b`, too long) panics before any promise is
  created. The deposit is refunded by the runtime when `create_vault`'s own gas is too low.
- **Gas.** Rhea: 235 Tgas minimum, and each callback reserves what the rest of the chain needs: on_quote 205,
  on_deposit 135, on_swap 95, on_withdraw 25. Intents: 230 minimum to request and 255 to cancel. The views and MPC fit
  in 300 Tgas. Callbacks with weight 0 get only their static budget, which is enough for their bounded work. Promise
  results are read with size limits (128/512/64 bytes), so an oversized reply cannot burn a callback's gas.
- **Release profile.** `overflow-checks = true` and `panic = "abort"`.
