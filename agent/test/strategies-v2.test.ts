// House strategies, version 2, and the Phase 3 review regressions (audits/phase-3-review.md). Offline: every network
// call goes to a fake fetch; no keys leave the temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { KeyPair } from "near-api-js";
import { decide, strategyById, strategyPrompt, RULES_SOURCE_SHA256, type RuleInput } from "../src/strategies/rules-v2.js";
import * as v1 from "../src/strategies/rules-v1.js";
import * as v3 from "../src/strategies/rules.js";
import { PUBLISHED, publishedByHash } from "../src/strategies/registry.js";
import { slotStart, slotBlock, checkSlotBlock, chainState, ARCHIVAL_RPC, type ChainState } from "../src/strategies/schedule.js";
import { houseRerun, houseCheck } from "../src/strategies/rerun.js";
import type { ChainDecision } from "../src/attest/chain.js";
import type { Candle } from "../src/strategies/market.js";
import { tick } from "../src/arena.js";
import { expectedDecision } from "../src/attest/pill.js";
import { main } from "../src/main.js";
import { canonical, sha256Hex } from "../src/receipt.js";
import { classify, eventsFromLogs, type Vault, type TxResult } from "../src/vault.js";
import { NETWORKS } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const W = "wrap.testnet";
const U = "usdc.itachicara.testnet";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 1);
const E24 = 10n ** 24n;
const VAULT = "house-luck.arena.irontrade.testnet";

const candles = (closes: number[]): Candle[] =>
  closes.map((c, i) => [T0 + i * DAY, (c * 1.01).toFixed(4), (c * 0.99).toFixed(4), c.toFixed(4)]);
const rise = (n: number) => Array.from({ length: n }, (_, i) => 2 + i * 0.02);

function chain(o: Partial<ChainState> = {}): ChainState {
  return { seq: 4, decisions_before: 3, requests: { buy: 0, sell: 0 }, last_request: null, slot: "2026-10-29T00:05:00.000Z",
    off_schedule: false, slot_block: { height: 100, hash: "SLOTHASH", time_secs: 0 }, ...o };
}

function input(o: { near?: string; usdc?: string; closes?: number[]; chain?: ChainState; perTradeUsdc?: string; perTradeNear?: string }): RuleInput {
  return {
    vault: {
      base: W, quote: U,
      balances: { [W]: o.near ?? "1", [U]: o.usdc ?? "0" },
      policy: { tokens: [{ token: W, max_per_trade: o.perTradeNear ?? "0.5", max_per_day: "300" }, { token: U, max_per_trade: o.perTradeUsdc ?? "1", max_per_day: "500" }] },
      usage: { spent_24h: {} },
    },
    market: { candles: candles(o.closes ?? rise(60)) },
    chain: o.chain ?? chain(),
  };
}

// ---------------------------------------------------------------- P3-1 luck

test("P3-1: the luck draw ignores when the tick is sent and any local history; only seq and the slot block hash move it", () => {
  const s = strategyById("luck");
  const base = input({ near: "1", usdc: "2" });
  const ref = JSON.stringify(decide(s, base, VAULT));
  // The reviewer's grind: 1000 different send times (the old seed's last-decision ms) and as_of hours.
  for (let ms = 0; ms < 1000; ms++) {
    const x = { ...base, market: { ...base.market!, as_of: new Date(T0 + ms).toISOString() }, history: [{ ts: new Date(T0 + ms).toISOString() }] };
    assert.equal(JSON.stringify(decide(s, x as RuleInput, VAULT)), ref, `send time ${ms} ms changed the draw`);
  }
  // The draw does follow the chain: across slot block hashes, both trades and no-trades occur.
  const reasons = new Set<string>();
  for (let i = 0; i < 64; i++) reasons.add(decide(s, input({ near: "1", usdc: "2", chain: chain({ slot_block: { height: 1, hash: `B${i}`, time_secs: 0 } }) }), VAULT).action);
  assert.ok(reasons.has("hold") && reasons.size > 1, "slot block hash drives the draw");
  // No chain state, no luck: a receipt can't drop the chain inputs to fall back to something guessable.
  assert.equal(decide(s, { ...base, chain: undefined }, VAULT).reason, "no_chain_state");
});

