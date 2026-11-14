// MCP server tests with a mocked RPC and transactions API (no network). Tools are called through a real MCP client
// over an in-memory transport, so the input schemas and error results are exercised too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, httpGate, serveHttp, MAX_CONCURRENT, type ServerDeps } from "../src/server.js";
import { NETS, checkAccount, parseEvent, type Fetch } from "../src/near.js";
import { REFUSAL_CODES } from "../src/tools.js";
import { canonical, sha256Hex } from "../../agent/src/receipt.js";
import { dcapVerifyQuoteWith, type QuoteFacts } from "../../agent/src/attest/verify.js";
import type { TeeBundle } from "../../agent/src/attest/evidence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, "..", "..", "agent");
const VAULT = "qwen36-tee.arena.irontrade.testnet";
const AGENT_ID = "agent-claude.testnet";

// ------------------------------------------------------------------ mock chain

type Handler = (body: Record<string, unknown>) => unknown;
interface Mock { fetch: Fetch; calls: { url: string; body: Record<string, unknown> }[] }

const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.1.0", event, data: [data] })}`;

// The vault under test is a genuine child of the legacy testnet factory: same global code, no keys, the factory's ids.
const IDS = { exchange_id: "ref-finance-101.testnet", intents_id: "it1793205011-intents.testnet", mpc_id: "v1.signer-prod.testnet" };
const GENUINE_VIEWS = { "arena.irontrade.testnet.get_config": { code_hash: "5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ", ...IDS }, [`${VAULT}.get_config`]: { owner_id: "owner.testnet", ...IDS } };

function mock(over: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>, extra: Record<string, Handler> = {}): Mock {
  const views: Record<string, unknown> = { ...GENUINE_VIEWS, ...over };
  const calls: Mock["calls"] = [];
  const fetch: Fetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    const reply = (v: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(v) });
    const path = new URL(url).pathname;
    if (extra[path]) return reply(extra[path](body));
    const p = body.params as Record<string, unknown>;
    if (body.method === "query" && p.request_type === "call_function") {
      const key = `${p.account_id}.${p.method_name}`;
      if (!(key in views)) return reply({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: `no ${key}` } });
      const v = views[key];
      const args = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString("utf8")) as Record<string, unknown>;
      return reply({ jsonrpc: "2.0", id: 1, result: { result: bytes(typeof v === "function" ? (v as (a: Record<string, unknown>) => unknown)(args) : v), logs: [] } });
    }
    if (body.method === "query" && p.request_type === "view_access_key_list") return reply({ jsonrpc: "2.0", id: 1, result: { keys: views[`${p.account_id}#keys`] ?? [] } });
    if (body.method === "query" && p.request_type === "view_account") return reply({ jsonrpc: "2.0", id: 1, result: { amount: "1", code_hash: "11111111111111111111111111111111", global_contract_hash: views[`${p.account_id}#hash`] ?? "5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ" } });
    if (body.method === "tx" && extra.tx) return reply({ jsonrpc: "2.0", id: 1, result: extra.tx(body) });
    return reply({ error: "unmocked" }, 500);
  };
  return { fetch, calls };
}

async function connect(deps: ServerDeps) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer(deps);
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

async function call(deps: ServerDeps, name: string, args: Record<string, unknown>) {
  const c = await connect(deps);
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  await c.close();
  const text = r.content[0]?.text ?? "";
  return { isError: !!r.isError, text, json: r.isError ? undefined : (JSON.parse(text) as Record<string, any>) };
}

// ------------------------------------------------------------------ the tool surface

test("server: exactly seven tools, every one annotated read-only and non-destructive", async () => {
  const c = await connect({ fetch: mock({}).fetch });
  const { tools } = await c.listTools();
  await c.close();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_agent_record", "get_vault_policy", "get_vault_usage", "list_vaults", "preview_trade", "verify_attestation", "verify_receipt"]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
  }
});

