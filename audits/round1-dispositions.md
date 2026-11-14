# Audit round 1: dispositions

**Reviewers:** three independent reviewers on 2026-10-29, reading the code without the author's conclusions.
- access control and async: `round1-access-async.md`
- NEAR Intents and crypto: `round1-intents-crypto.md`
- economic and policy: `round1-economic-policy.md`

Every finding has a disposition: fixed (with the test that covers it), or kept (with the reason).

| # | Finding (reports) | Severity | Disposition |
|---|---|---|---|
| 1 | Price floor from a Rhea pool the agent picks, manipulable in-block (all three) | High | **Fixed.** Policy `pools` → `pairs`: each allowed direction has an owner-set pool and price band (`min_price_num/den`), both timelocked. The agent no longer names a pool. Floor = max(agent min, Rhea floor, band). A quote below the band fails before any funds move. Tests: `quote_below_price_band_fails_before_funds_move`, `band_and_freeze_stop_signing_and_release`. Residual: the band is only as tight as the owner sets it; an oracle bound is the round-2 candidate |
| 2 | Intents signed at the Rhea floor: the slippage allowance is a giveaway to solvers (intents, economic) | Medium | **Fixed.** Intents are signed at the Rhea quote (and never below the band); a solver must at least match Rhea. Test: `signs_at_the_quote_with_v1_nonce_and_short_deadline`; sandbox settles at exactly the quote |
| 3 | 300 s open offer is a long free option (intents) | Low | **Fixed.** TTL 120 s |
| 4 | Legacy nonces will be prohibited; the vault is immutable (intents) | Medium | **Fixed.** V1 versioned nonce: magic `5628f6c6`, V1 tag, `current_salt` from intents.near (fetched in parallel with the quote), deadline in ns = intent deadline, 15 random bytes. Tests: `v1_nonce_layout`; the sandbox settles against the real intents.near v0.4.5 with it |
| 5 | Cap released when the signature reply can't be parsed, though a valid signature may exist (all three) | Medium | **Fixed.** After a sign request the cap is never released by the vault's own guess. `intent_unsigned` is recorded, the intent stays until its deadline, and permissionless `intents_settle` asks intents.near `is_nonce_used`: a used nonce is recorded as a trade, an unused one after the deadline as `intent_expired` (cap released). Test: `unreadable_signature_keeps_the_cap_until_settled_after_deadline` |
| 6 | No fill or expiry record on the intents path; expired caps never released (economic) | Medium | **Fixed** by `intents_settle` (as #5); a `request` event added on the intents path. Tests: `settle_records_a_fill_and_keeps_the_cap`; sandbox `swap_settles…` records the trade via settle |
| 7 | `open_intent` can get stuck permanently; `clear_stuck` covers Rhea only (all three) | Medium | **Fixed.** `live()` ends at the stuck timeout (Quote) or the deadline (later stages); a non-live unrecorded intent refuses new requests with code `unsettled` until `intents_settle`, which also clears an intent stuck before signing. Test: `stuck_before_signing_clears_after_timeout` |
| 8 | Withdrawal events logged before the transfer, result unchecked (economic) | High | **Fixed.** `withdraw`, `withdraw_near`, `exchange_withdraw`, `intents_deposit`, `intents_withdraw` record via the `on_moved` callback only after success, at the amount actually moved; failures emit `<kind>_failed`. Test: `withdraw_is_recorded_only_after_it_happened` |
| 9 | Caps reset at UTC midnight and hour buckets: about 2× the cap in minutes (economic) | Medium | **Fixed.** Rolling 24 h window in 24 hourly buckets per token; a release goes back to the hour it was reserved in. Test: `caps_roll_over_24_hours_not_at_midnight`; property test still holds |
| 10 | Freeze doesn't stop an intent mid-flow (all three) | Medium/Low | **Fixed for unsigned** (re-checked before signing, and before Rhea's deposit). **Kept for already signed:** a signature can't be recalled; the response is `intents_cancel` (owner or agent) or emptying the intents balance. Documented on `freeze` |
| 11 | Gas tight in `on_cancel_signed` (5 Tgas margin) and `on_intent_quote` (access) | Medium | **Fixed.** `on_cancel_signed` 85 Tgas; `on_intent_quote` has a 25 Tgas margin; minimums 230 (request) and 255 (cancel) are enforced up front. Real MPC gas is still to confirm on testnet |
| 12 | `apply_policy` between request and quote changes that request's slippage (access, economic) | Low | **Fixed.** Slippage and band are fixed into the request at request time |
| 13 | Owner and agent can become the same account via `set_agent` and `accept_owner` (economic, access) | Low | **Fixed.** Both directions checked. Test: `proposed_owner_cannot_become_agent` |
| 14 | Key stored before intents.near confirms registration (access) | Info | **Fixed.** Stored in `on_key_registered` only on success. Test: `key_is_kept_only_once_registered` |
| 15 | A replaced pending policy leaves no record (economic) | Low | **Fixed.** `policy_cancelled {replaced: true}` is emitted |
| 16 | Gifts (plain transfers, intents deposits by others) raise balances without events (economic) | Medium | **Kept, by design.** The record is built from events only; balances are not the score. The leaderboard indexer must not read raw balances (noted in the build log) |
| 17 | `on_verify` misreports when an earlier balance sits on Rhea; keeps the cap after a returned input (access) | Low | **Kept for round 2.** Fails safe (cap kept, `returned: false`), the owner reconciles with `exchange_withdraw`. Fix candidate: compare before and after |
| 18 | Receipt hashes are neither unique nor bound to the trade; skips can be spammed (economic) | Low | **Kept.** The agent's own record; spam costs the agent gas and dilutes only its own page. The indexer can flag duplicates |
| 19 | Policy tightening also waits 24 h (economic) | Low | **Kept.** Uniform timelock keeps the record predictable; `freeze` is the immediate brake |
| 20 | `mpc_id` not checked at init; the mock MPC's keys are public (intents) | Low | **Kept, with an operational guard:** the mainnet deploy script must assert `mpc_id == v1.signer` and refuse any other value; the mock is test-only and never deployed |
| 21 | MPC low-s assumption; real reply shape and fee unmeasured (intents, access) | Info | **Open, testnet task:** check real `v1.signer` signatures for low-s, the reply shape, the fee and the gas before mainnet |

**After the fixes:** 48 unit tests and 14 sandbox tests (mainnet nearcore 2.13.4 and next 2.14.0); clippy clean.