/** A fake archival chain: one block per second, height 1000 at `startSecs`; heights listed in `skip` don't exist. */
function fakeArchival(startSecs: number, head: number, skip: Set<number> = new Set()) {
  const block = (h: number) => (skip.has(h) || h < 1 || h > head ? null : { height: h, hash: `h${h}`, timestamp: String((startSecs + (h - 1000)) * 1e9) });
  const f = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), ARCHIVAL_RPC.testnet);
    const p = (JSON.parse(String(init?.body)) as { params: { block_id?: number; finality?: string } }).params;
    const b = p.finality ? block(head) : block(p.block_id!);
    const body = b ? { result: { header: b } } : { error: { cause: { name: "UNKNOWN_BLOCK" } } };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return f;
}

test("P3-1: the slot block is the first block at or after the slot, and a future slot can't be looked up (no peeking)", async () => {
  const start = Math.floor(Date.UTC(2026, 9, 29, 0, 0) / 1000); // height 1000 at 00:00:00
  const slot = Date.UTC(2026, 9, 29, 0, 5);                       // 300 s later: height 1300
  const f = fakeArchival(start, 1000 + 20_000, new Set([1300, 1301])); // the exact heights are skipped
  const b = await slotBlock("testnet", slot, f);
  assert.equal(b.height, 1302);
  assert.equal(await checkSlotBlock("testnet", slot, b, f), null);
  assert.match(String(await checkSlotBlock("testnet", slot, { ...b, hash: "forged" }, f)), /hash differs/);
  assert.match(String(await checkSlotBlock("testnet", slot, { height: 1310, hash: "h1310", time_secs: 0 }, f)), /earlier block/);
  // Before the slot is final there is no slot block, so a dry run can't show a future draw.
  await assert.rejects(slotBlock("testnet", slot, fakeArchival(start, 1200)), /not final yet/);
});

// ---------------------------------------------------------------- P3-2 schedule

const decision = (seq: number, t: number, o: Partial<ChainDecision> = {}): ChainDecision =>
  ({ seq, event: "skip", receipt_hash: `r${seq}`, tx: `t${seq}`, block_time_secs: Math.floor(t / 1000), ...o });

test("P3-2: one tick per daily slot inside the window; anything else is off schedule; history must be complete", async () => {
  const slot = Date.UTC(2026, 9, 29, 0, 5);
  assert.equal(slotStart(slot + 3_600_000), slot);
  assert.equal(slotStart(slot - 1), slot - DAY);
  const f = fakeArchival(Math.floor(Date.UTC(2026, 9, 28) / 1000), 1000 + 200_000);
  const prior = [decision(1, slot - DAY + 60_000)];
  const on = await chainState("testnet", VAULT, W, 1, slot + 600_000, f, prior);
  assert.equal(on.off_schedule, false);
  assert.equal(on.seq, 2);
  assert.equal(on.slot, new Date(slot).toISOString());
  assert.equal((await chainState("testnet", VAULT, W, 1, slot + 3 * 3_600_000, f, prior)).off_schedule, true, "after the window");
  const twice = [...prior, decision(2, slot + 60_000)];
  assert.equal((await chainState("testnet", VAULT, W, 2, slot + 600_000, f, twice)).off_schedule, true, "second tick in a slot");
  await assert.rejects(chainState("testnet", VAULT, W, 5, slot + 600_000, f, prior), /history incomplete/);
});

// ---------------------------------------------------------------- P3-5 hold, P3-6 breakout

test("P3-5: hold trades once, judged from on-chain requests; skips never re-open it", () => {
  const s = strategyById("hold");
  const first = decide(s, input({ near: "1", usdc: "0", chain: chain({ decisions_before: 0 }) }), VAULT);
  assert.equal(first.action, "sell");
  // The reviewer's case: one trade then five skips. The trade is still on chain, so hold stays put.
  const after = chain({ decisions_before: 6, requests: { buy: 0, sell: 1 }, last_request: { seq: 1, side: "sell" } });
  assert.equal(decide(s, input({ near: "1", usdc: "0", chain: after }), VAULT).reason, "no_signal");
});

