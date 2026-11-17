// Offline unit tests: no network, no keys. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, sealReceipt, sha256Hex, verifyFile, isReceiptHash, type Receipt } from "../src/receipt.js";
import { parseDecision, toUnits, fromUnits, clipBytes } from "../src/decision.js";
import { classify, eventsFromLogs, type Vault, type TxResult } from "../src/vault.js";
import { selectNetwork, redact, registerSecret, envOf, NETWORKS, MAINNET_CONFIRM_ENV, MAINNET_CONFIRM_VALUE } from "../src/config.js";
import { makeModel } from "../src/models.js";
import { tick } from "../src/arena.js";

const E24 = 10n ** 24n;

// ---------------------------------------------------------------- receipts

test("canonical JSON sorts keys at every level and drops undefined", () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" }, u: undefined }), '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

test("canonical JSON rejects values that would hash ambiguously", () => {
  assert.throws(() => canonical({ a: 1n }), /bigint/);
  assert.throws(() => canonical({ a: NaN }), /non-finite/);
});

test("sha256 matches a known vector and receipt hashes are 64 lowercase hex", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const r: Receipt = { v: 1, vault: "v.testnet", network: "testnet", agent: "a.testnet", model: { provider: "echo", id: "hold" },
    prompt_sha256: "00".repeat(32), inputs: { price: "2.5" }, decision: { action: "hold", amount_in: "0", reason: "x" }, model_output: "", ts: "2026-10-29T00:00:00.000Z" };
  const { line, hash } = sealReceipt(r);
  assert.ok(isReceiptHash(hash));
  assert.equal(hash, sha256Hex(line));
  assert.equal(sealReceipt({ ...r }).hash, hash, "deterministic");
  assert.notEqual(sealReceipt({ ...r, ts: "2026-10-29T00:00:00.001Z" }).hash, hash);
});

test("verifyFile re-hashes lines and flags a hand-edited (non-canonical) line", () => {
  const dir = mkdtempSync(join(tmpdir(), "it-"));
  const f = join(dir, "r.jsonl");
  const good = canonical({ ts: "t1", v: 1 });
  writeFileSync(f, `${good}\n{"v": 1, "ts": "t2"}\n`);
  const rows = verifyFile(f);
  assert.equal(rows[0].hash, sha256Hex(good));
  assert.deepEqual(rows.map((r) => r.canonical), [true, false]);
});

// ---------------------------------------------------------------- decisions

test("valid decisions parse, including number amounts, think blocks and code fences", () => {
  assert.deepEqual(parseDecision('{"action":"sell","amount_in":"0.05","reason":"take profit"}'),
    { ok: true, decision: { action: "sell", amount_in: "0.05", reason: "take profit" } });
  const qwen = '<think>\nprice is {up}...\n</think>\n```json\n{"action":"buy","amount_in":1.5,"reason":"dip"}\n```';
  assert.deepEqual(parseDecision(qwen), { ok: true, decision: { action: "buy", amount_in: "1.5", reason: "dip" } });
  assert.deepEqual(parseDecision('{"action":"hold","amount_in":"0","reason":"flat"}'),
    { ok: true, decision: { action: "hold", amount_in: "0", reason: "flat" } });
});

