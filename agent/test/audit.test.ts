// Regression tests for the round-2 agent-runner audit (audits/round2-agent-runner.md). Offline: local HTTP servers on
// 127.0.0.1, a fake vault, and throwaway keys generated per run. Each test is named after its finding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { canonical, sealReceipt, sha256Hex } from "../src/receipt.js";
import { parseDecision } from "../src/decision.js";
import { classify, eventsFromLogs, eventsFromOutcome, timedProvider, Vault, RpcTimeoutError, type TxResult, type VaultEvent } from "../src/vault.js";
import { selectNetwork, redact, loadAgentKey, NETWORKS, checkEndpointUrl } from "../src/config.js";
import { makeModel, MAX_RESPONSE_BYTES, type Model } from "../src/models.js";
import { tick, readHistory } from "../src/arena.js";
import { checkPrice, PriceError } from "../src/price.js";
import { verifyReceipts } from "../src/verify.js";
import { main, commandSucceeded } from "../src/main.js";

const AGENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(AGENT_DIR);
const E24 = 10n ** 24n;
/** A fake credential, assembled so secret scanners do not flag the test source. */
const SECRET = ["sk", "live", "SECRET", "0123456789"].join("-");

// ---------------------------------------------------------------- helpers

async function serve(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, close: () => { server.closeAllConnections(); server.close(); } };
}

/** A JSON-RPC stub: `results[method]` (or results["query:<request_type>"]) is returned as the result. */
function rpcServer(results: Record<string, unknown>) {
  return serve((_req, body, res) => {
    const r = JSON.parse(body) as { id: string; method: string; params: { request_type?: string } };
    const key = r.method === "query" ? `query:${r.params.request_type}` : r.method;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: results[key] }));
  });
}

const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.1.0", event, data: [data] })}`;
const tmp = () => mkdtempSync(join(tmpdir(), "it-audit-"));

function keyFile(dir: string, mode = 0o600): string {
  const f = join(dir, "agent.json");
  writeFileSync(f, JSON.stringify({ account_id: "agent.testnet", secret_key: KeyPair.fromRandom("ed25519").toString() }));
  chmodSync(f, mode);
  return f;
}

interface FakeOpts {
  config?: () => { agent_id: string; frozen: boolean; seq: number };
  preview?: unknown;
  logs?: Record<string, string[]>;
  openIntent?: unknown;
  txEvents?: (tx: string) => VaultEvent[];
}

/** Test stand-in for a vault that passed the provenance check (provenance.ts has its own tests). */
const GENUINE = async () => ({ sledgit_vault: true, status: "genuine" as const, reason: "test: treated as a factory vault" });

function fakeVault(o: FakeOpts = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const tx = (method: string) => async (...args: unknown[]): Promise<TxResult> => {
    calls.push({ method, args });
    const e = eventsFromLogs(o.logs?.[method] ?? []);
    return { tx: `tx-${method}`, ok: true, events: e, outcome: classify(e) };
  };
  const v = {
    id: "v1.owner.testnet", agentId: "agent.testnet", net: NETWORKS.testnet, chainId: "testnet",
    assertChain: async () => { calls.push({ method: "assertChain", args: [] }); },
    useKey: () => { calls.push({ method: "useKey", args: [] }); },
    checkAccessKey: async () => ({ kind: "function_call", warnings: [] }),
    assertAgent: async () => undefined,
    config: async () => (o.config ? o.config() : { agent_id: "agent.testnet", frozen: false, seq: 1 }),
    policy: async () => ({ tokens: [{ token: "wrap.testnet", max_per_trade: E24.toString(), max_per_day: (3n * E24).toString() }],
      pairs: [{ token_in: "wrap.testnet", token_out: "usdc.itachicara.testnet", pool_id: 1103, min_price_num: "14", min_price_den: "10" }],
      max_trades_per_hour: 10, max_slippage_bps: 100 }),
    usage: async () => ({ hour: "1", trades: 0, spent: [] }),
    intents: async () => ({ open_intent: o.openIntent ?? null }),
    inFlight: async () => null,
    decimals: async () => 24,
    balance: async (t: string) => (t === "wrap.testnet" ? E24 / 2n : E24),
    preview: async (...args: unknown[]) => { calls.push({ method: "preview", args }); return o.preview ?? { ok: true, pool_id: 1103, band_floor: "7" }; },
    logSkip: tx("log_skip"),
    requestSwap: tx("request_swap"),
    requestIntentSwap: tx("request_intent_swap"),
    intentsCancel: tx("intents_cancel"),
    intentsSettle: tx("intents_settle"),
    freeze: tx("freeze"),
    txEvents: async (t: string) => (o.txEvents ? o.txEvents(t) : []),
  };
  return { vault: v as unknown as Vault, calls };
}

