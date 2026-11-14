// House strategies, version 1 (frozen in rules-v1.ts; the 9 published receipts use it): offline, no network, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, strategyById, strategyPrompt, spec, rulesModel, STRATEGIES, RULES_SOURCE_SHA256, type RuleInput } from "../src/strategies/rules-v1.js";
import { checkCandles, type Candle } from "../src/strategies/market.js";
import { hold5050, stakeHold, STAKE_APR } from "../src/strategies/benchmarks.js";
import { classify, eventsFromLogs, type Vault, type TxResult } from "../src/vault.js";
import { NETWORKS } from "../src/config.js";
import { tick } from "../src/arena.js";
import { houseRerun } from "../src/main.js";
import { sha256Hex } from "../src/receipt.js";

const W = "wrap.testnet";
const U = "usdc.itachicara.testnet";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 1);

/** n daily candles with these closes; high/low ±1%. */
const candles = (closes: number[]): Candle[] =>
  closes.map((c, i) => [T0 + i * DAY, (c * 1.01).toFixed(4), (c * 0.99).toFixed(4), c.toFixed(4)]);

function input(o: { price?: string; near?: string; usdc?: string; closes?: number[]; traded?: boolean; spentNear?: string; asOf?: string }): RuleInput {
  return {
    reference_price: o.price === undefined ? { price: "2.5" } : { price: o.price },
    vault: {
      base: W, quote: U,
      balances: { [W]: o.near ?? "1", [U]: o.usdc ?? "0" },
      policy: { tokens: [{ token: W, max_per_trade: "0.5", max_per_day: "3" }, { token: U, max_per_trade: "1", max_per_day: "5" }] },
      usage: { spent_24h: o.spentNear ? { [W]: o.spentNear } : {} },
    },
    history: o.traded ? [{ outcome: { status: "traded" } }] : [],
    market: { candles: candles(o.closes ?? []), as_of: o.asOf ?? "2026-10-29T12:00:00.000Z" },
  };
}

const rise = (n: number) => Array.from({ length: n }, (_, i) => 2 + i * 0.02);
const fall = (n: number) => Array.from({ length: n }, (_, i) => 4 - i * 0.02);

test("rebalancer: all NEAR drifts past 10 points, so it sells toward 50/50, clipped to the per-trade cap", () => {
  const d = decide(strategyById("rebalancer"), input({ near: "1", usdc: "0" }), "v");
  assert.equal(d.action, "sell");
  assert.equal(d.amount_in, "0.5", "wants 0.5 of 1 NEAR, cap is 0.5");
  assert.equal(decide(strategyById("rebalancer"), input({ near: "1", usdc: "2.5" }), "v").reason, "no_signal", "exactly 50/50");
});

test("rebalancer: from all USDC it buys, capped by the USDC per-trade cap", () => {
  const d = decide(strategyById("rebalancer"), input({ near: "0", usdc: "4" }), "v");
  assert.deepEqual([d.action, d.amount_in], ["buy", "1"]);
});

test("caps: the rolling 24 h room bounds the size, and a used-up cap holds", () => {
  assert.equal(decide(strategyById("rebalancer"), input({ near: "1", spentNear: "2.8" }), "v").amount_in, "0.2");
  assert.equal(decide(strategyById("rebalancer"), input({ near: "1", spentNear: "3" }), "v").reason, "cap_or_balance_empty");
});

test("trend: above the 50-day average goes all NEAR, below goes all USDC, short history holds", () => {
  const t = strategyById("trend");
  assert.deepEqual(decide(t, input({ near: "0", usdc: "1", closes: rise(60) }), "v").action, "buy");
  assert.deepEqual(decide(t, input({ near: "1", usdc: "0", closes: fall(60) }), "v").action, "sell");
  assert.equal(decide(t, input({ near: "1", usdc: "0", closes: rise(60) }), "v").reason, "at_target");
  assert.equal(decide(t, input({ closes: rise(10) }), "v").reason, "not_enough_history");
});