test("malformed model output is rejected with a reason, never coerced into a trade", () => {
  const bad: [string, RegExp][] = [
    ["I think you should sell", /no JSON/],
    ['{"action":"sell","amount_in":"0.05",', /no JSON|invalid JSON/],
    ['{"action":"sell" "amount_in":"1","reason":"x"}', /invalid JSON/],
    ['{"action":"short","amount_in":"1","reason":"x"}', /buy\|sell\|hold/],
    ['{"action":"sell","amount_in":"-1","reason":"x"}', /positive decimal/],
    ['{"action":"sell","amount_in":"1e3","reason":"x"}', /positive decimal/],
    ['{"action":"sell","amount_in":1e-7,"reason":"x"}', /positive decimal/],
    ['{"action":"sell","amount_in":"0","reason":"x"}', /above 0/],
    ['{"action":"sell","amount_in":"0.000","reason":"x"}', /above 0/],
    ['{"action":"sell","amount_in":"1","reason":""}', /reason/],
    ['{"action":"sell","amount_in":"1"}', /reason/],
    ['{"action":"hold","amount_in":"5","reason":"x"}', /hold must have amount_in 0/],
    ['{"action":"sell","amount_in":"1","reason":"x","min_amount_out":"0"}', /unexpected fields/],
    ['[{"action":"hold"}]', /no JSON|not an object/],
    ["", /no JSON/],
  ];
  for (const [text, err] of bad) {
    const p = parseDecision(text);
    assert.equal(p.ok, false, text);
    if (!p.ok) assert.match(p.error, err, text);
  }
});

test("over-long reasons are clipped to 200 characters", () => {
  const p = parseDecision(JSON.stringify({ action: "hold", amount_in: "0", reason: "x".repeat(500) }));
  assert.ok(p.ok && p.decision.reason.length === 200);
});

// ---------------------------------------------------------------- amounts

test("amount conversion with 24-decimal testnet tokens", () => {
  assert.equal(toUnits("1", 24), E24);
  assert.equal(toUnits("0.05", 24), 5n * 10n ** 22n);
  assert.equal(toUnits("0.000000000000000000000001", 24), 1n);
  assert.equal(toUnits("3", 24).toString(), "3000000000000000000000000");
  assert.equal(fromUnits("349999999999999999999000", 24), "0.349999999999999999999");
  assert.equal(fromUnits(E24 / 4n, 24), "0.25");
  assert.equal(fromUnits(0n, 24), "0");
  for (const s of ["0.05", "1.5", "123.000000000000000000000001"]) assert.equal(fromUnits(toUnits(s, 24), 24), s);
});

test("amount conversion with 6-decimal mainnet stablecoins, and invalid inputs", () => {
  assert.equal(toUnits("2.5", 6), 2_500_000n);
  assert.equal(fromUnits(2_500_000n, 6), "2.5");
  assert.throws(() => toUnits("0.0000001", 6), /more than 6 decimals/);
  assert.throws(() => toUnits("-1", 24), /not a decimal/);
  assert.throws(() => toUnits("1,5", 24), /not a decimal/);
  assert.throws(() => fromUnits(-1n, 24), /negative/);
});

test("notes are clipped to 280 UTF-8 bytes without splitting characters", () => {
  assert.equal(clipBytes("a".repeat(300)).length, 280);
  const s = clipBytes("€".repeat(100)); // 3 bytes each
  assert.equal(new TextEncoder().encode(s).length, 279);
});

// ---------------------------------------------------------------- vault events and refusals

const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.2.0", event, data: [data] })}`;

test("events are read only from the vault standard, sledgit or the legacy irontrade (pre-rename testnet vaults)", () => {
  const legacy = `EVENT_JSON:${JSON.stringify({ standard: "irontrade", version: "1.1.0", event: "skip", data: [{ seq: 3 }] })}`;
  const e = eventsFromLogs(["plain log", 'EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{}]}', legacy, ev("skip", { seq: 4 })]);
  assert.deepEqual(e, [{ event: "skip", data: { seq: 3 } }, { event: "skip", data: { seq: 4 } }]);
});

test("refusals, trades, failures and tx errors are classified from the vault's events", () => {
  const c = (logs: string[], failure?: string) => classify(eventsFromLogs(logs), failure);
  assert.deepEqual(c([ev("refuse", { code: "daily_cap", reason: "24-hour cap is 3" })]), { status: "refused", code: "daily_cap", reason: "24-hour cap is 3" });
  assert.deepEqual(c([ev("request", {}), ev("trade", { amount_out: "123", venue: "rhea" })]), { status: "traded", amount_out: "123", venue: "rhea" });
  assert.deepEqual(c([ev("request", {}), ev("failed", { reason: "Rhea quote 1 below the price band 2" })]), { status: "failed", reason: "Rhea quote 1 below the price band 2" });
  assert.deepEqual(c([ev("skip", {})]), { status: "skipped" });
  assert.equal(c([], '{"ActionError":{}}').status, "error");
  assert.equal(c([ev("request", {})]).status, "pending");
  assert.deepEqual(c([ev("intent_expired", {})]), { status: "expired" });
  assert.equal(c([ev("intent_authorized", { min_amount_out: "9", deadline: "d" })]).status, "authorized");
});

