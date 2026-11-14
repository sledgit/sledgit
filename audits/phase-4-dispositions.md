# Phase 4 review: dispositions

Review: `audits/phase-4-review.md` (2 Critical, 5 High, 8 Medium, 5 Low, 1 Info). Each PoC scenario is a regression test in `agent/test/league.test.ts` (named `P4-n: …`). The reviewer's original PoCs, re-run against the pre-fix code, still reproduce every quoted number (A: +97.8%, B: +90%, C: +100%, D: +33%, E: ranked, F: duplicate ids, G: z=1.96 at n=3, H1: +33% after a full withdrawal). The new tests pass against the fixed code.

Schema bumped to `iron-trade-league-inputs/2` / `iron-trade-league/2` (SCHEMA.md). The method text in `snapshot.method` is what the site shows.

| # | Sev | Disposition | How (test) |
|---|---|---|---|
| P4-1 | Critical | **Fixed** | Holdings are replayed in BigInt raw units. The TWR closes a segment at each flow and chains it: `twr = growth · (end/segStart or 1) − 1`, so a full or dust withdrawal keeps the loss. Below `season.min_value_usd` at the cutoff, the entry is `inactive`: record kept, unranked. (`P4-1`) |
| P4-2 | Critical | **Fixed, both ways** | (a) Every trade is valued at the reference; a fill better than the reference by more than 2% is neutralised as owner money (`costs.neutralised_usd`, info flag). (b) A Rhea trade on a pool outside `season.canonical_pools` (testnet 1103; mainnet 4512) unranks. Recommendation: keep both; the cap also covers owner-run Intents solvers, where no pool id exists. (`P4-2`) |
| P4-3 | High | **Fixed** | Benchmarks pay `season.benchmark_cost_rate` (0.30%, the Rhea pool fee, published in the registry) on their one rebalance, never the entry's rate. `tn-lifecycle` now shows twr −1.9%, vs hold −0.8% (was +24%). (`P4-3`) |
| P4-4 | High | **Fixed** | Only league tokens are valued. A deposit, withdrawal or trade touching another token is a flow (never profit), and an in-season one unranks (`foreign_token`). (`P4-4`) |
| P4-5 | High | **Fixed** | `selfConsistent()` recomputes `sha256(canonical({season, entries, benchmarks, flags, luck_entry}))` from the body. `league check` fails first if it differs, then requires equal hashes, no differing entries and equal flags. The unit test checks the committed body and every agent file (entry equality plus `events_sha256`). The site prebuild (`site/scripts/league-files.mjs`) does the same and fails the build. Verified: a tampered copy exits 1 and the prebuild throws. (`P4-5`, committed-snapshot test) |
| P4-6 | High | **Fixed** | `checkProof` first requires a receipt for every in-season decision by the cutoff. Each receipt must name this vault and decide what the vault recorded. The TEE season check gets exactly those receipts, with the chain's decisions cut at the last in-season seq; it must report this vault. (`P4-6`) |
| P4-7 | High | **Fixed** | The rules tier runs `houseCheck` (= `house-rerun --check`: feed, chain state, slot block) on exactly the kept receipts, with the vault's decisions as of the cutoff. Each receipt must be for this vault, and `decisionMismatch()` ties hold ↔ skip and buy/sell ↔ request/refuse with the same token and raw amount. (`P4-7` ×2) |
| P4-8 | Medium | **Fixed** | Both proof checks are bounded by the cutoff (kept receipts and the decisions cut at the last in-season seq), so the detail is as-of-cutoff. `league check` on the live chain reproduced the hash exactly. |
| P4-9 | Medium | **Fixed** | `season_from_seq` is removed. One registry-level `season.start_ms` applies to every entry; earlier decisions are listed as history (`in_season: false`). Testnet season `testnet-s0` starts 2026-10-29 06:20 UTC, which places qwen36's policy-v1 seq 1 and the house v1 ticks in history. (`P4-9`) |
| P4-10 | Medium | **Fixed** | The ranking clock starts when the vault first holds `season.min_value_usd`. Ranking needs ≥ 7 such days, ≥ 7 in-season decisions, and the minimum at the cutoff. Gas is charged against the value at each moment (a multiplicative factor). (`P4-10`) |
| P4-11 | Medium | **Fixed** | Flags are structured `{ids, kind, severity, text}`. `unrank` flags (duplicate receipt, evidence reuse, provenance, non-canonical pool, foreign token, seq gap, unresolved intent, incomplete) unrank every listed entry. Agent pages show every flag naming the entry, including shared ones. (`P4-11`) |
| P4-12 | Medium | **Fixed** | Seq contiguity per vault (a gap unranks); `missed_slots` counted; unresolved intents unrank. Replayed holdings are reconciled with on-chain balances at build, when no event follows the cutoff, and `build` refuses to write on a mismatch. All 8 vaults reconcile today. A second-indexer cross-check is **kept** as a later improvement: one indexer is trusted, and the reconciliation catches gaps that change balances. (`P4-12`, `missed slots` test) |
| P4-13 | Medium | **Fixed** | The page cap rose to 100 (~20k txs). Past it the vault is marked `incomplete` (unranked, flag) and the build goes on. **Kept:** a spammer with > 20k txs touching a registered vault can still make it incomplete. The FastNEAR account API has no block-height bound to stop at; a mainnet indexer would close this. (`P4-13`) |
| P4-14 | Medium | **Fixed** | Unregistered vaults get the id `u-<account>`. Registry ids are validated and must be unique (as must accounts), and `compute` throws on any duplicate id. (`P4-14`) |
| P4-15 | Medium | **Fixed** | `range95 {lo, hi, n}`: Student-t (df = n−1) around the observed cumulative difference, asymmetric, using only hourly steps without trades or flows. Null below 24 steps ("not enough data"). `beyond_noise = lo > 0` is shown. The site copy says a result is skill only when its range clears Hold. (`P4-15`) |
| P4-16 | Low | **Fixed** | `r8` throws on non-finite numbers; amounts must be digit strings; klines need finite closes. (`P4-16`) |
| P4-17 | Low | **Fixed** | `cmp` is code-point ordering everywhere, in collect and compute. (`P4-17`) |
| P4-18 | Low | **Fixed** | The leaderboard cards and lede match the method (valued at the reference; the day-7 clock at the minimum value; the range vs Hold). Testnet uses the snapshot's order, and rank numbers count ranked rows only. |
| P4-19 | Low | **Fixed** | Separate sections for test fixtures, retired entries (`retired: true` in the registry) and unregistered vaults ("names chosen by their creators, not league entries"). |
| P4-20 | Low | **Fixed** | An in-season `intent_unresolved` or `intent_closed` unranks the entry until reconciled. (`P4-12` test) |
| P4-21 | Info | **Partly fixed** | `build` prints owners or agents shared between arena/house entries for the registry's admission review. Today the testnet house and arena vaults share one owner by design (house-run), reported. **Kept:** not a hashed flag. Owner and agent come from current views, which `set_agent` can change, so hashing them would break `check`. Mainnet registry admission requires distinct owners (go-live checklist). |

**Standings after the fix (testnet, cutoff 2026-10-29 10:08 UTC, `derived_sha256` `ae7447b6…`):** nothing is ranked; every entry has 0.2 days at the minimum value in season `testnet-s0`. Proof tiers:
- `tn-qwen36-tee`: tee, seq 2.
- `tn-house-rebalancer`: rules, seqs 4–5. This includes the always-on host's tick, whose receipt was merged into `deploy/testnet/receipts-house/rebalancer/`.
- `tn-house-trend` and `tn-house-luck`: rules, seq 4.
- `tn-llama32-local`: self.
- Fixtures: listed apart.

Flags: off-schedule (info) for the three house vaults.