test("breakout: enters on a new 55-day high, exits on a new 20-day low, otherwise no change", () => {
  const b = strategyById("breakout");
  const flat = Array(60).fill(3);
  assert.equal(decide(b, input({ near: "0", usdc: "1", closes: [...flat.slice(0, 59), 3.5] }), "v").action, "buy");
  assert.equal(decide(b, input({ near: "1", usdc: "0", closes: [...flat.slice(0, 59), 2.5] }), "v").action, "sell");
  assert.equal(decide(b, input({ near: "1", usdc: "0", closes: flat }), "v").reason, "no_signal");
});

test("hold: one move to 50/50, then never trades", () => {
  const h = strategyById("hold");
  assert.equal(decide(h, input({ near: "1" }), "v").action, "sell");
  assert.equal(decide(h, input({ near: "1", traded: true }), "v").reason, "no_signal");
});

test("luck: the same seed (vault, hour) gives the same decision; different hours differ in aggregate", () => {
  const l = strategyById("luck");
  const x = input({ near: "1", usdc: "2" });
  assert.deepEqual(decide(l, x, "a.testnet"), decide(l, x, "a.testnet"));
  let trades = 0;
  for (let h = 0; h < 400; h++) {
    const d = decide(l, input({ near: "1", usdc: "2", asOf: new Date(T0 + h * 3_600_000).toISOString() }), "a.testnet");
    if (d.action !== "hold") {
      trades++;
      assert.ok(Number(d.amount_in) <= (d.action === "sell" ? 0.5 : 1), "never above the cap");
    }
  }
  assert.ok(trades > 60 && trades < 140, `about a quarter of ticks trade, got ${trades}/400`);
});

test("no price or an empty vault holds without trading", () => {
  const r = strategyById("rebalancer");
  assert.equal(decide(r, { ...input({}), reference_price: null }, "v").reason, "no_price");
  assert.equal(decide(r, input({ near: "0", usdc: "0" }), "v").reason, "empty_vault");
});

test("strategy hash: stable, distinct per strategy, and covers this rules file", () => {
  const hashes = STRATEGIES.map((s) => strategyPrompt(s).sha256);
  assert.equal(new Set(hashes).size, STRATEGIES.length);
  assert.equal(strategyPrompt(strategyById("trend")).sha256, strategyPrompt(strategyById("trend")).sha256);
  assert.equal((spec(strategyById("trend")) as { source_sha256: string }).source_sha256, RULES_SOURCE_SHA256);
  assert.match(RULES_SOURCE_SHA256, /^[0-9a-f]{64}$/);
});

test("rules model: same input, same output; output is a valid decision", async () => {
  const m = rulesModel(strategyById("rebalancer"), "v");
  const user = JSON.stringify(input({ near: "1" }));
  assert.equal(await m.complete("", user), await m.complete("", user));
  assert.deepEqual(JSON.parse(await m.complete("", user)), { action: "sell", amount_in: "0.5", reason: "rebalancer: target 0.5 from 1.000" });
});

test("candles: open bars are dropped; gaps and bad prices are rejected", () => {
  const k = (t: number, c: string, closeT = t + DAY - 1) => [t, "1", c, c, c, "0", closeT];
  const now = T0 + 2 * DAY + 5;
  assert.equal(checkCandles([k(T0, "2"), k(T0 + DAY, "2.1"), k(T0 + 2 * DAY, "2.2")], now).length, 2);
  assert.throws(() => checkCandles([k(T0, "2"), k(T0 + 2 * DAY, "2.1")], now + DAY), /consecutive/);
  assert.throws(() => checkCandles([k(T0, "1e9")], now), /plain decimal/);
});

test("benchmarks: hold tracks half the price move; stake & hold adds the APR on the NEAR half", () => {
  const closes: [number, number][] = [[T0, 2], [T0 + 365 * DAY, 4]];
  assert.equal(hold5050(100, closes)[1].value, 150);
  const s = stakeHold(100, closes)[1].value;
  assert.ok(Math.abs(s - (50 + 25 * (1 + STAKE_APR / 365) ** 365 * 4)) < 1e-9);
  assert.ok(stakeHold(100, [[T0, 2], [T0 + DAY, 2]])[1].value > 100, "flat price: staking still earns");
});

