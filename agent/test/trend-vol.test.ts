// Trend and volatility ensemble: the rule's weights, its staked version, its published hash and a re-run of a tick.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type RuleInput } from "../src/strategies/rules.js";
import { decideStaked } from "../src/strategies/staked.js";
import { TREND_VOL, STAKED_TREND_VOL, trendVolPrompt } from "../src/strategies/trend-vol.js";
import { houseRule } from "../src/strategies/house.js";
import { publishedByHash } from "../src/strategies/registry.js";
import { houseRerun } from "../src/strategies/rerun.js";
import { tick } from "../src/arena.js";
import { classify, eventsFromLogs, type Vault, type TxResult } from "../src/vault.js";
import { NETWORKS } from "../src/config.js";
import type { Candle } from "../src/strategies/market.js";

const DAY = 86_400_000, T0 = Date.UTC(2026, 8, 1);
const W = "wrap.near", U = "usdc", S = "meta-pool.near";
const series = (f: (i: number) => number, n = 60): Candle[] =>
  Array.from({ length: n }, (_, i) => { const p = f(i); return [T0 + i * DAY, String(p * 1.002), String(p * 0.998), String(p)]; });
const input = (candles: Candle[], near = 0, usdc = 100): RuleInput => ({
  vault: { base: W, quote: U, balances: { [W]: String(near), [U]: String(usdc) },
    policy: { tokens: [W, U].map((token) => ({ token, max_per_trade: "1000", max_per_day: "1000" })) }, usage: { spent_24h: {} } },
  market: { candles },
});
const target = (c: Candle[], w = 0) => TREND_VOL.target(input(c), w, TREND_VOL);

test("trend-vol: a calm uptrend goes to the top of the range, a downtrend to the floor, volatility scales it down", () => {
  const calmUp = series((i) => 3 * 1.002 ** i);
  assert.ok(Math.abs((target(calmUp) as number) - 0.75) < 1e-9, "calm uptrend: 75%");
  assert.equal(target(series((i) => 3 * 0.998 ** i)), 0.2, "downtrend: the 20% floor");
  // A choppy uptrend: every channel up, but realised volatility far above 40% cuts the trend part.
  const wild = target(series((i) => 3 * 1.002 ** i * (i % 2 ? 1.08 : 0.94)));
  assert.ok(typeof wild === "number" && wild > 0.2 && wild < 0.5, String(wild));
  assert.equal(target(calmUp, 0.7), null, "within the 10-point band: no trade");
  assert.equal(target(calmUp.slice(-30)), "not_enough_history");
  assert.equal(decide(TREND_VOL, input(calmUp), "v").action, "buy");
});

test("trend-vol: the staked version stakes idle wNEAR and its spec pins the decision code", () => {
  const calmUp = series((i) => 3 * 1.002 ** i);
  const x = { ...input(calmUp, 30, 30), vault: { ...input(calmUp, 30, 30).vault, stake: S, stake_rate: "1.5",
    balances: { [W]: "30", [U]: "30", [S]: "0" }, policy: { tokens: [W, U, S].map((token) => ({ token, max_per_trade: "1000", max_per_day: "1000" })) } } };
  assert.equal(decideStaked(STAKED_TREND_VOL, x, "v").action, "stake");
  for (const staked of [false, true]) {
    const p = trendVolPrompt(staked), r = publishedByHash(p.sha256);
    assert.equal(r?.id, staked ? "stake-trend-vol" : "trend-vol");
    assert.equal(r?.staked, staked);
    assert.equal(houseRule(r!.id).prompt.sha256, p.sha256);
  }
});

test("trend-vol: a house tick's receipt re-runs to the same decision", async () => {
  const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.2.0", event, data: [data] })}`;
  const tx = (method: string, events: string[]) => async (): Promise<TxResult> => {
    const e = eventsFromLogs(events);
    return { tx: `tx-${method}`, ok: true, events: e, outcome: classify(e) };
  };
  const E24 = 10n ** 24n;
  const vault = {
    id: "tv.arena.sledgit.near", agentId: "agent.near", net: NETWORKS.mainnet, chainId: "mainnet",
    config: async () => ({ agent_id: "agent.near", frozen: false, seq: 1 }),
    policy: async () => ({ tokens: [{ token: W, max_per_trade: (100n * E24).toString(), max_per_day: (100n * E24).toString() },
      { token: NETWORKS.mainnet.quote, max_per_trade: "100000000", max_per_day: "100000000" }], pairs: [], max_trades_per_hour: 2, max_slippage_bps: 100 }),
    usage: async () => ({ hour: "1", trades: 0, spent: [] }), intents: async () => ({ open_intent: null }), inFlight: async () => null,
    decimals: async (t: string) => (t === W ? 24 : 6), balance: async (t: string) => (t === W ? 0n : 50_000_000n),
    preview: async () => ({ ok: true, pool_id: 4512, band_floor: "7" }),
    logSkip: tx("log_skip", [ev("skip", { seq: 2 })]),
    requestSwap: tx("request_swap", [ev("request", { seq: 2 }), ev("trade", { amount_out: "1", venue: "rhea" })]),
  } as unknown as Vault;
  const dir = mkdtempSync(join(tmpdir(), "it-tv-"));
  const rule = houseRule("trend-vol");
  const chain = { seq: 2, decisions_before: 1, requests: { buy: 0, sell: 0 }, last_request: null, slot: "x", off_schedule: false,
    slot_block: { height: 1, hash: "h", time_secs: 0 } };
  const r = await tick({ vault, model: rule.model(vault.id), prompt: rule.prompt,
    price: async () => ({ source: "t", symbol: "NEARUSDT", price: "3", fetched_at: "2026-11-01T00:30:00.000Z" }),
    market: async () => ({ source: "t", interval: "1d", candles: series((i) => 3 * 1.002 ** i), as_of: "x" }),
    chain: chain as never, historySize: 0, receiptsPath: join(dir, "receipts.jsonl"), outcomesPath: join(dir, "outcomes.jsonl"), dryRun: true });
  assert.equal(r.decision.action, "buy");
  const row = houseRerun(readFileSync(join(dir, "receipts.jsonl"), "utf8")).rows[0];
  assert.deepEqual([row.strategy, row.hash_match, row.same, row.decision_consistent], ["trend-vol", true, true, true]);
});
