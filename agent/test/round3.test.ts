// Audit round 3 (off-chain) regressions: each test is a reviewer PoC that used to pass and must now fail the attack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { houseRerun, houseCheck } from "../src/strategies/rerun.js";
import { decide, strategyById, strategyPrompt, rulesModel } from "../src/strategies/rules.js";
import { slotBlock, ARCHIVAL_RPC } from "../src/strategies/schedule.js";
import { verifyReceipts, rowPasses } from "../src/verify.js";
import { expectedDecision, eventMatches, pairCheck } from "../src/attest/pill.js";
import { verifySeason, type SeasonChain } from "../src/attest/season.js";
import { NETWORKS } from "../src/config.js";
import { tick } from "../src/arena.js";
import { canonical, sha256Hex, sealReceipt, type Receipt } from "../src/receipt.js";
import type { ChainDecision } from "../src/attest/chain.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const W = "wrap.testnet", U = "usdc.itachicara.testnet", DAY = 86_400_000, T0 = Date.UTC(2026, 7, 1);
const VAULT = "house-luck.arena.irontrade.testnet";
const GENUINE = async () => ({ sledgit_vault: true, status: "genuine" as const, reason: "test" });
const houseLines = (s: string) => readFileSync(join(REPO, "deploy", "testnet", "receipts-house", s, "receipts.jsonl"), "utf8").split("\n").filter(Boolean);

test("R3-01: a receipt whose decision isn't the rule's output fails re-run and verify (PoC-5)", async () => {
  const r = JSON.parse(houseLines("rebalancer").find((l) => JSON.parse(l).decision.action === "hold")!);
  r.decision = { action: "sell", amount_in: "0.4", reason: "rebalancer: target 0.5 from 1.000" };
  const line = canonical(r), h = sha256Hex(line);
  const rr = houseRerun(line).rows[0];
  assert.equal(rr.same, true, "the rule's output still re-runs");
  assert.equal(rr.decision_consistent, false);
  assert.match(String(rr.error), /not what the rule's output says/);
  const src = { txEvents: async () => [{ event: "request", data: { receipt_hash: h, seq: 3, token_in: W, amount_in: "400000000000000000000000" } }],
    decimals: async () => 24, provenance: GENUINE };
  const [v] = await verifyReceipts(line, JSON.stringify({ receipt_hash: h, tx: "TX" }), NETWORKS.testnet, src as never);
  assert.equal(rowPasses(v), false);
  assert.ok(v.problems.some((p) => /not what its model\/rule output says/.test(p)), v.problems.join("; "));
});

// ---- houseCheck world (fake archival chain, fake Binance, fake RPC), as in the reviewer's PoC-2
function fakeArchival(startSecs: number, head: number) {
  const block = (h: number) => (h < 1 || h > head ? null : { height: h, hash: `h${h}`, timestamp: String((startSecs + (h - 1000)) * 1e9) });
  return (async (_u: string | URL, init?: RequestInit) => {
    const p = (JSON.parse(String(init?.body)) as { params: { block_id?: number; finality?: string } }).params;
    const b = p.finality ? block(head) : block(p.block_id!);
    return new Response(JSON.stringify(b ? { result: { header: b } } : { error: { cause: { name: "UNKNOWN_BLOCK" } } }));
  }) as typeof fetch;
}
const candles = (n: number) => Array.from({ length: n }, (_, i) => { const c = 2 + i * 0.02; return [T0 + i * DAY, (c * 1.01).toFixed(4), (c * 0.99).toFixed(4), c.toFixed(4)]; });
function world(daily: unknown[][], slotSecs: number) {
  const arch = fakeArchival(slotSecs - 300, 1000 + 400_000);
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(ARCHIVAL_RPC.testnet)) return arch(url, init);
    if (u.includes("/api/v3/klines")) {
      const q = new URL(u).searchParams;
      if (q.get("interval") === "1m") return new Response(JSON.stringify([[Number(q.get("startTime")), "1", "100", "0.01", "2", "0"]]));
      const from = Number(q.get("startTime"));
      return new Response(JSON.stringify(daily.filter((c) => (c[0] as number) >= from).map((c) => [c[0], "0", c[1], c[2], c[3], "0", (c[0] as number) + DAY - 1])));
    }
    const p = (JSON.parse(String(init?.body)) as { params: { request_type: string; method_name?: string } }).params;
    if (p.request_type === "view_account") return new Response(JSON.stringify({ result: { global_contract_hash: "5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ" } }));
    if (p.request_type === "view_access_key_list") return new Response(JSON.stringify({ result: { keys: [] } }));
    const cfg = { exchange_id: "ref-finance-101.testnet", intents_id: "x.testnet", mpc_id: "v1.signer-prod.testnet" };
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(p.method_name === "get_config" ? cfg : {}))] } }));
  }) as typeof fetch;
}