function countingModel(inner: Model): { model: Model; count: () => number } {
  let n = 0;
  return { model: { ref: inner.ref, complete: (s, u) => { n++; return inner.complete(s, u); } }, count: () => n };
}

function tickDeps(vault: Vault, model: Model, price?: () => Promise<{ source: string; symbol: string; price: string; fetched_at: string }>) {
  const dir = tmp();
  return {
    vault, model, prompt: { text: "PROMPT", sha256: sha256Hex("PROMPT"), path: "p" },
    price: price ?? (async () => ({ source: "test", symbol: "NEARUSDT", price: "2.50", fetched_at: "t" })),
    receiptsPath: join(dir, "receipts.jsonl"), outcomesPath: join(dir, "outcomes.jsonl"),
  };
}

function mainEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { SLEDGIT_KEY_FILE: keyFile(dir), SLEDGIT_VAULT: "v1.owner.testnet", ...extra };
}

async function runMain(argv: string[], deps: Parameters<typeof main>[1]) {
  const logs: string[] = [];
  const warns: string[] = [];
  const code = await main(argv, { log: (s) => logs.push(s), warn: (s) => warns.push(s), sleep: async () => undefined, provenance: GENUINE, ...deps });
  return { code, out: logs.join("\n"), warn: warns.join("\n") };
}

// ---------------------------------------------------------------- H1

test("H1: an echoing 401 server leaks neither the key nor the base URL into the note, receipt or outcomes", async () => {
  const srv = await serve((req, _b, res) => { res.statusCode = 401; res.end(`invalid key ${req.headers.authorization} at ${req.headers.host}`); });
  try {
    const model = makeModel("openai-compatible", "m", { SLEDGIT_OPENAI_BASE_URL: `${srv.url}/v1`, SLEDGIT_OPENAI_API_KEY: SECRET });
    const { vault, calls } = fakeVault({ logs: { log_skip: [ev("skip", {})] } });
    const d = tickDeps(vault, model);
    const r = await tick(d);
    assert.match(r.decision_error!, /^model_error:[a-z0-9_]+$/);
    assert.equal(r.decision_error, "model_error:http_401");
    const note = String(calls.find((c) => c.method === "log_skip")!.args[1]);
    assert.equal(note, "model_error");
    for (const text of [note, readFileSync(d.receiptsPath, "utf8"), readFileSync(d.outcomesPath, "utf8"), r.decision_detail ?? ""]) {
      assert.ok(!text.includes(SECRET), "key leaked");
      assert.ok(!text.includes(`127.0.0.1:${srv.port}`), "endpoint leaked");
    }
  } finally {
    srv.close();
  }
});

test("H1: a base URL carrying credentials is refused, and the password is not echoed", () => {
  assert.throws(() => makeModel("openai-compatible", "m", { SLEDGIT_OPENAI_BASE_URL: "http://ops:hunter2@127.0.0.1/v1" }),
    (e: Error) => /credentials/.test(e.message) && !e.message.includes("hunter2"));
});

test("H1: model output that echoes the key is redacted before the receipt is sealed", async () => {
  const reply = JSON.stringify({ action: "hold", amount_in: "0", reason: `my key is ${SECRET}` });
  const srv = await serve((_r, _b, res) => res.end(JSON.stringify({ choices: [{ message: { content: reply } }] })));
  try {
    const model = makeModel("openai-compatible", "m", { SLEDGIT_OPENAI_BASE_URL: `${srv.url}/v1`, SLEDGIT_OPENAI_API_KEY: SECRET });
    const { vault } = fakeVault({ logs: { log_skip: [ev("skip", {})] } });
    const d = tickDeps(vault, model);
    const r = await tick(d);
    const line = readFileSync(d.receiptsPath, "utf8").trim();
    assert.ok(!line.includes(SECRET) && line.includes("[REDACTED]"));
    assert.equal(sha256Hex(line), r.receipt_hash, "the hash covers the redacted bytes");
    assert.ok(!readFileSync(d.outcomesPath, "utf8").includes(SECRET));
  } finally {
    srv.close();
  }
});

test("H1: an SLEDGIT_RPC URL with an API key is registered with the redactor", () => {
  const token = ["abcdef", "0123456789"].join("");
  const rpc = `https://rpc.example.com/?${"api" + "key"}=${token}`;
  selectNetwork(false, { SLEDGIT_RPC: rpc });
  const msg = redact(`${rpc} Bad Gateway`);
  assert.ok(!msg.includes(token) && !msg.includes("rpc.example.com"));
});

