# demo-trader

A small AI trading desk whose broker is a Sledgit vault. It's a worked example of three things: how to run an agent on Sledgit, how to verify every transaction it makes, and how to find it on the leaderboard.

The desk has four roles and one broker:

| Role | Job |
|---|---|
| **Screener** | Checks there's something to decide on: enough history, a price, a funded vault with no swap in flight. |
| **Analyst** | Reads the daily trend (20- and 50-day averages). Optionally also reads a **Kronos** forecast of the next 24 hours, and then both must agree. |
| **Risk** | Holds when the vault's own limits are already used up. |
| **Budget** | Sizes the step: toward 70% NEAR when the view is up, or 30% when it's down, at most 25% of the vault per decision. |
| **Broker** | The vault. It checks the trade against its on-chain policy, then swaps on Rhea or refuses. Either way it leaves an event carrying the receipt's hash. |

The roles follow the [trader-skill](https://github.com/Jakeschincariol/trader-skill) pack's design (screener → analyst → risk → budget → broker), adapted from stocks to wNEAR/USDC. The desk is plain code, published with its parameters in [`prompts/iron-trader-v1.md`](prompts/iron-trader-v1.md), so anyone can re-run any decision from its receipt. See [`NOTICE.md`](NOTICE.md) for sources and licences.

**Be honest with yourself about what this is.**
- A trend rule and a forecast model are signals to test, not edges. Kronos is a research model for candlestick data; nothing here claims it predicts profitably.
- Most agents don't beat holding. The leaderboard ranks this one against holding and staking NEAR, after costs, like every other entry.
- Testnet results are practice: testnet pools aren't real markets.

## 1. Install

You need Node 20.18.3 or later. Run everything from the repository root.

```bash
(cd agent && npm ci --ignore-scripts)    # the runner demo-trader is built on (pinned dependencies, no install scripts)
(cd demo-trader && npm test)             # offline tests: no keys, no network
node demo-trader/bin/demo-trader.mjs tick --help
```

**Optional: Kronos.** Use a separate Python 3.12 virtualenv, and keep the Kronos checkout and weights outside this repository:

```bash
git clone https://github.com/shiyu-coder/Kronos ~/kronos/src && git -C ~/kronos/src checkout 67b630e67f6a18c9e9be918d9b4337c960db1e9a
python3.12 -m venv ~/kronos/venv
~/kronos/venv/bin/pip install torch==2.9.1 "numpy<2.4" pandas==2.3.3 einops==0.8.1 huggingface_hub==0.33.1 safetensors==0.6.2 tqdm==4.67.1
~/kronos/venv/bin/huggingface-cli download NeoQuasar/Kronos-small --local-dir ~/kronos/Kronos-small
~/kronos/venv/bin/huggingface-cli download NeoQuasar/Kronos-Tokenizer-base --local-dir ~/kronos/Kronos-Tokenizer-base
export DEMO_TRADER_KRONOS_PYTHON=~/kronos/venv/bin/python DEMO_TRADER_KRONOS_SRC=~/kronos/src \
       DEMO_TRADER_KRONOS_MODEL=~/kronos/Kronos-small DEMO_TRADER_KRONOS_TOKENIZER=~/kronos/Kronos-Tokenizer-base
```

The runner checks both `model.safetensors` files against the sha256 values pinned in `NOTICE.md` and refuses anything else. A forecast takes about 30 seconds on a laptop CPU. The script runs offline (`HF_HUB_OFFLINE=1`) with `python -I`.

## 2. Create and top up a vault

Every vault comes from a keyless factory. Nobody holds a key to the factory or to your vault, so nobody can change its code, including us.

- **Testnet (now, free):**
  1. Create a NEAR testnet account and get test NEAR from a faucet.
  2. Create `<name>.arena2.irontrade.testnet` from the factory, with yourself as owner and a separate account as the agent. The exact commands are on the site's developer page (`/developers/`) and in `agent/SKILL.md`.
  3. Deposit a little wNEAR and test USDC.
- **Mainnet (after launch):** the same steps against the mainnet factory. The code is reviewed, not externally audited, and you can lose what you deposit. Only the owner can withdraw, at any time. Vault storage costs about 0.1–0.2 NEAR.

The agent account gets **one function-call key** that can only call your vault's agent methods. With it, the agent can only ask the vault to trade within your limits. It can't withdraw or change the limits. Keep that key in a file only you can read (`chmod 600`) and point the runner at it:

```bash
export SLEDGIT_KEY_FILE=~/.config/demo-trader/agent-key.json   # never commit it, never paste it into a chat
```

## 3. Connect an agent

**Run the desk:**

```bash
B="node demo-trader/bin/demo-trader.mjs"
V=<name>.arena2.irontrade.testnet
$B status --vault $V                                     # balances, limits, usage
$B tick   --vault $V --dry-run                           # the desk's decision; nothing is sent
$B tick   --vault $V --receipts runs/$V                  # one real decision
$B tick   --vault $V --kronos --receipts runs/$V         # with the Kronos forecast
$B tick   --vault $V --receipts runs/$V --ticks 24 --interval 3600   # hourly for a day (in a terminal you keep open)
```

**Let your coding agent drive it.** [`skill/SKILL.md`](skill/SKILL.md) teaches an agent to run the desk, explain each decision, verify it and stop when something looks wrong. The agent never handles keys.

| Harness | How to plug it in |
|---|---|
| Claude Code | Copy `demo-trader/skill/` to `.claude/skills/demo-trader/` in your project (or to `~/.claude/skills/demo-trader/`), then ask: "run one demo-trader tick on my vault and verify it". |
| Codex | Copy it to `~/.codex/skills/demo-trader/`, or paste `SKILL.md` into your project's `AGENTS.md`. |
| OpenClaw and other skill-aware agents | Put the `demo-trader/` skill folder in the agent's skills directory. |
| Chat-only assistants (no shell) | They can't run commands. Paste a receipt and ask them to explain it, using `SKILL.md` as the instructions. |
| Any MCP client | `mcp/` is a read-only MCP server for policy, usage, previews, records and verification. |

**Use your own model instead of the desk.** It's the same vault, prompt format and checks. Your model decides; the vault still enforces the limits:

```bash
node agent/bin/sledgit.mjs arena --vault $V --provider anthropic --model <model id>           # needs ANTHROPIC_API_KEY
node agent/bin/sledgit.mjs arena --vault $V --provider openai-compatible --model <model id>   # needs SLEDGIT_OPENAI_BASE_URL (+ _API_KEY)
```

## 4. Watch it trade

Each tick prints the decision, the receipt hash and the transaction:

```
"reason": "screen ok | analyst trend up, kronos 75% up +1.8% -> up | risk ok | budget buy 0.5 w=0.42->0.7 | to broker"
"outcome": { "status": "traded", ... }    the swap passed the vault's checks and filled above its floor
"outcome": { "status": "skipped" }        a hold, or a refusal at preview (the on-chain note says refused:<code>)
"outcome": { "status": "refused" }        the vault refused at request time; nothing moved
"explorer": "https://testnet.nearblocks.io/txns/<tx>"
```

A refusal counts as a result: it shows the limits working. The vault records it with a fixed code such as `trade_cap`, `daily_cap` or `rate_limit`.

## 5. Verify every transaction

There are four checks, and each needs less trust than the one before:

1. **Receipt.** `runs/$V/receipts.jsonl` holds one JSON line per decision: the inputs (balances, limits, candles, the Kronos window and forecast), the desk spec's hash, and the decision. The line's sha256 is the receipt hash.
2. **`verify`** matches each receipt against the vault's on-chain event that carries the same hash. It also checks that the vault really came from the keyless factory and runs the pinned code:
   ```bash
   $B verify runs/$V/receipts.jsonl      # "verify: onchain N of N; all passed"
   ```
3. **`rerun`** re-runs the desk on each receipt's recorded inputs, which needs no trust in us. With `--refetch` it downloads the hourly window Kronos read again and compares hashes:
   ```bash
   $B rerun runs/$V/receipts.jsonl --refetch    # "rerun: N of N reproduce"
   ```
4. **Explorer.** Open the transaction on nearblocks. The `log_skip` or `request_swap` call carries the receipt hash in its arguments and its event.

## 6. See it on the leaderboard

At sledgit.com, open **Leaderboard** and switch to **testnet**. The demo desk is listed as `Demo trader` (agent page `/agents/tn-iron-trader-demo/`). For every entry, the page shows:

- each decision, with its transaction, receipt hash, side, amount and fill;
- the result against **Hold 50/50** and **Stake & hold**, after gas;
- the proof tier. demo-trader is **self-reported**: the receipts let anyone re-run each decision, but it isn't TEE-attested.

To list your own vault, ask for it to be added to the league registry (`deploy/testnet/league/entries.json`) with its receipts directory. The leaderboard is rebuilt from the chain, and nothing you claim about your entry is taken on trust.

## The live demo (testnet)

| | |
|---|---|
| Vault | `iron-trader-demo.arena2.irontrade.testnet` (from the keyless factory `arena2.irontrade.testnet`) |
| Agent | `itrader-agent.it1793205219-owner.testnet`, one function-call key for this vault, plus an offline recovery key |
| Receipts | [`deploy/testnet/s1/receipts-arena/iron-trader-demo/`](../deploy/testnet/s1/receipts-arena/iron-trader-demo/) |

The two ticks of 1 Nov 2026 are both holds: the daily trend was mixed, so the analyst passed.

1. Without Kronos: `8aDakBspEdqwWsdJkBgR7VpkE1xD6ksyoZcdWbdLnhG`.
2. With Kronos: `6ro1vnD9M2idWHd2EzfGf7BgiRVY3q5oM1qXQqmQ7qi1`. Kronos gave 62.5% of paths up and a median of +2.4% over 24 hours, but the desk needs the trend and Kronos to agree.

`verify` passes 2 of 2 and `rerun --refetch` reproduces 2 of 2.
