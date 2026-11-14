// Review fixes for verify (Phase 5 review F1, F2, F5): only genuine Sledgit vaults verify, a hostile token can't
// make verification expensive, and events from failed receipts don't count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { vaultProvenance, cachedProvenance, FACTORIES, type ChainReader } from "../src/provenance.js";
import { verifyReceipts, type EventSource } from "../src/verify.js";
import { toUnits, fromUnits, checkDecimals } from "../src/decision.js";
import { eventsFromOutcome, txResult } from "../src/vault.js";
import { NETWORKS } from "../src/config.js";
import { canonical, sha256Hex } from "../src/receipt.js";

const ARENA = "arena.irontrade.testnet";
const ARENA2 = "arena2.irontrade.testnet";
const HASH2 = "2ZP4H1ENzFKyN4nVSZf9vKf3pEpgoup9DVU6NbjbE2Gg";
const HASH = "5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ";
const IDS = { exchange_id: "ref-finance-101.testnet", intents_id: "it1793205011-intents.testnet", mpc_id: "v1.signer-prod.testnet" };

function chain(over: { hash?: string; keys?: number; vaultCfg?: Record<string, unknown>; fail?: boolean } = {}): ChainReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    viewAccount: async (id) => { calls.push(`account ${id}`); if (over.fail) throw new Error("UNKNOWN_ACCOUNT"); return { code_hash: "1".repeat(32), global_contract_hash: over.hash ?? HASH }; },
    accessKeyCount: async (id) => { calls.push(`keys ${id}`); return over.keys ?? 0; },
    view: async <T>(id: string, method: string) => {
      calls.push(`${id}.${method}`);
      return (id === ARENA ? { code_hash: HASH, ...IDS } : { owner_id: "o.testnet", ...IDS, ...over.vaultCfg }) as T;
    },
  };
}

test("F1: a direct child of a known factory that runs its pinned code with no keys is a Sledgit vault", async () => {
  const p = await vaultProvenance(`qwen36-tee.${ARENA}`, "testnet", chain());
  assert.equal(p.sledgit_vault, true, p.reason);
  assert.equal(p.status, "genuine");
  assert.equal(p.factory, ARENA);
  assert.equal(p.factory_locked, true);
});

test("F1: anything else is not: unknown parent, grandchild, other code, a key, other ids, unreadable", async () => {
  const cases: [string, ChainReader, RegExp][] = [
    ["totally-legit.testnet", chain(), /not a direct sub-account of a known Sledgit factory/],
    [`x.y.${ARENA}`, chain(), /not a direct sub-account/],
    [`fake.${ARENA}`, chain({ hash: "Other1111" }), /does not run the code/],
    [`fake.${ARENA}`, chain({ keys: 1 }), /1 access key/],
    [`fake.${ARENA}`, chain({ vaultCfg: { mpc_id: "evil-signer.testnet" } }), /initialised with mpc_id/],
    [`fake.${ARENA}`, chain({ fail: true }), /could not read/],
  ];
  for (const [vault, r, why] of cases) {
    const p = await vaultProvenance(vault, "testnet", r);
    assert.equal(p.sledgit_vault, false, vault);
    assert.match(p.reason, why);
  }
  assert.equal((await vaultProvenance("v.sledgit.near", "mainnet", chain())).sledgit_vault, false, "no mainnet factory yet");
});

test("F1 / P2-3: the factory list and its code hashes are pinned in config; a legacy factory's children are history, not genuine", async () => {
  assert.deepEqual(FACTORIES.testnet.map((f) => f.id), [ARENA2, ARENA, "irontrade.testnet"]);
  const LEGACY = FACTORIES.testnet[2].vault_code_hash;
  const legacy = chain({ hash: LEGACY });
  legacy.accessKeyCount = async (id) => (id === "irontrade.testnet" ? 1 : 0);
  legacy.view = async <T>(id: string) => ({ code_hash: LEGACY, ...IDS, ...(id === "irontrade.testnet" ? {} : { owner_id: "o" }) }) as T;
  const p = await vaultProvenance("claude.irontrade.testnet", "testnet", legacy);
  assert.equal(p.sledgit_vault, false, "a child of a factory that holds a key never counts");
  assert.equal(p.status, "legacy");
  assert.match(p.reason, /legacy: child of irontrade\.testnet, which holds 1 access key/);
});

test("P2-3: the pinned hash wins over the factory's live answer, and a locked factory that regains a key stops vouching", async () => {
  // A factory (or whoever controls it) claiming another code hash can't make a child running that code genuine.
  const lying = chain({ hash: "Evil111111111111111111111111111111111111111" });
  lying.view = async <T>(id: string) => ({ code_hash: "Evil111111111111111111111111111111111111111", ...IDS, ...(id === ARENA ? {} : { owner_id: "o" }) }) as T;
  const p = await vaultProvenance(`fake.${ARENA}`, "testnet", lying);
  assert.equal(p.sledgit_vault, false);
  assert.match(p.reason, /does not run the code arena\.irontrade\.testnet was locked with/);
  const rekeyed = chain();
  rekeyed.accessKeyCount = async (id) => (id === ARENA ? 1 : 0);
  const q = await vaultProvenance(`qwen36-tee.${ARENA}`, "testnet", rekeyed);
  assert.equal(q.sledgit_vault, false);
  assert.equal(q.status, "legacy");
  assert.equal(q.factory_locked, false);
});