// ---------------------------------------------------------------- H2

test("H2: a mainnet RPC behind a testnet run is refused before any key is loaded", async () => {
  const srv = await rpcServer({ status: { chain_id: "mainnet" } });
  try {
    const net = selectNetwork(false, { SLEDGIT_RPC: srv.url });
    assert.equal(net.id, "testnet");
    await assert.rejects(new Vault(net, "v1.owner.testnet").assertChain(), /chain_id "mainnet".*testnet/);
    // Through the CLI: the key file does not exist, so reaching the key loader would fail differently.
    await assert.rejects(runMain(["skip", "x", "--vault", "v1.owner.testnet"],
      { env: { SLEDGIT_RPC: srv.url, SLEDGIT_KEY_FILE: "/nonexistent/key.json" } }), /chain_id/);
  } finally {
    srv.close();
  }
});

test("H2: account suffixes must match the network; http RPCs off loopback are refused", async () => {
  await assert.rejects(new Vault(NETWORKS.testnet, "x.near").assertChain(), /not a testnet account/);
  await assert.rejects(runMain(["status", "--vault", "x.near"], { env: {} }), /not a testnet account/);
  assert.throws(() => selectNetwork(false, { SLEDGIT_BASE: "wrap.near" }), /not a testnet account/);
  assert.throws(() => selectNetwork(false, { SLEDGIT_RPC: "http://rpc.example.com" }), /must be https/);
});

// ---------------------------------------------------------------- M1

test("M1: bad --interval and --ticks values are rejected before anything runs", async () => {
  for (const argv of [["--interval", "5m"], ["--interval", "3000000"], ["--interval", "5"], ["--ticks", "Infinity"],
    ["--ticks", "1e9"], ["--ticks", "0"], ["--ticks", "2.5"]]) {
    await assert.rejects(runMain(["arena", ...argv], { env: {} }), /--interval|--ticks/, argv.join(" "));
  }
});

test("M1: a frozen vault or a replaced agent means no model call, no receipt and no transaction", async () => {
  for (const [cfg, reason] of [[{ agent_id: "agent.testnet", frozen: true, seq: 1 }, "frozen"],
    [{ agent_id: "other.testnet", frozen: false, seq: 1 }, "agent_replaced"]] as const) {
    const { vault, calls } = fakeVault({ config: () => cfg });
    const m = countingModel(makeModel("echo", "sell 0.05"));
    const d = tickDeps(vault, m.model);
    const r = await tick(d);
    assert.equal(r.stopped, reason);
    assert.equal(m.count(), 0);
    assert.deepEqual(calls, []);
    assert.ok(!existsSync(d.receiptsPath));
  }
});

test("M1: the arena loop stops at the first tick after a freeze", async () => {
  const dir = tmp();
  let frozen = false;
  const { vault, calls } = fakeVault({ config: () => ({ agent_id: "agent.testnet", frozen, seq: 1 }), logs: { log_skip: [ev("skip", {})] } });
  const origSkip = vault.logSkip;
  (vault as unknown as { logSkip: typeof origSkip }).logSkip = async (...a) => { frozen = true; return origSkip(...a); };
  const r = await runMain(["arena", "--provider", "echo", "--model", "hold", "--ticks", "50", "--interval", "30", "--receipts", dir],
    { env: mainEnv(dir), makeVault: () => vault });
  assert.equal(r.code, 1);
  assert.equal(calls.filter((c) => c.method === "log_skip").length, 1);
  assert.match(r.warn, /frozen/);
});

// ---------------------------------------------------------------- M2

async function realReceiptAndOutcome(dir: string) {
  const { vault } = fakeVault({ logs: { request_swap: [ev("request", {}), ev("trade", { amount_out: "100", venue: "rhea" })] } });
  const d = { ...tickDeps(vault, makeModel("echo", "sell 0.05")), receiptsPath: join(dir, "receipts.jsonl"), outcomesPath: join(dir, "outcomes.jsonl") };
  const r = await tick(d);
  const onchain: VaultEvent[] = [{ event: "request", data: { seq: 7, receipt_hash: r.receipt_hash, token_in: "wrap.testnet", amount_in: (5n * 10n ** 22n).toString() } }];
  return { r, d, onchain };
}

