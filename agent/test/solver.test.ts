// Solver relay client: quote choice, publish errors, status polling. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestQuote, publish, waitSettled, relayKey } from "../src/solver.js";

const relay = (results: unknown[]) => {
  const calls: { method: string; params: unknown; key: string | null }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ method: body.method, params: body.params[0], key: new Headers(init.headers).get("X-API-Key") });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: results.shift() }), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
};

test("bestQuote picks the largest amount_out and sends the key", async () => {
  const r = relay([[{ quote_hash: "a", amount_in: "1", amount_out: "100" }, { quote_hash: "b", amount_in: "1", amount_out: "250" }]]);
  const q = await bestQuote("k", "wrap.near", "nbtc.bridge.near", 10n ** 24n, 120_000, r.f);
  assert.equal(q?.quote_hash, "b");
  assert.equal(r.calls[0].key, "k");
  assert.deepEqual(r.calls[0].params, { defuse_asset_identifier_in: "nep141:wrap.near", defuse_asset_identifier_out: "nep141:nbtc.bridge.near",
    exact_amount_in: (10n ** 24n).toString(), min_deadline_ms: 120_000 });
});

test("bestQuote returns null when no solver answers", async () => {
  assert.equal(await bestQuote("k", "a", "b", 1n, 120_000, relay([null]).f), null);
});

test("bestQuote ignores error replies such as INSUFFICIENT_AMOUNT", async () => {
  assert.equal(await bestQuote("k", "a", "b", 1n, 120_000, relay([[{ type: "INSUFFICIENT_AMOUNT" }]]).f), null);
  const q = await bestQuote("k", "a", "b", 1n, 120_000, relay([[{ type: "INSUFFICIENT_AMOUNT" }, { quote_hash: "c", amount_in: "1", amount_out: "7" }]]).f);
  assert.equal(q?.quote_hash, "c");
});

test("publish throws on a refusal and returns the intent hash on OK", async () => {
  await assert.rejects(publish("k", "h", {}, relay([{ status: "FAILED", reason: "bad signature" }]).f), /bad signature/);
  assert.equal(await publish("k", "h", {}, relay([{ status: "OK", intent_hash: "ih" }]).f), "ih");
});

test("waitSettled polls until settled", async () => {
  const r = relay([{ status: "PENDING" }, { status: "TX_BROADCASTED" }, { status: "SETTLED", data: { hash: "tx1" } }]);
  const s = await waitSettled("k", "ih", new Date(Date.now() + 60_000), r.f, async () => {});
  assert.deepEqual(s, { status: "SETTLED", tx: "tx1" });
  assert.equal(r.calls.length, 3);
});

test("relayKey refuses a key file others can read", () => {
  const p = join(mkdtempSync(join(tmpdir(), "relay-")), "jwt");
  writeFileSync(p, "secret\n"); chmodSync(p, 0o644);
  assert.throws(() => relayKey(p), /chmod 600/);
  chmodSync(p, 0o600);
  assert.equal(relayKey(p), "secret");
});
