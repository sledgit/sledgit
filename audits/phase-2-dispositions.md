# Phase 2 review: dispositions

Review: `phase-2-review.md` (15 findings, none High). This file records what was done with each.
- Phase 2b (testnet keys, factory float, deploy script): P2-1, P2-2, P2-6, P2-8, P2-9.
- Phase 1b (agent code and repo hygiene): P2-3, P2-11, P2-15, in their section below.
- Phase 6 (the mainnet deploy script): P2-4, P2-5, P2-7.

## Phase 2b

| # | Severity | Disposition |
|---|---|---|
| P2-1 | Medium (mainnet blocker) | **Script fixed; testnet float raised to 46.0 NEAR (shortfall 54 NEAR, kept open).**<br>`deploy_and_lock.rs` now refuses to delete the key unless the factory holds at least `IT_MIN_SPARE` free (default `MAX_DEPOSIT` = 100 NEAR). The factory is funded from that by default (`IT_MIN_SPARE + 3000` millinear).<br>Unit test: `lock_refuses_below_the_refund_float`.<br>Live dry run: `IT_CHECK_ONLY=1` against `arena.irontrade.testnet` printed `FAIL spare: 1.010 NEAR free, needs 100.000` and exited non-zero.<br>Testnet: the treasury sent 45 NEAR to `arena.irontrade.testnet` (tx `GJQM67GnBTrE5qxU7PPKDu89uKTBormdUUqfBnKEoqpj`). Free went from 1.01 to 46.01 NEAR (check-only: `FAIL spare: 46.010 NEAR free, needs 100.000`; `PASS` at `IT_MIN_SPARE=45000`).<br>**Shortfall: 54 NEAR, kept open.** The faucet returned 429 on 4 attempts over ~35 min (4 accounts came through earlier), and the treasury keeps ~10.8 NEAR for operations. Top `arena` up when the faucet allows.<br>Until then, on testnet a failed `create_vault` above ~46 NEAR could hit the feared refund ordering. Mainnet still needs the refund-ordering fix or the float check before the lock (Phase 6). |
| P2-2 | Medium | **Fixed on chain.** The owner's `set_agent` re-pointed `perf`, `lifecycle` and `suite.arena.irontrade.testnet` to dedicated agent accounts, `agent2-<name>.it1793205219-owner.testnet` (`deploy/testnet/arena-1793250981.json`). Each holds one function-call key: the vault, the 6 agent methods, no allowance.<br>RPC check after the change: none of the 5 arena agents shares a key with the owner, the root, `irontrade.testnet`, the intents contract, the old fund accounts, the old shared agent or the factory.<br>The three are labelled test fixtures in `deploy/testnet/FIXTURES.md`; that note also states the testnet intents copy is operator-upgradeable and pinned by `arena`. |
| P2-6 | Low | **Fixed.**<br>The global publish is skipped when the chain already serves code under that hash. It's fetched and re-hashed; live: `global vault code 5ePvrz… on chain: true`.<br>`IT_RESUME=1` finishes an interrupted run from the pending key file. It refuses if the factory's only key isn't that key, and it never repeats a paid step. Unit test: `resume_never_repeats_or_guesses`.<br>Every finished step is recorded in `deploy/testnet/lock-progress-<factory>.json` (no secrets). `IT_CHECK_ONLY=1` runs every pre-lock check on an existing factory without sending anything. |
| P2-8 | Low | **Fixed.**<br>Key files are created 0600 from the first byte (`OpenOptions::mode`) and are never replaced (`create_new`), in `deploy_and_lock.rs` and `arena_setup.rs`. Unit tests: `key_files_are_private_and_never_replaced` (both examples).<br>`arena_setup` names key files after the agent account (`testnet-<agent>.json`), so a re-key can't overwrite an earlier key.<br>`faucet.rs` refuses an existing file and creates its own 0600. |
| P2-9 | Low | **Fixed.** `arena_setup`'s post-check now also requires the exact agent method set and no allowance. Unit test: `method_list_must_match_exactly`. |

## Phase 6 (mainnet deploy script), kept with reason

| # | Severity | Why it waits |
|---|---|---|
| P2-4 | Medium (mainnet) | Independent checks need values that only exist for the mainnet run: an expected vault and factory hash from the reproducible build (needs the 1 Nov repo), a pinned MPC root key for `v1.signer`, pinned code hashes for `v2.ref-finance.near` and `intents.near`, and a canary `create_vault` (plus a bad-policy refund) before the lock. |
| P2-5 | Medium (mainnet) | Separate parent and owner keys are a mainnet account-setup decision for John (irontrade.near). On testnet the shared key is accepted and documented in `deploy/testnet/FIXTURES.md`. |
| P2-7 | Low | A direct `status.chain_id` check and `.near`-only constants belong to the mainnet binary. The testnet guard is sound as written (the review agrees). |

## Pending agent edits after Phase 1b

P2-10 (SKILL.md: what a leaked agent key can still do, and the fix, `set_agent`), P2-12 (warn when an uncapped agent account holds a large balance) and P2-13 (one finality for `reader()`) touch `agent/` and `agent/SKILL.md`, which Phase 1b is editing. They're queued for right after it.

## Phase 1b

P2-3 (provenance trusts the unlocked legacy factory), P2-11 (failed receipts counted in `call()`) and P2-15 (gitleaks fingerprints): recorded by Phase 1b.
