# Audit round 2: agent runner and SKILL.md

**Scope:** `agent/src/*.ts`, `agent/test/unit.test.ts`, `agent/SKILL.md`, `agent/README.md`, `agent/prompts/arena-v1.md`,
`agent/package.json`, `agent/package-lock.json`. Checked against the agent-facing methods in
`contracts/vault/src/lib.rs` and `contracts/vault/src/intents.rs`.
**Date:** 2026-10-29. Node v20.19.3. **Baseline:** `npm test` passes 20/20, `npm run typecheck` is clean.
**Method:** I read all of the code and ran proofs of concept (PoCs) against the real modules, using local HTTP servers,
dummy keys and a fake vault. Nothing touched a network chain, and no file outside this report was changed.

Severity summary: **High 2 · Medium 4 · Low 9 · Info 7**

---

## High

### H1. Secrets and internal URLs reach the public chain and the receipts without redaction
- **Where:** `src/arena.ts:84-88` (`model_error: ${message}`), `src/arena.ts:104,123` (the error becomes the
  `log_skip` note), `src/arena.ts:107-113` (sealed into the receipt), `src/arena.ts:141-145` (outcomes),
  `src/models.ts:68,72` (`${base} answered HTTP ...: ${body.slice(0,300)}`). `redact()` runs only in `src/cli.ts:33,152`.
- **Failure:** any provider error message is placed verbatim in (a) the on-chain `skip` note, which is public and
  permanent, (b) the hashed receipt line and (c) `outcomes.jsonl`. None of these pass through the redactor. The README's
  promise ("Keys are never written to the repo, receipts or output") holds only for stdout.
- **PoC (ran it):** a local OpenAI-compatible server returns `401 invalid key <Authorization header>`. One arena tick
  produced the on-chain note `model_error: http://127.0.0.1:PORT/v1 answered HTTP 401: invalid key Bearer sk-live-SECRET-0123456789`.
  Both the receipt and the outcomes file contained the key. In a second run with `IRON_TRADE_OPENAI_BASE_URL=http://ops:hunter2@host/v1`,
  Node's fetch throws `Request cannot be constructed from a URL that includes credentials: http://ops:hunter2@...`,
  and that string went to the note and the receipt as well.
- **Impact:** an API key, basic-auth credentials or an internal host or IP (for example a home-server or mesh address) is
  published on-chain with no way to remove it. The base URL leaks on *every* model error, even when the server behaves
  correctly. The key leaks whenever a proxy or server echoes credentials. The same gap applies to `IRON_TRADE_RPC`: an
  RPC URL that carries an API key appears in the `${url} Bad Gateway` errors from near-api-js, because it is never
  registered as a secret.
- **Fix:**
  1. Never put free-form error text on-chain. Send a fixed code such as `model_error:http_401`,
     `model_error:timeout` or `invalid_output:<validator code>`. Keep the detail only in local logs.
  2. Apply `redact()` to `model_output` and the error *before* `sealReceipt`, so the hash is taken over the redacted
     bytes.
  3. Register `IRON_TRADE_OPENAI_BASE_URL`, its userinfo and `IRON_TRADE_RPC` as secrets, or strip them from messages.
  4. Reject base URLs that contain userinfo.
- **Test:** an echoing 401 server (the PoC above). Assert that the note passed to `logSkip`, the receipt line and the
  outcomes line contain neither the key nor the base URL, and that the note matches `^model_error:[a-z0-9_]+$`.

### H2. `IRON_TRADE_RPC` bypasses the mainnet gate, and the network is never verified
- **Where:** `src/config.ts:37-48`, `src/cli.ts:54`, `src/vault.ts:68`.
- **Failure:** `selectNetwork(false, {IRON_TRADE_RPC: "https://free.rpc.fastnear.com"})` returns `{id: "testnet", rpc: <mainnet RPC>}`
  (I checked this). If a mainnet RPC and a mainnet `IRON_TRADE_VAULT` are both left in the shell, every signing command
  signs and broadcasts on **mainnet** without `--mainnet` or `IRON_TRADE_MAINNET_CONFIRM`. The transaction's block hash
  comes from that RPC, so the transaction is valid on mainnet. Receipts and outcomes are labelled
  `network: "testnet"` and the explorer link points at testnet. The reverse also works: `--mainnet` plus a testnet
  RPC labels testnet activity as mainnet. Nothing checks that the vault or token account suffixes (`.near` or
  `.testnet`) match the network.
