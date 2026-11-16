# Sledgit agent

The agent side of Sledgit:

- [`SKILL.md`](SKILL.md) - a skill any AI agent can follow to operate a vault safely.
- `src/` - a runner CLI that implements it, including `arena`: an LLM decides each tick under one fixed prompt, so
  different models can be compared on the same rules, the same data and the same vault policy.

TypeScript on Node 20 (>= 20.18.3) with `near-api-js` 7.2.0, the library the official NEAR agent skills recommend for
TypeScript. 7.2.0 is the newest release that still supports Node 20 (7.3+ needs Node 22.22). All dependencies are
pinned to exact versions. `tsx` is a runtime dependency: `bin/sledgit.mjs` loads it from this package, so running
the CLI never fetches anything from the registry.

## Setup

```
cd agent
npm ci --ignore-scripts       # the only install scripts are esbuild's and fsevents' (optional); not needed
npm test                      # offline unit tests, no keys or network
npm ci --omit=dev --ignore-scripts && node bin/sledgit.mjs --help   # runtime-only install also works
```

## Configuration (all from the environment)

| Variable | Meaning |
|---|---|
| `SLEDGIT_VAULT` | vault account id (or `--vault`) |
| `SLEDGIT_KEY_FILE` | path to a JSON key file: `{"secret_key"|"private_key": "ed25519:...", "account_id"?: ...}` |
| `SLEDGIT_AGENT` | agent account, when the key file has no `account_id` |
| `SLEDGIT_RPC`, `SLEDGIT_BASE`, `SLEDGIT_QUOTE` | optional overrides of the network defaults |
| `ANTHROPIC_API_KEY` | for `--provider anthropic` |
| `SLEDGIT_OPENAI_BASE_URL`, `SLEDGIT_OPENAI_API_KEY` | for `--provider openai-compatible` (key optional) |
| `SLEDGIT_HTTP_HOSTS` | comma-separated hosts allowed over plain `http` (loopback and Yggdrasil `200::/7` are always allowed) |
| `SLEDGIT_MAINNET_CONFIRM` | must equal `I-UNDERSTAND-REAL-FUNDS` for `--mainnet` |

The old `IRON_TRADE_*` names are still read when the `SLEDGIT_*` one is unset (legacy; to be removed).

Testnet is the default. Mainnet needs both `--mainnet` and the confirmation variable. Before any key is loaded, every
command asks the RPC for its `chain_id` and stops unless it equals the selected network, so `SLEDGIT_RPC` can never
move a testnet run onto mainnet (or label mainnet activity as testnet). Vault, base and quote ids must end in
`.testnet` on testnet and `.near` (or be implicit) on mainnet. Signing commands also check that the vault's `agent_id`
is the key's account.

Endpoints (`SLEDGIT_RPC`, `SLEDGIT_OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`) must be `https` except on loopback,
Yggdrasil or an allowlisted host, and must not carry `user:pass@`. Every RPC call has a deadline (30 s for views,
150 s for sending a transaction).

**Secrets.** Keys, API keys and endpoint URLs are registered with a redactor that runs on everything printed, on the
model's output before the receipt is sealed (so the hash covers the redacted bytes), and on reasons. Receipts and
`outcomes.jsonl` carry only fixed error codes (`model_error:http_401`, `invalid_output:bad_amount`,
`price_error:bad_price`), never an error message; on-chain notes are only `hold`, `model_error`,
`invalid_model_output`, `price_error` or `refused:<code> <action> <amount>`. The redacted detail is printed to the terminal as `decision_detail`
and stored nowhere. A malformed key file is reported by path only; a key file readable by other users draws a warning.

**Agent key.** Use a FunctionCall access key, not a FullAccess key: receiver = the vault, methods =
`request_swap, request_intent_swap, log_skip, intents_cancel, intents_settle, freeze`, and a small allowance
(for example 0.25 NEAR). All agent methods take 0 deposit, so this is enough, and a leaked key or a runaway loop can
then only spend its allowance on vault calls. The CLI checks the key at startup: a FullAccess key draws a warning, and
a FunctionCall key for another receiver is refused. Add one with near-cli's
`account add-key <agent> grant-function-call-access` (signed by a full-access key of the agent account, kept offline).

