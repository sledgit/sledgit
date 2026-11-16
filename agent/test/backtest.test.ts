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
});