- **Impact:** the main guard against moving real funds by accident can be bypassed through an env var, and the records
  then name the wrong network.
- **Fix:** at startup, call `provider.viewNodeStatus()` (or `getNetworkId()`) and require `chain_id === net.id`. Also
  require the vault, base and quote IDs to end in `.near` on mainnet and `.testnet` on testnet, or put any override
  behind the same confirmation phrase. Record `chain_id` in the receipt.
- **Test:** stub the RPC so `status` returns `chain_id: "mainnet"`, then run `selectNetwork(false)` followed by the
  startup check. It must throw before any key is loaded. Also assert that `--vault x.near` without `--mainnet` throws.

---

## Medium

### M1. The arena loop has no bounds (denial of wallet), and it keeps sending while frozen or no longer the agent
- **Where:** `src/cli.ts:102-104` (`Number(o.ticks)`, `setTimeout(..., Number(o.interval) * 1000)`), and
  `src/arena.ts:58-140`, which has no per-tick check of `frozen` or `agent_id`.
- **Failure (ran it):**
  - `--interval 5m` gives `NaN` and `--interval 3000000` overflows 32 bits. Node fires both timers after about 1 ms,
    so ticks run back to back.
  - `--ticks Infinity` or `--ticks 1e9` is accepted, so the loop is effectively endless.
  - Every tick costs one LLM call (the Anthropic SDK also retries twice by default) and at least one signed
    transaction, because a hold, a refusal or a bad output all end in `log_skip`.
  - When the owner freezes the vault, every tick still sends a `log_skip`, since `log_skip` has no frozen check. SKILL
    §5.1 says "stop. Do not call anything else."
  - After `set_agent`, every tick sends a transaction that panics with `agent only` and still costs gas.
    `assertAgent` runs only once, at startup.
- **Impact:** a typo drains the agent account's NEAR and the LLM budget. A misbehaving loop keeps writing to the
  public record after the owner has pulled the brake.
- **Fix:**
  - Accept ticks only as an integer between 1 and N, and interval only as an integer between 30 and 86 400 seconds.
    Reject anything else.
  - Stop the run when `config.frozen` is true or `config.agent_id` is not the key's account. Do this at the top of
    every tick, before the model call and before any transaction.
  - Add a per-run cap on transactions and model calls.
  - Strongly recommend a FunctionCall access key with an allowance (see M4), which caps the gas a runaway loop can
    spend.
- **Test:**
  - `parseArgs(["arena", "--interval", "5m"])` must throw.
  - A fake vault whose `config()` returns `frozen: true` must lead to 0 calls to `logSkip` or `requestSwap`.
  - The same applies when `agent_id` is `other.testnet`.

### M2. `verify` does not detect content tampering
- **Where:** `src/receipt.ts:54-58`, `src/cli.ts:47-52`; README "Receipts and verification".
- **Failure (ran it):** I took the first real receipt, changed `decision.amount_in` to `"5"` and `reason` to
  `"TAMPERED"`, and re-serialized it with `canonical()`. `verify` printed `canonical: true` and exited 0. The check
  only finds edits that break canonical *form*. It never compares the hash with the on-chain `receipt_hash`.
  `outcomes.jsonl`, the file a user is told to use for the lookup, is not hashed or authenticated either.
- **Impact:** the command's name and exit code suggest an integrity check it does not perform. A rewritten receipt
  file passes CI or any operator who relies on the exit code.
- **Fix:** have `verify` fetch the vault's events (by tx hash from the outcomes file, or by scanning the vault's
  history through an indexer) and require each line's sha256 to appear as `receipt_hash` in an `irontrade` event
  emitted *by the vault account*. Also check that the event's `token_in`, `amount_in` and `action` match the
  receipt's decision. Exit non-zero on any receipt with no on-chain match. Rename the current check `lint`.
- **Test:** the PoC above as a unit test, with a stubbed event source holding the original hash. `verify` must report
  `onchain: false` and exit 1 for the tampered line.

### M3. The intents path is misdescribed in SKILL.md and misclassified by the runner
- **Where:** `SKILL.md:101,121-126,153-156`; `src/vault.ts:54-55`; `src/cli.ts:82,94-97`; contract
  `intents.rs:326-342,383-430`.