test("P3-6: breakout keeps buying toward all NEAR across capped ticks until it gets there", () => {
  const s = strategyById("breakout");
  const flat = Array.from({ length: 60 }, () => 2);
  const breakoutDay = [...flat.slice(0, 59), 2.5];            // close above the prior 55-day high
  const after = [...flat.slice(0, 59), 2.3];                 // no new signal the following days
  let near = 0, usdc = 10, ch = chain({ decisions_before: 0 });
  for (let day = 0; day < 30; day++) {
    const closes = day === 0 ? breakoutDay : after;
    const p = closes[closes.length - 1];
    const d = decide(s, input({ near: String(near), usdc: String(usdc), closes, chain: ch, perTradeUsdc: "1" }), VAULT);
    if (d.action === "hold") break;
    assert.equal(d.action, "buy");
    usdc -= Number(d.amount_in); near += Number(d.amount_in) / p;
    ch = chain({ decisions_before: day + 1, requests: { buy: day + 1, sell: 0 }, last_request: { seq: day + 1, side: "buy" } });
  }
  const w = (near * 2.3) / (near * 2.3 + usdc);
  assert.ok(w > 0.97, `reached ${w.toFixed(3)} NEAR weight (v1 stopped near 0.6)`);
  // An exit close flips it to selling even while "in".
  const exit = [...flat.slice(0, 59), 1.5];
  assert.equal(decide(s, input({ near: "4", usdc: "0", closes: exit, chain: ch, perTradeNear: "1" }), VAULT).action, "sell");
});

// ---------------------------------------------------------------- P3-7 hashes and published specs

test("P3-7: the v2 source hash ignores CRLF; every published version and spec file is accounted for", () => {
  const src = readFileSync(join(HERE, "..", "src", "strategies", "rules-v2.ts"), "utf8");
  const crlf = src.replace(/\n/g, "\r\n");
  assert.equal(createHash("sha256").update(crlf.replace(/\r\n/g, "\n")).digest("hex"), RULES_SOURCE_SHA256);
  // The frozen v1 file still hashes to the value the 9 published receipts recorded.
  assert.equal(v1.RULES_SOURCE_SHA256, "791d8bc5cf9b1f0535850732de93a868d3eb63a8cdba3260a9977853391eb4da");
  for (const s of ["rebalancer", "trend", "luck"]) {
    const line = readFileSync(join(REPO, "deploy", "testnet", "receipts-house", s, "receipts.jsonl"), "utf8").split("\n")[0];
    const p = publishedByHash(JSON.parse(line).prompt_sha256);
    assert.equal(p?.version, 1, `${s}: first receipt is a published v1 hash`);
  }
  // deploy/testnet/receipts-house/specs/<hash>.json holds the exact canonical spec of every published version.
  const dir = join(REPO, "deploy", "testnet", "receipts-house", "specs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const p of PUBLISHED) {
    const text = readFileSync(join(dir, `${p.hash}.json`), "utf8");
    assert.equal(sha256Hex(text), p.hash, `${p.id} v${p.version}`);
    assert.equal(text, canonical(p.spec));
  }
  assert.equal(files.length, PUBLISHED.length, "no stray spec files");
  assert.equal(strategyPrompt(strategyById("luck")).sha256, PUBLISHED.find((p) => p.id === "luck" && p.version === 2)!.hash);
});

// ---------------------------------------------------------------- P3-12 robustness

test("P3-12: an unknown strategy or hash is a failing row, not a crash; non-rules lines are counted", () => {
  const ok = { vault: VAULT, network: "testnet", model: { provider: "rules", id: "nope" }, prompt_sha256: "0".repeat(64), model_output: "{}", inputs: {} };
  const llm = { ...ok, model: { provider: "anthropic", id: "x" } };
  const { rows, skipped } = houseRerun(`${JSON.stringify(ok)}\n${JSON.stringify(llm)}\nnot json\n`);
  assert.equal(skipped, 1);
  assert.equal(rows.length, 2);
  assert.match(String(rows[0].error), /not a published version/);
  assert.match(String(rows[1].error), /unparseable/);
});