test("M2: verify passes a genuine receipt and fails a tampered canonical one (exit 1)", async () => {
  const dir = tmp();
  const { d, onchain } = await realReceiptAndOutcome(dir);
  const { vault } = fakeVault({ txEvents: () => onchain });
  const good = await runMain(["verify", d.receiptsPath], { env: {}, makeVault: () => vault, provenance: GENUINE });
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /"status": "ok"/);

  const receipt = JSON.parse(readFileSync(d.receiptsPath, "utf8"));
  receipt.decision.amount_in = "5";
  receipt.decision.reason = "TAMPERED";
  const tampered = canonical(receipt);
  writeFileSync(d.receiptsPath, tampered + "\n");
  const bad = await runMain(["verify", d.receiptsPath], { env: {}, makeVault: () => vault, provenance: GENUINE });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /"onchain": false/);

  // Even if the outcomes file is also rewritten to point the new hash at the same tx, the chain disagrees.
  appendFileSync(d.outcomesPath, JSON.stringify({ receipt_hash: sha256Hex(tampered), tx: "tx-request_swap" }) + "\n");
  const rows = await verifyReceipts(tampered + "\n", readFileSync(d.outcomesPath, "utf8"), NETWORKS.testnet,
    { txEvents: async () => onchain, decimals: async () => 24, provenance: GENUINE });
  assert.equal(rows[0].status, "mismatch");
});

test("verify, lint and verify-attestation fail on a missing or empty receipts file (never a pass on nothing)", async () => {
  const dir = tmp();
  const { vault } = fakeVault({ txEvents: () => [] });
  const empty = join(dir, "receipts.jsonl");
  writeFileSync(empty, "\n");
  for (const cmd of ["verify", "lint", "verify-attestation"]) {
    await assert.rejects(runMain([cmd, join(dir, "missing.jsonl")], { env: {}, makeVault: () => vault }), /no such file/, cmd);
    await assert.rejects(runMain([cmd, empty], { env: {}, makeVault: () => vault }), /has no receipts/, cmd);
  }
});

test("P1-2: a forged receipt whose outcome claims dry_run fails verify; --allow-dry-run accepts it only without problems", async () => {
  const dir = tmp();
  const { vault } = fakeVault({ txEvents: () => [] });
  const forged = (network: string) => canonical({ v: 2, vault: "v1.owner.testnet", network, agent: "agent.testnet",
    model: { provider: "echo", id: "x" }, prompt_sha256: "", inputs: {}, model_output: "",
    decision: { action: "buy", amount_in: "1000", reason: "forged" }, ts: "2026-10-29T00:00:00.000Z" });
  for (const [network, plain, allowed] of [["testnet", 1, 0], ["mainnet", 1, 1]] as const) {
    const line = forged(network);
    const receipts = join(dir, `${network}.jsonl`);
    const outcomes = join(dir, `${network}-outcomes.jsonl`);
    writeFileSync(receipts, line + "\n");
    writeFileSync(outcomes, JSON.stringify({ receipt_hash: sha256Hex(line), outcome: { status: "dry_run" } }) + "\n");
    const deps = { env: {}, makeVault: () => vault, provenance: GENUINE };
    assert.equal((await runMain(["verify", receipts, "--outcomes", outcomes], deps)).code, plain, `${network}: a dry run is not on chain`);
    assert.equal((await runMain(["verify", receipts, "--outcomes", outcomes, "--allow-dry-run"], deps)).code, allowed,
      `${network}: --allow-dry-run ${allowed ? "still fails on the network mismatch" : "accepts a clean dry run"}`);
  }
});

test("M2: verify flags an amount that differs from the vault's event, and lint keeps the old offline check", async () => {
  const dir = tmp();
  const { d, onchain } = await realReceiptAndOutcome(dir);
  const wrong = [{ ...onchain[0], data: { ...onchain[0].data, amount_in: "1" } }];
  const rows = await verifyReceipts(readFileSync(d.receiptsPath, "utf8"), readFileSync(d.outcomesPath, "utf8"), NETWORKS.testnet,
    { txEvents: async () => wrong, decimals: async () => 24, provenance: GENUINE });
  assert.equal(rows[0].status, "mismatch");
  assert.match(rows[0].problems.join(), /amount_in/);
  const lint = await runMain(["lint", d.receiptsPath], { env: {} });
  assert.equal(lint.code, 0);
});

// ---------------------------------------------------------------- M3

test("M3: intent_unsigned is unknown until settled, never failed", () => {
  const o = classify(eventsFromLogs([ev("request", {}), ev("intent_unsigned", { deadline: "2026-10-29T00:02:00Z", reason: "no readable signature" })]));
  assert.equal(o.status, "unknown_until_settled");
  assert.notEqual(o.status, "failed");
  assert.equal(classify(eventsFromLogs([ev("intent_cancelled", {})])).status, "cancelled");
  assert.equal(classify(eventsFromLogs([ev("intent_cancel_failed", { reason: "nonce already used" })])).status, "cancel_failed");
});

