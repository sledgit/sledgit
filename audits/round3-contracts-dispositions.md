# Round 3 contract audit: dispositions

Findings: `round3-contracts.md` (1 Medium, 5 Low, 10 Info; no Critical or High). Every PoC from the round 3 report is
now a regression test. The M-1 sandbox PoC recorded `intent_expired` with the cap released on the earlier code; on the
fixed code the same scenario records `intent_unresolved` and keeps the cap.

Build after the fixes (`cargo near build non-reproducible-wasm`; the reproducible build follows the first commit):

| Contract | sha256 (hex) | base58 | Size |
|---|---|---|---|
| vault | `172736501d8d9c1b729e82a835994fd0361701dd4774fe50e69ef3c0db475119` | `2ZP4H1ENzFKyN4nVSZf9vKf3pEpgoup9DVU6NbjbE2Gg` | 329,070 B |
| factory | `ea2e0538128ad5b337580f1328a4995887fb1a9dee0dc40bdea7ba12967aeb1d` | `Gm96uvdZgj5ZGmGhChYQ677goMn5eYnGfD8Dt56A9CPe` | 167,790 B |

The testnet factory `arena.irontrade.testnet` and its vaults still run the earlier code (`5ePvrz…`). A testnet
redeploy of the new code (a new global code publish, ~31 test NEAR, and a new locked factory) is pending test NEAR.

| # | Finding | Disposition |
|---|---|---|
| M-1 | Salt invalidation + garbage collection turned a fill into `intent_expired` and released the cap | **Fixed.** `on_settle` reads `is_nonce_used`; an unused nonce past the deadline then asks intents.near `is_valid_salt(salt)` (salt taken from the stored V1 nonce) before deciding. Salts never become valid again, so a salt still valid after the nonce read means no salt-based cleanup happened first: `intent_expired`, cap released. An invalid salt records `intent_unresolved` and keeps the cap; an unreadable answer decides nothing. `intents_settle` now needs `TG_MIN_SETTLE` = 60 Tgas (the runner attaches 100). Tests: unit `settle_state_machine` (used/unused × salt valid/invalid/unreadable × before/after the deadline × burn attempted), `nonce_salt_round_trips`, `settle_needs_gas_for_the_salt_check`; sandbox against the real intents.near: `salt_invalidation_after_a_fill_is_unresolved_not_expired` (the round 3 PoC), `unfilled_intent_with_a_valid_salt_expires_and_releases` (shows the `is_valid_salt` call matches the real binary), `unfilled_intent_with_an_invalidated_salt_keeps_the_cap` |
| L-1 | Rhea's lostfound: no way to claim, and `on_verify` could report "returned" | **Fixed, and widened.** Probing the real binary in the sandbox confirmed `claim_lostfound(token_id)`, `get_lostfound_token(account_id, token_id)` and a third path: when Rhea is short of its own spare NEAR, a failed payout goes to the **exchange's owner**, not the user's lostfound. Checking Rhea's ledgers can't see that path, so the vault now proves arrival directly: it reads its own token balance alongside the swap and again after the withdraw, and a payout counts as back only if the balance rose by the amount. Same gas budget (`TG_MIN_REQUEST` stays 235). Added owner-only, 1-yocto `exchange_claim_lostfound(token)`, recorded as `exchange_lostfound_claim` at what arrived (balance after − before). Tests: unit `payout_counts_as_returned_only_if_the_vault_balance_rose`, `lostfound_claim_records_what_arrived`; sandbox `lostfound_payout_is_detected_and_claimed` (forces a real lostfound payout on the real Rhea binary, then claims it), plus `full_swap_against_real_rhea` and `payout_to_unregistered_vault_is_detected_and_recoverable` still pass |
| L-2 | No escape for an intent settlement can't resolve | **Fixed.** Owner-only, 1-yocto `intents_abandon()`, allowed only for a signed intent at least one hour past its deadline (`ABANDON_GRACE_NS`). It records `intent_unresolved` and keeps the cap, so it can never free a cap. The auditor suggested "after the deadline"; the directive mentioned the nonce deadline, but past that (30 days) `intents_settle` already records `intent_unresolved` itself, so the escape is useful only between the two; the one-hour grace leaves settlement first try. The league treats `intent_unresolved` as a possible fill (unrank flag), so abandoning can't hide a fill from the ranking. Test: `owner_can_abandon_an_unresolvable_intent_without_freeing_the_cap` |
| L-3 | Front-running `create_vault` before the lock spent the factory name | **Fixed.** `deploy_mainnet.rs`: the canary is `canary-<12 hex>` from /dev/urandom, kept in the pending key file so a resume finds the same one; every vault the factory lists (paged) must be genuine (direct child, 0 keys, pinned code, the factory's ids) instead of "exactly the canary". `deploy_and_lock.rs`: "no vaults yet" replaced by the same genuine-vault check. Still fail-closed on a real mismatch. Tests: `canary_names_are_unguessable_and_valid`; the sandbox end-to-end run now stops on a bad canary policy (key kept), lets a third party create a vault from the unlocked factory, resumes, accepts that vault as genuine, and locks |
| L-4 | Pinned hashes can't be tied to public source | **Fixed as a plan; passes only after 1 Nov.** The mainnet script requires `IT_EXPECT_SOURCE_REV` (the commit of the reproducible build) before it will send, and checks that the factory's and the canary's NEP-330 `contract_source_metadata.build_info.source_code_snapshot` names it. A non-reproducible build has no `build_info`, so this fails today by design. Steps in the go-live checklist A.1. Test: `source_metadata_must_name_the_commit` |
| L-5 | Recorded refunds need a float for their own storage | **Fixed.** A recorded refund is the deposit less the 0.01 NEAR listing fee, which never left the factory and now pays for that record's storage (~125 B ≈ 0.00125 NEAR). Each record funds itself, so claims never deadlock however many exist at once. The comment and the `vault_create_failed` event (`pending`, `kept_for_record_storage`) say so precisely; factory event version 1.2.0. `deploy_and_lock.rs`'s spare-float default drops from 100 NEAR to 0.5 NEAR (set 100000 for a pre-change factory). Tests: `many_records_never_deadlock_claims` (300 records with storage flushed so it really grows, no float, every claim succeeds; it deadlocks on the earlier code), the updated `refund_is_recorded_when_the_runtime_refund_is_late`, sandbox `failed_creation_with_no_float_is_refunded_or_claimable` |
| I-1 | Hourly buckets: 2× the daily cap within 23 h 00 m 01 s, 2× the hourly rate across a boundary | **Kept, documented (since round 2).** The test comment is corrected ("rolls off 23 to 24 hours later"), and the two PoCs became `bucket_edges::at_most_two_daily_caps_inside_any_24_hours` and `at_most_twice_the_hourly_rate_across_a_boundary`, which pin the 2× bound so a change can't widen it unnoticed |
| I-2 | `exchange_withdraw` measured a concurrent swap's movements too | **Fixed.** `exchange_op_since` marks an owner exchange operation (withdraw or lostfound claim); `check()` reports `busy` until its last callback, or for at most `STUCK_NS` if a callback never comes back; one operation at a time. Test: `swaps_wait_for_an_exchange_operation` |
| I-3 | `exchange_storage_deposit(registration_only=false)` parks all attached NEAR on Rhea | **Kept, documented.** Registering only the minimum would make `exchange_register_tokens` fail on Rhea's storage check. Attach about 0.1 NEAR (the measured setup cost); excess storage on Rhea can't be withdrawn by the vault |
| I-4 | `withdraw_near` keeps a 0.5 NEAR reserve, more than a small factory vault holds | **Kept, documented.** Small vaults hold tokens, not NEAR; the reserve protects gas and storage |
| I-5 | The canary's `preview_swap` check passed on `ok:false`; policy and agent not compared | **Fixed.** A 1-unit preview of the first pair must say `ok:true`; `get_policy` must equal the canary policy file (both parsed as the vault's `Policy`); `agent_id` must match |
| I-6 | `IT_OWNER == IT_FACTORY` wasn't refused | **Fixed.** `names_ok` refuses it. Test: `names_stay_on_mainnet_and_owner_is_separate` |
| I-7 | Rhea and intents.near are upgradeable by their governance; vaults trust them for life | **Kept, monitored.** Go-live checklist G: daily code-hash check; on a change, freeze and review |
| I-8 | A refund to a deleted creator account bounces to the factory | **Kept.** Accepted residual |
| I-9 | "Owner made whole" used `saturating_sub`, so it also passed on an over-refund | **Fixed.** Both failed-creation sandbox tests now also assert `after <= before` |
| I-10 | An unparsable cancel signature can be rebuilt by a third party | **Kept.** Conservative (the cap is kept) |

