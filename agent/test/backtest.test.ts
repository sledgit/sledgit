import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulate, metrics, COSTS } from "../src/backtest/engine.js";
import { SKILLS } from "../src/backtest/skills.js";
import { report } from "../src/backtest/cli.js";
import type { Candle } from "../src/strategies/market.js";

const flat = (n: number, p = 2): Candle[] => Array.from({ length: n }, (_, i) => [i * 86_400_000, String(p), String(p), String(p)]);
const skill = (id: string) => SKILLS.find((s) => s.strategy.id === id)!;

test("backtest: hold on a flat price loses only the entry costs", () => {
  const r = simulate(skill("hold"), flat(300));
  assert.equal(r.trades, 1);
  const cost = 500 * (COSTS.fee + 500 / COSTS.depth_usd) + COSTS.gas_usd;
  assert.ok(Math.abs(r.equity[r.equity.length - 1] - (1000 - cost)) < 1e-6);
});

test("backtest: staking grows the NEAR leg on a flat price", () => {
  const a = simulate(skill("hold"), flat(600)), b = simulate(skill("stake-hold"), flat(600));
  assert.ok(b.equity[b.equity.length - 1] > a.equity[a.equity.length - 1] + 10);
});

test("backtest: a rule never spends more than it holds or the cap allows", () => {
  const k: Candle[] = flat(400).map((c, i) => [c[0], "9", "1", String(1 + 4 * Math.abs(Math.sin(i / 9)))]);
  for (const s of SKILLS) {
    const r = simulate(s, k);
    assert.ok(r.equity.every((v) => v > 0 && Number.isFinite(v)), s.strategy.id);
    assert.ok(metrics(r).max_dd <= 0);
  }
});

test("backtest: the committed history gives a reproducible report with no false promise", () => {
  const c = (JSON.parse(readFileSync(new URL("../data/near-usdt-1d.json", import.meta.url), "utf8")) as { candles: Candle[] }).candles;
  const a = report(c), b = report(c);
  assert.deepEqual(a, b);
  for (const s of a.skills) if (s.verdict.startsWith("promising")) assert.ok(s.p_vs_hold! < a.significance.alpha);
  // Every skill but hold and luck faces random rules that trade about as often; promising needs the 95% bar too.
  for (const s of a.skills) {
    if (s.id === "hold" || s.id === "luck") { assert.equal(s.random, null); continue; }
    const r = s.random!;
    assert.equal(r.runs, a.random_rules.runs);
    for (const v of [r.full.beats, r.out_of_sample.beats]) assert.ok(v >= 0 && v <= 1);
    const t = (s.periods.full as unknown as { trades_per_year: number }).trades_per_year;
    if (t >= 5) assert.ok(Math.abs(r.trades_per_year_median - t) / t < 0.35, `${s.id}: ${r.trades_per_year_median} vs ${t}`);
    if (s.verdict.startsWith("promising")) assert.ok(r.out_of_sample.beats >= a.random_rules.bar);
  }
});

test("vol-target v3: low volatility caps at 90%, high volatility cuts NEAR, small moves hold", async () => {
  const { decide, strategyById } = await import("../src/strategies/rules.js");
  const s = strategyById("vol-target");
  const day = (i: number, p: number): Candle => [i * 86_400_000, String(p), String(p), String(p)];
  const calm = Array.from({ length: 60 }, (_, i) => day(i, 3 * (1 + 0.001 * (i % 2))));
  const wild = Array.from({ length: 60 }, (_, i) => day(i, 3 * (i % 2 ? 1.15 : 0.87)));
  const x = (k: Candle[], near: number, usd: number) => ({
    vault: { base: "wrap.near", quote: "usdc", balances: { "wrap.near": String(near), usdc: String(usd) },
      policy: { tokens: [{ token: "usdc", max_per_trade: "1000", max_per_day: "1000" }, { token: "wrap.near", max_per_trade: "1000", max_per_day: "1000" }] },
      usage: { spent_24h: {} } },
    market: { candles: k },
  });
  const p = Number(calm[59][3]);
  assert.equal(s.target(x(calm, 0, 100), 0, s), 0.9);
  const t = s.target(x(wild, 50 / Number(wild[59][3]), 50), 0.5, s) as number;
  assert.ok(t > 0 && t < 0.2, String(t));
  assert.equal(s.target(x(calm, 85 / p, 15), 0.85, s), null);
  assert.equal(s.target(x(calm.slice(0, 20), 0, 100), 0, s), "not_enough_history");
  assert.equal(decide(s, x(calm, 0, 100), "v").action, "buy");
});