async function forgedRebalancer() {
  const slot = Date.UTC(2026, 9, 29, 0, 5);
  const f = world(candles(60), Math.floor(slot / 1000));
  const sb = await slotBlock("testnet", slot, f);
  const chainState = { seq: 4, decisions_before: 3, requests: { buy: 0, sell: 1 }, last_request: { seq: 2, side: "sell" },
    slot: new Date(slot).toISOString(), off_schedule: false, slot_block: sb };
  const v = { id: VAULT, net: { id: "testnet", base: W, quote: U }, agentId: "a.testnet", chainId: "testnet",
    config: async () => ({ agent_id: "a.testnet", frozen: false, seq: 3 }),
    policy: async () => ({ tokens: [{ token: W, max_per_trade: "500000000000000000000000", max_per_day: "3000000000000000000000000" }, { token: U, max_per_trade: "1000000000000000000000000", max_per_day: "5000000000000000000000000" }], pairs: [], max_trades_per_hour: 12, max_slippage_bps: 100 }),
    usage: async () => ({ hour: "0", trades: 0, spent: [] }), intents: async () => ({ open_intent: null }), inFlight: async () => null,
    decimals: async () => 24, balance: async (t: string) => (t === W ? 10n ** 24n : 2n * 10n ** 24n) };
  const dir = mkdtempSync(join(tmpdir(), "r3c-"));
  const s = strategyById("rebalancer");
  await tick({ vault: v as never, model: rulesModel(s, VAULT), prompt: strategyPrompt(s),
    price: async () => ({ source: "t", symbol: "NEARUSDT", price: "2.5", fetched_at: "2026-10-29T00:30:00.000Z" }),
    market: async () => ({ source: "t", interval: "1d", candles: candles(60), as_of: "x" }) as never,
    chain: chainState as never, historySize: 0, receiptsPath: join(dir, "receipts.jsonl"), outcomesPath: join(dir, "o.jsonl"), dryRun: true });
  const r = JSON.parse(readFileSync(join(dir, "receipts.jsonl"), "utf8").trim());
  const chainAtBlock = { config: r.inputs.raw.config, policy: r.inputs.raw.policy, usage: r.inputs.raw.usage, balances: { ...r.inputs.raw.balances } };
  // Forge: the vault "held" 100 wNEAR and 0 USDC (raw and human agree), so the rule says sell.
  r.inputs.raw.balances[W] = (100n * 10n ** 24n).toString(); r.inputs.vault.balances[W] = "100";
  r.inputs.raw.balances[U] = "0"; r.inputs.vault.balances[U] = "0";
  const { raw: _raw, ...x } = r.inputs;
  const d = decide(s, x, VAULT);
  r.model_output = JSON.stringify(d); r.decision = expectedDecision({ model_output: r.model_output, network: "testnet" });
  const line = canonical(r);
  const prior: ChainDecision[] = [1, 2, 3].map((n) => ({ seq: n, event: n === 2 ? "request" : "skip", ...(n === 2 ? { token_in: W } : {}),
    receipt_hash: `r${n}`, tx: `t${n}`, block_time_secs: Math.floor((slot - (4 - n) * DAY / 2) / 1000) }) as ChainDecision);
  return { f, slot, line, d, prior, chainAtBlock };
}