test("M3: cancel exits 1 on intent_cancel_failed; settle exits 1 when nothing was recorded", async () => {
  const dir = tmp();
  const failedCancel = fakeVault({ logs: { intents_cancel: [ev("intent_cancel_failed", { reason: "signing failed" })] } });
  const c = await runMain(["cancel"], { env: mainEnv(dir), makeVault: () => failedCancel.vault });
  assert.equal(c.code, 1);
  assert.match(c.warn, /NOT cancelled/);
  const goodCancel = fakeVault({ logs: { intents_cancel: [ev("intent_cancelled", {})] } });
  assert.equal((await runMain(["cancel"], { env: mainEnv(dir), makeVault: () => goodCancel.vault })).code, 0);
  const noop = fakeVault({ logs: { intents_settle: [] } });
  assert.equal((await runMain(["settle"], { env: mainEnv(dir), makeVault: () => noop.vault })).code, 1);
  const expired = fakeVault({ logs: { intents_settle: [ev("intent_expired", {})] } });
  assert.equal((await runMain(["settle"], { env: mainEnv(dir), makeVault: () => expired.vault })).code, 0);
  assert.equal(commandSucceeded("cancel", { ok: true, outcome: { status: "pending", note: "" } }), false);
});

test("M3: the intent command prints and saves the signed multi_payload", async () => {
  const dir = tmp();
  const multi = { standard: "erc191", payload: "{\"signer_id\":\"v1.owner.testnet\"}", signature: "secp256k1:abc" };
  const { vault } = fakeVault({ logs: { request_intent_swap: [ev("request", {}),
    ev("intent_authorized", { min_amount_out: "9", deadline: "2026-10-29T00:02:00Z", multi_payload: multi })] } });
  const r = await runMain(["intent", "sell", "0.05", "--receipts", dir], { env: mainEnv(dir), makeVault: () => vault });
  assert.equal(r.code, 0);
  assert.match(r.out, /multi_payload/);
  assert.match(r.out, /secp256k1:abc/);
  const saved = JSON.parse(readFileSync(join(dir, "intents.jsonl"), "utf8").trim());
  assert.deepEqual(saved.multi_payload, multi);
});

test("M3: freeze warns when an intent is still open", async () => {
  const dir = tmp();
  const { vault } = fakeVault({ logs: { freeze: [ev("freeze", { by: "agent.testnet" })] }, openIntent: { seq: 3 } });
  const r = await runMain(["freeze"], { env: mainEnv(dir), makeVault: () => vault });
  assert.equal(r.code, 0);
  assert.match(r.warn, /intent is still open.*cancel/);
});

