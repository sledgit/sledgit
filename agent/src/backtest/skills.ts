// The skills catalogue: every published strategy with its backtest settings. House skills are the live rules in
// strategies/rules.ts, run unchanged. Research skills use the same Strategy interface and are not traded live yet.
import { STRATEGIES, type RuleInput, type Strategy } from "../strategies/rules.js";
import { stakedById, type StakedStrategy } from "../strategies/staked.js";

export type SkillStatus = "house" | "research" | "llm";

export interface Skill {
  strategy: Strategy;
  name: string;
  status: SkillStatus;
  /** The NEAR leg earns staking yield (held as a liquid-staking token). */
  stake: boolean;
  /** A published staked strategy: run with its own decide(), stake and unstake costs included. */
  staked?: StakedStrategy;
  /** Daily candles the rule reads; live house rules read 60. */
  candles: number;
  evidence: string;
}

const closes = (x: RuleInput) => (x.market?.candles ?? []).map((c) => Number(c[3]));
const sma = (c: number[], n: number) => c.slice(-n).reduce((a, b) => a + b, 0) / n;
const num = (s: Strategy, k: string) => Number(s.params[k]);
const house = (id: string) => STRATEGIES.find((s) => s.id === id)!;
/** A staked house skill: its id, the base rule's settings, and the staked decide(). */
const stakedHouse = (id: string) => { const s = stakedById(id)!; return { strategy: { ...s.base, id, rule: s.rule }, staked: s }; };

const trendOverlay: Strategy = {
  id: "trend-overlay", version: 1, params: { low: 0.25, high: 0.75, band: 0.10, lookbacks: "20,50,100,200" },
  rule: "NEAR weight between 25% and 75%: 25% plus 12.5 points for each of the 20, 50, 100 and 200-day averages the "
    + "last close is above. Trades only when the target is more than 10 points from the current weight.",
  target: (x, w, s) => {
    const c = closes(x);
    const ns = String(s.params.lookbacks).split(",").map(Number);
    if (c.length < Math.max(...ns)) return "not_enough_history";
    const last = c[c.length - 1];
    const up = ns.filter((n) => last > sma(c, n)).length;
    const t = num(s, "low") + ((num(s, "high") - num(s, "low")) * up) / ns.length;
    return Math.abs(t - w) > num(s, "band") ? t : null;
  },
};

export const SKILLS: Skill[] = [
  { strategy: house("hold"), name: "Hold 50/50", status: "house", stake: false, candles: 60,
    evidence: "The benchmark every skill must beat." },
  { ...stakedHouse("stake-hold"), name: "Stake and hold", status: "house", stake: true, candles: 60,
    evidence: "Carry: the only strategy with solid after-cost evidence. The NEAR half is held as stNEAR." },
  { strategy: house("rebalancer"), name: "Band rebalance 40-60", status: "house", stake: false, candles: 60,
    evidence: "Rebalancing mainly trims drawdowns; the return edge over holding is not significant." },
  { ...stakedHouse("stake-rebalancer"), name: "Staked band rebalance", status: "house", stake: true, candles: 60,
    evidence: "Carry plus a wide rebalance band." },
  { strategy: trendOverlay, name: "Slow trend overlay", status: "research", stake: false, candles: 200,
    evidence: "Slow time-series momentum survives costs in crypto studies, mostly by cutting crash losses." },
  { strategy: house("vol-target"), name: "Volatility target", status: "house", stake: false, candles: 60,
    evidence: "Volatility scaling lowers drawdowns; return effects are mixed." },
  { ...stakedHouse("stake-vol-target"), name: "Staked volatility target", status: "house", stake: true, candles: 60,
    evidence: "Carry plus volatility scaling." },
  { strategy: house("trend"), name: "Trend 50-day", status: "house", stake: false, candles: 60,
    evidence: "Best in-sample of 26 trend settings in our earlier test, so likely overfit." },
  { strategy: house("breakout"), name: "Breakout 55/20", status: "house", stake: false, candles: 60,
    evidence: "Classic turtle-style channel breakout." },
  { strategy: house("luck"), name: "Luck (random)", status: "house", stake: false, candles: 60,
    evidence: "Random trades under the same limits. A new random seed swings its result by tens of points a year: a reminder that a good backtest can be pure luck." },
];