test("server: the source has no signing, keys or write calls", () => {
  const src = readdirSync(join(HERE, "..", "src")).map((f) => readFileSync(join(HERE, "..", "src", f), "utf8")).join("\n");
  for (const bad of [/signAndSend/, /KeyPair/, /secret_key|private_key|secretKey/, /send_tx|broadcast_tx/, /request_swap|request_intent_swap|log_skip|intents_settle|intents_cancel|withdraw/, /config\.js/, /vault\.js/]) {
    assert.doesNotMatch(src, bad, String(bad));
  }
});

// ------------------------------------------------------------------ views

const POLICY = { tokens: [{ token: "wrap.testnet", max_per_trade: "5000000000000000000000000", max_per_day: "20000000000000000000000000" }], pairs: [], max_trades_per_hour: 4, max_slippage_bps: 100 };

test("get_vault_policy: policy, config and keyless = no access keys", async () => {
  const m = mock({ [`${VAULT}.get_policy`]: POLICY, [`${VAULT}.get_config`]: { owner_id: "owner.testnet", agent_id: AGENT_ID, frozen: false, ...IDS } });
  const r = await call({ fetch: m.fetch }, "get_vault_policy", { vault: VAULT });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json!.policy, POLICY);
  assert.equal(r.json!.keyless, true);
  assert.equal(r.json!.access_keys, 0);
  assert.equal(r.json!.provenance.sledgit_vault, true, r.json!.provenance.reason);
});

test("get_vault_policy: a vault with a key is reported as not keyless", async () => {
  const m = mock({ [`${VAULT}.get_policy`]: POLICY, [`${VAULT}.get_config`]: {}, [`${VAULT}#keys`]: [{ public_key: "ed25519:x", access_key: { permission: "FullAccess" } }] });
  const r = await call({ fetch: m.fetch }, "get_vault_policy", { vault: VAULT });
  assert.equal(r.json!.keyless, false);
});

test("inputs: bad ids, ids from the other network and oversized limits are refused before any request", async () => {
  const m = mock({});
  for (const [name, args, want] of [
    ["get_vault_policy", { vault: "Not_Valid!" }, /not a valid NEAR account id/],
    ["get_vault_policy", { vault: "vault.near" }, /not a testnet account/],
    ["get_vault_usage", { network: "mainnet", vault: VAULT }, /not a mainnet account/],
    ["get_vault_usage", { vault: "a".repeat(65) + ".testnet" }, /./],
    ["list_vaults", { limit: 1000 }, /./],
    ["get_agent_record", { vault: VAULT, max_txs: 5000 }, /./],
  ] as const) {
    const r = await call({ fetch: m.fetch }, name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.text, want);
  }
  assert.equal(m.calls.length, 0, "nothing reached the network");
});

test("get_vault_usage: returns the contract's own counters", async () => {
  const usage = { hour: "123", trades: 1, spent: [["wrap.testnet", "1000"]] };
  const r = await call({ fetch: mock({ [`${VAULT}.get_usage`]: usage }).fetch }, "get_vault_usage", { vault: VAULT });
  assert.deepEqual(r.json!.usage, usage);
});

test("preview_trade: passes amounts through unchanged and reports the refusal code", async () => {
  let seen: Record<string, unknown> | undefined;
  const m = mock({ [`${VAULT}.preview_swap`]: (a: Record<string, unknown>) => (seen = a, { ok: false, code: "trade_cap", reason: "above max_per_trade" }) });
  const r = await call({ fetch: m.fetch }, "preview_trade", { vault: VAULT, token_in: "wrap.testnet", token_out: "usdc.itachicara.testnet", amount_in: "50000000000000000000000000", min_amount_out: "1" });
  assert.equal(r.json!.preview.code, "trade_cap");
  assert.match(r.json!.note, /would refuse: trade_cap/);
  assert.deepEqual(seen, { token_in: "wrap.testnet", token_out: "usdc.itachicara.testnet", amount_in: "50000000000000000000000000", min_amount_out: "1" });
});