test("R3-01 / R3-03: --check fails a trade event that isn't the receipt's decision, and forged balances the chain doesn't have (PoC-2)", async () => {
  const { f, slot, line, d, prior, chainAtBlock } = await forgedRebalancer();
  assert.equal(d.action, "sell", "the forged balances make the rule sell");
  // On chain, the decision with this receipt hash is a BUY of a different size.
  const mine: ChainDecision = { seq: 4, event: "request", token_in: U, amount_in: "999999", receipt_hash: sha256Hex(line), tx: "t4",
    block_time_secs: Math.floor((slot + 25 * 60_000) / 1000), tx_block_height: 1200 };
  const [row] = await houseCheck(line, "testnet", { fetch: f, decisions: async () => [...prior, mine], stateAt: async () => chainAtBlock as never });
  assert.equal(row.pass, false);
  assert.equal(row.event_matches_decision, false);
  assert.equal(row.chain_state_matches, false);
  assert.equal(row.state_block, 1200);
  assert.ok(row.problems.some((p) => /wrap\.testnet balance .* differs from the chain's/.test(p)), row.problems.join("; "));
});

test("R3-03: the chain state is read at the transaction's block, looked up when the indexer didn't give it", async () => {
  const { f, slot, line, prior, chainAtBlock } = await forgedRebalancer();
  const mine: ChainDecision = { seq: 4, event: "skip", receipt_hash: sha256Hex(line), tx: "t4", block_time_secs: Math.floor((slot + 25 * 60_000) / 1000) };
  const seen: number[] = [];
  const [row] = await houseCheck(line, "testnet", { fetch: f, decisions: async () => [...prior, mine],
    txBlock: async () => 4321, stateAt: async (_n, _v, _t, h) => { seen.push(h); return chainAtBlock as never; } });
  assert.deepEqual(seen, [4321]);
  assert.equal(row.state_block, 4321);
  assert.equal(row.pass, false, "forged balances still differ");
});

test("R3-02: --check fails a line that isn't a rules receipt unless --skip-non-rules", async () => {
  const manual = sealReceipt({ v: 1, vault: "house-rebalancer.arena.irontrade.testnet", network: "testnet", agent: "x.testnet",
    model: { provider: "human", id: "cli" }, prompt_sha256: "", inputs: {}, decision: { action: "sell", amount_in: "3", reason: "manual" },
    model_output: "", ts: "2026-10-29T00:00:00.000Z" }).line;
  const strict = await houseCheck(manual, "testnet", { decisions: async () => [] });
  assert.equal(strict.length, 1);
  assert.equal(strict[0].pass, false);
  assert.match(strict[0].problems[0], /not a rules receipt/);
  assert.deepEqual(await houseCheck(manual, "testnet", { decisions: async () => [], skipNonRules: true }), []);
});

const tee = () => JSON.parse(readFileSync(join(REPO, "deploy", "testnet", "receipts-arena", "qwen36-tee", "receipts.jsonl"), "utf8").split("\n")[0]) as Receipt;

test("R3-04: unsigned raw.decimals can't change what the reply says (PoC-3a)", () => {
  const sell = tee();
  const before = expectedDecision(sell);
  assert.equal(before.action, "sell");
  const r = structuredClone(sell) as Receipt & { inputs: { raw: { decimals: Record<string, number> } } };
  r.inputs.raw.decimals[W] = 1;
  assert.deepEqual(expectedDecision(r), before);
});

test("R3-05: the traded token comes from the network's pinned pair, not the receipt's labels (PoC-3b)", async () => {
  const r = structuredClone(tee()) as Receipt & { inputs: { vault: { base: string; quote: string } } };
  r.inputs.vault.base = U; r.inputs.vault.quote = W;
  const ev: ChainDecision = { seq: 1, event: "request", receipt_hash: "x", token_in: U, amount_in: "125000000000000000000000", tx: "t", block_time_secs: 0 };
  assert.equal((await eventMatches(r, ev, async () => 24)).ok, false);
  assert.equal(pairCheck(r).ok, false);
  assert.equal(pairCheck(tee()).ok, true);
});

test("R3-06: the season reaches the vault's own seq; decisions the indexer didn't return drop the pill", async () => {
  const line = sealReceipt({ v: 2, vault: "qwen36-tee.arena.irontrade.testnet", network: "testnet", agent: "a.testnet",
    model: { provider: "nearai-tee", id: "m" }, prompt_sha256: "", inputs: {}, decision: { action: "hold", amount_in: "0", reason: "price_error" },
    model_output: "", ts: "2026-10-29T00:00:00.000Z" }).line;
  const events: ChainDecision[] = [{ seq: 1, event: "skip", receipt_hash: sha256Hex(line), tx: "t1", block_time_secs: 0 }];
  const chain = (seq?: number): SeasonChain => ({ provenance: GENUINE, decisions: async () => events, decimals: async () => 24,
    ...(seq === undefined ? {} : { seq: async () => seq }) });
  const lagging = await verifySeason(line, () => undefined, chain(3), {});
  assert.equal(lagging.tee_pill, false);
  assert.equal(lagging.to_seq, 3);
  assert.ok(lagging.problems.some((p) => /recorded 3 decisions but the indexer returned up to seq 1/.test(p)));
  assert.equal(lagging.decisions.filter((d) => /not returned by the indexer/.test(d.failed[0]?.detail ?? "")).length, 2);
  const unread = await verifySeason(line, () => undefined, chain(undefined), {});
  assert.ok(unread.problems.some((p) => /on-chain seq was not read/.test(p)));
  assert.equal((await verifySeason(line, () => undefined, chain(1), {})).problems.length, 0);
});