// ---------------------------------------------------------------- config and secrets

test("mainnet needs the flag AND the confirmation phrase", () => {
  assert.equal(selectNetwork(false, {}).id, "testnet");
  assert.throws(() => selectNetwork(true, {}), /SLEDGIT_MAINNET_CONFIRM/);
  assert.throws(() => selectNetwork(true, { [MAINNET_CONFIRM_ENV]: "yes" }), /SLEDGIT_MAINNET_CONFIRM/);
  assert.equal(selectNetwork(true, { [MAINNET_CONFIRM_ENV]: MAINNET_CONFIRM_VALUE }).rpc, NETWORKS.mainnet.rpc);
});

test("SLEDGIT_* variables win; the legacy IRON_TRADE_* names still work, except the mainnet confirmation", () => {
  assert.equal(envOf({ SLEDGIT_VAULT: "new.testnet", IRON_TRADE_VAULT: "old.testnet" }, "VAULT"), "new.testnet");
  assert.equal(envOf({ IRON_TRADE_VAULT: "old.testnet" }, "VAULT"), "old.testnet");
  assert.equal(envOf({}, "VAULT"), undefined);
  assert.throws(() => selectNetwork(true, { IRON_TRADE_MAINNET_CONFIRM: MAINNET_CONFIRM_VALUE }), /SLEDGIT_MAINNET_CONFIRM/);
});

test("registered secrets are redacted", () => {
  const fake = ["sk", "test", "0123456789"].join("-"); // built at runtime so secret scanners don't flag it
  registerSecret(fake);
  assert.equal(redact(`key=${fake} end`), "key=[REDACTED] end");
});

test("providers need their key or base URL from env", () => {
  assert.throws(() => makeModel("anthropic", "claude-opus-5-5", {}), /ANTHROPIC_API_KEY/);
  assert.throws(() => makeModel("openai-compatible", "qwen3.6", {}), /SLEDGIT_OPENAI_BASE_URL/);
  assert.throws(() => makeModel("gpt", "x", {}), /unknown provider/);
});

// ---------------------------------------------------------------- arena tick against a fake vault

function fakeVault(opts: { preview?: unknown; base?: bigint; quote?: bigint }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const tx = (method: string, events: string[]) => async (...args: unknown[]): Promise<TxResult> => {
    calls.push({ method, args });
    const e = eventsFromLogs(events);
    return { tx: `tx-${method}`, ok: true, events: e, outcome: classify(e) };
  };
  const v = {
    id: "v1.owner.testnet", agentId: "agent.testnet", net: NETWORKS.testnet,
    config: async () => ({ agent_id: "agent.testnet", frozen: false, seq: 1 }),
    policy: async () => ({ tokens: [{ token: "wrap.testnet", max_per_trade: E24.toString(), max_per_day: (3n * E24).toString() }],
      pairs: [{ token_in: "wrap.testnet", token_out: "usdc.itachicara.testnet", pool_id: 1103, min_price_num: "14", min_price_den: "10" }],
      max_trades_per_hour: 10, max_slippage_bps: 100 }),
    usage: async () => ({ hour: "1", trades: 0, spent: [] }),
    intents: async () => ({ open_intent: null }),
    inFlight: async () => null,
    decimals: async () => 24,
    balance: async (t: string) => (t === "wrap.testnet" ? opts.base ?? E24 / 2n : opts.quote ?? 0n),
    preview: async (...args: unknown[]) => { calls.push({ method: "preview", args }); return opts.preview ?? { ok: true, pool_id: 1103, band_floor: "7" }; },
    logSkip: tx("log_skip", [ev("skip", {})]),
    requestSwap: tx("request_swap", [ev("request", {}), ev("trade", { amount_out: "100", venue: "rhea" })]),
  };
  return { vault: v as unknown as Vault, calls };
}

