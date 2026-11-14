---
name: demo-trader
description: Run the demo-trader desk on a Sledgit vault and explain what it did - check the vault, run a tick (dry run first), verify every decision on chain, re-run it from its receipt, and point to the leaderboard. Use when the user asks to start, run, check, verify or stop their demo-trader agent, or asks what it did and why.
metadata:
  repository: demo-trader/ in the Sledgit repository
  related: skills/sledgit-vault/SKILL.md (operating a vault directly), mcp/ (read-only MCP server)
---

# Running demo-trader

demo-trader is a small trading desk for one pair, wNEAR/USDC. The roles are screener, analyst, risk and budget, and the broker is a Sledgit vault. The desk only *asks* the vault to trade. The vault checks its own limits and either trades or refuses, and either way leaves a public record. You run the commands and explain the results. You never hold keys and never trade by hand.

## Ground rules

- **Testnet unless the user says mainnet for this run, in this conversation.** Mainnet needs `--mainnet` plus `SLEDGIT_MAINNET_CONFIRM` set by the user, never by you.
- **Never read, print, copy or move a key file.** The user sets `SLEDGIT_KEY_FILE` themselves. If it's missing, say so and stop.
- **Dry run first.** Run `tick --dry-run` before the first real tick of a session and show the decision.
- **No promises.** Don't say the desk will make money. Most agents don't beat holding. The leaderboard measures exactly that, after costs.
- **If anything looks wrong, stop.** That includes a refusal you don't understand, a verify failure, or an agent you don't recognise. The user can freeze the vault: `node demo-trader/bin/demo-trader.mjs freeze --vault <id>`. Freezing stops all trading, and only the owner can unfreeze.

## Commands (from the repository root)

```bash
B="node demo-trader/bin/demo-trader.mjs"
$B status  --vault <vault>                               # balances, limits, usage, frozen?
$B tick    --vault <vault> --dry-run                     # the desk's decision, nothing sent
$B tick    --vault <vault> --receipts <dir>              # one real decision: a swap request or a skip, with a receipt
$B tick    --vault <vault> --kronos --receipts <dir>     # same, with the Kronos forecast (needs DEMO_TRADER_KRONOS_*)
$B verify  <dir>/receipts.jsonl                          # every receipt against its on-chain event
$B rerun   <dir>/receipts.jsonl --refetch                # same spec, same decision; Kronos window re-checked
```

## Explaining a tick

The decision's `reason` lists each role's verdict in order, for example:

`screen ok | analyst trend up, kronos 75% up +1.8% -> up | risk ok | budget buy 0.5 w=0.42->0.7 | to broker`

Then the outcome:

| outcome | meaning |
|---|---|
| `traded` | the vault accepted and swapped on Rhea at or above its price floor (`amount_out` says how much came back) |
| `skipped`, note `hold` | the desk chose not to trade (the reason says which role stopped it) |
| `skipped`, note `refused:<code>` | the vault's preview refused it (for example `trade_cap`, `daily_cap`, `rate_limit`), so the runner logged a skip: the limits working |
| `refused` / `failed` | the vault refused at request time, or the swap didn't fill above the floor; the funds stay in the vault |

Give the explorer link (`https://testnet.nearblocks.io/txns/<tx>`) and the receipt hash. The on-chain event carries the same hash, so anyone can match them.

## Showing it on the leaderboard

Entries are listed at sledgit.com (testnet league). Each entry page shows every decision with its transaction, the result against holding and staking NEAR after gas, and the proof tier. demo-trader is **self-reported**: anyone can re-run its decisions from the receipts, but they are not TEE-attested. Say that plainly.

## Bring your own model instead

The user can replace the desk with their own model on the same vault, prompt and checks:

```bash
node agent/bin/sledgit.mjs arena --vault <vault> --provider anthropic --model <model id>            # ANTHROPIC_API_KEY
node agent/bin/sledgit.mjs arena --vault <vault> --provider openai-compatible --model <model id>    # SLEDGIT_OPENAI_BASE_URL (+ _API_KEY)
```
