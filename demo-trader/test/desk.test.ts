import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { desk, PARAMS, type Candle, type DeskInput, type KronosSignal } from "../src/roles.js";
import { deskModel, modelId, HARNESS } from "../src/model.js";
import { checkHourly } from "../src/market.js";
import { checkSpec, PROMPT } from "../src/cli.js";
import { parseDecision } from "../../agent/src/decision.js";
import { tick } from "../../agent/src/arena.js";
import { NETWORKS } from "../../agent/src/config.js";
import type { Vault, TxResult } from "../../agent/src/vault.js";
import type { Json } from "../../agent/src/receipt.js";

const W = "wrap.testnet", U = "usdc.itachicara.testnet";
const DAY = 86_400_000;

/** 60 daily candles ending at `last`, rising (slope > 0) or falling (slope < 0). */
function candles(slope: number, last = 2.5): Candle[] {
  return Array.from({ length: 60 }, (_, i) => {
    const c = (last - slope * (59 - i)).toFixed(4);
    return [i * DAY, c, c, c] as Candle;
  });
}
const kronos = (up_share: number, change_pct: number): KronosSignal =>
  ({ last_close: 2.5, median_close: 2.5 * (1 + change_pct / 100), change_pct, up_share, paths: 8, pred_len: 24 });

function input(o: { slope?: number; nearBal?: string; usdcBal?: string; k?: KronosSignal | "unavailable"; trades?: number; spentNear?: string } = {}): DeskInput {
  return {
    reference_price: { price: "2.5" },
    vault: {
      base: W, quote: U, busy: false,
      balances: { [W]: o.nearBal ?? "1", [U]: o.usdcBal ?? "2.5" },
      policy: { tokens: [{ token: W, max_per_trade: "0.5", max_per_day: "3" }, { token: U, max_per_trade: "1", max_per_day: "5" }], max_trades_per_hour: 2 },
      usage: { trades_this_hour: o.trades ?? 0, spent_24h: o.spentNear ? { [W]: o.spentNear } : {} },
    },
    market: {
      daily: { candles: candles(o.slope ?? 0.01) },
      kronos: o.k === undefined ? { status: "off" } : o.k === "unavailable" ? { status: "unavailable", code: "timeout" } : { status: "ok", forecast: o.k },
    },
  };
}

test("analyst: an up trend tilts toward NEAR, a down trend toward USDC, within one step", () => {
  const up = desk(input({ slope: 0.01 }), false).decision;
  assert.equal(up.action, "buy");
  // 50/50 at $5; target 0.7 -> 0.2 * 5 = 1 USDC, capped by max_per_trade 1.
  assert.equal(up.amount_in, "1");
  const down = desk(input({ slope: -0.01 }), false).decision;
  assert.equal(down.action, "sell");
  assert.equal(down.amount_in, "0.4"); // 0.2 * $5 / $2.5
});

test("analyst: a mixed trend holds", () => {
  const x = input();
  x.market!.daily!.candles = candles(0.01).map((c, i) => (i === 59 ? [c[0], "1", "1", "1"] as Candle : c));
  assert.equal(desk(x, false).decision.action, "hold");
});

test("kronos: must agree with the trend, and its absence holds instead of trading without it", () => {
  assert.equal(desk(input({ slope: 0.01, k: kronos(0.75, 2) }), true).decision.action, "buy");
  assert.equal(desk(input({ slope: 0.01, k: kronos(0.25, -2) }), true).decision.action, "hold");
  assert.equal(desk(input({ slope: 0.01, k: kronos(0.75, 0.1) }), true).decision.action, "hold"); // move too small
  const off = desk(input({ slope: 0.01, k: "unavailable" }), true);
  assert.equal(off.decision.action, "hold");
  assert.match(off.decision.reason, /kronos_timeout/);
  assert.equal(desk(input({ slope: 0.01 }), true).decision.action, "hold"); // started with --kronos, no signal recorded
});

test("risk and budget: hourly limit, used caps, at target, and amounts within balance", () => {
  assert.match(desk(input({ trades: 2 }), false).decision.reason, /hourly_limit/);
  assert.match(desk(input({ slope: -0.01, spentNear: "3" }), false).decision.reason, /cap_used/);
  // Already at 0.7 NEAR: nothing to do on an up trend.
  assert.match(desk(input({ nearBal: "1.4", usdcBal: "1.5" }), false).decision.reason, /at_target/);
  const small = desk(input({ slope: -0.01, nearBal: "0.1", usdcBal: "4.75" }), false).decision;
  assert.equal(small.action, "hold"); // 5% NEAR already under the 0.3 target
  const d = desk(input({ slope: 0.01, nearBal: "0.1", usdcBal: "0.3" }), false).decision;
  assert.equal(d.action, "buy");
  assert.ok(Number(d.amount_in) <= 0.3);
});

test("every decision parses under the runner's own rules, reasons stay under 200 characters", async () => {
  for (const k of [false, true]) {
    for (const x of [input(), input({ slope: -0.01, k: kronos(0.1, -3) }), input({ k: "unavailable" }), input({ trades: 9 })]) {
      const out = await deskModel(k).complete("", JSON.stringify(x));
      const p = parseDecision(out);
      assert.ok(p.ok, out);
      assert.ok(JSON.parse(out).reason.length <= 200);
    }
  }
  assert.equal(deskModel(true).ref.id, modelId(true));
  assert.equal(deskModel(false).ref.provider, "iron-trader");
});