test("M3/L5/I1/I5/I6: SKILL.md states the intent, freeze, canonical-JSON and finality rules", () => {
  const skill = readFileSync(join(AGENT_DIR, "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /`intent_unsigned`, `intent_expired`, `intent_cancelled` \| intent did not trade/);
  assert.match(skill, /`intent_unsigned`[^\n]*unknown until `intents_settle`/);
  assert.match(skill, /already-signed intent[^\n]*(can still fill|stays fillable)/i);
  assert.match(skill, /RFC 8785/);
  assert.match(skill, /never re-serialize/i);
  assert.match(skill, /mt_balance_of/);
  assert.match(skill, /optimistic/);
  assert.match(skill, /FunctionCall/);
});

// ---------------------------------------------------------------- M4

test("M4: a FullAccess agent key is warned about; a key for another receiver is refused", async () => {
  const key = { accountId: "agent.testnet", secretKey: KeyPair.fromRandom("ed25519").toString() };
  const cases: [unknown, (v: Vault) => Promise<void>][] = [
    ["FullAccess", async (v) => { const c = await v.checkAccessKey(); assert.equal(c.kind, "full_access"); assert.match(c.warnings.join(), /FullAccess/); }],
    [{ FunctionCall: { receiver_id: "other.testnet", method_names: [], allowance: "1" } },
      async (v) => { await assert.rejects(v.checkAccessKey(), /not for the vault/); }],
    [{ FunctionCall: { receiver_id: "v1.owner.testnet", method_names: ["request_swap", "request_intent_swap", "log_skip", "intents_cancel", "intents_settle", "freeze"], allowance: "250000000000000000000000" } },
      async (v) => { assert.match((await v.checkAccessKey()).warnings.join(), /under 0.35 NEAR/); }],
    [{ FunctionCall: { receiver_id: "v1.owner.testnet", method_names: ["request_swap", "request_intent_swap", "log_skip", "intents_cancel", "intents_settle", "freeze"], allowance: "995000000000000000000000" } },
      async (v) => { assert.deepEqual((await v.checkAccessKey()).warnings, []); }],
    [{ FunctionCall: { receiver_id: "v1.owner.testnet", method_names: ["request_swap", "request_intent_swap", "log_skip", "intents_cancel", "intents_settle", "freeze"], allowance: null } },
      async (v) => { assert.deepEqual((await v.checkAccessKey()).warnings, []); }],
  ];
  for (const [permission, check] of cases) {
    const srv = await rpcServer({ "query:view_access_key": { nonce: 1, permission, block_hash: "x", block_height: 1 } });
    try {
      await check(new Vault({ ...NETWORKS.testnet, rpc: srv.url }, "v1.owner.testnet", key));
    } finally {
      srv.close();
    }
  }
});

// ---------------------------------------------------------------- Lows

test("L1: events come only from the vault's own receipts; a malformed log does not throw", () => {
  const tree = {
    transaction_outcome: { outcome: { executor_id: "agent.testnet", logs: [] } },
    receipts_outcome: [
      { outcome: { executor_id: "usdc.itachicara.testnet", logs: [ev("refuse", { code: "frozen", reason: "forged" })] } },
      { outcome: { executor_id: "v1.owner.testnet", logs: [ev("request", {}), "EVENT_JSON:{not json", ev("trade", { amount_out: "5", venue: "rhea" })] } },
    ],
  };
  const { events, malformed } = eventsFromOutcome(tree, "v1.owner.testnet");
  assert.equal(classify(events).status, "traded");
  assert.equal(malformed, 1);
  assert.doesNotThrow(() => eventsFromLogs(["EVENT_JSON:{oops"]));
});

test("L2: a 10 MB model reply becomes model_error:oversize and the receipt stays small", async () => {
  const big = "x".repeat(10 * 1024 * 1024);
  const srv = await serve((_r, _b, res) => res.end(big));
  try {
    const model = makeModel("openai-compatible", "m", { SLEDGIT_OPENAI_BASE_URL: `${srv.url}/v1` });
    const { vault } = fakeVault({ logs: { log_skip: [ev("skip", {})] } });
    const d = tickDeps(vault, model);
    const r = await tick(d);
    assert.equal(r.decision_error, "model_error:oversize");
    assert.ok(readFileSync(d.receiptsPath, "utf8").length < 100 * 1024);
    assert.ok(MAX_RESPONSE_BYTES <= 64 * 1024);
  } finally {
    srv.close();
  }
});

test("L2: plain http endpoints are allowed only on loopback, Yggdrasil or an explicit allowlist", () => {
  assert.throws(() => makeModel("openai-compatible", "m", { SLEDGIT_OPENAI_BASE_URL: "http://models.example.com/v1" }), /https/);
  assert.doesNotThrow(() => checkEndpointUrl("http://[200:1234::1]:8080/v1", "X", {}));
  assert.doesNotThrow(() => checkEndpointUrl("http://home.lan/v1", "X", { SLEDGIT_HTTP_HOSTS: "home.lan" }));
  assert.doesNotThrow(() => checkEndpointUrl("https://models.example.com/v1", "X", {}));
});

test("L3: an implausible reference price holds the tick without a model call", async () => {
  for (const p of ["0x10", "1e9", "Infinity", " 2.5 ", "-1", "0", "99999999"]) assert.throws(() => checkPrice(p), PriceError, p);
  assert.equal(checkPrice("2.50000000"), "2.50000000");
  const { vault, calls } = fakeVault({ logs: { log_skip: [ev("skip", {})] } });
  const m = countingModel(makeModel("echo", "sell 0.05"));
  const r = await tick(tickDeps(vault, m.model, async () => { checkPrice("0x10"); throw new Error("unreachable"); }));
  assert.equal(r.decision_error, "price_error:bad_price");
  assert.equal(m.count(), 0);
  assert.equal(String(calls.find((c) => c.method === "log_skip")!.args[1]), "price_error");
});

test("L4: a malformed key file never echoes key bytes; loose permissions warn; a Vault never shows its key", () => {
  const dir = tmp();
  const secret = KeyPair.fromRandom("ed25519").toString();
  const bad = join(dir, "bad.json");
  writeFileSync(bad, `{"secret_key":"${secret}",}`);
  chmodSync(bad, 0o600);
  assert.throws(() => loadAgentKey({ SLEDGIT_KEY_FILE: bad, SLEDGIT_AGENT: "a.testnet" }, () => undefined),
    (e: Error) => /not valid JSON/.test(e.message) && !e.message.includes("ed25519:"));
  const warnings: string[] = [];
  const loose = keyFile(dir, 0o644);
  const key = loadAgentKey({ SLEDGIT_KEY_FILE: loose }, (m) => warnings.push(m));
  assert.match(warnings.join(), /readable by other users/);
  const seed = (KeyPair.fromString(key.secretKey as `ed25519:${string}`) as unknown as { secretKey: string }).secretKey;
  const v = new Vault(NETWORKS.testnet, "v1.owner.testnet", key);
  for (const shown of [inspect(v, { depth: 10, showHidden: true }), JSON.stringify(v)]) {
    assert.ok(!shown.includes(seed) && !shown.includes(key.secretKey.slice(8)), "key material visible");
  }
  assert.ok(!redact(`seed ${seed}`).includes(seed), "the seed form is registered too");
  const gi = readFileSync(join(REPO, ".gitignore"), "utf8");
  assert.match(gi, /^\*key\*\.json$/m);
});

/** Evaluate `const NAME: u64 = a + B * 2;` style constants from the contract source. */
function rustConsts(...files: string[]): Record<string, number> {
  const defs = new Map<string, string>();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/const (TG_[A-Z_]+): u64 = ([^;]+);/g)) defs.set(m[1], m[2]);
  }
  const memo: Record<string, number> = {};
  const evalName = (n: string): number => {
    if (n in memo) return memo[n];
    const expr = defs.get(n);
    if (!expr) throw new Error(`no constant ${n}`);
    return (memo[n] = expr.split("+").reduce((s, term) => s + term.split("*").reduce((p, f) => {
      const t = f.trim();
      return p * (/^\d+$/.test(t) ? Number(t) : evalName(t));
    }, 1), 0));
  };
  for (const n of defs.keys()) evalName(n);
  return memo;
}