test("preview_trade: decimals, negatives, values above u128 and a zero or missing minimum are refused", async () => {
  const m = mock({});
  const base = { vault: VAULT, token_in: "wrap.testnet", token_out: "usdc.itachicara.testnet" };
  for (const amount_in of ["1.5", "-1", "1e9", String(2n ** 128n), ""]) {
    const r = await call({ fetch: m.fetch }, "preview_trade", { ...base, amount_in, min_amount_out: "1" });
    assert.equal(r.isError, true, amount_in);
  }
  for (const min of [{ min_amount_out: "0" }, { min_amount_out: "000" }, {}]) {
    const r = await call({ fetch: m.fetch }, "preview_trade", { ...base, amount_in: "1", ...min });
    assert.equal(r.isError, true, JSON.stringify(min));
  }
  assert.equal(m.calls.length, 0);
});

test("list_vaults on mainnet: the Season 1 factory is the default (it fails closed until the factory exists)", async () => {
  const m = mock({ "arena.sledgit.near.get_vaults": () => [], "arena.sledgit.near.get_config": { code_hash: "2ZP4" } });
  const r = await call({ fetch: m.fetch }, "list_vaults", { network: "mainnet" });
  assert.equal(r.json!.factory, "arena.sledgit.near");
  assert.equal(r.json!.known_factory, true);
  assert.deepEqual(r.json!.vaults, []);
});

test("list_vaults: the network's factory by default, limit passed through", async () => {
  let args: Record<string, unknown> | undefined;
  const m = mock({ "arena2.irontrade.testnet.get_vaults": (a: Record<string, unknown>) => (args = a, [VAULT]), "arena2.irontrade.testnet.get_config": { code_hash: "2ZP4" } });
  const r = await call({ fetch: m.fetch }, "list_vaults", { limit: 10 });
  assert.deepEqual(r.json!.vaults, [VAULT]);
  assert.equal(r.json!.factory, "arena2.irontrade.testnet", "the current (round-3) factory is the default");
  assert.equal(r.json!.known_factory, true);
  assert.deepEqual(args, { from_index: 0, limit: 10 });
});

test("rpc errors surface with the method and reason, never as an empty success", async () => {
  const r = await call({ fetch: mock({}).fetch }, "get_vault_usage", { vault: VAULT });
  assert.equal(r.isError, true);
  assert.match(r.text, /RPC query: UNKNOWN_ACCOUNT/);
});

test("a stalled endpoint times out with a message naming the host", async () => {
  const hang: Fetch = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
  const r = await call({ fetch: hang, timeoutMs: 50 }, "get_vault_usage", { vault: VAULT });
  assert.equal(r.isError, true);
  assert.match(r.text, /rpc\.testnet\.fastnear\.com: no answer within 0\.05 s/);
});

// ------------------------------------------------------------------ records and receipts

function apiTx(hash: string, signer: string, outs: { executor: string; logs: string[]; status?: unknown }[]) {
  return { transaction: { hash, signer_id: signer }, receipts: outs.map((o, i) => ({ execution_outcome: { id: `r${i}`, block_height: 100 + i, block_timestamp: 1_793_000_000_000_000_000 + i, outcome: { executor_id: o.executor, logs: o.logs, status: o.status ?? { SuccessValue: "" } } } })) };
}

const TX1 = "4".repeat(44), TX2 = "5".repeat(44);

test("get_agent_record: only events logged by the vault count; a token contract can't forge one", async () => {
  const txs = [
    apiTx(TX1, AGENT_ID, [{ executor: VAULT, logs: [ev("refuse", { seq: 1, code: "trade_cap", receipt_hash: "a".repeat(64) })] },
      { executor: "wrap.testnet", logs: [ev("trade", { seq: 99, amount_out: "1" })] }]),
    apiTx(TX2, AGENT_ID, [{ executor: VAULT, logs: [ev("skip", { seq: 2, note: "hold" }), "EVENT_JSON:{broken"] }]),
  ];
  const m = mock({}, {
    "/v0/account": () => ({ account_txs: [{ transaction_hash: TX2 }, { transaction_hash: TX1 }] }),
    "/v0/transactions": () => ({ transactions: txs }),
  });
  const r = await call({ fetch: m.fetch }, "get_agent_record", { vault: VAULT });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json!.counts, { refuse: 1, skip: 1 });
  assert.equal(r.json!.malformed_events, 1);
  assert.ok(r.json!.events.every((e: { tx: string; explorer: string }) => e.explorer.endsWith(e.tx)));
});