- **Failures:**
  1. **`intent_unsigned` is not a non-trade.** SKILL lists it as "intent did not trade", and `classify` maps it to
     `{status: "failed"}`. The contract says the opposite: a signature may exist, the cap stays reserved, and the
     outcome is decided only by `intents_settle` after the deadline, which can record a `trade`. An agent or operator
     who reads "failed" may treat the funds as unspent and make a decision that depends on that.
  2. **Cancel and settle report success when nothing happened.** The `cancel` command returns exit 0 when the
     transaction succeeds but emits `intent_cancel_failed` (a solver filled first, or signing failed), so the intent
     may still be live. `settle` returns exit 0 when `on_settle` was a no-op because the intent is still live. Both
     events fall through to `pending` in `classify`.
  3. **The signed `multi_payload` is never shown.** `classify` keeps only `min_amount_out` and `deadline`, and the
     `intent` command does not print `events`. Neither SKILL nor the runner says who sends the intent to solvers, or
     how. As shipped, every intent just expires: the cap is held for 120 s, then the vault returns `unsettled` until
     someone settles it.
  4. **SKILL's freeze rule omits a gap.** "`freeze()` is always safe" does not mention that an intent that is already
     signed stays fillable until its deadline. The contract's own doc comment on `freeze` says to follow it with
     `intents_cancel`.
- **Impact:** the agent's view of the vault diverges from what the vault records: it can believe funds were not spent
  when they were, or that a cancel worked when it did not.
- **Fix:**
  - Classify `intent_unsigned` as `{status: "unknown_until_settled", deadline}`.
  - Classify `intent_cancelled` and `intent_cancel_failed` explicitly, and return a non-zero exit code on cancel
    failure and on a settle with no event.
  - Print or return `multi_payload`, and document the publishing step, or state plainly that the runner does not
    publish.
  - In SKILL, change "intent did not trade" to "unknown until `intents_settle` after the deadline; the cap stays
    reserved", and add "if an intent is open, also call `intents_cancel`" to the freeze rule.
- **Test:**
  - `classify([intent_unsigned])` must not return `failed`.
  - A fake cancel whose logs hold `intent_cancel_failed` must make `main()` return 1.
  - An `intent` command test must assert that `multi_payload` appears in the output.

### M4. Nothing steers the operator toward a FunctionCall access key; any full-access key is accepted
- **Where:** `src/config.ts:59-71`, `src/vault.ts:69`, SKILL §8 "Keys", README "Configuration".
- **Failure:** the runner signs with whatever key the file holds, and the docs never mention access-key type. A
  full-access agent key that leaks lets an attacker drain the agent account's NEAR, add keys or delete the account,
  besides trading within policy. It also gives a runaway loop (M1) unlimited gas.
- **Fix:** document that the agent key should be a FunctionCall key with `receiver_id = <vault>`, methods
  `[request_swap, request_intent_swap, log_skip, intents_cancel, intents_settle, freeze]` and a small allowance. Every
  agent method takes 0 deposit, so this works. At startup, call `viewAccessKey` and warn, or refuse with
  `--allow-full-access`, when the key is `FullAccess` or its receiver is not the vault.
- **Test:** stub `viewAccessKey` to return `FullAccess`. Startup must fail unless the flag is set.

---

## Low

### L1. Events are trusted from any contract in the transaction, and a malformed event crashes the run after sending
- **Where:** `src/vault.ts:33-41,132`.
- `eventsFromLogs` reads logs from every receipt in the transaction tree, including the token and exchange contracts.
  A token contract in the policy (on testnet, `usdc.itachicara.testnet` belongs to a third party and can be upgraded)
  can log `EVENT_JSON:{"standard":"irontrade","event":"refuse",...}`. `classify` puts `refuse` first, so a real trade
  would be recorded as refused, and the model would see that in its history.
- A log that starts with `EVENT_JSON:` but is not valid JSON throws *after* the transaction landed. The outcome is
  then never written and the arena loop exits.
- **Fix:** keep only receipts with `outcome.executor_id === this.id`, and wrap the parse in try/catch, recording the
  error.
- **Test:** feed a fake transaction result with a forged `refuse` log from `token.testnet` plus a real `trade` from
  the vault, and assert `traded`. A malformed log must not throw.

