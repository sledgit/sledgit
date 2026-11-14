# Testnet fixture vaults

All five vaults below are children of the locked factory `arena.irontrade.testnet` (0 access keys, pinned vault code `5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ`). Each vault has 0 keys.

| Vault | Purpose | Agent (one function-call key: this vault, the 6 agent methods, no allowance) |
|---|---|---|
| `qwen36-tee.arena.irontrade.testnet` | Arena entry: Qwen3.6 via NEAR AI with TEE evidence | `agent2-qwen36-tee.it1793205219-owner.testnet` |
| `llama32-local.arena.irontrade.testnet` | Arena entry: local model, self-reported | `agent2-llama32-local.it1793205219-owner.testnet` |
| `perf.arena.irontrade.testnet` | Fixture: performance runs | `agent2-perf.it1793205219-owner.testnet` |
| `lifecycle.arena.irontrade.testnet` | Fixture: owner powers (freeze, timelock, ownership) | `agent2-lifecycle.it1793205219-owner.testnet` |
| `suite.arena.irontrade.testnet` | Fixture: the live test suite (every refusal code, caps, intents) | `agent2-suite.it1793205219-owner.testnet` |

**Fixture status:**
- The suite created `perf`, `lifecycle` and `suite` with agents that shared full-access keys: `perf`'s agent with the owner and root, and `lifecycle`/`suite`'s agents with the testnet intents contract's key.
- On 2026-10-29 (Phase 2b) the owner's `set_agent` re-pointed each one to a dedicated agent account with one scoped key (`deploy/testnet/arena-1793250981.json`).
- They are still test fixtures, not arena entries: their trades are scripted, so leaderboards should label them "fixture" or leave them out.
- To re-run the suite's agent steps against them, sign with the new agent key files (`~/.config/sledgit/testnet-agent2-<name>.it1793205219-owner.testnet.json`). The suite otherwise creates fresh vaults.

**Owner:**
- All five are owned by `it1793205219-owner.testnet`, which shares its key with the root `irontrade.testnet`.
- The root has no power over `arena` or its vaults, but exposing that key exposes the owner of every vault (review P2-5).
- On testnet that's accepted. Mainnet uses separate parent and owner keys (Phase 6).

**Intents contract:**
- The testnet copy of NEAR Intents (`it1793205011-intents.testnet`) is upgradeable by its key holder, and `arena` pins it permanently.
- Mainnet pins `intents.near`, so this doesn't carry over.