const receipt = {
  v: 2, vault: VAULT, network: "testnet", agent: AGENT_ID, harness: "sledgit-runner/0.1.0",
  model: { provider: "echo", id: "hold" }, prompt_sha256: "0".repeat(64), inputs: { price: "2.1" },
  decision: { action: "hold" }, model_output: "", ts: "2026-10-29T00:00:00Z",
};
const LINE = canonical(receipt);
const HASH = sha256Hex(LINE);
const skipTree = (hash: string, executor = VAULT) => ({
  transaction: { hash: TX1, signer_id: AGENT_ID },
  transaction_outcome: { outcome: { executor_id: VAULT, logs: [], status: { SuccessReceiptId: "r0" } } },
  receipts_outcome: [{ id: "r0", outcome: { executor_id: executor, logs: [ev("skip", { seq: 7, receipt_hash: hash, note: "hold" })], status: { SuccessValue: "" } } }],
});

test("verify_receipt: a receipt whose hash the vault logged, with a matching decision, is ok", async () => {
  const m = mock({}, { tx: () => skipTree(HASH) });
  const r = await call({ fetch: m.fetch }, "verify_receipt", { receipt: LINE, tx: TX1 });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json!.status, "ok");
  assert.equal(r.json!.receipt_hash, HASH);
  assert.equal(r.json!.onchain, true);
});

test("verify_receipt: an edited receipt no longer matches; an event from another contract doesn't count", async () => {
  const edited = canonical({ ...receipt, inputs: { price: "9.9" } });
  let r = await call({ fetch: mock({}, { tx: () => skipTree(HASH) }).fetch }, "verify_receipt", { receipt: edited, tx: TX1 });
  assert.equal(r.json!.status, "mismatch");
  r = await call({ fetch: mock({}, { tx: () => skipTree(HASH, "evil.testnet") }).fetch }, "verify_receipt", { receipt: LINE, tx: TX1 });
  assert.equal(r.json!.status, "mismatch");
});

test("verify_receipt: without tx, finds the transaction in the vault's history", async () => {
  const m = mock({}, {
    "/v0/account": () => ({ account_txs: [{ transaction_hash: TX1 }] }),
    "/v0/transactions": () => ({ transactions: [apiTx(TX1, AGENT_ID, [{ executor: VAULT, logs: [ev("skip", { seq: 7, receipt_hash: HASH, note: "hold" })] }])] }),
    tx: () => skipTree(HASH),
  });
  const r = await call({ fetch: m.fetch }, "verify_receipt", { receipt: LINE });
  assert.equal(r.json!.status, "ok");
  assert.equal(r.json!.tx, TX1);
});

test("verify_receipt: not found is reported as not_found, and junk input is an error", async () => {
  const m = mock({}, { "/v0/account": () => ({ account_txs: [] }), "/v0/transactions": () => ({ transactions: [] }) });
  const r = await call({ fetch: m.fetch }, "verify_receipt", { receipt: LINE });
  assert.equal(r.json!.status, "not_found");
  for (const bad of ["not json", `${LINE}\n${LINE}`, canonical({ ...receipt, vault: "x.near" })]) {
    const e = await call({ fetch: m.fetch }, "verify_receipt", { receipt: bad });
    assert.equal(e.isError, true, bad.slice(0, 30));
  }
  const badTx = await call({ fetch: m.fetch }, "verify_receipt", { receipt: LINE, tx: "0xnot-a-hash" });
  assert.equal(badTx.isError, true);
});

// ------------------------------------------------------------------ attestation (the agent's real recorded bundle, offline)