test("L5: SKILL.md gas minimums equal the contract's constants", () => {
  const src = join(REPO, "contracts", "vault", "src");
  const c = rustConsts(join(src, "lib.rs"), join(src, "intents.rs"));
  assert.deepEqual([c.TG_MIN_REQUEST, c.TG_MIN_INTENT_REQUEST, c.TG_MIN_CANCEL], [265, 230, 255]);
  const skill = readFileSync(join(AGENT_DIR, "SKILL.md"), "utf8");
  const row = (m: string) => skill.split("\n").find((l) => l.startsWith(`| \`${m}\``)) ?? "";
  assert.match(row("request_swap"), new RegExp(`min ${c.TG_MIN_REQUEST}\\b`));
  assert.match(row("request_intent_swap"), new RegExp(`min ${c.TG_MIN_INTENT_REQUEST}\\b`));
  assert.match(row("intents_cancel"), new RegExp(`min ${c.TG_MIN_CANCEL}\\b`));
  assert.doesNotMatch(skill, /min 200\b/);
});

test("L6: a partial outcomes line and dry runs are left out of the history; the next tick still runs", async () => {
  const { vault } = fakeVault({ logs: { log_skip: [ev("skip", {})] } });
  const d = tickDeps(vault, makeModel("echo", "hold"));
  await tick({ ...d, dryRun: true });
  appendFileSync(d.outcomesPath, '{"ts":\n');
  const r = await tick(d);
  assert.equal(r.outcome.status, "skipped");
  assert.deepEqual(readHistory(d.outcomesPath, vault.id, "echo:hold", 5).length, 1, "only the real tick");
});

test("L7: numeric amounts beyond 15 significant digits are rejected, not rounded", () => {
  const p = parseDecision('{"action":"sell","amount_in":123456789012345678901,"reason":"x"}');
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.code, "imprecise_number");
  assert.equal(parseDecision('{"action":"sell","amount_in":1234567890.12345,"reason":"x"}').ok, true);
  assert.equal(parseDecision('{"action":"sell","amount_in":"123456789012345678901","reason":"x"}').ok, true);
});

test("L8: tsx is a pinned runtime dependency and the CLI runs through the local launcher", () => {
  const pkg = JSON.parse(readFileSync(join(AGENT_DIR, "package.json"), "utf8"));
  assert.match(pkg.dependencies.tsx, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.devDependencies?.tsx, undefined);
  assert.equal(pkg.bin.sledgit, "bin/sledgit.mjs");
  assert.deepEqual(Object.keys(pkg.bin).sort(), ["sledgit"]);
  assert.match(readFileSync(join(AGENT_DIR, "src", "cli.ts"), "utf8").split("\n")[0], /npx --no tsx/);
  // Run from outside the package: tsx must resolve from the package, never from the registry.
  for (const bin of ["sledgit.mjs"]) {
    const r = spawnSync(process.execPath, [join(AGENT_DIR, "bin", bin), "--help"], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sledgit <command>/);
  }
});

