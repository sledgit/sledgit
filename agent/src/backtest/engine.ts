// Daily backtest of a skill with the live decide() code: one decision per day at the close, filled at that close
// with the pool fee, price impact and gas. Every vault starts in USDC, so the first move pays costs too.
import { createHash } from "node:crypto";
import { decide, type RuleInput } from "../strategies/rules.js";
import type { Candle } from "../strategies/market.js";
import type { Skill } from "./skills.js";

const DAY = 86_400_000;
const BASE = "wrap.near", QUOTE = "usdc";

export interface Costs {
  start_usd: number;
  fee: number;
  /** One side of the pool, in USD: price impact = trade / depth. */
  depth_usd: number;
  gas_usd: number;
  /** Per-trade and 24 h cap as a share of vault value. */
  cap: number;
}

export const COSTS: Costs = { start_usd: 1000, fee: 0.003, depth_usd: 900_000, gas_usd: 0.01, cap: 0.5 };
/** Staking APR on the NEAR leg: 9% before NEAR's inflation cut on 2025-10-30, 4.5% after. */
export const stakeApr = (t: number) => (t < Date.UTC(2025, 9, 30) ? 0.09 : 0.045);
export const WARMUP = 200;

export interface Run { t: number[]; equity: number[]; trades: number; costs_usd: number }

export function simulate(skill: Skill, candles: Candle[], c: Costs = COSTS, from = WARMUP): Run {
  let b = 0, q = c.start_usd, trades = 0, costs = 0;
  const requests = { buy: 0, sell: 0 };
  let last: { seq: number; side: "buy" | "sell" } | null = null;
  const out: Run = { t: [], equity: [], trades: 0, costs_usd: 0 };
  for (let i = from; i < candles.length; i++) {
    const p = Number(candles[i][3]);
    if (skill.stake && i > from) b *= 1 + stakeApr(candles[i][0]) / 365;
    const value = b * p + q;
    const cap = (value * c.cap).toString();
    const x: RuleInput = {
      vault: {
        base: BASE, quote: QUOTE, balances: { [BASE]: String(b), [QUOTE]: String(q) },
        policy: { tokens: [{ token: QUOTE, max_per_trade: cap, max_per_day: cap }, { token: BASE, max_per_trade: String(value * c.cap / p), max_per_day: String(value * c.cap / p) }] },
        usage: { spent_24h: {} },
      },
      market: { candles: candles.slice(Math.max(0, i + 1 - skill.candles), i + 1) },
      chain: {
        seq: i - from + 1, decisions_before: i - from, requests: { ...requests }, last_request: last, slot: new Date(candles[i][0]).toISOString(),
        off_schedule: false, slot_block: { height: i, hash: createHash("sha256").update(`backtest|${candles[i][0]}`).digest("hex") },
      } as RuleInput["chain"],
    };
    const d = decide(skill.strategy, x, `backtest-${skill.strategy.id}`);
    if (d.action !== "hold") {
      const a = Number(d.amount_in);
      const usd = d.action === "buy" ? a : a * p;
      const cost = usd * (c.fee + usd / c.depth_usd) + c.gas_usd;
      if (d.action === "buy") { q -= a; b += (a - cost) / p; } else { b -= a; q += usd - cost; }
      trades++; costs += cost; requests[d.action]++; last = { seq: i - from + 1, side: d.action };
    }
    out.t.push(candles[i][0]);
    out.equity.push(b * p + q);
  }
  out.trades = trades; out.costs_usd = costs;
  return out;
}

export interface Metrics { cagr: number; max_dd: number; vol: number; sharpe: number; trades_per_year: number; cost_drag: number; days: number }

export function metrics(r: Run, lo = 0, hi = r.equity.length): Metrics {
  const e = r.equity.slice(lo, hi);
  const days = e.length - 1;
  const years = days / 365;
  const rets = e.slice(1).map((v, i) => Math.log(v / e[i]));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  let peak = -Infinity, dd = 0;
  for (const v of e) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  const avg = e.reduce((a, b) => a + b, 0) / e.length;
  const share = days / Math.max(1, r.equity.length - 1);
  return {
    cagr: (e[e.length - 1] / e[0]) ** (1 / years) - 1, max_dd: dd, vol: sd * Math.sqrt(365),
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(365) : 0, trades_per_year: (r.trades * share) / years,
    cost_drag: (r.costs_usd * share) / avg / years, days,
  };
}

/** Seeded uniform PRNG (mulberry32), so the bootstrap is reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** One-sided stationary block bootstrap p-value that the mean daily log excess over the benchmark is > 0. */
export function bootstrapP(a: Run, bench: Run, reps = 2000, block = 20, seed = 1): number {
  const x = a.equity.slice(1).map((v, i) => Math.log(v / a.equity[i]) - Math.log(bench.equity[i + 1] / bench.equity[i]));
  const n = x.length;
  const mean = x.reduce((s, v) => s + v, 0) / n;
  const c = x.map((v) => v - mean);
  const r = rng(seed);
  let hits = 0;
  for (let k = 0; k < reps; k++) {
    let s = 0, j = Math.floor(r() * n);
    for (let i = 0; i < n; i++) {
      if (r() < 1 / block) j = Math.floor(r() * n);
      s += c[j];
      j = (j + 1) % n;
    }
    if (s / n >= mean) hits++;
  }
  return (hits + 1) / (reps + 1);
}

export const dayIndex = (r: Run, t: number) => r.t.findIndex((x) => x >= t);
export { DAY };