test("spec: the published prompt carries the running parameters; a changed parameter is refused", () => {
  const text = readFileSync(PROMPT, "utf8");
  checkSpec(text);
  assert.throws(() => checkSpec(text.replace(`"weight_up":${PARAMS.weight_up}`, `"weight_up":0.9`)), /PARAMS/);
});

test("hourly candles: open bars dropped, gaps and bad prices refused", () => {
  const H = 3_600_000;
  const k = (t: number) => [t, "2.5", "2.6", "2.4", "2.55", "1000.5", t + H - 1];
  assert.equal(checkHourly([k(0), k(H), k(2 * H)], 2 * H + 10).length, 2);
  assert.throws(() => checkHourly([k(0), k(2 * H)], 10 * H), /consecutive/);
  assert.throws(() => checkHourly([[0, "1e9", "1", "1", "1", "1", H - 1]], 10 * H), /plain decimal/);
});

/** Just enough vault for tick(): balances, policy and the two transaction kinds the broker uses. */
function fakeVault(previewOk: boolean) {
  const calls: string[] = [];
  const E24 = 10n ** 24n;
  const tx = (m: string) => async (): Promise<TxResult> => {
    calls.push(m);
    return { tx: `tx-${m}`, ok: true, events: [], outcome: { status: m === "log_skip" ? "skipped" : "requested" } } as unknown as TxResult;
  };
  const v = {
    id: "desk.arena2.irontrade.testnet", agentId: "agent.testnet", net: NETWORKS.testnet, chainId: "testnet",
    config: async () => ({ agent_id: "agent.testnet", frozen: false, seq: 1 }),
    policy: async () => ({ tokens: [{ token: W, max_per_trade: (E24 / 2n).toString(), max_per_day: (3n * E24).toString() },
      { token: U, max_per_trade: E24.toString(), max_per_day: (5n * E24).toString() }],
      pairs: [{ token_in: W, token_out: U, pool_id: 1103, min_price_num: "14", min_price_den: "10" }], max_trades_per_hour: 2, max_slippage_bps: 100 }),
    usage: async () => ({ hour: "1", trades: 0, spent: [] }),
    intents: async () => ({ open_intent: null }),
    inFlight: async () => null,
    decimals: async () => 24,
    balance: async (t: string) => (t === W ? E24 : (5n * E24) / 2n),
    preview: async () => { calls.push("preview"); return previewOk ? { ok: true, pool_id: 1103, band_floor: "7" } : { ok: false, code: "trade_cap", reason: "over the per-trade cap" }; },
    logSkip: tx("log_skip"), requestSwap: tx("request_swap"),
  };
  return { vault: v as unknown as Vault, calls };
}

async function runTick(slope: number, previewOk: boolean, k: Json) {
  const dir = mkdtempSync(join(tmpdir(), "demo-trader-"));
  const { vault, calls } = fakeVault(previewOk);
  const text = readFileSync(PROMPT, "utf8");
  const r = await tick({
    vault, model: deskModel(k !== null), prompt: { text, sha256: createHash("sha256").update(text).digest("hex"), path: PROMPT },
    price: async () => ({ source: "test", symbol: "NEARUSDT", price: "2.5", fetched_at: "t" }),
    market: async () => ({ daily: { candles: candles(slope) } as unknown as Json, kronos: k ?? { status: "off" } }),
    receiptsPath: join(dir, "receipts.jsonl"), outcomesPath: join(dir, "outcomes.jsonl"), harness: HARNESS,
  });
  const receipt = JSON.parse(readFileSync(join(dir, "receipts.jsonl"), "utf8").trim());
  return { r, calls, receipt };
}

test("broker: through the agent runner, a buy previews then requests; a refusal and a hold are skips with receipts", async () => {
  const buy = await runTick(0.01, true, null);
  assert.deepEqual(buy.calls, ["preview", "request_swap"]);
  assert.equal(buy.receipt.harness, HARNESS);
  assert.deepEqual(buy.receipt.model, { provider: "iron-trader", id: "iron-trader-v1" });
  assert.equal(buy.receipt.inputs.market.kronos.status, "off");

  const refused = await runTick(0.01, false, null);
  assert.deepEqual(refused.calls, ["preview", "log_skip"]);

  const k = { status: "ok", forecast: kronos(0.25, -2), input: { candles_sha256: "ab" } } as unknown as Json;
  const held = await runTick(0.01, true, k); // trend up, Kronos down: disagree
  assert.deepEqual(held.calls, ["log_skip"]);
  assert.equal(held.receipt.model.id, "iron-trader-v1+kronos-small");
  assert.equal(held.receipt.inputs.market.kronos.input.candles_sha256, "ab");
  assert.match(held.receipt.decision.reason, /kronos 25% up/);
});

test("rerun: a receipt reproduces from its inputs; an edited decision or another spec does not", async () => {
  const { rerun } = await import("../src/rerun.js");
  const { receipt } = await runTick(0.01, true, null);
  const spec = receipt.prompt_sha256 as string;
  const [ok] = await rerun(JSON.stringify(receipt), spec);
  assert.deepEqual([ok.same_spec, ok.same_decision], [true, true]);
  const edited = { ...receipt, decision: { ...receipt.decision, amount_in: "0.9" } };
  assert.equal((await rerun(JSON.stringify(edited), spec))[0].same_decision, false);
  assert.equal((await rerun(JSON.stringify(receipt), "other"))[0].same_spec, false);
});