// ---------------------------------------------------------------- house command: schedule gate, flags, chain inputs

function fakeVault(seq = 3) {
  const calls: string[] = [];
  const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.1.0", event, data: [data] })}`;
  const tx = (method: string, events: string[]) => async (): Promise<TxResult> => {
    calls.push(method);
    const e = eventsFromLogs(events);
    return { tx: `tx-${method}`, ok: true, events: e, outcome: classify(e) };
  };
  const v = {
    id: VAULT, agentId: "agent.testnet", net: NETWORKS.testnet, chainId: "testnet",
    assertChain: async () => undefined, useKey: () => undefined, assertAgent: async () => undefined, checkAccessKey: async () => ({ kind: "function_call", warnings: [] }),
    config: async () => ({ agent_id: "agent.testnet", frozen: false, seq }),
    policy: async () => ({ tokens: [{ token: W, max_per_trade: (E24 / 2n).toString(), max_per_day: (3n * E24).toString() },
      { token: U, max_per_trade: E24.toString(), max_per_day: (5n * E24).toString() }],
    pairs: [{ token_in: W, token_out: U, pool_id: 1103, min_price_num: "14", min_price_den: "10" }], max_trades_per_hour: 12, max_slippage_bps: 100 }),
    usage: async () => ({ hour: "1", trades: 0, spent: [] }),
    intents: async () => ({ open_intent: null }), inFlight: async () => null, decimals: async () => 24,
    balance: async (t: string) => (t === W ? E24 / 2n : E24),
    preview: async () => ({ ok: true, pool_id: 1103, band_floor: "7" }),
    logSkip: tx("log_skip", [ev("skip", { seq: seq + 1 })]),
    requestSwap: tx("request_swap", [ev("request", { seq: seq + 1 }), ev("trade", { amount_out: "100", venue: "rhea" })]),
  };
  return { vault: v as unknown as Vault, calls };
}

async function runHouse(argv: string[], off: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "it-house2-"));
  const key = join(dir, "agent.json");
  writeFileSync(key, JSON.stringify({ account_id: "agent.testnet", secret_key: KeyPair.fromRandom("ed25519").toString() }));
  chmodSync(key, 0o600);
  const { vault, calls } = fakeVault();
  const logs: string[] = [];
  const warns: string[] = [];
  const code = await main([...argv, "--receipts", dir], {
    env: { SLEDGIT_KEY_FILE: key, SLEDGIT_VAULT: VAULT }, log: (s) => logs.push(s), warn: (s) => warns.push(s),
    makeVault: () => vault, sleep: async () => undefined, now: () => Date.UTC(2026, 9, 29, 7, 0),
    provenance: async () => ({ sledgit_vault: true, status: "genuine" as const, reason: "test" }),
    price: async () => ({ source: "t", symbol: "NEARUSDT", price: "2.5", fetched_at: "2026-10-29T07:00:00.000Z" }),
    market: async () => ({ source: "t", interval: "1d", candles: candles(rise(60)), as_of: "x" }),
    chainState: async () => chain({ seq: 4, off_schedule: off }),
  });
  return { code, calls, warns: warns.join("\n"), dir };
}

test("P3-2/P3-17: house refuses off-schedule ticks unless asked, records the flag, and takes no prompt/harness/attest", async () => {
  const refused = await runHouse(["house", "--strategy", "luck"], true);
  assert.equal(refused.code, 1);
  assert.match(refused.warns, /off schedule/);
  assert.deepEqual(refused.calls, [], "nothing sent");

  const forced = await runHouse(["house", "--strategy", "luck", "--off-schedule"], true);
  assert.equal(forced.code, 0);
  const r = JSON.parse(readFileSync(join(forced.dir, "receipts.jsonl"), "utf8").trim());
  assert.equal(r.inputs.chain.off_schedule, true);
  assert.deepEqual(r.inputs.history, [], "house rules get no local history");
  assert.equal(r.prompt_sha256, v3.strategyPrompt(v3.strategyById("luck")).sha256);

  for (const extra of [["--harness", "x"], ["--prompt", "p.md"], ["--attest", "tee"], ["--model", "m"]]) {
    await assert.rejects(runHouse(["house", "--strategy", "luck", ...extra], false), /house takes no/);
  }
});