// ---------------------------------------------------------------- full tick + re-run

const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.1.0", event, data: [data] })}`;
const E24 = 10n ** 24n;

function fakeVault() {
  const calls: string[] = [];
  const tx = (method: string, events: string[]) => async (): Promise<TxResult> => {
    calls.push(method);
    const e = eventsFromLogs(events);
    return { tx: `tx-${method}`, ok: true, events: e, outcome: classify(e) };
  };
  const v = {
    id: "house-rebalancer.arena.irontrade.testnet", agentId: "agent.testnet", net: NETWORKS.testnet,
    config: async () => ({ agent_id: "agent.testnet", frozen: false, seq: 1 }),
    policy: async () => ({ tokens: [{ token: W, max_per_trade: (E24 / 2n).toString(), max_per_day: (3n * E24).toString() }],
      pairs: [{ token_in: W, token_out: U, pool_id: 1103, min_price_num: "14", min_price_den: "10" }], max_trades_per_hour: 12, max_slippage_bps: 100 }),
    usage: async () => ({ hour: "1", trades: 0, spent: [] }),
    intents: async () => ({ open_intent: null }),
    inFlight: async () => null,
    decimals: async () => 24,
    balance: async (t: string) => (t === W ? E24 / 2n : 0n),
    preview: async () => ({ ok: true, pool_id: 1103, band_floor: "7" }),
    logSkip: tx("log_skip", [ev("skip", {})]),
    requestSwap: tx("request_swap", [ev("request", {}), ev("trade", { amount_out: "100", venue: "rhea" })]),
  };
  return { vault: v as unknown as Vault, calls };
}

test("house tick: rules decision is sealed with the strategy hash, sent, and re-runs to the same decision", async () => {
  const s = strategyById("rebalancer");
  const { vault, calls } = fakeVault();
  const dir = mkdtempSync(join(tmpdir(), "it-house-"));
  const receiptsPath = join(dir, "receipts.jsonl");
  const r = await tick({ vault, model: rulesModel(s, vault.id), prompt: strategyPrompt(s),
    price: async () => ({ source: "t", symbol: "NEARUSDT", price: "2.5", fetched_at: "t" }),
    market: async () => ({ source: "t", interval: "1d", candles: candles(rise(60)), as_of: "2026-10-29T12:00:00.000Z" }),
    receiptsPath, outcomesPath: join(dir, "outcomes.jsonl") });
  assert.deepEqual(calls, ["request_swap"]);
  assert.equal(r.decision.action, "sell");
  assert.equal(r.decision.amount_in, "0.25", "0.5 NEAR all on one side: sell half");
  const line = readFileSync(receiptsPath, "utf8").trim();
  const receipt = JSON.parse(line);
  assert.equal(receipt.prompt_sha256, strategyPrompt(s).sha256);
  assert.deepEqual(receipt.model, { provider: "rules", id: "rebalancer" });
  assert.equal(receipt.inputs.market.candles.length, 60);
  assert.deepEqual(houseRerun(line), [{ receipt: sha256Hex(line), strategy: "rebalancer", version: 1, hash_match: true, same: true, decision_consistent: true }]);

  // A receipt whose recorded decision was edited no longer re-runs to itself.
  const forged = JSON.parse(line);
  forged.model_output = forged.model_output.replace("0.25", "0.5");
  writeFileSync(join(dir, "forged.jsonl"), JSON.stringify(forged));
  assert.equal(houseRerun(JSON.stringify(forged))[0].same, false);
  // And a receipt claiming a different strategy version fails the hash check.
  const other = JSON.parse(line);
  other.prompt_sha256 = "0".repeat(64);
  assert.equal(houseRerun(JSON.stringify(other))[0].hash_match, false);
});