### L2. Model responses have no size limit; plain HTTP is allowed
- **Where:** `src/models.ts:61-67`, `src/arena.ts:111`.
- `res.text()` has no cap. A hostile or broken endpoint can return hundreds of MB within the 180 s timeout. That text
  is regex-scanned (`<think>` stripping), then stored whole as `model_output` in every receipt line, and
  `verify`/`readHistory` load whole files into memory.
- `http://` endpoints are accepted, which exposes the bearer key and lets a man-in-the-middle choose decisions. Policy
  still bounds those decisions.
- **Fix:** stream the response and stop at about 64 KB, recording `model_error:oversize`. Require `https:` unless the
  host is loopback or an operator-allowlisted overlay address.
- **Test:** a server returns 10 MB. The tick must give `model_error:oversize`, and the receipt line must stay under
  100 KB.

### L3. No sanity check on the reference price; SKILL's "freeze if the feed is wildly off" is not implemented
- **Where:** `src/price.ts:14`, `src/arena.ts:63-70`.
- `Number(body.price) > 0` accepts `"0x10"` (16), `"Infinity"`, `" 2.5 "` and absurd values. The price is never
  compared with the vault's own pool quote or the band. The vault's band limits the loss, so this is Low, but the
  runner does not do what its own skill requires.
- **Fix:** require `/^\d+(\.\d+)?$/` and a plausible range. Compare with the implied price from the pool's
  `get_return` for a small amount, and hold (or freeze, as SKILL says) when they diverge by more than X%.
- **Test:** a price stub returning `"0x10"` or `"1e9"` must make the tick hold with an error code, and no model call
  may be made.

### L4. Edge cases in key handling
- **Where:** `src/config.ts:62`, `src/vault.ts:65,69`.
  - (a) If the key file is not valid JSON, the V8 parse error quotes about 10 characters of it, for example
    `Unexpected token 'e', "ed25519:3D"... is not valid JSON` (ran it). This is printed *before* `registerSecret`, so
    a key prefix goes to stderr and CI logs. Partial, so Low.
  - (b) near-api-js keeps the key as `signer.key.secretKey` (the 32-byte seed in base58, a different string from the
    registered `extendedSecretKey`). `JSON.stringify(vault)` or `util.inspect(vault)` exposes it, and `redact()`
    would not catch it (ran it). No current code path logs the vault, but one `console.log(vault)` while debugging
    would leak the key.
  - (c) The key file's permissions are not checked, so a world-readable file is accepted.
  - (d) The repo `.gitignore` ignores `*.key`, `*.pem` and `.env`, but not `*.json` key files, which is the format
    the runner reads.
- **Fix:**
  - Catch the JSON error and rethrow `key file is not valid JSON: <path>` with no detail.
  - Make `account` an ES `#private` field, or add `toJSON` and `[util.inspect.custom]` to `Vault`, and register the
    seed form as well.
  - Warn when the file mode is `& 0o077`.
  - Add `*key*.json` and `*.credentials.json` to `.gitignore`.
- **Test:** a key file with a trailing comma must produce stderr that contains no `ed25519:`. `util.inspect(new Vault(...))`
  must not contain the seed.

### L5. The gas minimums in SKILL.md are wrong
- **Where:** `SKILL.md:80`.
- "300 Tgas (min 200)" for `request_swap`. The contract requires `TG_MIN_REQUEST = 10 + 205 + 20 = 235`. The other
  minimums are `TG_MIN_INTENT_REQUEST = 230` and `TG_MIN_CANCEL = 255`.
- An agent that follows "min 200" and attaches 200-234 Tgas gets a panic, not a refusal event. Gas is burned and
  nothing reaches the record.
- **Fix:** list the exact minimums (235 / 230 / 255). Also say that `agent only`, a bad hash, too little gas and a long
  note are panics (the transaction fails and no event is emitted), not refusal codes.
- **Test:** a docs check that greps SKILL.md for the constants computed from `lib.rs` and `intents.rs`.

### L6. A corrupt `outcomes.jsonl` stops the arena from running again
- **Where:** `src/arena.ts:51-56`.
- `readHistory` calls `JSON.parse` on every line. One partial line (a crash or full disk during `appendFileSync`)
  throws on every later tick.
