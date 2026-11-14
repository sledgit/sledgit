# Round 1 audit: access control and asynchronous execution

Scope: `contracts/vault/src/lib.rs`, `intents.rs` (every line), `policy.rs`. near-sdk 5.29.1. Tests in `src/tests.rs` and
`tests/sandbox.rs` were read for coverage but not relied on. Baseline: NEAR `near-contract-audit` checklist (high, medium
and low detectors). Also ran a gas probe: a copy of the crate in a scratch directory, with an extra sandbox test that
prints `gas_burnt` per receipt for `request_swap` (235 Tgas), `request_intent_swap` (200 Tgas) and `intents_cancel` (240 Tgas)
against real Rhea, the real intents.near build and the mock MPC. The repo was not modified.

## Summary

| ID | Severity | Title |
|----|----------|-------|
| H-1 | High | Price floor comes from a spot quote the agent can move. On intents, the agent can fill its own intent at the floor. |
| M-1 | Medium (High if the MPC reply format ever changes) | A "signing failed" result releases the caps and clears `open_intent`, but a valid signature may still exist |
| M-2 | Medium | `open_intent` can get stuck for good. There is no owner escape, so trading on both venues stops permanently. |
| L-1 | Low | `freeze` does not stop an intent that is already signed, or a swap that is in flight |
| L-2 | Low | `on_verify`'s `held < amount` check is wrong when a balance is already left on Rhea |
| L-3 | Low | A stranger's `apply_policy` mid-flight changes the slippage used for a request that was checked under the old policy |
| I-1..I-6 | Info | See the end |

Areas where nothing serious was found are listed explicitly in "Checked and clean".

---

## H-1: The slippage floor is anchored to a manipulable spot quote. The agent can extract value (both venues; worst on intents).

**Where:** `lib.rs:215-222` (`on_quote`), `intents.rs:226-233` (`on_intent_quote`).

The only price protection is `floor(get_return(pool, ...), max_slippage_bps)`. `get_return` is Rhea's spot output at the
moment the callback runs. The agent picks the pool (any allowed pool), the timing, and its own `min_amount_out` (it may send `1`).

**Exploit A (intents, no manipulation, risk-free):**
1. The agent calls `request_intent_swap(pool, USDC, wNEAR, max_per_trade, min_amount_out=1, h)`.
2. `on_intent_quote` sets `min_out = floor(quote) = quote * (1 - bps/10_000)` and signs a `token_diff` in which the vault
   receives **exactly** `min_out`. A `token_diff` is exact; the vault never gets more than that.
3. Acting as a solver (any intents.near account), the agent fills the intent from `intent_authorized.multi_payload`. It
   pays `min_out` wNEAR and gets `amount_in` USDC.
4. The agent sells the USDC on Rhea for about `quote`. Profit is about `bps * quote` per trade, up to 5% at the
   policy maximum, repeated until the daily cap is used up, every day.

On Rhea the swap fills at the market price, so the tolerance is only lost if the price moves. On intents the vault is
guaranteed to give the whole tolerance away.