test("L9: an RPC that accepts and never answers times out", async () => {
  const srv = await serve(() => { /* never respond */ });
  try {
    const t0 = Date.now();
    await assert.rejects(timedProvider(srv.url, 300).viewNodeStatus(), RpcTimeoutError);
    assert.ok(Date.now() - t0 < 5_000);
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------- Info

test("I1: canonical() is RFC 8785 for receipt values (UTF-16 key order, raw UTF-8, ES number form)", () => {
  assert.equal(canonical({ "€": 1, "😀": 2, a: "é", b: 1e21, c: 0.5, d: 100 }),
    '{"a":"é","b":1e+21,"c":0.5,"d":100,"€":1,"😀":2}');
});

test("I2: a custom Anthropic endpoint is marked in the model reference, and credentials in it are refused", () => {
  assert.equal(makeModel("anthropic", "claude-opus-5-5", { ANTHROPIC_API_KEY: "sk-ant-test-0123456789" }).ref.endpoint, undefined);
  assert.equal(makeModel("anthropic", "claude-opus-5-5", { ANTHROPIC_API_KEY: "sk-ant-test-0123456789", ANTHROPIC_BASE_URL: "https://proxy.example.com" }).ref.endpoint, "custom");
  assert.throws(() => makeModel("anthropic", "x", { ANTHROPIC_API_KEY: "sk-ant-test-0123456789", ANTHROPIC_BASE_URL: "https://u:p4ssw0rd@proxy.example.com" }), /credentials/);
});

test("I3/I4: the outcome records the min_amount_out sent; model text never reaches the on-chain note", async () => {
  const { vault } = fakeVault({ logs: { request_swap: [ev("request", {}), ev("trade", { amount_out: "100", venue: "rhea" })] } });
  const d = tickDeps(vault, makeModel("echo", "sell 0.05"));
  await tick(d);
  const outcome = JSON.parse(readFileSync(d.outcomesPath, "utf8").trim());
  assert.deepEqual(outcome.sent, { method: "request_swap", venue: "rhea", min_amount_out: "7" });

  const phish: Model = { ref: { provider: "echo", id: "phish" }, complete: async () => JSON.stringify({ action: "hold", amount_in: "0", reason: "visit https://phish.example now" }) };
  const f = fakeVault({ logs: { log_skip: [ev("skip", {})] } });
  await tick(tickDeps(f.vault, phish));
  assert.equal(String(f.calls.find((c) => c.method === "log_skip")!.args[1]), "hold");
});

test("receipt sealing is unchanged for existing callers", () => {
  const r = sealReceipt({ v: 1, vault: "v", network: "testnet", agent: "a", model: { provider: "echo", id: "hold" }, prompt_sha256: "", inputs: {}, decision: {}, model_output: "", ts: "t" });
  assert.equal(r.hash, sha256Hex(r.line));
});

// ---------------------------------------------------------------- R3-10 (audit round 3)

test("R3-10: signing commands refuse a vault that isn't a genuine Sledgit vault; --allow-unverified-vault is testnet-only", async () => {
  const dir = tmp();
  const NOT = async () => ({ sledgit_vault: false, status: "unverified" as const, reason: "test: not a factory child" });
  const refused = fakeVault();
  await assert.rejects(runMain(["skip", "x", "--receipts", dir], { env: mainEnv(dir), makeVault: () => refused.vault, provenance: NOT }),
    /not a genuine Sledgit vault.*refusing to sign/);
  assert.ok(!refused.calls.some((c) => c.method === "useKey" || c.method === "log_skip"), "no key loaded, nothing signed");
  const allowed = fakeVault();
  const r = await runMain(["skip", "x", "--receipts", dir, "--allow-unverified-vault"], { env: mainEnv(dir), makeVault: () => allowed.vault, provenance: NOT });
  assert.match(r.warn, /signing anyway \(--allow-unverified-vault, testnet\)/);
  assert.ok(allowed.calls.some((c) => c.method === "log_skip"));
  // Read-only commands don't need provenance.
  assert.equal((await runMain(["status"], { env: mainEnv(dir), makeVault: () => refused.vault, provenance: NOT })).code, 0);
});