**Anthropic endpoint.** The Anthropic SDK honours `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS`. The runner
passes the base URL explicitly, disables SDK retries (one request per tick), and when either variable is set it records
`model.endpoint: "custom"` in every receipt, since the model named there is then whatever that endpoint says it is.

## Commands

```
npx tsx src/cli.ts status
npx tsx src/cli.ts preview sell 0.05          # free policy check
npx tsx src/cli.ts swap sell 0.05 --reason "..."   # receipt -> preview -> request_swap (Rhea)
npx tsx src/cli.ts intent sell 0.05           # receipt -> preview -> request_intent_swap
npx tsx src/cli.ts skip "no edge this hour"   # receipt -> log_skip
npx tsx src/cli.ts settle | cancel | freeze
npx tsx src/cli.ts verify receipts/testnet/receipts.jsonl   # match every receipt to the vault's on-chain event
npx tsx src/cli.ts lint receipts/testnet/receipts.jsonl     # offline: canonical-form check only
npx tsx src/cli.ts arena --provider anthropic --model claude-opus-5-5 --ticks 12 --interval 300
npx tsx src/cli.ts arena --provider openai-compatible --model qwen3.6        # a local model, with SLEDGIT_OPENAI_BASE_URL
npx tsx src/cli.ts arena --provider echo --model "sell 0.02"                 # stub, no model call
npx tsx src/cli.ts arena ... --dry-run        # seal the receipt, send nothing
```

`node bin/sledgit.mjs <command>` (or `npm run it -- <command>`) is equivalent to `npx tsx src/cli.ts <command>`.

`buy` spends the quote token (USD stable) for wNEAR; `sell` spends wNEAR. Amounts are decimals of the token spent.
`swap` and `intent` stop without sending if the preview refuses, and print the code. Exit codes say whether the vault
recorded what you asked for: `intent` exits 0 only on `intent_authorized`; `cancel` exits 1 unless the vault emitted
`intent_cancelled` (on `intent_cancel_failed` the intent may still fill); `settle` exits 1 when nothing was recorded
(the intent is still live).

**Intents.** On `intent_authorized` the CLI prints the signed `multi_payload` and appends it to
`receipts/<network>/intents.jsonl`. **This runner does not publish it to solvers**: to get a fill, submit it to a NEAR
Intents solver relay before its deadline. Otherwise it expires; run `settle` after the deadline to release the cap. An
`intent_unsigned` result is `unknown_until_settled`: the cap stays reserved and only `settle` decides. `freeze` warns
when an intent is still open, because a signed intent stays fillable until its deadline: run `cancel` too. The
intents balance (`mt_balance_of` on the intents contract) is not checked before requesting.

## Arena tick

0. Read `get_config`. If the vault is frozen, or its `agent_id` is no longer this key's account, the run stops (exit 1)
   before any model call, receipt or transaction.
1. Read the vault (policy, usage, in-flight, open intent, balances, decimals) and the mainnet NEAR/USDT price
   from Binance's public ticker. Views use `optimistic` finality (the near-api-js default).
2. Send the model `prompts/arena-v1.1.md` as the system prompt and the inputs as one canonical JSON user message. The
   model's last five decisions on this vault are included as history.
3. Parse and validate the answer: exactly `{action, amount_in, reason}`, action `buy|sell|hold`, a plain decimal
   amount with no more digits than the token has (a JSON number with more than 15 significant digits is rejected;
   send amounts as strings). Anything else becomes a recorded `hold` with `invalid_output:<code>`; a provider error
   becomes `model_error:<code>`; a reference price that is not a plain decimal between 0.01 and 10 000 becomes
   `price_error:<code>` without calling the model. Replies over 64 KB are cut off as `model_error:oversize`. Nothing
   is retried.