## Interface changes for readers (agent, MCP, league, site)

- Vault event standard version `1.1.0` → `1.2.0` (additive).
  - New events: `exchange_lostfound_claim` {token, amount, to}, `exchange_lostfound_claim_failed` {token, reason}.
  - `intent_unresolved` gains two reasons: salt invalidated, and abandoned by the owner.
  - The `trade.note` / `failed.reason` text for a payout that didn't arrive now reads "did not reach the vault: recover with exchange_withdraw or exchange_claim_lostfound".
- New owner methods: `intents_abandon()`, `exchange_claim_lostfound(token)` (both 1 yocto). The claim needs ≥ `TG_MIN_CLAIM_LOSTFOUND` (120 Tgas, as `exchange_withdraw`).
- New private callbacks: `on_settle_salt`, `on_claim_before`, `on_claim_after`.
- Changed signatures: `on_settle` (now returns a promise or value), `on_withdraw`/`on_verify` (carry the balance before).
- `intents_settle` needs ≥ 60 Tgas. Agent minimums are unchanged: `request_swap` 235, `request_intent_swap` 230, `intents_cancel` 255.
- Factory event version `1.2.0`: `vault_create_failed.pending` is now the deposit less the listing fee, with a new `kept_for_record_storage`.
- `agent/src/provenance.ts` pins the arena factory's vault code hash `5ePvrz…`. A factory built from this code pins `2ZP4H1EN…`, so add it when the new factory is deployed.

## Tests

- Vault unit: 63/63, up from 54.
- Factory unit: 5/5.
- Script tests: `deploy_and_lock` 2, `deploy_mainnet` 5, `arena_setup` 3.
- Clippy on wasm32 (`-D warnings`): clean.
- Sandbox against the real Rhea and intents.near mainnet binaries: **24/24 on nearcore 2.13.4 and 24/24 on 2.14.0**, up from 20.
- `tests/run.sh --quick`: 10 passed, 0 failed, 2 skipped (sandbox, run separately above).
