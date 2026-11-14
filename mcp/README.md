# Sledgit MCP server (read-only)

An MCP server for AI agents and their operators to inspect Sledgit vaults on NEAR.
- It reads a vault's on-chain limits and usage, asks the vault whether a trade would be accepted, and lists an agent's decisions.
- It verifies a receipt against the vault's own on-chain event, and verifies a NEAR AI Cloud TEE attestation.

It holds no keys and cannot sign or move funds. Trading goes through the agent CLI (`agent/`), which signs with the agent's own function-call key; see `skills/sledgit-vault/SKILL.md`.

## Tools

| Tool | What it returns |
|---|---|
| `get_vault_policy` | Caps per token, allowed pairs (pool and minimum price band), trades per hour, max slippage; owner, agent and `frozen`; `keyless` (0 access keys) and the code hash |
| `get_vault_usage` | Spent per token over the rolling 24 h and trades this hour, as the contract counts them |
| `preview_trade` | The vault's own answer to a proposed swap: `ok` with pool and price floor, or a refusal code (`trade_cap`, `daily_cap`, `pair_not_allowed`, `rate_limit`, `frozen`, `busy`, `unsettled`, `zero_amount`, `unpriceable`, `intents_not_set_up`). `min_amount_out` must be above 0 |
| `list_vaults` | Vaults created by a factory, and the factory's pinned code hash and contract ids |
| `get_agent_record` | The vault's recent events, newest first (trade, refuse, skip, request, intent_*), with transaction links and counts |
| `verify_receipt` | sha256 of the exact receipt line, matched to a `request`/`refuse`/`skip` event logged by the vault itself, and checked against the receipt's decision |
| `verify_attestation` | A TEE evidence bundle checked fail-closed: Intel TDX quote, nonce and signer binding, RTMR3, MRCONFIGID, NVIDIA GPU evidence, and the model's signature over the exact request and reply. With a receipt, also checks the bundle is that decision's |

`network` is `testnet` (default) or `mainnet`. Account ids must carry the network's suffix, so an id can't cross networks. Lists and histories are capped (100 vaults, 200 transactions, 200 events).

## Run

```bash
cd mcp && npm ci            # agent/ needs `npm ci` too: receipt and attestation checks import its code
node bin/sledgit-mcp.mjs # stdio
node bin/sledgit-mcp.mjs --http 8787   # Streamable HTTP on 127.0.0.1:8787/mcp (loopback only, Host-checked)
```

Client config (stdio), for Claude Code, Codex, Cursor or any MCP client:

```json
{ "mcpServers": { "sledgit": { "command": "node", "args": ["/path/to/sledgit/mcp/bin/sledgit-mcp.mjs"] } } }
```

To serve it publicly, put a reverse proxy with TLS in front of the HTTP mode. The server itself never binds beyond loopback.

## Trust and network calls

- **Chain data:** JSON-RPC (`rpc.testnet.fastnear.com`, `free.rpc.fastnear.com`) and the FastNEAR transactions API (`tx.test.fastnear.com`, `tx.main.fastnear.com`). A dishonest RPC could lie about views. Cross-check important answers against a second RPC or your own node.
- **Vault provenance:** every vault-taking tool reports `provenance.sledgit_vault`. It is true only for a direct sub-account of a known factory (`agent/src/provenance.ts`; testnet: `arena.irontrade.testnet`, keyless, and the legacy `irontrade.testnet`, which still holds a key and is reported as such) that runs the factory's pinned code, has no access keys and was initialised with the factory's exchange/intents/MPC ids. Anything else is any contract: `verify_receipt` answers `unverified_vault`, and the other tools flag the data as untrusted.
- **Event authenticity:** only events logged by the vault account itself, in receipts that succeeded, count. A token or exchange contract in the same transaction can't forge one, and a failed receipt's logs (reverted) are reported as `failed_receipt_events`.
- **`verify_attestation`:** checks the bundle locally first (format, nonce, request, at most 8 model reports, the reply's signature). Only then does it fetch Intel collateral (Phala PCCS, 30 s deadline) and ask NVIDIA NRAS (30 s, 256 KB cap) for the GPU verdict, for the gateway and the one report whose address signed the reply. NRAS's answer is trusted over TLS; its JWT is not validated locally. A bundle alone proves a genuine TEE reply, not a vault decision: pass the receipt for that.
- **Timeouts:** every request has a 20 s deadline and an 8 MB response cap, enforced while the body streams. Token decimals outside 0–38 are refused. Errors come back as tool errors that name the endpoint and reason.
- **HTTP mode:** loopback only; only `POST /mcp` with a loopback Host and no foreign Origin; at most 8 requests at once (503 beyond); a request is closed after 120 s.

## Tests

```bash
npm test          # mocked RPC, no network: every tool, input refusals, forged-event and edited-receipt cases, the real recorded TEE bundle
npm run smoke     # opt-in, read-only live testnet run through the real stdio server
npm run typecheck
```

## Publishing (not done yet; needs the public repository)

1. **MCP Registry:**
   1. Replace `OWNER` in `server.json` and `package.json` (`mcpName`) with the GitHub owner.
   2. **Register the npm name first** (`sledgit-mcp` is unregistered as of 2026-10-29). Until then anyone could squat it, and a user copying the registry entry would run their code. `package.json` stays `private: true` so nothing publishes by accident.
   3. Publish a self-contained npm package: this directory bundled (esbuild) with the agent modules it imports, so it doesn't depend on `agent/node_modules`; the crypto dependencies (`@phala/dcap-qvl`, `@noble/*`) are declared and pinned here for that bundle. `private` removed.
   4. Run `mcp-publisher login github`, then `mcp-publisher publish`.

   `server.json` validates against the 2025-12-11 schema.
2. **Skills (`npx skills add <owner>/sledgit`):** works once the repository is public. The CLI finds `skills/sledgit-vault/SKILL.md`.
3. **ClawHub:** `clawhub login`, then `clawhub skill publish skills/sledgit-vault --slug sledgit-vault --version 0.1.0`.
