// Staked house strategies, version 1: a published version 3 rule decides the NEAR weight, and the NEAR side is held as
// the liquid-staking token. NEAR exposure counts base plus the staking token at its recorded redemption rate. One
// decision per tick: buys land in base and are staked on a later tick; a sell spends base first and unstakes when it
// has too little. The rate is read from the staking contract and recorded in the receipt with the balances.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonical, type Json } from "../receipt.js";
import type { Decision } from "../decision.js";
import type { Model } from "../models.js";
import type { Prompt } from "../arena.js";
import { decide, spec as baseSpec, strategyById, type RuleInput, type Strategy } from "./rules.js";

export interface StakedInput extends RuleInput {
  vault: RuleInput["vault"] & { stake?: string; stake_rate?: string };
}

export interface StakedStrategy { id: string; version: number; base: Strategy; rule: string }

/** Ignore stakes and unstakes smaller than this share of the vault (as rules.ts MIN_TRADE). */
const MIN_STAKE = 0.02;
const DP = 6;

const staked = (id: string, base: string, rule: string): StakedStrategy => ({ id, version: 1, base: strategyById(base), rule });

export const STAKED: StakedStrategy[] = [
  staked("stake-hold", "hold", "Hold 50/50 with the NEAR half staked: buy once, then stake every idle wNEAR."),
  staked("stake-rebalancer", "rebalancer", "Band rebalance 40-60 on total NEAR (wNEAR plus staked at its redemption rate); idle wNEAR is staked, and a sell unstakes when wNEAR is short."),
  staked("stake-vol-target", "vol-target", "Volatility target on total NEAR (wNEAR plus staked at its redemption rate); idle wNEAR is staked, and a sell unstakes when wNEAR is short."),
];

export const stakedById = (id: string): StakedStrategy | undefined => STAKED.find((s) => s.id === id);

export const STAKED_SOURCE_SHA256 = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url), "utf8").replace(/\r\n/g, "\n")).digest("hex");

export function stakedSpec(s: StakedStrategy): Json {
  const base = canonical(baseSpec(s.base));
  return {
    kind: "sledgit-rules-staked", id: s.id, version: s.version, rule: s.rule, source_sha256: STAKED_SOURCE_SHA256,
    base: { id: s.base.id, spec_sha256: createHash("sha256").update(base).digest("hex") }, min_stake: MIN_STAKE, decimals: DP,
    inputs: { stake_rate: "redemption rate of the staking token in base units, read from the staking contract with the balances" },
  };
}

export function stakedPrompt(s: StakedStrategy): Prompt {
  const text = canonical(stakedSpec(s));
  return { text, sha256: createHash("sha256").update(text).digest("hex"), path: `rules:${s.id}` };
}

const floorDp = (n: number): string => {
  const f = Math.floor(n * 10 ** DP) / 10 ** DP;
  return f > 0 ? f.toFixed(DP).replace(/\.?0+$/, "") : "0";
};
const hold = (reason: string): Decision => ({ action: "hold", amount_in: "0", reason });

function room(x: RuleInput, token: string): number {
  const t = x.vault.policy.tokens.find((p) => p.token === token);
  if (!t) return 0;
  const spent = Number(x.vault.usage.spent_24h[token] ?? "0");
  return Math.max(0, Math.min(Number(t.max_per_trade), Number(t.max_per_day) - spent));
}

/** The decision for one tick. Pure: same input and vault, same output. */
export function decideStaked(s: StakedStrategy, x: StakedInput, vault: string): Decision {
  const { base, quote, stake } = x.vault;
  const rate = Number(x.vault.stake_rate);
  if (!stake || !(rate > 0)) return hold("no_stake_rate");
  const c = x.market?.candles ?? [];
  const p = c.length ? Number(c[c.length - 1][3]) : NaN;
  if (!(p > 0)) return hold("no_market");
  const b = Number(x.vault.balances[base] ?? "0");
  const l = Number(x.vault.balances[stake] ?? "0");
  const near = b + l * rate;
  const value = near * p + Number(x.vault.balances[quote] ?? "0");
  if (!(value > 0)) return hold("empty_vault");

  // The base rule sees total NEAR as if it were all base.
  const d = decide(s.base, { ...x, vault: { ...x.vault, balances: { ...x.vault.balances, [base]: String(near) } } }, vault);
  if (d.action === "buy") return { ...d, reason: `${s.id}: ${d.reason}` };
  if (d.action === "sell") {
    const want = Number(d.amount_in);
    if (b * p >= MIN_STAKE * value || b >= want) {
      const a = floorDp(Math.min(want, b));
      return a === "0" ? hold("cap_or_balance_empty") : { action: "sell", amount_in: a, reason: `${s.id}: ${d.reason}` };
    }
    const a = floorDp(Math.min(l, (want - b) / rate, room(x, stake)));
    return a === "0" ? hold("cap_or_balance_empty") : { action: "unstake", amount_in: a, reason: `${s.id}: unstake to sell (${d.reason})` };
  }
  if (b * p >= MIN_STAKE * value) {
    const a = floorDp(Math.min(b, room(x, base)));
    if (a !== "0") return { action: "stake", amount_in: a, reason: `${s.id}: stake idle wNEAR` };
  }
  return d;
}

/** A staked strategy as a Model, like rulesModel. */
export function stakedModel(s: StakedStrategy, vaultId: string): Model {
  return {
    ref: { provider: "rules", id: s.id },
    async complete(_system: string, user: string): Promise<string> {
      return JSON.stringify(decideStaked(s, JSON.parse(user) as StakedInput, vaultId));
    },
  };
}
