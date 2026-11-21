// Trend and volatility ensemble, version 1: four daily channel signals set how much NEAR to hold, scaled down when NEAR
// is volatile. Lookbacks fit the 60 daily candles the runner records. Decisions use decide() from rules.ts unchanged;
// the staked version holds the NEAR side as the staking token through decideStaked() in staked.ts.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonical, type Json } from "../receipt.js";
import type { Prompt } from "../arena.js";
import { RULES_SOURCE_SHA256, type Strategy } from "./rules.js";
import { STAKED_SOURCE_SHA256, type StakedStrategy } from "./staked.js";
import { CANDLES } from "./market.js";
import { SCHEDULE } from "./schedule.js";

const num = (s: Strategy, k: string) => Number(s.params[k]);

export const TREND_VOL: Strategy = {
  id: "trend-vol", version: 1,
  params: { lookbacks: "10,20,40,55", target_vol: 0.40, vol_days: 30, low: 0.20, high: 0.75, band: 0.10 },
  rule: "NEAR weight between 20% and 75%. Trend score: the share of the 10, 20, 40 and 55-day channels whose midpoint "
    + "(between the prior high and low) the last close is above. Weight = 20% plus 55 points times the score, times "
    + "min(1, 40% annual volatility / NEAR's realised volatility over 30 daily closes). Trades only when the target is "
    + "more than 10 points from the current weight.",
  target: (x, w, s) => {
    const k = x.market?.candles ?? [];
    const ns = String(s.params.lookbacks).split(",").map(Number);
    const n = num(s, "vol_days");
    if (k.length < Math.max(...ns, n) + 1) return "not_enough_history";
    const c = k.map((d) => Number(d[3]));
    const last = c[c.length - 1];
    const prior = k.slice(0, -1);
    const up = ns.filter((d) => {
      const win = prior.slice(-d);
      const hi = Math.max(...win.map((x) => Number(x[1]))), lo = Math.min(...win.map((x) => Number(x[2])));
      return last > (hi + lo) / 2;
    }).length;
    const r = c.slice(-n - 1).slice(1).map((p, i) => Math.log(p / c[c.length - n - 1 + i]));
    const m = r.reduce((a, b) => a + b, 0) / n;
    const vol = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) * Math.sqrt(365);
    if (!(vol > 0)) return "no_volatility";
    const t = num(s, "low") + (num(s, "high") - num(s, "low")) * (up / ns.length) * Math.min(1, num(s, "target_vol") / vol);
    return Math.abs(t - w) > num(s, "band") ? t : null;
  },
};

export const STAKED_TREND_VOL: StakedStrategy = {
  id: "stake-trend-vol", version: 1, base: TREND_VOL,
  rule: "Trend and volatility ensemble on total NEAR (wNEAR plus staked at its redemption rate); idle wNEAR is staked, "
    + "and a sell unstakes when wNEAR is short.",
};

export const TREND_VOL_SOURCE_SHA256 = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url), "utf8").replace(/\r\n/g, "\n")).digest("hex");

/** The published spec. The decision code is rules.ts decide() (and staked.ts for the staked version), pinned by hash. */
export function trendVolSpec(staked: boolean): Json {
  const s = staked ? STAKED_TREND_VOL : TREND_VOL;
  return {
    kind: "sledgit-rules-trend-vol", id: s.id, version: s.version, rule: s.rule, params: TREND_VOL.params,
    source_sha256: TREND_VOL_SOURCE_SHA256, decide_source_sha256: RULES_SOURCE_SHA256,
    ...(staked ? { staked_source_sha256: STAKED_SOURCE_SHA256 } : {}),
    inputs: {
      price: "close of the last closed daily candle (Binance NEARUSDT 1d); the spot reference price is recorded but not read",
      candles: CANDLES, schedule: SCHEDULE,
      ...(staked ? { stake_rate: "redemption rate of the staking token in base units, read from the staking contract with the balances" } : {}),
    },
  };
}

export function trendVolPrompt(staked: boolean): Prompt {
  const text = canonical(trendVolSpec(staked));
  return { text, sha256: createHash("sha256").update(text).digest("hex"), path: `rules:${staked ? STAKED_TREND_VOL.id : TREND_VOL.id}` };
}