- Dry-run outcomes also feed the model's history as if they were real decisions.
- **Fix:** skip and count lines that do not parse. Exclude `outcome.status === "dry_run"` from the history, or keep
  dry runs in a separate file.
- **Test:** append `{"ts":` to the outcomes file. The next tick must still run, and its history must omit that line.

### L7. Numeric amounts lose precision silently
- **Where:** `src/decision.ts:51,65-70`.
- `{"amount_in": 123456789012345678901}` parses to `123456789012345680000`. That passes, and the amount traded differs
  from the model's output stored in the same receipt.
- **Fix:** reject numeric `amount_in` with more than 15 significant digits, or reject numbers outright, since the
  schema says string.
- **Test:** `parseDecision('{"action":"sell","amount_in":123456789012345678901,"reason":"x"}')` must fail.

### L8. The shebang and runtime pull in dev or unpinned tooling
- **Where:** `src/cli.ts:1` (`#!/usr/bin/env -S npx tsx`), `package.json` `bin`.
- Run outside the package directory (for example after `npm link`), `npx tsx` can fetch the latest unpinned `tsx`
  from the registry.
- Running at all needs devDependencies (`tsx`, `esbuild` with its install script), so `npm ci --omit=dev` cannot run
  the CLI, and the runtime trust boundary includes the dev tree.
- **Fix:** compile with `tsc` to `dist/` and run it with plain `node`, or use `node --import tsx` with tsx as a pinned
  runtime dependency. Document `npm ci --ignore-scripts`, which works here because the only install scripts are
  esbuild and fsevents.
- **Test:** CI runs `npm ci --omit=dev --ignore-scripts && node dist/cli.js --help`.

### L9. The JSON-RPC client has no request timeout
- **Where:** `src/vault.ts:68`.
- near-api-js's `fetchJsonRpc` sets no `AbortSignal`. A stalled RPC connection hangs the tick, and the arena,
  indefinitely, with nothing logged.
- **Fix:** pass a fetch wrapper that has a timeout, or race each call against a deadline.
- **Test:** a server that accepts and never responds must make `status` fail within N seconds.

---

## Info

- **I1. The canonical form is underspecified in SKILL.md (`SKILL.md:69`).** "Standard JSON escaping" is ambiguous.
  JS `JSON.stringify` leaves non-ASCII as raw UTF-8, while Python's default `ensure_ascii=True` escapes it, and the
  two print numbers differently (`1e+16` versus `10000000000000000`). Receipts from a non-JS agent are flagged
  non-canonical by `verify` even when they are honest. Hashing still verifies, because the stored line is the hashed
  bytes. Recommend naming RFC 8785 (JCS), which this implementation already almost matches with its UTF-16 key order,
  and saying "verify by hashing the stored bytes; never re-serialize".
- **I2. The model named in a receipt depends on the environment.** The Anthropic SDK honours `ANTHROPIC_BASE_URL`
  and `ANTHROPIC_CUSTOM_HEADERS`, so "the model named in a receipt is the model that answered" holds only if those are
  unset. Record the effective `baseURL` (and `ANTHROPIC_LOG` state) in `receipt.model`, or pass `baseURL` explicitly.
- **I3. Arena receipts do not commit to what was sent.** The receipt is sealed before preview, so the
  `min_amount_out` and venue actually sent are not in it; they are only in `outcomes.jsonl` and the on-chain
  `request` event. Nothing proves only one model call was made per tick, so an operator could cherry-pick. This
  matters for an arena that compares models: consider a per-run commitment, such as a hash chain of all receipts
  posted at the start and end of a run.
- **I4. Model-written text is published on-chain.** The model's `reason`, up to 200 characters of arbitrary Unicode,
  goes into a public on-chain note under the vault. An endpoint that has been prompt-injected or is malicious controls
  that text, for example phishing links. Consider a character allowlist.
- **I5. View finality differs from SKILL.** near-api-js views default to `optimistic` finality; SKILL's raw example
  uses `final`. This is harmless because the contract re-checks, but say which one the runner uses.
- **I6. SKILL does not explain the intents balance.** It says intents spend the vault's intents.near balance but not
  how to read it (`mt_balance_of` on intents.near with the `nep141:<token>` id). The `intent` command does not check
  it.