4. Seal the receipt, append it to `receipts/<network>/receipts.jsonl`.
5. Hold -> `log_skip`. Otherwise: more than the vault holds -> `log_skip` with `refused:insufficient_balance`;
   preview refuses -> `log_skip` with `refused:<code>`; preview passes -> `request_swap` with
   `min_amount_out = band_floor`. Every decision therefore lands on-chain with its receipt hash.
6. Append the outcome (tx hash, preview, refusal code, what was sent including `min_amount_out`, vault event) to
   `receipts/<network>/outcomes.jsonl`. History for the next tick skips lines that do not parse and dry runs.

`--ticks` must be a whole number from 1 to 1000 and `--interval` from 30 to 86 400 seconds; anything else (`5m`,
`1e9`, `Infinity`) is refused. Each tick makes at most one model request and one transaction, so `--ticks` caps both.
The runner reads events only from receipts the vault itself executed.

Every model gets the same prompt, the same input format and the same validator. The Anthropic provider asks for the
decision through structured output (a JSON schema) at `effort: "medium"` and does not enable server-side fallbacks, so
the model named in a receipt is the model that answered. The openai-compatible provider does not use JSON mode (some
local servers return `{}` with it), strips `<think>` blocks, and falls back to `reasoning_content` when `content` is
empty.

## Adding a model

Add a case to `makeModel` in `src/models.ts` that returns `{ ref: {provider, id}, complete(system, user) }`, where
`complete` returns the model's raw text. Do not parse or repair the output there; `src/decision.ts` validates every
provider the same way. Add the provider's key to the redactor with `registerSecret`.

## Receipts and verification

A receipt is `{v, vault, network, agent, model, prompt_sha256, inputs, decision, model_output, ts}`. `inputs` holds the
reference price with its source and fetch time, the converted policy/usage/balances the model saw, and under
`inputs.raw` the exact on-chain values. CLI actions get receipts too, with `model: {provider: "human", id: "cli"}`.

- Canonical form: RFC 8785 (JCS): keys sorted at every level by UTF-16 code units, no whitespace, ECMAScript string
  escaping and number form, amounts as strings.
- `receipt_hash = sha256(canonical line)` in lowercase hex. The line in `receipts.jsonl` is exactly the hashed bytes.
- `prompt_sha256 = sha256(prompts/arena-v1.1.md bytes)`. Changing the prompt changes every later receipt, so runs under
  different prompts are never mixed by accident; name a new prompt file (`arena-v2.md`) rather than editing v1.

To verify: `verify <file> [--outcomes <file>]` hashes each stored line, finds its transaction in `outcomes.jsonl`, reads
that transaction from the chain, and requires a `request`, `refuse` or `skip` event **emitted by the vault account**
with the same `receipt_hash`, whose direction, `token_in` and `amount_in` match the receipt's decision. It exits 1 if
any receipt has no on-chain match. Dry-run receipts are reported as `dry_run` (never on chain). `lint <file>` is the
old offline check: it only flags lines that are not in canonical form, which a rewritten line can still pass.

## Tests

`npm test` runs the offline suites. `test/unit.test.ts`: canonical JSON and hashing, receipt linting, decision
parsing including malformed model output, 24- and 6-decimal amount conversion, event/refusal classification, mainnet
gating, redaction, and full arena ticks against a fake vault (swap path, preview refusal, insufficient balance,
invalid output, dry run). `test/audit.test.ts`: one regression test per finding of the round-2 audit, using local
HTTP servers on 127.0.0.1, a fake vault and keys generated per run (secret leaks via an echoing model server, chain_id
mismatch, loop bounds and the freeze brake, on-chain verify of a tampered receipt, intent exit codes and
`multi_payload`, access-key checks, forged events, oversized replies, bad prices, key-file handling, SKILL gas numbers
against the contract source, corrupt outcomes, imprecise numbers, the local launcher, and RPC timeouts).
`npm run typecheck` runs `tsc`.

The testnet smoke run is the CLI itself against a real vault: `status`, `preview`, `swap sell 0.05`, `skip`, and one
`arena --provider echo` tick.