const FIX = join(AGENT, "test", "fixtures", "nearai");
const realBundle = readFileSync(join(FIX, "real-bundle.json"), "utf8");
const realCol = JSON.parse(readFileSync(join(FIX, "real-collateral.json"), "utf8")) as { verified_at: number; collateral: Record<string, unknown> };
const offline = (b: TeeBundle) => ({
  verifyQuote: async (quote: Buffer): Promise<QuoteFacts> => {
    const key = Buffer.from(b.report.gateway_attestation.intel_quote, "hex").equals(quote) ? "gateway" : "model0";
    return dcapVerifyQuoteWith(realCol.collateral[key], realCol.verified_at)(quote);
  },
  nras: async () => true, // NVIDIA's live verdict for this bundle was true
});

test("verify_attestation: the real recorded (pre-binding) NEAR AI call passes every evidence check but earns no pill under policy v2", async () => {
  const b = JSON.parse(realBundle) as TeeBundle;
  const ok = await call({ fetch: mock({}).fetch, attest: offline(b) }, "verify_attestation", { bundle: realBundle });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.json!.pill, false);
  const failed = (ok.json!.checks as { name: string; ok: boolean | null; detail?: string }[]).filter((c) => c.ok !== true);
  assert.deepEqual(failed.map((c) => c.name), ["bundle format v2 (vault, salt and chain anchor inside the signed request)"]);
  assert.match(failed[0].detail!, /pre-binding format/);
  const resp = Buffer.from(b.response_b64, "base64");
  resp[resp.length - 2] ^= 1;
  const bad = await call({ fetch: mock({}).fetch, attest: offline(b) }, "verify_attestation", { bundle: JSON.stringify({ ...b, response_b64: resp.toString("base64") }) });
  assert.equal(bad.json!.pill, false);
});

test("verify_attestation: with a receipt that doesn't commit to the bundle, no pill", async () => {
  const b = JSON.parse(realBundle) as TeeBundle;
  const r = await call({ fetch: mock({}).fetch, attest: offline(b) }, "verify_attestation", { bundle: realBundle, receipt: LINE });
  assert.equal(r.json!.scope, "decision");
  assert.equal(r.json!.pill, false);
  assert.match(JSON.stringify(r.json!.checks), /self-reported/);
});

// ------------------------------------------------------------------ drift against the agent

