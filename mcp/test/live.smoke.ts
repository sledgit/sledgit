// Opt-in live smoke test (read-only, testnet): spawns the real server over stdio and calls each chain tool once.
// Run: npm run smoke (sets SLEDGIT_MCP_LIVE=1). Skipped otherwise, so unit runs never touch the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const live = process.env.SLEDGIT_MCP_LIVE === "1";
const VAULT = process.env.SLEDGIT_MCP_VAULT ?? "qwen36-tee.arena2.irontrade.testnet";

test("live testnet: every chain tool answers through the real stdio server", { skip: !live && "set SLEDGIT_MCP_LIVE=1", timeout: 180_000 }, async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(HERE, "..", "bin", "sledgit-mcp.mjs")], stderr: "inherit" });
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!r.isError, `${name}: ${r.content[0]?.text}`);
    return JSON.parse(r.content[0].text) as Record<string, any>;
  };
  try {
    const list = await call("list_vaults", { limit: 20 });
    console.log(`list_vaults: ${list.vaults.length} vaults from ${list.factory}`);
    const pol = await call("get_vault_policy", { vault: VAULT });
    console.log(`get_vault_policy: ${VAULT} keyless=${pol.keyless} agent=${pol.config.agent_id} tokens=${pol.policy.tokens.length}`);
    const use = await call("get_vault_usage", { vault: VAULT });
    console.log(`get_vault_usage: trades this hour=${use.usage.trades}`);
    // A sell far above any per-trade cap must be refused by the vault's own policy.
    const pv = await call("preview_trade", { vault: VAULT, token_in: "wrap.testnet", token_out: "usdc.itachicara.testnet", amount_in: "1000000000000000000000000000", min_amount_out: "1" });
    console.log(`preview_trade (1000 wNEAR): ok=${pv.preview.ok} code=${pv.preview.code ?? "-"}`);
    assert.equal(pv.preview.ok, false);
    assert.equal(pv.preview.code, "trade_cap");
    const rec = await call("get_agent_record", { vault: VAULT, max_txs: 50, limit: 5 });
    console.log(`get_agent_record: ${rec.transactions_read} txs read, counts=${JSON.stringify(rec.counts)}`);
    // The committed on-chain arena decision (Qwen3.6 via NEAR AI on the round-3 vault, TEE-attested).
    const rf = join(HERE, "..", "..", "deploy", "testnet", "s1", "receipts-arena", "qwen36-tee", "receipts.jsonl");
    const of = join(HERE, "..", "..", "deploy", "testnet", "s1", "receipts-arena", "qwen36-tee", "outcomes.jsonl");
    if (existsSync(rf) && existsSync(of)) {
      const line = readFileSync(rf, "utf8").split("\n").find((l) => l.trim())!;
      const r = JSON.parse(line) as { vault: string };
      const hash = (await import("../../agent/src/receipt.js")).sha256Hex(line);
      const out = readFileSync(of, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { receipt_hash: string; tx?: string }).find((o) => o.receipt_hash === hash && o.tx);
      const v = await call("verify_receipt", { receipt: line, ...(out?.tx ? { tx: out.tx } : {}) });
      console.log(`verify_receipt: ${r.vault} ${hash.slice(0, 12)}… status=${v.status}`);
      assert.equal(v.status, "ok");
    }
  } finally {
    await client.close();
  }
});