- **I7. Prompt-injection surface is small, and that is good.** The only untrusted strings that reach the model are
  the Binance price (numeric-checked, see L3), contract-generated refusal and failure reasons in the history, and the
  model's own earlier `reason`. The last one can carry an injection forward across ticks for the same model key.

---

## Checked and found safe

- **The model output cannot exceed its role.** The model chooses only `action`, a decimal `amount_in` and a reason.
  The runner fixes tokens (from network config), `min_amount_out` (the vault's own `band_floor`), the venue (Rhea
  only) and the method. Model output never reaches `freeze`, `cancel`, `settle` or `request_intent_swap`. The
  validator rejects extra fields, arrays, `__proto__` keys, exponent notation, negatives, a zero buy or sell, a
  non-zero hold, and more fraction digits than the token has. Invalid output becomes a recorded hold. Policy and caps
  are enforced on-chain whatever the runner does.
- **Units.** `toUnits`/`fromUnits` use only BigInt and are strict. `worst_price_out_per_in` scales correctly by
  `10^(dec_in − dec_out)`. Decimals are read from `ft_metadata`. Unit confusion by the model (sending smallest units
  as a decimal) gives a huge amount, which hits the local balance check or `trade_cap`.
- **Mainnet flag.** It needs the exact phrase; apart from H2, it is gated correctly. `assertAgent` runs before any
  signing command. The agent attaches 0 deposit, so owner-only methods (which need 1 yocto) are unreachable even with
  a full-access key.
- **Receipt ordering and format.** The receipt is sealed and appended (mode 0600) before any transaction. The hash is
  lowercase hex and matches the contract's `valid_hash`. `canonical()` sorts keys recursively, drops `undefined`, and
  rejects bigint and non-finite numbers. Duplicate-key or whitespace edits are flagged. A note goes through
  `clipBytes(280)`, which matches the contract's byte-based `MAX_NOTE`.
- **No retry storms in the runner.** Each tick makes exactly one transaction. The near-api-js retries are a
  resend of the same signed transaction (idempotent) and a re-sign only on `InvalidNonceError`, which cannot
  double-execute a transaction that has landed. Gas attached (300) is at or above every contract minimum (235, 230,
  255); 30 Tgas for `log_skip` and `freeze` and 100 for `intents_settle` are enough.
- **No `child_process`, `eval` or dynamic `import`** in `src/`. The key is never placed in a receipt, inputs or
  output. The Anthropic SDK's debug logger redacts `x-api-key`.
- **Supply chain.**
  - Top-level dependencies are pinned exactly.
  - The lockfile (v3) has 105 packages, all `resolved` from `registry.npmjs.org` with `integrity`.
  - Only `esbuild` and `fsevents` (both dev) have install scripts.
  - No typosquats: `near-seed-phrase`, `near-hd-key`, `bip39-light` and `is-my-json-valid` are the legitimate
    near-api-js 7.2.0 dependencies.
  - The old crypto chain is at patched versions (`sha.js 2.4.12`, `cipher-base 1.0.7`, `pbkdf2 3.1.7`, past the 2025
    advisories).
  - `npm audit --omit=dev` and the full `npm audit` both report 0 vulnerabilities (2026-10-29; this queries the
    registry's advisory database).
- **The existing local receipts** (`agent/receipts/testnet/*.jsonl`) contain no key material and all re-hash as
  canonical. A grep of the repo, excluding `node_modules` and `target`, found no `ed25519:` secret.

## Suggested test additions (one per finding above)

H1: an echoing 401 server; no key or URL in the note, receipt or outcomes. · H2: a stubbed `chain_id` mismatch throws
before the key loads. · M1: a bad `--interval` is rejected; frozen or not-agent means zero transactions. · M2: a
tampered canonical receipt makes `verify` exit 1. · M3: `intent_unsigned` is not `failed`; `intent_cancel_failed`
gives exit 1; the intent command prints `multi_payload`. · M4: a FullAccess key is refused without the flag. · L1: a
forged event from another executor is ignored, and a malformed log does not throw. · L2: a 10 MB body gives oversize.
· L3: a `"0x10"` price means hold. · L4: no key prefix on stderr; inspecting the Vault shows no seed. · L5: SKILL gas
numbers equal the contract constants. · L6: a partial outcomes line is tolerated. · L7: a numeric amount with more than
15 digits is rejected. · L8: the CLI runs with `--omit=dev`. · L9: an RPC that never responds times out.
