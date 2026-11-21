// `backtest.mjs [--out file]`: every skill in the catalogue over the committed daily NEAR history. Read-only.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Candle } from "../strategies/market.js";
import { STRATEGIES } from "../strategies/rules.js";
import { HOUSE_RULES } from "../strategies/house.js";
import { bootstrapP, COSTS, dayIndex, metrics, simulate, WARMUP, type Metrics, type Run } from "./engine.js";
import { SKILLS, type Skill } from "./skills.js";

const DATA = new URL("../../data/near-usdt-1d.json", import.meta.url);
const OOS = Date.UTC(2025, 0, 1);
/** 5% split across every skill tested against hold (Bonferroni). */
const ALPHA = 0.05 / (SKILLS.length - 1);
const ENGINE = ["engine.ts", "skills.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** Random rules per skill: the published luck rule with fresh seeds, trading about as often as the skill. */
const RANDOM_RUNS = 100;
/** A skill is called promising only if it also beats this share of its random rules out of sample. */
const RANDOM_BAR = 0.95;
const fix = (m: Metrics) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, k === "days" ? v : r4(v)]));

/** Random rules matched to a skill: luck with its trade rate set to the skill's and, for staked skills, a staked NEAR
 * side. Returns each run's CAGR minus hold's, for the full period and out of sample. */
function randomRules(s: Skill, tradesPerYear: number, hold: Run, k: number, candles: Candle[]) {
  const luck = STRATEGIES.find((x) => x.id === "luck")!;
  const p = Math.min(1, Math.max(1 / 365, tradesPerYear / 365));
  const full: number[] = [], oos: number[] = [], trades: number[] = [];
  const h = { full: metrics(hold).cagr, oos: metrics(hold, k, hold.equity.length).cagr };
  for (let i = 0; i < RANDOM_RUNS; i++) {
    // decide() recognises the luck rule by its id, so only the seed and trade rate change.
    const strategy = { ...luck, params: { ...luck.params, p_trade: p, seed: `sledgit-random-${s.strategy.id}-${i}` } };
    const r = simulate({ strategy, name: `random ${i}`, status: "research", stake: s.stake, candles: 60, evidence: "" }, candles);
    full.push(metrics(r).cagr - h.full);
    oos.push(metrics(r, k, r.equity.length).cagr - h.oos);
    trades.push(metrics(r).trades_per_year);
  }
  return { full, oos, p_trade: p, trades: trades.sort((a, b) => a - b)[trades.length >> 1] };
}

/** Share of random runs the value beats (ties count half). */
const beats = (v: number, xs: number[]) => xs.reduce((n, x) => n + (v > x ? 1 : v === x ? 0.5 : 0), 0) / xs.length;
const pct = (xs: number[], q: number) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };

export function report(candles: Candle[]) {
  const runs = new Map<string, Run>(SKILLS.map((s) => [s.strategy.id, simulate(s, candles)]));
  const hold = runs.get("hold")!, stake = runs.get("stake-hold")!;
  const k = dayIndex(hold, OOS);
  const periods = { full: [0, hold.equity.length], in_sample: [0, k + 1], out_of_sample: [k, hold.equity.length] } as const;
  const skills = SKILLS.map((s) => {
    const r = runs.get(s.strategy.id)!;
    const per = Object.fromEntries(Object.entries(periods).map(([name, [lo, hi]]) => {
      const m = metrics(r, lo, hi), h = metrics(hold, lo, hi), st = metrics(stake, lo, hi);
      return [name, { ...fix(m), vs_hold: r4(m.cagr - h.cagr), vs_stake_hold: r4(m.cagr - st.cagr) }];
    }));
    const years: Record<string, number> = {};
    for (let y = new Date(r.t[0]).getUTCFullYear(); y <= new Date(r.t[r.t.length - 1]).getUTCFullYear(); y++) {
      const lo = Math.max(0, dayIndex(r, Date.UTC(y, 0, 1)) - (y === new Date(r.t[0]).getUTCFullYear() ? 0 : 1));
      const end = dayIndex(r, Date.UTC(y + 1, 0, 1));
      const hi = end < 0 ? r.t.length : end;
      if (hi - lo > 30) years[y] = r4(r.equity[hi - 1] / r.equity[lo] - hold.equity[hi - 1] / hold.equity[lo]);
    }
    const p = s.strategy.id === "hold" ? null : r4(bootstrapP(r, hold));
    const oos = (per.out_of_sample as { vs_hold: number }).vs_hold;
    const full = per.full as unknown as { vs_hold: number; trades_per_year: number };
    const rnd = s.strategy.id === "hold" || s.strategy.id === "luck" ? null : randomRules(s, full.trades_per_year, hold, k, candles);
    const random = rnd && {
      runs: RANDOM_RUNS, p_trade: r4(rnd.p_trade), trades_per_year_median: r4(rnd.trades),
      full: { beats: r4(beats(full.vs_hold, rnd.full)), median_vs_hold: r4(pct(rnd.full, 0.5)), p95_vs_hold: r4(pct(rnd.full, 0.95)) },
      out_of_sample: { beats: r4(beats(oos, rnd.oos)), median_vs_hold: r4(pct(rnd.oos, 0.5)), p95_vs_hold: r4(pct(rnd.oos, 0.95)) },
    };
    const verdict = s.strategy.id === "hold" ? "benchmark"
      : p !== null && p < ALPHA && oos > 0 && (!random || random.out_of_sample.beats >= RANDOM_BAR) ? "promising (backtest only)" : "unproven";
    const weekly = r.equity.filter((_, i) => i % 7 === 0 || i === r.equity.length - 1).map((v) => Math.round(v * 100) / 100);
    // House skills carry the published spec hash the live rule records; research skills have none.
    const live = s.status === "house" ? HOUSE_RULES.find((x) => x.id === s.strategy.id) : undefined;
    return {
      id: s.strategy.id, name: s.name, status: s.status, stake: s.stake, rule: s.strategy.rule, params: s.strategy.params,
      version: s.staked?.version ?? s.strategy.version,
      spec_sha256: live ? live.prompt.sha256 : null, evidence: s.evidence,
      periods: per, years, p_vs_hold: p, random, verdict, weekly,
    };
  });
  return {
    generated_from: { data_sha256: sha(readFileSync(DATA, "utf8")), engine_sha256: sha(ENGINE.join("\n")) },
    data: { source: "Binance NEARUSDT daily closes", first: new Date(hold.t[0]).toISOString().slice(0, 10), last: new Date(hold.t[hold.t.length - 1]).toISOString().slice(0, 10), out_of_sample_from: "2025-01-01", warmup_days: WARMUP },
    significance: { test: "one-sided stationary block bootstrap of daily log excess vs hold 50/50 (20-day blocks, 2000 reps)", alpha: r4(ALPHA), correction: `Bonferroni over ${SKILLS.length - 1} skills` },
    random_rules: { runs: RANDOM_RUNS, bar: RANDOM_BAR, rule: "the published luck rule with fresh seeds, its trade probability set to the skill's trades per year / 365; staked skills get a staked NEAR side" },
    costs: COSTS, stake_apr: "9% before 2025-10-30, 4.5% after",
    hold_weekly: hold.equity.filter((_, i) => i % 7 === 0 || i === hold.equity.length - 1).map((v) => Math.round(v * 100) / 100),
    skills,
  };
}

export async function run(argv: string[]): Promise<number> {
  const { values: o } = parseArgs({ args: argv, options: { out: { type: "string" } } });
  const candles = (JSON.parse(readFileSync(DATA, "utf8")) as { candles: Candle[] }).candles;
  const text = `${JSON.stringify(report(candles), null, 1)}\n`;
  if (o.out) writeFileSync(o.out, text); else process.stdout.write(text);
  return 0;
}