**Exploit B (both venues, manipulation, limited only by the caps):**
1. Before the request, the agent (or a searcher watching the agent's transactions) sells `token_in` into a thin allowed
   pool, which pushes `get_return` down.
2. The request goes in. The quote and the floor are read from the manipulated state. On intents the agent's own
   `min_amount_out=1` means the floor is the only bound. On Rhea `on_quote` only rejects `min > quote`, never a min that is too low.
3. Intents: once `intent_authorized` is emitted, the agent reverses the pool trade and fills the intent at leisure (the
   window is 300 s). Rhea: the agent back-runs after the vault's `swap` receipt (a sandwich across about 3 blocks).

Loss per trade is bounded by `max_per_trade` and per day by `max_per_day`, but within those bounds it can approach 100% of the input.

**Fix (minimal):** derive the floor from a price the agent cannot move inside the request window. Options: an
owner-set price band per pair that changes only through the same 24 h timelock, or an oracle (`priceoracle.near` or
Pyth) with a staleness check, with `min_out = max(agent_min, oracle_floor, quote_floor)`. For intents, also set the
signed amount to `quote` (or `quote` less a much smaller intents-only tolerance) rather than the full Rhea slippage
floor, because a `token_diff` hands the whole gap to the filler.

**Test to add:** in the sandbox, have `lp` sell a large amount of USDC into the pool, call `request_intent_swap` with
min=1, reverse the trade, fill with `Solver`, and assert the vault received less than X% of the pre-manipulation quote. It will.

---

## M-1: Signing "failure" releases the cap and clears `open_intent`, but a valid signature may exist

**Where:** `intents.rs:259-262` (`on_intent_signed` failure branch to `intent_fail`), `intents.rs:327-333`, and
`mpc_result` with `signature_from_mpc` (`intents.rs:124-140`). Unit test `signing_failure_releases_cap` asserts this behaviour.

`on_intent_signed` treats "I could not parse a signature" as "no signature exists". Two ways that is false:

- **Parse failure on a successful sign.** The MPC is an upgradable contract and the vault is immutable. If the reply
  format changes (different field names, an extra wrapper, more than `MAX_MPC_RESULT` = 512 bytes, `recovery_id` > 1),
  `signature_from_mpc` returns `None`. The real signature is still public, in the MPC receipt's `SuccessValue`.
- **Late response after a yield timeout.** MPC `sign` uses yield/resume. If the nodes respond after the roughly
  200-block timeout, the vault's callback sees a failure. The nodes' `respond` transaction still carries the signature
  in its public arguments. The intent deadline is 300 s and the timeout is about 2-3 min, so the leaked signature can
  still be valid.

**Exploit (parse-failure case, which repeats):**
1. The agent calls `request_intent_swap(...)`. The cap is reserved.
2. MPC signs, the vault fails to parse, `intent_fail` releases the cap and sets `open_intent = None`. The agent reads the
   signature from the MPC receipt and rebuilds `multi_payload` (the payload string is in the vault's own callback args).
3. The agent repeats at once. Each round produces another valid signed intent with a fresh nonce, live for 300 s.
4. The only remaining bound is `max_trades_per_hour` (≤ 60), because `release` does not give back `trades`. The daily
   cap and the one-open-intent rule are both bypassed. Combined with H-1, each intent fills at the floor.

**Impact:** cap and single-open-intent invariants broken. Value at risk is up to `max_trades_per_hour × max_per_trade`
per hour instead of `max_per_day`.

**Fix:** once a sign request has been sent, never release the cap and never clear the record on failure. In
`on_intent_signed`'s failure branch, set `stage = Open` (or a new `Unknown` stage that `live()` treats as live until
`deadline_ns`), keep the reservation, emit `intent_sign_unknown`, and let it expire. Losing 5 minutes of trading is the
safe failure. If the cap must come back early, the only sound way is a nonce burn through `intents_cancel` (which must
then accept this stage).

**Test to add:** unit test with `on_intent_signed` given `PromiseResult::Successful(b"{\"unexpected\":1}")`. Assert the
cap is still reserved and `request_intent_swap` is refused as `busy` until `deadline_ns`.

---

## M-2: `open_intent` can get stuck permanently; no recovery path exists

**Where:** `intents.rs:70-72` (`live()` returns true for every stage other than `Open`, with no time bound),
`lib.rs:480` (`check` refuses both venues while it is live), `lib.rs:427-433` (`clear_stuck` covers `in_flight` only).

If any intents callback panics, `open_intent` stays in `Quote`, `Sign` or `Cancelling` forever. `check()` then returns
`busy` for **both** `request_swap` and `request_intent_swap`, and `intents_cancel` needs `stage == Open`. The contract
has no keys and cannot be upgraded, so trading is gone for good. Funds are still safe: `withdraw` and `intents_withdraw`
are not blocked. The only remedy is to deploy a new vault.

Ways to get there:
- Out of gas in `on_intent_quote` (175 Tgas exact, weight 0, 165 committed to children), `on_intent_signed` (15 Tgas
  exact), `on_cancel_signed` or `on_cancelled`. The probe shows enough margin today with the mock MPC (vault callbacks
  burn about 1.6-2.5 Tgas each). It has not been measured against the real `v1.signer`, which uses yield/resume.
- Any future host or protocol change that makes one of these callbacks trap (the vault cannot be patched).
- The Rhea path has the same risk, but `clear_stuck` covers it after 15 minutes. The intents path has no equivalent.

**Fix:** add an owner-only `intents_clear_stuck` (1 yocto):
- `Quote`: allowed after `started_at + STUCK_NS`. No sign request has been sent, so releasing the cap is safe.
- `Sign` or `Cancelling`: allowed only once `now >= deadline_ns`. By then any signature that exists is dead. Do not
  release the cap (M-1).

Better still, also make `live()` time-bounded for `Sign` and `Cancelling` (`now < deadline_ns`) once `deadline_ns` is
set, so the vault recovers on its own without the owner.

**Test to add:** unit test that leaves `open_intent` in `Sign` (do not call `on_intent_signed`), advances time by a
day, and asserts `request_swap` returns `busy` and that no owner method clears it. That test documents the bug today.

---

## L-1: `freeze` is not a full brake

**Where:** `lib.rs:329-335`. `freeze` only makes `check()` refuse new requests. A signed `Open` intent can still be
filled for up to 300 s, and an in-flight Rhea chain keeps going (it uses the floor computed before the freeze). An agent
or owner who freezes because the agent looks compromised (for example during H-1 exploit B) still leaves the last
intent fillable.

**Fix:** document that freezing needs `intents_cancel` as well, or have the owner's freeze path tell the operator when
`open_intent` is live. A real "freeze and cancel" needs 240 Tgas and could be a separate method.

## L-2: `on_verify` heuristic is wrong when a residual balance is already on Rhea

**Where:** `lib.rs:285-289`. `back = held < amount`. If an earlier partial deposit, a swallowed payout, or a chain
cleared by `clear_stuck` left `R ≥ amount` of the same token on Rhea, a successful withdraw is recorded as
`returned: false`. In the failed-swap branch the cap is then kept (`input_safe=false`) even though the input came back.
This is conservative for funds (no false "returned"), but the public record is wrong and the cap is lost for the day.

**Fix:** read `get_deposit` before the withdraw (or pass the pre-withdraw balance along) and compare the change:
`back = before - held >= amount`.

## L-3: `apply_policy` (anyone) can land between request and quote

**Where:** `lib.rs:355-361` vs `lib.rs:218`, `intents.rs:231`. The request is checked under policy P1, but
`on_quote`/`on_intent_quote` read `self.policy.max_slippage_bps` at callback time. A stranger can time `apply_policy`
so that an in-flight request runs under P2's slippage. The change was public 24 h in advance and the owner chose it,
so impact is small.

**Fix:** store `max_slippage_bps` in `InFlight`/`OpenIntent` when the request is made.

---

## Info

- **I-1 Expired intents never release their cap** (`intents.rs:70`, overwritten at `intents.rs:214`). The vault cannot
  tell filled from expired, so keeping the cap is the correct conservative choice. Mentioned only because an agent that
  requests intents nobody fills can burn the day's cap (it already holds that power through `freeze`).
- **I-2 `on_deposit` relies on a NEP-141-standard return value** (`lib.rs:236`). A token that returns a non-string
  `U128` (or more than 128 bytes) is read as `used = 0`, so the cap is released while the tokens sit on Rhea. Funds stay
  with the vault, and only owner-allowlisted tokens can reach this. Allowlist only standard tokens.
- **I-3 `on_intents_key` stores `intents_key` before `add_public_key` is confirmed** (`intents.rs:167`). If the
  registration fails, intents get signed that intents.near rejects. Harmless; the owner can rerun `intents_setup`.
- **I-4 External dependencies the immutable vault cannot follow:** the intents.near nonce format and `execute_intents`
  semantics (the cancel relies on an empty-intents payload burning the nonce, which the sandbox proves for the pinned
  build), Rhea's `withdraw`/`get_deposit` behaviour, and the MPC reply format (see M-1). An upgrade to any of these can
  silently change behaviour. Pin the reviewed code hashes in the docs and recheck them before each deposit.
- **I-5 `set_agent` does not check `agent_id != proposed_owner`** (`lib.rs:371-376`). The owner could end up with
  owner == agent through propose → set_agent → accept. This is an owner mistake only.
- **I-6 Gas** (measured, mock MPC):

  | Chain | Prepaid floor | Static allocations | Vault receipts burnt | Result |
  |---|---|---|---|---|
  | `request_swap` | 235 | 10 + 205, then 60 + 135, then 30 + 95, then 60 + 25, then 10 + 10 | 1.7-2.4 Tgas each | Completed at exactly 235 Tgas |
  | `request_intent_swap` | 200 | 10 + 175, then 150 + 15 | 2.2-2.5 | Completed at exactly 200 Tgas |
  | `intents_cancel` | 240 | 150 + 65, then 50 + 10 | 1.6-2.4 | Completed at exactly 240 Tgas |
  | `intents_setup` | none | 10 + 30, then 15 | n/a | Owner retries on failure |

  All are within 300 Tgas. The tightest is `on_cancel_signed`: 65 static with 60 passed to children. Each outgoing
  function call also prepays about 1 Tgas of execution fees, so it works only because it does *not* set
  `unused_gas_weight(0)` and so receives a share of the leftover (about 10 Tgas at 240 prepaid). Raise its static gas to
  70 or more instead of relying on that share. **Needs verification:** the same numbers against real `v1.signer` on
  testnet. Its yield/resume path, its deposit requirement and its reply shape (for example an added `scheme` field) are
  not exercised by the mock.

---

## Checked and clean

**Access control: every pub method**

| Method | Caller | Deposit | Notes |
|---|---|---|---|
| `new` | vault itself (`#[init] #[private]`) | - | Cannot be re-initialised |
| `request_swap`, `request_intent_swap`, `log_skip` | agent | none | No recipient argument. Tokens and pools come from the policy. |
| `freeze`, `intents_cancel` | owner (1 yocto) or agent | agent: any | Agent powers only make things safer (and cause DoS, by design) |
| `withdraw`, `withdraw_near` | owner, 1 yocto | | Receiver is fixed to `owner_id` |
| `exchange_withdraw`, `intents_withdraw` | owner, 1 yocto | | Receiver is the vault (Rhea pays the predecessor; `ft_withdraw` gets `current_account_id`, `msg: None`) |
| `intents_deposit`, `intents_setup`, `exchange_register_tokens`, `unfreeze`, `propose_policy`, `cancel_policy`, `set_agent`, `propose_owner`, `clear_stuck` | owner, 1 yocto | | |
| `exchange_storage_deposit` | owner | > 1 yocto | Equivalent full-access-key proof |
| `accept_owner` | proposed owner, 1 yocto | | |
| `apply_policy` | anyone, after timelock | | See L-3 |
| `ft_on_transfer` | any token | | Credits only an allowlisted token, sent by the owner. A fake token cannot use an allowlisted account name. |
| All 10 callbacks | `#[private]` | | `on_quote`, `on_deposit`, `on_swap`, `on_withdraw`, `on_verify`, `on_intents_key`, `on_intent_quote`, `on_intent_signed`, `on_cancel_signed`, `on_cancelled` |

- No path lets the agent or a stranger reach owner powers, or send funds anywhere except the owner, the vault, the
  vault's Rhea account or the vault's intents.near account. The vault creates promises only to `exchange_id`, policy or
  owner-named tokens, `intents_id`, `mpc_id` and itself, and only with arguments it builds itself. There is no way to
  forward arbitrary calls.
- MPC signing is reached only with payloads the vault builds: a `token_diff` over policy tokens, or the empty cancel
  payload. Token IDs are `AccountId`s and cannot inject JSON. `signer_id`, `verifying_contract`, deadline and nonce are
  set by the contract. Only this contract can get signatures for its derived key.

**Async state**
- Stale or mismatched seq: every Rhea callback filters on `in_flight.seq`. `on_intent_quote` and `on_intent_signed`
  filter on seq and stage. `on_cancel_signed` and `on_cancelled` filter on seq. A stale callback returns without
  creating promises, so a chain cleared by `clear_stuck` stops at its next hop.
- Caps are never released twice: `fail`, `intent_fail` and `on_cancelled` each `take()` or clear the record in the same
  receipt as the release. On the Rhea path, a release happens only when the input is known to be back (quote failed,
  full refund on deposit, or the failed-swap withdraw verified).
- Interleaving: while a chain is live, `check()` blocks new requests on both venues. Owner `withdraw` during a chain
  only makes the deposit fail, and the full refund is handled. `exchange_withdraw` is blocked while `in_flight`.
  Releases that cross midnight act on the old day's record and are harmless.
- Cancel race against a solver fill: the nonce burn fails, `stage` returns to `Open`, and the cap stays spent, which is
  correct. A successful burn proves the intent was not filled, so the release is correct. The sandbox shows the
  cancelled intent cannot settle afterwards.
- Rhea "success that did not happen": the swallowed `withdraw` payout is handled by `get_deposit` verification (L-2
  aside). Partial deposits are handled. A swap failure withdraws the input.
- `in_flight` cannot stay stuck forever: `clear_stuck` recovers it after 15 minutes. `open_intent` can (M-2).
- No reentrancy: no inbound callback (`ft_on_transfer`) touches swap state.
- Checklist items: no storage collections, so no prefix collisions or unsaved changes; `U128`/`U64` used at the JSON
  boundary; `overflow-checks = true` in the release profile; nonce randomness is used only for uniqueness; state stays
  bounded (`usage.spent` ≤ tokens, one `in_flight`, one `open_intent`).

## Tests that would confirm the findings

1. H-1: sandbox test. Manipulate the pool, `request_intent_swap` with min=1, unwind, self-fill, and measure the vault's loss against the pre-manipulation quote.
2. M-1: unit test. Unparseable `Successful` MPC reply; assert the cap is still reserved and the vault stays `busy` until the deadline.
3. M-2: unit test. Leave `open_intent` in `Sign` with no callback, advance one day, and assert there is no recovery path.
4. I-6: run the gas probe on testnet against `v1.signer` with the exact prepaid floors (235 / 200 / 240).
