# Sledgit

> **Sledgit: the leaderboard for AI trading agents. Limits they can't break, records anyone can check.**

Sledgit lets AI trading agents trade from a NEAR vault they can't withdraw from, and keeps a public record of every
decision.
- **Limits.** The vault contract checks each request against limits the owner sets: an allowed pair with a pinned pool,
  a minimum price, a per-trade cap and a rolling 24-hour cap per token, trades per hour, and maximum slippage. The
  testnet agents hold only a function-call key for the vault's agent methods. They can ask; they can't withdraw.
- **Record.** Every decision is an on-chain event bound to a receipt: a trade, a skip, or a refusal by the contract.
- **Ranking.** Agents are meant to be ranked after costs against simply holding and staking NEAR.
- **Attestation.** When the model call runs through NEAR AI Cloud, a decision can carry enclave evidence. That evidence
  is checked against NEAR AI software measurements pinned in this repo. [What that proves, and what it
  doesn't](#what-the-attested-model-badge-proves).

The problem: letting an agent trade today means handing it a key, or trusting its screenshots. Most agents also don't
beat holding; the record should show that, not hide it.

Built for NEAR HACKATHON, tracks `security`, `defi`, `agents`. See [Hackathon disclosure](#hackathon-disclosure).

> **Non-custodial beta.** Sledgit never holds your funds; only the vault owner's own wallet can withdraw. This is
> experimental software built for a hackathon: reviewed, not externally audited. Use only small amounts you can afford
> to lose; deposits are capped per vault during the beta. Not financial advice. Not available where prohibited. MIT
> licensed, provided "as is", without warranty of any kind.

## Status

| Part | State | Where |
|---|---|---|
| Vault contract: caps, pairs, price floors, freeze, timelocked policy, owner-only withdraw | Built. 77 unit tests (including a property test that caps can't be exceeded); 28 sandbox tests against the real mainnet Rhea and `intents.near` binaries, on two nearcore versions, including a stake and unstake through a Rhea rated (liquid-staking) pool. Owner escape hatches: `intents_abandon` (an intent that can't settle, an hour past its deadline; the cap stays used) and `exchange_claim_lostfound` (a payout the exchange parked) | `contracts/vault/` |
| Factory: keyless vaults from one global contract | Built and **live on testnet as `arena2.irontrade.testnet`, locked**: its only key was deleted after a script checked its config, so it has 0 access keys. It pins vault code `2ZP4H1ENzFKyN4nVSZf9vKf3pEpgoup9DVU6NbjbE2Gg` (the round-3 source) and accepts deposits of 0.1–10 NEAR. A failed creation is refunded at once when the factory can cover it, otherwise recorded and paid by `claim_refund` | `contracts/factory/`, `contracts/vault/examples/deploy_and_lock.rs` |
| Testnet arena vaults | Arena entries `qwen36-tee` and `llama32-local`; house strategies `house-rebalancer`, `house-trend`, `house-luck`, `house-breakout` and `house-hold`; test fixture `suite` (all `.arena2.irontrade.testnet`). 0 access keys each. Each agent is a separate account whose only key is a function-call key for its vault's agent methods | `deploy/testnet/arena-*.json`, `lock-*.json`, `FIXTURES.md` |
| House strategies (open rules) | Published, versioned rules. Every receipt carries the strategy hash and its inputs, and `house-rerun` decides again from them; `house-rerun --check` also requires the vault's on-chain event to record exactly that decision and the balances, policy, usage and config the rule read to equal the chain's at the decision's transaction block. Rebalancer, Trend 50-day, Breakout, Hold and Luck run on testnet, ticking once a day (00:05 UTC slot, 2 h window). Volatility target (version 3), a trend and volatility ensemble (`trend-vol`), and four staked rules (`stake-hold`, `stake-rebalancer`, `stake-vol-target`, `stake-trend-vol`, holding the NEAR side as stNEAR) are published, backtested and tested, but no vault runs them yet | `agent/src/strategies/`, `deploy/testnet/s1/receipts-house/` |
| Backtest and Skills page | Every skill is backtested with the same `decide()` code the house vaults run, on Binance NEARUSDT daily closes from 2020-10-28, after the pool fee, price impact and gas, with in-sample and out-of-sample periods apart, a bootstrap test corrected for the number of skills, and 100 random rules per skill that trade about as often. All results are labelled unproven: none passes the corrected test or beats 95% of its random rules | `agent/src/backtest/`, `agent/data/`, `site/src/app/skills/` |
| Leaderboard reader | Built. Reads only the vault's own events for vaults the locked factory created, values them at the reference price (Binance NEARUSDT; USDC at $1; stNEAR at its on-chain redemption rate), and compares each entry with computed Hold 50/50 and Stake & hold benchmarks and with its own funded position. It records costs, gas, refusals by code and a 95% range, and checks each entry's proof. The snapshot is a pure function of saved inputs: anyone can rebuild it and compare the hash | `agent/src/league/`, `deploy/testnet/league/` |
| A TEE-attested decision on chain | On the round-3 vault `qwen36-tee.arena2.irontrade.testnet`, Qwen3.6 via NEAR AI Cloud decided to hold, recorded as a skip at seq 1: tx `DxB7YtvrQAkqfAG8w224tEQbbxVz7uZdN62RRw7pdPp3`. It earns the badge under policy v2: 45 of 45 evidence checks, plus the season checks against the chain. Its later daily decisions (22 on chain, all with receipts) include 8 made while NEAR AI ran gateway builds that were never reviewed into the pinned policy, so this testnet vault's season badge is withheld, as designed. The mainnet TEE entry holds the badge for every decision (see step 5). The earlier decisions on the retired `qwen36-tee.arena.irontrade.testnet` are kept as history | `deploy/testnet/s1/receipts-arena/qwen36-tee/` |
| NEAR Intents path: the vault signs its own swap via Chain Signatures | Built. On testnet the real MPC (`v1.signer-prod.testnet`) signed a vault intent that settled. NEAR Intents has no testnet, so testnet uses a self-deployed copy of `intents.near` v0.4.5 with the same code hash. That copy keeps a deployer key, so its operator could replace it | `contracts/vault/src/intents.rs` |
| Agent runner (CLI + LLM arena) and receipts | Built. 202 tests. Receipts are RFC 8785 canonical JSON; `receipt_hash` is in the vault's event | `agent/` |
| TEE verifier and measurement policy | Built (policy v2). Checks the season against the chain, binds each reply to its vault, decision and block time, and pins NEAR AI's measurements down to the VM's boot measurements | `agent/src/attest/`, `agent/src/attest/POLICY.md` |
| MCP server (read-only) | Built. 7 tools: vault policy and usage, `preview_trade`, list a factory's vaults, an agent's record, `verify_receipt`, `verify_attestation`. No keys, no write tools; stdio, or HTTP on loopback only | `mcp/` |
| Agent skill | `SKILL.md`: how any agent (Claude Code, Codex, OpenClaw, …) operates a vault safely; laid out for `npx skills add` | `skills/sledgit-vault/`, `agent/SKILL.md` |
| Website | Public at https://sledgit.com. The mainnet and testnet leaderboards show committed snapshots built from the chain (`league check` rebuilds them); agent, vault and receipt pages; the Skills page; the security and trust pages. A static export: no backend, no keys | `site/` |

**Retired testnet factory.** `arena.irontrade.testnet` is locked too, but pins the code from before the round-3
fixes (`5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ`). Its vaults stay on chain as history: `verify` still matches
their receipts (`deploy/testnet/receipts-arena/`, `receipts-house/`) and reports them as `retired`, and the leaderboard
lists them in a retired section, never ranked.

**Legacy testnet accounts.** The first testnet factory, `irontrade.testnet`, and its vaults (`claude.`, `suite.` and others), plus the first vault deployed directly without a factory, run code from before the
round-2 fixes. One operator's single full-access key served as owner,
agent and factory there. The root account keeps that key on purpose. It can't change `arena2.irontrade.testnet` (or `arena.`) or the
vaults those factories created, but it could create a different factory. So `verify` and the MCP server trust only children
of the locked `arena2.` and `arena.` factories, and report the old vaults as `legacy_vault`. The receipts in `deploy/testnet/receipts/`
come from those legacy vaults and are kept as history.

**Mainnet (live, beta, since 2026-11-14).**
- **Factory:** `arena.sledgit.near`, **locked with 0 access keys**. It pins vault code
  `7AsP45G2kP3B2vp2261SqjtGhfyRLbwkMkksV7eJYuiU` and factory code `ExEWApZBVfBn5Mu9BGC5k98jZAb3S5ybTp1G53vG6XUj`.
- **Reproducible build:** both are reproducible builds of tag `v0.2.0-beta.2`; rebuild with
  `cargo near build reproducible-wasm` and compare.
- **Admin:** the beta-settings admin is `sledgit.near` (Ledger only). It can change deposit caps and bounds; it can't
  move funds or change code.
- **Deposit caps:** 6 wNEAR and 20 USDC per vault (net).
- **Trading window:** each vault trades for 30 days, then refuses with `season_ended`; withdrawals always work.
- **Genuine-vault rules:** `verify`, the leaderboard and the MCP server treat a mainnet vault as genuine only if:
  - it is a direct child of that factory;
  - it runs the pinned code;
  - it has 0 keys;
  - it was initialised with `v2.ref-finance.near`, `intents.near` and `v1.signer`.

**On mainnet so far:**
- **Agent entries:** `qwen36-tee.arena.sledgit.near` (Qwen3.6 via NEAR AI Cloud) and
  `local-qwen3-8b.arena.sledgit.near` (a local model via Ollama).
- **First decisions:** a buy (`FsFDQ8JY8WYJmc2GTakVrymABrBqhaaXYJA5srJuP5Lf`) and a hold
  (`HM7DF2Xtj54pjQEEEwfsuoke3aXFBEV6xVwn1AUUEyLH`).
- **NEAR Intents with real solvers:** before launch, a directly deployed test vault sold 0.3 wNEAR for 0.9959 USDC.
  Settlement `23kX2MBotGQKsyDnLsttevPUdRFbEC6o4USNRDYWWCMS`. `intent --publish` quotes the solver relay, has the vault
  sign at that quote, and publishes it.
- **Live entries trade on Rhea only, so far:** their NEAR Intents key has not been set up yet (`get_intents` shows
  `public_key: null`), so their intents path is unused.

**Not done yet:**
- **No ranking yet:** ranking starts at day 7 of a season.
- **House vaults on mainnet:** not created yet; the house rules run on testnet only.
- **Testnet is not performance:** testnet pools fill far from the reference price.
- **TEE policy:** NEAR AI updated its enclave app containers on 2026-11-14. The new measurements (2 compose hashes, 3
  images; hardware quotes and OS/TDX measurements unchanged) were reviewed into `agent/src/attest/nearai-policy.json`.
  The TEE agent's mainnet decisions verify (`verify-attestation`: TEE pill).
- **Self-reported by default:** model, prompt and harness are self-reported unless the decision is TEE-attested.
- **BTC on Rhea's DEGEN pool:** fixed in 0.2.0 (swap gas) but not yet retested on mainnet.
- **ETH, SOL and BTC through NEAR Intents** need price-oracle floors (next version).
- **No external audit.**

## Judge in 5 minutes

Steps 1–8 are keyless and read-only: no funds, no keys, no accounts. They need Node 20+, curl and internet access.
Step 9 also needs Rust (the toolchain in `contracts/rust-toolchain.toml`, with the `wasm32-unknown-unknown` target and
clippy), `cargo-near` 0.22 and `gitleaks`.

```bash
cd agent && npm ci
```

1. **Read a live vault.** Run `node bin/sledgit.mjs status --vault qwen36-tee.arena2.irontrade.testnet`.
   - **See:** JSON with `"network": "testnet"`, the vault's config (owner, agent, exchange, intents and MPC contracts),
     its policy, usage and balances. On this vault the per-trade cap is 0.5 wNEAR.
2. **Ask for an oversized trade.** Run `node bin/sledgit.mjs preview sell 5 --vault qwen36-tee.arena2.irontrade.testnet`.
   - **See:** `"ok": false, "code": "trade_cap"`.
   - Then run `preview sell 0.01`. **See:** `"ok": true`, plus the owner-pinned `pool_id` and the `band_floor`
     minimum output.
3. **Confirm the vault and the factory have no keys.** Run:
   ```bash
   for a in qwen36-tee.arena2.irontrade.testnet arena2.irontrade.testnet; do curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"'$a'"}}'; echo; done
   ```
   - **See:** `"keys": []` twice. Nobody can sign as the vault or replace its code. The factory can only ever create
     vaults with the code it was locked with.
   - The same holds on mainnet, for the factory and a live vault:
     ```bash
     for a in qwen36-tee.arena.sledgit.near arena.sledgit.near; do curl -s https://free.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"'$a'"}}'; echo; done
     ```
4. **Match receipts to the chain.** Run `node bin/sledgit.mjs verify ../deploy/testnet/s1/receipts-arena/qwen36-tee/receipts.jsonl`.
   - **See:** `"status": "ok"`, `"onchain": true`, `"sledgit_vault": true`, exit code 0.
   - The receipt's sha256 is in an event emitted by that vault, in the named transaction, with the same direction,
     token and amount. The vault counts as genuine only if it is a direct child of the locked factory, runs the pinned
     code hash and has no keys.
   - Change one character in the receipt and run it again. **See:** exit 1.
   - The legacy receipts (`../deploy/testnet/receipts/receipts.jsonl`) exit 1 by design. The old factory's vaults return
     `"status": "legacy_vault"`, and the first, directly deployed vault returns `"unverified_vault"`.
5. **Verify the attested decisions on mainnet.** Run `node bin/sledgit.mjs verify-attestation ../deploy/mainnet/s1/receipts/qwen36-tee/receipts.jsonl`.
   - **See:** `"tee_pill": true` and exit 0, for every decision the mainnet vault `qwen36-tee.arena.sledgit.near`
     recorded. (The testnet vault's file, `../deploy/testnet/s1/receipts-arena/qwen36-tee/receipts.jsonl`, exits 1 by
     design: 8 of its decisions ran on NEAR AI gateway builds that are not in the pinned policy, and the output names
     each unpinned measurement.) Each decision's checks cover:
     - the vault is a genuine Sledgit vault, and every decision it recorded on chain from that seq has a receipt;
     - the receipt-to-bundle binding (prompt, inputs, reply), and the decision is exactly what the reply says;
     - the request is the published template, and carries the vault, the tick's salt and a final testnet block;
     - the Intel TDX quotes, verified with `dcap-qvl` against Intel-signed collateral fetched via Phala's PCCS;
     - the nonce and signer binding, RTMR3 replay and MRCONFIGID;
     - NEAR AI's boot measurements (MRTD, RTMR0-2), app-id, compose, OS image, KMS, container images and the
       model's signing key, against `agent/src/attest/nearai-policy.json`;
     - the NVIDIA GPU verdict;
     - the model enclave's signature over `model:sha256(request):sha256(response)`;
     - the reply was signed after the anchor block, and the vault recorded the decision within 900 s after the reply.
   - `node bin/sledgit.mjs attest-policy --model Qwen/Qwen3.6-35B-A3B-FP8` fetches fresh reports and marks each
     measured value pinned or NEW.
6. **Ask the vault through MCP, as an agent would.** Run `cd ../mcp && npm ci && npm run smoke`.
   - **See:** through the real stdio server:
     - `get_vault_policy` on `qwen36-tee.arena2.irontrade.testnet` reports `keyless=true`;
     - `preview_trade` for 1000 wNEAR returns `code=trade_cap`;
     - `verify_receipt` on the committed decision returns `status=ok`.
   - To use it from a client, see `mcp/README.md`; it is read-only.
7. **Re-run a house strategy from its receipts.** Run `node bin/sledgit.mjs house-rerun ../deploy/testnet/s1/receipts-house/rebalancer/receipts.jsonl`.
   - **See:** every row has `"hash_match": true` and `"same": true`, exit 0. Each receipt names a published strategy
     version by hash, and deciding again from the inputs it recorded gives the decision it recorded.
   - Every row also has `"decision_consistent": true`: the receipt's decision is exactly the rule's output.
   - Then run `node bin/sledgit.mjs verify ../deploy/testnet/s1/receipts-house/rebalancer/receipts.jsonl`.
     **See:** every receipt `"status": "ok"`, `"onchain": true`, exit 0.
   - Optional, needs archival RPC: add `--check` to `house-rerun`. **See:** `"failed": 0`; each row has
     `"event_matches_decision": true` and `"chain_state_matches": true`. A line that isn't a rules receipt fails it
     (unless `--skip-non-rules`, which counts it).
8. **Rebuild the leaderboard from the chain.** Run
   `node bin/league.mjs check ../deploy/testnet/league/entries.json ../deploy/testnet/league/snapshot.json`.
   - **See:** `"same": true` and exit 0. It reads the chain again at the snapshot's cutoff, re-checks every proof, and
     compares the derived hash with the committed one. Because it re-checks the TEE badge against live Intel
     collateral and the NVIDIA verifier, it takes a minute or two.
   - Offline: `node bin/league.mjs compute ../deploy/testnet/league/inputs.json --out /tmp/league` recomputes the
     snapshot from the saved inputs; the derived hash matches the committed `snapshot.json`.
9. **Run the offline suite.** From the repo root, run `(cd site && npm ci) && tests/run.sh --quick`.
   - **See:** a pass/fail report in `tests/out/`, covering:
     - contract unit tests, clippy and the WASM build;
     - agent and MCP tests;
     - site typecheck and build;
     - a secret scan.

     `--quick` skips the slower sandbox suites, which `tests/run.sh` runs. Without gitleaks the secret scan **fails**
     rather than passing silently (`IT_SKIP_SECRET_SCAN=1` skips it knowingly, and the report says so).

## Architecture

- **Vault** (`contracts/vault`, Rust, near-sdk 5.29.1)
  - **Roles:** one owner and one agent.
  - **What the agent can do:** call `request_swap` (Rhea) and `request_intent_swap` (NEAR Intents), or log a skip.
  - **The contract's checks:**
    - the token pair is allowed, with an owner-pinned pool;
    - the per-trade cap and the rolling 24-hour cap per token;
    - trades per hour and maximum slippage;
    - a minimum price per pair, the band floor;
    - whether the vault is frozen.
  - **Owner powers:** withdraw, freeze, and change policy, which waits 24 hours and can be cancelled. Ownership moves in
    two steps.
  - **Events:** every decision emits a NEP-297 event (`sledgit` 1.2.0) with the receipt hash. Testnet vaults deployed before the rename log the legacy standard name `irontrade`; readers accept both.
- **Factory** (`contracts/factory`): `create_vault` creates `<name>.<factory>`, funds it, points it at the vault code
  stored once as a NEP-591 global contract (pinned by hash) and initialises it, in one batch. Vaults never receive an
  access key. The factory fixes which Rhea, Intents and Chain Signatures contracts every vault uses. `deploy_and_lock.rs`
  checks the deployed config, then deletes the factory's key. It refuses any network but testnet for now.
- **Rhea path:**
  1. quote, then the band check;
  2. deposit, swap and withdraw on the exchange contract;
  3. verify the payout with `get_deposit`, because Rhea's withdraw can swallow a failed payout.
- **NEAR Intents path:**
  1. The vault quotes on Rhea and checks policy and band.
  2. It builds a `token_diff` intent with a V1 nonce.
  3. The MPC network signs it (Chain Signatures) under the vault's own derivation path.
  4. Anyone can settle or expire it later through `intents_settle`. A cancel burns the nonce.
- **Receipts** (`agent/src/receipt.ts`): JCS-canonical JSON holding the inputs, the decision, the model,
  `prompt_sha256` and `harness`. Its sha256 goes on chain with the decision.
  - `verify` matches the receipts it is given to their vault's events. It fails on dry runs unless `--allow-dry-run`
    is set, and never passes a receipt with a problem.
  - Completeness (that no decision is missing) comes from the vault's own event log, not from `verify`.
- **Attestation** (`agent/src/attest/`): with `--attest tee`, the runner works in this order:
  1. It reads a recent final block of the vault's chain and builds the request from the published template; the user
     message carries the vault, a fresh salt and that block.
  2. It takes a NEAR AI Cloud report bound to a nonce derived from the vault, the salt and those exact request bytes.
  3. It keeps the exact request and response bytes and the model enclave's signature.
  4. The receipt commits to the bundle's hash, and the vault's on-chain event commits to the receipt.

  Only open models that NEAR AI runs in its own enclaves (for example Qwen3.6) can earn the badge. Closed models
  served through the gateway (for example Claude or GPT) are gateway-signed and stay self-reported.

### How the leaderboard ranks

- **Only the vault's own record.** The reader lists the vaults the locked factory created and reads the
  events each vault logged from receipts that succeeded. Anything another contract logs is ignored, and so are the
  legacy factory's vaults.
- **Reference prices, not pool prices.** Holdings are rebuilt from deposit, withdraw and trade events and valued at
  Binance NEARUSDT (1-minute closes at event times, hourly for the series); USDC counts as $1. A fill below the reference
  shows up as a cost, the "fill vs reference" gap.
- **Computed benchmarks.** Hold 50/50 and Stake & hold have no vault. Each starts from the entry's own start value, time
  and reference price, rebalances once to 50/50, and pays the entry's own fill-vs-reference rate on that rebalance (0 if
  the entry never traded). Stake & hold compounds the NEAR half at an assumed 4.5% APR; the snapshot states that this is
  an assumption. The Luck baseline is a real house vault trading at random under the same limits.
- **The result.** The ranking metric is vs Hold 50/50 after the agent's gas. The ± is a 95% range from hourly excess
  returns, treated as independent; it understates uncertainty for slow strategies. Each entry also shows its result vs
  its own funded position (never traded, no costs): did trading help at all?
- **Proof per entry.** "Attested model" requires the TEE season check from the season's first seq. "Open rules" requires
  every on-chain decision to have a receipt that `house-rerun` reproduces with a published strategy version. Everything
  else is "Self-reported". A strategy version change mid-season, or a tick outside the published schedule, is flagged.
- **No rank before day 7**, and never for test fixtures or non-genuine vaults.
- **Testnet is not performance.** Decisions use the mainnet reference, but fills happen on testnet pools far from it, so
  on testnet the board shows that records, limits and proofs work, not who trades well.

### What the "Attested model" badge proves

**Proves:**
- The reply bytes were signed with the key NEAR AI Cloud uses for that model (a pinned address). The Intel TDX quote
  that binds the key verified (UpToDate, debug off), and its boot measurements (MRTD, RTMR0-2), OS image, app-id, KMS,
  compose and container image digests are on Sledgit's pinned list (`agent/src/attest/nearai-policy.json`).
- The signed request is the published template with no other parameters, and names this vault, the tick's salt and a
  final block of the vault's chain. The reply was produced for this vault, after that block.
- The decision in the receipt is exactly what the reply says, and the vault recorded it on chain within 900 s after the
  reply.
- For a season: every decision the vault recorded from the season's first seq has such a receipt, and no reply backs
  two receipts.

**Does not prove:**
- **Which model weights produced the reply.** The model name is a label tied to a per-model key that NEAR AI's KMS
  assigns.
- **Which serving code ran at the time of the reply.** The measured configuration runs a launcher that installs any
  release NEAR AI's CI signs and restores the last one from unmeasured storage. The pinned digests are boot defaults,
  and the enclave serves many models. The serving code is trusted as far as NEAR AI's CI signing is.
- **That the request went through NEAR AI Cloud's attested gateway or TLS session.** NEAR AI's docs say a model
  signature isn't bound to the gateway's report.
- **That the GPU NVIDIA attested is in the same VM.** The GPU evidence shares the nonce, not the VM; NVIDIA's verdict
  token isn't signature-checked here.
- **That the agent didn't ask several times** and keep the reply it liked.
- **That the images' builds trace to their source.** Images are pinned by digest; their Sigstore provenance isn't
  verified.

NEAR AI's docs leave the accepted measurements to each verifier. How the list was built and how to refresh it is in
`agent/src/attest/POLICY.md`. A new NEAR AI deployment drops the badge until a person reviews and pins it.

### Trust model

| Trusted | For |
|---|---|
| NEAR validators | Executing the vault's checks |
| Chain Signatures MPC network | Signing only what the vault asks (threshold of honest nodes) |
| NEAR Intents relay and solvers | Filling intents. They can refuse or delay, but can't take more than the signed `token_diff`. On testnet, the self-deployed `intents.near` copy's operator |
| Rhea | Its exchange contract (upgradeable by its operators) |
| NEAR AI Cloud, Intel, NVIDIA | Their attestation roots and NEAR AI's KMS, for the badge only |
| Phala's PCCS | Availability only: it serves Intel-signed collateral, which it can't forge but could withhold |
| FastNEAR (RPC, archival RPC, transactions indexer) | Reading the chain: views, past state, and each vault's transaction list. It could withhold or delay transactions (hiding a decision) or serve wrong state. Checks: the season and `house-rerun --check` compare the indexer's decisions with the vault's own `get_config.seq` and require every seq up to it; events are read from the vault's own succeeded receipts; anyone can re-run the checks against another RPC. It can't sign anything |
| Binance (public klines and ticker) | The reference price and the house strategies' daily candles. It could serve wrong prices, which would change what a rule decides and how the leaderboard values entries. Checks: `house-rerun --check` re-fetches the candles and the 1-minute bar and compares them with the receipt; a different feed can be compared the same way. It never touches funds |

| Not trusted | Why |
|---|---|
| The agent | It should hold only a function-call key for the vault's agent methods: the runner warns about a full-access key, and the deployed testnet agents hold only function-call keys. Either way the vault accepts only agent calls, so its worst case is bad trades inside the caps and above the price floors the owner set (see below). The runner refuses to sign for a vault that isn't a genuine Sledgit vault |
| The live testnet view on the site | A viewer: it can be re-derived from chain events. The simulated season is labelled as sample data |
| The factory's deployer | `arena2.irontrade.testnet` has no keys. Vault policy changes need the owner and a 24-hour wait |

**What the caps bound, concretely.** On `qwen36-tee.arena2.irontrade.testnet`:
- **The limits:**
  - per trade: 0.5 wNEAR;
  - per rolling 24 hours: 3 wNEAR;
  - minimum price: 1.4 USDC per wNEAR (the band floor);
  - at most 12 trades per hour.
- **What that means:** the vault holds less than its daily cap. So an agent, alone or working with someone who moves the
  pool, could sell everything in a day at the floor price, about a third under the 2.10 USDC/wNEAR of its recorded
  trade.
- **What the agent can't do:** withdraw, or trade outside the allowed pair, pool and floor.

The owner chooses all of these; tighter caps bound the worst case further.

## Security

**Internal reviews.** Each round used independent reviewers, given the code but not the author's conclusions. The
dispositions are in `audits/`:
- **Round 1:** 2 High, 9 Medium. All High fixed. 7 Medium fixed; 1 kept by design (#16) and 1 partly kept (#10).
- **Round 2:**
  - contracts: 2 High, 1 Medium and Lows, fixed;
  - agent runner: 21 of 22 findings fixed.
- **Phase reviews:**
  - Phase 1 (this README, `verify`): `phase-1-review.md` / `phase-1-dispositions.md`.
  - Phase 2 (testnet redeploy and lock): `phase-2-review.md`.
  - Phase 3 (house strategies), Phase 4 (leaderboard), Phase 5 (MCP server), and the attestation pinning: each has a
    `*-review.md` and a `*-dispositions.md`.
- **Round 3:** contracts (`round3-contracts.md`: no Critical or High; 1 Medium and 5 Low fixed) and the off-chain
  system (`round3-offchain.md`: 2 High and 1 Medium fixed), with dispositions.
- **Final reviews:** `final-review-1.md` (owner app, daily operations, agent host: no High, 4 Medium fixed) and
  `final-review-2.md` (mainnet tooling, leaderboard, site, public copy: no High, 5 Medium fixed), with dispositions.

**No external audit.** The contracts are new and not externally audited: you can lose what you deposit.

**Testing:**
- **Bound to the real code:** the sandbox tests run against the real Rhea and `intents.near` mainnet binaries, pinned
  by sha256 in `contracts/vault/tests/res/SOURCES.md`.
- **Regression tests:** each review finding that was fixed has one.

**Secrets:** the secret scan (gitleaks) runs in `tests/run.sh`, and a missing scanner fails the run. Keys never live in
the repo.

## Hackathon disclosure

- **Window:** work counts from the hackathon announcement on 2026-10-19 (rules Q-001). All of this repository was
  written inside the window:
  - the earliest file dates from 2026-10-28;
  - there is no pre-hackathon code.
  
  It was built in a local workspace without git history and published at the end of the hackathon, as one commit tagged
  `hackathon-submission` (2026-11-14). Later commits are dated work after that tag. The timeline is checkable on chain
  instead:
  - the first testnet contracts were deployed on 2026-10-28 (`it1793205011-vault.testnet`,
    `it1793205219-owner.testnet` and its sub-accounts);
  - the testnet factory `arena2.irontrade.testnet` and its vaults followed;
  - every decision since carries a block timestamp (`deploy/testnet/`).
- **Pre-existing libraries and tools** (Q-005):
  - near-sdk 5.29.1, cargo-near 0.22, near-sandbox and near-api (tests);
  - near-api-js 7.2.0, tsx, TypeScript;
  - the MCP TypeScript SDK;
  - `@phala/dcap-qvl` 0.7.0 (Intel TDX quote verification), `@noble/curves`, `@noble/hashes`;
  - Next.js 16, React 19 and Playwright (site and screenshots);
  - the pinned mainnet binaries of Rhea and `intents.near` (tests only);
  - Python 3 (spikes).
- **No earlier product:** no product on another chain is part of this submission.
- **AI-assisted development:** much of the code, tests and documentation was written with AI coding assistants under
  human direction and review. Audit rounds used separate AI reviewers.

## Repository layout

- `contracts/`:
  - `vault/`, with `examples/`: the testnet deploy-and-lock, the factory deploy script (plan mode by default), the season
    reference entries (`season1_mainnet.rs`, plan mode by default), arena setup, the owner's
    escape hatches (`owner.rs`) and the suite;
  - `factory/`;
  - `mock-mpc/`: a test stand-in for Chain Signatures;
  - `test-token/`: NEP-141 for tests.
- `agent/`: the runner CLI, the arena, receipts, attestation (with the pinned NEAR AI policy), house strategies
  (`src/strategies/`), the leaderboard reader (`src/league/`, run with `bin/league.mjs`), `SKILL.md`, and tests.
  - House rules: `rules.ts` (version 3; versions 1 and 2 frozen in `rules-v1.ts` and `rules-v2.ts` for their receipts).
  - `trend-vol.ts`: the trend and volatility ensemble (and its staked version); `house.ts` lists every rule `house` can run.
  - Staked rules: `staked.ts` runs a version 3 rule with the NEAR side held as stNEAR (Meta Pool), adding `stake` and
    `unstake` decisions between wNEAR and stNEAR on Rhea rated pool 3514. Mainnet only; testnet has no staking token.
  - Backtest: `src/backtest/` runs every skill with the live decide code over `data/near-usdt-1d.json`
    (`bin/backtest.mjs`); results feed the site's Skills page.
- `mcp/`: the read-only MCP server, with `server.json` for the MCP Registry.
- `skills/sledgit-vault/`: the agent skill, laid out for `npx skills add`.
- `site/`: the website (Next.js static export).
- `deploy/`:
  - `testnet/`: lock, arena, suite and perf results;
    - `s1/receipts-arena/`, `s1/receipts-house/`: season s1 decisions on the round-3 vaults (`arena2.`), with TEE evidence;
    - `receipts-arena/`, `receipts-house/`: earlier decisions on the retired `arena.` vaults, kept as history;
    - `league/`: the leaderboard registry (`entries.json`), saved inputs, snapshot and per-agent records (`SCHEMA.md`);
    - `receipts/`: the legacy vaults' receipts;
  - `vercel/`: the preview deploy.
- `tests/`: `tests/run.sh` runs every check and writes a report (`tests/README.md`).
- `audits/`: review findings and dispositions.
- `spikes/`: experiments behind design decisions. Each has its own README:
  - `chainsig-intents`: a policy-checked intent signed by the MPC;
  - `chainsig-hyperliquid`: an account (not yet the vault) signing a Hyperliquid order;
  - `near-ai-tee`: a TEE spike;
  - `arb-paper`: no profitable loop in 320 checks;
  - `backtest`: 6 years of NEAR data; only staking beat holding with confidence.
- `prototype/`: the first single-file version, kept for reference.

## Roadmap

1. Mainnet house vaults: volatility target, breakout, band rebalance and a staked rule, as reference entries.
2. Price-oracle floors per pair, so pairs without a Rhea pool (SOL, gold, EUR stablecoins inside NEAR Intents) can be
   traded under the same limits.
3. The public factory (live): anyone can create a small vault (about 0.1–0.2 NEAR of storage plus
   their deposit). Beta deposit cap, set by the factory for the life of each vault: the owner's net deposits per token
   (deposits made with `ft_transfer_call`, minus withdrawals) can't exceed it, and the excess is sent straight back.
   The factory's admin account (`sledgit.near`) can change the caps for every vault (`set_deposit_caps`, then
   `push_deposit_caps`, which delivers each change to each vault once) and the NEAR deposit range for new vaults. It
   can raise, lower or remove the caps and can stop new deposits or new vaults; it can't move funds or touch any
   vault's code, limits, agent or withdrawals. It hands over in two steps and can renounce the role for good.
   It isn't a ceiling on what a vault can hold: a plain `ft_transfer` or a NEAR Intents transfer into the vault isn't
   counted. The per-trade and daily limits still bound what the agent can trade, and the leaderboard unranks an entry
   whose balances don't match its recorded deposits.
   - Two agent entries run from this factory so far, each with its own owner and agent account.
   - Agent software holds only a function-call key scoped to its vault with a finite allowance. Each agent account also
     has a separate full-access recovery key for its gas money; moving those keys offline is still open.
   - The reproducible build hash is published at the release tag. Deployed vaults never change: a new version means a
     new factory and vaults that owners choose to move to.
4. No fees: the contracts take none, and none are planned on chain.
5. Badge hardening: binding to the gateway's TLS session, Sigstore provenance for the pinned images, NVIDIA token
   signature checks, and keeping each quote's Intel collateral with the evidence.
6. List the MCP server in the MCP Registry, and publish the skill (`npx skills add`, ClawHub).
7. A hardware (TPM2) badge.

## License

MIT. See [LICENSE](LICENSE).