function deps(vault: Vault, modelId: string) {
  const dir = mkdtempSync(join(tmpdir(), "it-arena-"));
  return {
    vault, model: makeModel("echo", modelId), prompt: { text: "PROMPT", sha256: sha256Hex("PROMPT"), path: "p" },
    price: async () => ({ source: "test", symbol: "NEARUSDT", price: "2.50", fetched_at: "t" }),
    receiptsPath: join(dir, "receipts.jsonl"), outcomesPath: join(dir, "outcomes.jsonl"),
  };
}

test("arena: a sell passes preview and goes to request_swap with the receipt hash and band floor", async () => {
  const { vault, calls } = fakeVault({});
  const d = deps(vault, "sell 0.05");
  const r = await tick(d);
  const swap = calls.find((c) => c.method === "request_swap")!;
  assert.deepEqual(swap.args, ["wrap.testnet", "usdc.itachicara.testnet", 5n * 10n ** 22n, 7n, r.receipt_hash]);
  const line = readFileSync(d.receiptsPath, "utf8").trim();
  assert.equal(sha256Hex(line), r.receipt_hash, "receipt line hashes to the on-chain receipt_hash");
  const receipt = JSON.parse(line);
  assert.equal(receipt.prompt_sha256, sha256Hex("PROMPT"));
  assert.equal(receipt.inputs.vault.policy.pairs[0].worst_price_out_per_in, 1.4);
  assert.equal(r.outcome.status, "traded");
});

test("arena: a preview refusal is logged as a skip carrying the code; no swap is sent", async () => {
  const { vault, calls } = fakeVault({ preview: { ok: false, code: "daily_cap", reason: "cap" } });
  const r = await tick(deps(vault, "sell 0.05"));
  assert.ok(!calls.some((c) => c.method === "request_swap"));
  assert.match(String(calls.find((c) => c.method === "log_skip")!.args[1]), /^refused:daily_cap/);
  assert.equal(r.preview && !r.preview.ok && r.preview.code, "daily_cap");
});

test("arena: spending more than the vault holds is refused locally before preview", async () => {
  const { vault, calls } = fakeVault({});
  const r = await tick(deps(vault, "sell 0.9"));
  assert.equal(r.local_refusal, "insufficient_balance");
  assert.deepEqual(calls.map((c) => c.method), ["log_skip"]);
});

test("arena: invalid model output becomes a recorded hold, never a trade", async () => {
  const { vault, calls } = fakeVault({});
  const r = await tick(deps(vault, "sell 0.0000000000000000000000001")); // 25 decimals
  assert.equal(r.decision.action, "hold");
  assert.match(r.decision_error!, /invalid_output/);
  assert.deepEqual(calls.map((c) => c.method), ["log_skip"]);
});

test("arena: dry run seals a receipt and sends nothing", async () => {
  const { vault, calls } = fakeVault({});
  const r = await tick({ ...deps(vault, "hold"), dryRun: true });
  assert.equal(r.outcome.status, "dry_run");
  assert.equal(calls.length, 0);
});

test("finished transactions are read from the archival node (regular RPC prunes them)", async () => {
  const { archivalTx, ARCHIVAL_RPC } = await import("../src/attest/chain.js");
  const seen: { url: string; method: string }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), method: (JSON.parse(String(init?.body)) as { method: string }).method });
    return new Response(JSON.stringify({ result: { receipts_outcome: [] } }));
  }) as typeof fetch;
  assert.deepEqual(await archivalTx("testnet", "h", "a.testnet", f), { receipts_outcome: [] });
  assert.deepEqual(seen, [{ url: ARCHIVAL_RPC.testnet, method: "tx" }]);
});