// ---------------------------------------------------------------- P3-3 / P3-4 / attack 6: houseCheck

/** fetch for houseCheck: Binance klines (the given daily candles; a wide 1m bar), provenance RPC, archival blocks. */
function worldFetch(daily: Candle[], slotSecs: number) {
  const arch = fakeArchival(slotSecs - 300, 1000 + 400_000);
  const view = (m: string) => {
    const cfg = { exchange_id: "ref-finance-101.testnet", intents_id: "it1793205011-intents.testnet", mpc_id: "v1.signer-prod.testnet" };
    return m === "get_config" ? cfg : {};
  };
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(ARCHIVAL_RPC.testnet)) return arch(url, init);
    if (u.includes("/api/v3/klines")) {
      const q = new URL(u).searchParams;
      if (q.get("interval") === "1m") return new Response(JSON.stringify([[Number(q.get("startTime")), "1", "100", "0.01", "2", "0"]]));
      const from = Number(q.get("startTime"));
      return new Response(JSON.stringify(daily.filter((c) => c[0] >= from).map((c) => [c[0], "0", c[1], c[2], c[3], "0", c[0] + DAY - 1])));
    }
    const body = JSON.parse(String(init?.body)) as { params: { request_type: string; account_id: string; method_name?: string } };
    const p = body.params;
    if (p.request_type === "view_account") return new Response(JSON.stringify({ result: { global_contract_hash: "5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ" } }));
    if (p.request_type === "view_access_key_list") return new Response(JSON.stringify({ result: { keys: [] } }));
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(view(p.method_name!)))] } }));
  }) as typeof fetch;
}

async function sealedV2(off = false) {
  const slot = Date.UTC(2026, 9, 29, 0, 5);
  const f = worldFetch(candles(rise(60)), Math.floor(slot / 1000));
  const sb = await slotBlock("testnet", slot, f);
  const { vault } = fakeVault(3);
  const dir = mkdtempSync(join(tmpdir(), "it-check-"));
  const s = strategyById("luck");
  const { rulesModel } = await import("../src/strategies/rules.js");
  const ch = chain({ seq: 4, decisions_before: 3, requests: { buy: 0, sell: 1 }, last_request: { seq: 2, side: "sell" },
    slot: new Date(slot).toISOString(), off_schedule: off, slot_block: sb });
  await tick({ vault, model: rulesModel(s, VAULT), prompt: strategyPrompt(s),
    price: async () => ({ source: "t", symbol: "NEARUSDT", price: "2.5", fetched_at: "2026-10-29T00:30:00.000Z" }),
    market: async () => ({ source: "t", interval: "1d", candles: candles(rise(60)), as_of: "x" }),
    chain: ch as never, historySize: 0, receiptsPath: join(dir, "receipts.jsonl"), outcomesPath: join(dir, "outcomes.jsonl"), dryRun: true });
  const line = readFileSync(join(dir, "receipts.jsonl"), "utf8").trim();
  const prior: ChainDecision[] = [decision(1, slot - 2 * DAY), decision(2, slot - DAY, { event: "request", token_in: W }), decision(3, slot - DAY + 3_600_000)];
  const decisions = (h: string) => async () => [...prior, decision(4, slot + 25 * 60_000, { receipt_hash: h })];
  return { line, f, decisions, slot };
}

/** The chain at the decision's transaction block, as the genuine receipt recorded it (R3-03's archival read, faked). */
function world(genuineLine: string) {
  const raw = (JSON.parse(genuineLine) as { inputs: { raw: { config: unknown; policy: unknown; usage: unknown; balances: Record<string, string> } } }).inputs.raw;
  return { stateAt: async () => ({ config: raw.config, policy: raw.policy, usage: raw.usage, balances: raw.balances }) as never, txBlock: async () => 100 };
}