const VAULT = `v.${ARENA}`, AGENT = "a.testnet", TX = "4".repeat(44);
const receipt = (vault: string, decision: Record<string, unknown>) => canonical({ v: 2, vault, network: "testnet", agent: AGENT, decision, ts: "2026-10-29T00:00:00Z" });

function source(o: { genuine?: boolean; events?: (hash: string) => unknown[]; decimals?: number } = {}) {
  const calls: string[] = [];
  const src: EventSource = {
    provenance: async (v) => { calls.push(`prov ${v}`); return { sledgit_vault: o.genuine ?? true, status: o.genuine === false ? "unverified" : "genuine", reason: o.genuine === false ? "test: not a factory child" : "test" }; },
    txEvents: async () => { calls.push("txEvents"); return (o.events?.("") ?? []) as never; },
    decimals: async (t) => { calls.push(`decimals ${t}`); return o.decimals ?? 24; },
  };
  return { src, calls };
}

test("F1: verify never says ok for a contract that is not a Sledgit vault, and reads nothing else from it", async () => {
  const line = receipt("totally-legit.testnet", { action: "hold" });
  const { src, calls } = source({ genuine: false, events: () => [{ event: "skip", data: { receipt_hash: sha256Hex(line), note: "hold" } }] });
  const [row] = await verifyReceipts(line, JSON.stringify({ receipt_hash: sha256Hex(line), tx: TX }), NETWORKS.testnet, src);
  assert.equal(row.status, "unverified_vault");
  assert.equal(row.sledgit_vault, false);
  assert.equal(row.onchain, false);
  assert.deepEqual(calls, ["prov totally-legit.testnet"]);
});

test("F2: a wrong token ends the check before its metadata is read; amounts in messages are clipped", async () => {
  const line = receipt(VAULT, { action: "sell", amount_in: "1" });
  const hash = sha256Hex(line);
  const { src, calls } = source({ events: () => [{ event: "request", data: { receipt_hash: hash, token_in: "evil-token.testnet", amount_in: "9".repeat(5000) } }], decimals: 1e8 });
  const t0 = Date.now();
  const [row] = await verifyReceipts(line, JSON.stringify({ receipt_hash: hash, tx: TX }), NETWORKS.testnet, src);
  assert.equal(row.status, "mismatch");
  assert.ok(!calls.some((c) => c.startsWith("decimals")), "no ft_metadata read for a wrong token");
  assert.ok(JSON.stringify(row).length < 2000);
  assert.ok(Date.now() - t0 < 1000);
});

test("F2: decimals outside 0-38 are refused by toUnits/fromUnits and by verify, quickly", async () => {
  for (const d of [-1, 39, 1e8, 1.5, NaN]) {
    assert.throws(() => checkDecimals(d), /out of range/);
    assert.throws(() => toUnits("1", d));
    assert.throws(() => fromUnits(1n, d));
  }
  assert.equal(toUnits("1.5", 38), 15n * 10n ** 37n);
  const line = receipt(VAULT, { action: "sell", amount_in: "1" });
  const hash = sha256Hex(line);
  const { src } = source({ events: () => [{ event: "request", data: { receipt_hash: hash, token_in: "wrap.testnet", amount_in: "1" } }], decimals: 1e8 });
  const t0 = Date.now();
  const [row] = await verifyReceipts(line, JSON.stringify({ receipt_hash: hash, tx: TX }), NETWORKS.testnet, src);
  assert.equal(row.status, "mismatch");
  assert.match(row.problems.join(), /out of range/);
  assert.ok(Date.now() - t0 < 1000);
});

test("F5: verify counts only events from receipts that succeeded", () => {
  const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", event, data: [{}] })}`;
  const tree = {
    transaction_outcome: { outcome: { executor_id: AGENT, logs: [], status: { SuccessReceiptId: "r" } } },
    receipts_outcome: [
      { outcome: { executor_id: VAULT, logs: [ev("request")], status: { SuccessValue: "" } } },
      { outcome: { executor_id: VAULT, logs: [ev("trade")], status: { Failure: { ActionError: {} } } } },
      { outcome: { executor_id: VAULT, logs: [ev("trade")] } },
    ],
  };
  const all = eventsFromOutcome(tree, VAULT);
  assert.equal(all.events.length, 3, "without the option every log is read");
  const ok = eventsFromOutcome(tree, VAULT, { onlySucceeded: true });
  assert.deepEqual(ok.events.map((e) => e.event), ["request"]);
  assert.equal(ok.failed, 2);
  // P2-11: the runner's live call() uses the same rule, so it can't record a trade whose receipt was reverted.
  const live = txResult({ ...tree, status: { SuccessValue: "" }, transaction: { hash: "tx-1" } }, VAULT);
  assert.deepEqual(live.events.map((e) => e.event), ["request"]);
  assert.equal(live.failed_receipt_logs, 2);
  assert.notEqual(live.outcome.status, "traded");
});