test("drift: networks, tokens and refusal codes equal the agent's", () => {
  // The pair lives in the agent's key-free pairs.ts; the endpoints in config.ts.
  const config = readFileSync(join(AGENT, "src", "config.ts"), "utf8") + readFileSync(join(AGENT, "src", "pairs.ts"), "utf8");
  for (const n of Object.values(NETS)) {
    for (const v of [n.rpc, n.base, n.quote]) assert.ok(config.includes(`"${v}"`), `${v} not in agent config`);
  }
  const vault = readFileSync(join(AGENT, "src", "vault.ts"), "utf8");
  const codes = [...(vault.match(/REFUSAL_CODES = \[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(codes, [...REFUSAL_CODES]);
});

test("checkAccount: NEAR id rules", () => {
  for (const ok of ["ab.testnet", "a-b_c.testnet", "claude.irontrade.testnet"]) assert.equal(checkAccount(ok, NETS.testnet), ok);
  for (const bad of ["a", "A.testnet", "a..b.testnet", "-a.testnet", "a-.testnet", "a b.testnet"]) assert.throws(() => checkAccount(bad, NETS.testnet), bad);
  assert.equal(checkAccount("f".repeat(64), NETS.mainnet), "f".repeat(64));
});

// ------------------------------------------------------------------ Phase 5 review fixes

test("F1: a contract that logs vault events but isn't a factory vault never verifies, and its data is flagged", async () => {
  const FAKE = "totally-legit.testnet";
  const line = canonical({ ...receipt, vault: FAKE });
  const tree = { ...skipTree(sha256Hex(line), FAKE), receipts_outcome: skipTree(sha256Hex(line), FAKE).receipts_outcome };
  const m = mock({ [`${FAKE}.get_policy`]: { tokens: [], pairs: [], max_trades_per_hour: 999, max_slippage_bps: 0 }, [`${FAKE}.get_config`]: { frozen: false } }, { tx: () => tree });
  const v = await call({ fetch: m.fetch }, "verify_receipt", { receipt: line, tx: TX1 });
  assert.equal(v.json!.status, "unverified_vault");
  assert.equal(v.json!.onchain, false);
  assert.match(v.json!.problems.join(), /not a direct sub-account of a known Sledgit factory/);
  assert.ok(!m.calls.some((c) => c.body.method === "tx"), "its transactions aren't even read");
  const p = await call({ fetch: m.fetch }, "get_vault_policy", { vault: FAKE });
  assert.equal(p.json!.provenance.sledgit_vault, false);
  assert.match(p.json!.provenance.warning, /untrusted/);
  // Right parent, wrong code: a hand-made child running other code is not a vault either.
  const other = mock({ [`x.arena.irontrade.testnet.get_config`]: { ...IDS }, "arena.irontrade.testnet.get_config": { code_hash: "5ePv", ...IDS } });
  const q = await call({ fetch: other.fetch }, "get_vault_usage", { vault: "x.arena.irontrade.testnet" });
  assert.equal(q.isError, true, "no get_usage mocked, but the provenance runs first");
  const r = await call({ fetch: mock({ "x.arena.irontrade.testnet.get_usage": {}, "x.arena.irontrade.testnet.get_config": IDS, "x.arena.irontrade.testnet#hash": "Other1111111111111111111111111111111111111", "arena.irontrade.testnet.get_config": { code_hash: "5ePv", ...IDS } }).fetch }, "get_vault_usage", { vault: "x.arena.irontrade.testnet" });
  assert.equal(r.json!.provenance.sledgit_vault, false);
  assert.match(r.json!.provenance.reason, /does not run the code/);
});

test("F2: a token reporting absurd decimals can't stall the server or bloat the result", async () => {
  const line = canonical({ ...receipt, decision: { action: "sell", amount_in: "1" } });
  const tree = { ...skipTree(""), receipts_outcome: [{ id: "r0", outcome: { executor_id: VAULT, logs: [ev("request", { seq: 1, receipt_hash: sha256Hex(line), token_in: "wrap.testnet", amount_in: "1" })], status: { SuccessValue: "" } } }] };
  const m = mock({ "wrap.testnet.ft_metadata": { decimals: 100_000_000 } }, { tx: () => tree });
  const t0 = Date.now();
  const r = await call({ fetch: m.fetch }, "verify_receipt", { receipt: line, tx: TX1 });
  assert.ok(Date.now() - t0 < 2000, "no 40 s stall");
  assert.equal(r.json!.status, "mismatch");
  assert.match(r.json!.problems.join(), /out of range/);
  assert.ok(r.text.length < 4000);
});

test("F5: events from a failed receipt don't count as decisions", async () => {
  const txs = [apiTx(TX1, AGENT_ID, [
    { executor: VAULT, logs: [ev("trade", { seq: 1, amount_out: "5" })], status: { Failure: { ActionError: {} } } },
    { executor: VAULT, logs: [ev("skip", { seq: 2, note: "hold" })] },
  ])];
  const m = mock({}, { "/v0/account": () => ({ account_txs: [{ transaction_hash: TX1 }] }), "/v0/transactions": () => ({ transactions: txs }) });
  const r = await call({ fetch: m.fetch }, "get_agent_record", { vault: VAULT });
  assert.deepEqual(r.json!.counts, { skip: 1 });
  assert.equal(r.json!.failed_receipt_events, 1);
});

test("F6: an oversized body is refused while it streams, not after it is buffered", async () => {
  const pulls: number[] = [];
  const big: Fetch = async () => {
    const i = pulls.push(0) - 1;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls[i]++; c.enqueue(new Uint8Array(1024 * 1024)); } });
    return { ok: true, status: 200, text: async () => { throw new Error("buffered"); }, body, headers: { get: () => null } };
  };
  const r = await call({ fetch: big }, "get_vault_usage", { vault: VAULT });
  assert.equal(r.isError, true);
  assert.match(r.text, /larger than 8388608 bytes/);
  assert.ok(pulls.every((n) => n <= 10), `each endless body stopped near 8 MB: ${pulls.join(",")}`);
  const declared: Fetch = async () => ({ ok: true, status: 200, text: async () => { throw new Error("read"); }, headers: { get: (h) => (h === "content-length" ? String(9 * 1024 * 1024) : null) } });
  assert.match((await call({ fetch: declared }, "get_vault_usage", { vault: VAULT })).text, /larger than/);
});

test("F7: the HTTP gate admits only same-port loopback POST /mcp, refuses foreign origins, GET and overload", () => {
  const P = 8123, ok = { method: "POST", url: "/mcp", host: `127.0.0.1:${P}` };
  assert.equal(httpGate(ok, P, 0), null);
  assert.equal(httpGate({ ...ok, origin: `http://127.0.0.1:${P}` }, P, 0), null);
  assert.equal(httpGate({ ...ok, origin: "https://evil.example" }, P, 0)?.status, 403);
  assert.equal(httpGate({ ...ok, origin: "http://localhost:3000" }, P, 0)?.status, 403);
  assert.equal(httpGate({ ...ok, host: "evil.example" }, P, 0)?.status, 403);
  assert.equal(httpGate({ ...ok, method: "GET" }, P, 0)?.status, 405);
  assert.equal(httpGate({ ...ok, method: "DELETE" }, P, 0)?.status, 405);
  assert.equal(httpGate({ ...ok, url: "/other" }, P, 0)?.status, 404);
  assert.equal(httpGate(ok, P, MAX_CONCURRENT)?.status, 503);
});

test("F7: the live HTTP server refuses a forged Origin and a GET stream", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = serveHttp(port, { fetch: mock({}).fetch });
  await new Promise((r) => srv.once("listening", r));
  try {
    const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal((await post({ origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { accept: "text/event-stream" } })).status, 405);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("F9: the server's import graph reaches no key-handling module", () => {
  const SRC = join(HERE, "..", "src");
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    // Value imports only: `import type` and `type` specifiers vanish at runtime.
    for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms)) {
      const spec = m[1];
      if (!spec.startsWith(".")) { assert.ok(!/near-api-js/.test(spec), `${file} imports ${spec}`); continue; }
      walk(join(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  };
  walk(join(SRC, "server.ts"));
  const agentFiles = [...seen].filter((f) => f.includes(`${join("agent", "src")}`)).map((f) => f.split(join("agent", "src"))[1]);
  for (const bad of ["/config.ts", "/vault.ts", "/models.ts", "/attest/nearai.ts", "/main.ts", "/arena.ts"]) assert.ok(!agentFiles.includes(bad), `reaches agent/src${bad}`);
  assert.ok(agentFiles.includes("/provenance.ts") && agentFiles.includes("/verify.ts"), "the graph walk works");
});

test("F10: verify_attestation says what it proves; F12: mainnet ids under any top-level account pass the id check", async () => {
  const b = JSON.parse(realBundle) as TeeBundle;
  const r = await call({ fetch: mock({}).fetch, attest: offline(b) }, "verify_attestation", { bundle: realBundle });
  assert.match(r.json!.proves, /NOT that any vault decision used it/);
  for (const ok of ["vault.sledgit.near", "token.sweat", "app.tg", "f".repeat(64)]) assert.equal(checkAccount(ok, NETS.mainnet), ok);
  for (const bad of ["x.testnet", "plain"]) assert.throws(() => checkAccount(bad, NETS.mainnet), bad);
});

test("events parse from the sledgit standard and the legacy irontrade one (pre-rename testnet vaults)", () => {
  const log = (standard: string) => `EVENT_JSON:${JSON.stringify({ standard, version: "1.2.0", event: "skip", data: [{ seq: 1 }] })}`;
  for (const s of ["sledgit", "irontrade"]) assert.deepEqual(parseEvent(log(s)), { event: "skip", data: { seq: 1 } });
  assert.equal(parseEvent(log("nep141")), null);
});