/** Re-decide a forged receipt so its decision is what its (new) output says. */
function redecide(r: { inputs: Record<string, unknown>; model_output: string; network: string; decision: unknown }) {
  r.model_output = JSON.stringify(decide(strategyById("luck"), (({ raw: _r, ...x }) => x)(r.inputs) as never, VAULT));
  r.decision = expectedDecision({ model_output: r.model_output, network: r.network as never });
}

test("P3-3: house-rerun --check passes a genuine v2 receipt and catches forged candles, balances and chain state", async () => {
  const { line, f, decisions } = await sealedV2();
  const good = await houseCheck(line, "testnet", { ...world(line), fetch: f, decisions: decisions(sha256Hex(line)) });
  assert.equal(good.length, 1);
  assert.deepEqual(good[0].problems, []);
  assert.equal(good[0].pass, true);

  // Attack 1: forge the candles and the output. Re-run alone agrees; the check sees the feed disagree.
  const forged = JSON.parse(line);
  forged.inputs.market.candles[59][3] = "9.9999";
  const fl = canonical(forged);
  const r1 = (await houseCheck(fl, "testnet", { ...world(line), fetch: f, decisions: decisions(sha256Hex(fl)) }))[0];
  assert.equal(r1.candles_match, false);
  assert.equal(r1.pass, false);

  // Attack 6: human balances that don't match the raw chain balances in the same receipt.
  const b6 = JSON.parse(line);
  b6.inputs.vault.balances[W] = "99";
  const l6 = canonical(b6);
  redecide(b6);
  const l6b = canonical(b6);
  const r6 = (await houseCheck(l6b, "testnet", { ...world(line), fetch: f, decisions: decisions(sha256Hex(l6b)) }))[0];
  assert.equal(r6.balances_match_raw, false, l6.length ? "balances checked against raw" : "");
  assert.equal(r6.pass, false);

  // P3-4: a receipt claiming different history than the chain fails.
  const h = JSON.parse(line);
  h.inputs.chain.requests = { buy: 0, sell: 0 };
  h.inputs.chain.last_request = null;
  redecide(h);
  const lh = canonical(h);
  const rh = (await houseCheck(lh, "testnet", { ...world(line), fetch: f, decisions: decisions(sha256Hex(lh)) }))[0];
  assert.equal(rh.chain_inputs_match, false);

  // Not the vault's own decision at all.
  const none = (await houseCheck(line, "testnet", { ...world(line), fetch: f, decisions: async () => [] }))[0];
  assert.equal(none.on_chain, false);
  assert.equal(none.pass, false);
});

test("P3-2: a receipt that claims on-schedule but landed after the window fails the check", async () => {
  const { line, f, slot } = await sealedV2(false);
  const late = async () => [decision(1, slot - 2 * DAY), decision(2, slot - DAY, { event: "request", token_in: W }),
    decision(3, slot - DAY + 3_600_000), decision(4, slot + 5 * 3_600_000, { receipt_hash: sha256Hex(line) })];
  const r = (await houseCheck(line, "testnet", { ...world(line), fetch: f, decisions: late }))[0];
  assert.equal(r.off_schedule, true);
  assert.ok(r.problems.some((p) => /off schedule/.test(p)));
});

test("P3-4 (v1): a v1 receipt whose local history disagrees with the chain fails the check", async () => {
  const line = readFileSync(join(REPO, "deploy", "testnet", "receipts-house", "rebalancer", "receipts.jsonl"), "utf8").split("\n")[1];
  const r = JSON.parse(line);
  const daily = r.inputs.market.candles as Candle[];
  const f = worldFetch(daily, Math.floor(Date.UTC(2026, 9, 29, 0, 5) / 1000));
  const h = sha256Hex(line);
  // The chain says the earlier decision was a skip, but the receipt's history says it traded.
  const bad = (await houseCheck(line, "testnet", { ...world(line), fetch: f, decisions: async () => [decision(1, Date.parse(r.ts) - 60_000), decision(2, Date.parse(r.ts), { receipt_hash: h })] }))[0];
  assert.equal(bad.local_history_matches_chain, false);
  assert.equal(bad.pass, false);
});