test("provenance is looked up once per vault per run", async () => {
  const r = chain();
  const p = cachedProvenance("testnet", r);
  await Promise.all([p(VAULT), p(VAULT), p(VAULT)]);
  assert.equal(r.calls.filter((c) => c.startsWith("account")).length, 1);
});

test("round-3 migration: arena2 vaults are genuine and current; arena vaults stay genuine history marked retired", async () => {
  const c2 = chain({ hash: HASH2 });
  c2.view = async <T>(id: string) => ({ code_hash: HASH2, ...IDS, ...(id === ARENA2 ? {} : { owner_id: "o" }) }) as T;
  const p2 = await vaultProvenance(`qwen36-tee.${ARENA2}`, "testnet", c2);
  assert.equal(p2.sledgit_vault, true, p2.reason);
  assert.equal(p2.retired, undefined);
  const p1 = await vaultProvenance(`qwen36-tee.${ARENA}`, "testnet", chain());
  assert.equal(p1.sledgit_vault, true, "old receipts still verify");
  assert.match(p1.retired ?? "", /pre-round-3 code/);
  assert.match(p1.reason, /history, not ranked/);
  // arena2 pins its own code: the old code under arena2 is not genuine.
  const mixed = chain({ hash: HASH });
  mixed.view = c2.view;
  assert.equal((await vaultProvenance(`x.${ARENA2}`, "testnet", mixed)).sledgit_vault, false);
});

test("mainnet: the Season 1 factory is known, and a vault fails closed while it doesn't exist", async () => {
  const f = FACTORIES.mainnet.find((k) => k.id === "arena.sledgit.near");
  assert.ok(f, "arena.sledgit.near is in FACTORIES.mainnet");
  assert.match(f.vault_code_hash, /^REPLACE/, "a placeholder until the reproducible build at the 1 Nov tag");
  assert.equal(FACTORIES.testnet.find((k) => k.id === ARENA2)?.vault_code_hash, HASH2, "testnet unchanged");
  const missing: ChainReader = {
    viewAccount: async () => { throw new Error("UNKNOWN_ACCOUNT"); },
    accessKeyCount: async () => { throw new Error("UNKNOWN_ACCOUNT"); },
    view: async () => { throw new Error("UNKNOWN_ACCOUNT"); },
  };
  const p = await vaultProvenance("house-trend.arena.sledgit.near", "mainnet", missing);
  assert.equal(p.sledgit_vault, false);
  const q = await vaultProvenance("house-trend.arena.irontrade.testnet", "mainnet", missing);
  assert.equal(q.sledgit_vault, false);
  assert.match(q.reason, /not a direct sub-account/);
  // Even a perfect-looking child (locked factory, current code, pinned ids, 0 keys) fails while the hash is a placeholder.
  const ids = { exchange_id: "v2.ref-finance.near", intents_id: "intents.near", mpc_id: "v1.signer" };
  const looksRight: ChainReader = {
    viewAccount: async () => ({ global_contract_hash: HASH2 }),
    accessKeyCount: async () => 0,
    view: async <T>() => ids as T,
  };
  const r = await vaultProvenance("house-trend.arena.sledgit.near", "mainnet", looksRight);
  assert.equal(r.sledgit_vault, false);
  assert.match(r.reason, /does not run the code/);
});

test("F2-01: the exchange/intents/MPC ids are pinned per factory, never taken from the factory's live answer", async () => {
  for (const net of ["testnet", "mainnet"] as const) for (const f of FACTORIES[net]) {
    assert.ok(f.bound.exchange_id && f.bound.intents_id && f.bound.mpc_id, `${f.id} pins its bound ids`);
  }
  assert.deepEqual(FACTORIES.mainnet[0].bound, { exchange_id: "v2.ref-finance.near", intents_id: "intents.near", mpc_id: "v1.signer" });
  // A look-alike factory whose live config AND whose vault both name the attacker's exchange: same code, keyless.
  const evil = { ...IDS, exchange_id: "evil-exchange.testnet" };
  const lookalike: ChainReader = {
    viewAccount: async () => ({ code_hash: "1".repeat(32), global_contract_hash: HASH }),
    accessKeyCount: async () => 0,
    view: async <T>(id: string) => (id === ARENA ? { code_hash: HASH, ...evil } : { owner_id: "o.testnet", ...evil }) as T,
  };
  const p = await vaultProvenance(`fake.${ARENA}`, "testnet", lookalike);
  assert.equal(p.sledgit_vault, false);
  assert.match(p.reason, /initialised with exchange_id other than the pinned ref-finance-101\.testnet/);
  // The factory alone misreporting is caught too.
  const badFactory: ChainReader = { ...lookalike, view: async <T>(id: string) => (id === ARENA ? { code_hash: HASH, ...evil } : { owner_id: "o.testnet", ...IDS }) as T };
  const q = await vaultProvenance(`v.${ARENA}`, "testnet", badFactory);
  assert.equal(q.sledgit_vault, false);
  assert.match(q.reason, /reports exchange_id other than the pinned values/);
});
