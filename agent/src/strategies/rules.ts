// House strategies, version 3: deterministic rules, published with a hash ("open rules"). A rule reads only the tick's
// recorded inputs: closed daily candles, vault balances, policy, usage, and the vault's own on-chain decision history
// with the slot block (`chain`). Nothing it reads depends on when the operator sends the tick, so anyone can re-run a
// receipt and get the same decision. Versions 1 and 2 stay frozen in rules-v1.ts and rules-v2.ts for their receipts.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonical, type Json } from "../receipt.js";
import type { Decision } from "../decision.js";
import type { Model } from "../models.js";
import type { Prompt } from "../arena.js";
import { SCHEDULE, type ChainState } from "./schedule.js";
import { CANDLES } from "./market.js";

/** The parts of a tick's inputs a rule reads (see arena.ts `inputs`). */
export interface RuleInput {
  vault: {
    base: string; quote: string;
    balances: Record<string, string>;
    policy: { tokens: { token: string; max_per_trade: string; max_per_day: string }[] };
    usage: { spent_24h: Record<string, string> };
  };
  market?: { candles: [number, string, string, string][]; as_of?: string };
  chain?: ChainState;
}

export interface Strategy {
  id: string;
  version: number;
  rule: string;
  params: Record<string, number | string>;
  /** Target NEAR weight (0..1), or null for "no change", or a reason code to hold. */
  target(x: RuleInput, w: number, s: Strategy): number | string | null;
}

/** Ignore moves smaller than this share of the vault (bt.py MIN_TRADE); keeps rules from paying gas for noise. */
const MIN_TRADE = 0.02;
/** Amounts are rounded down to this many decimals. */
const DP = 6;

const num = (s: Strategy, k: string) => Number(s.params[k]);
const closes = (x: RuleInput) => (x.market?.candles ?? []).map((c) => Number(c[3]));

/** sha256 over seed parts; returns three uniforms in [0,1). */
function uniforms(seed: string): [number, number, number] {
  const h = createHash("sha256").update(seed).digest();
  const u = (i: number) => h.readUInt32BE(i * 4) / 2 ** 32;
  return [u(0), u(1), u(2)];
}

export const STRATEGIES: Strategy[] = [
  {
    id: "rebalancer", version: 3, params: { drift: 0.10, weight: 0.5 },
    rule: "Back to 50/50 when the NEAR weight, valued at the last daily close, drifts more than 10 points.",
    target: (_x, w, s) => (Math.abs(w - num(s, "weight")) > num(s, "drift") ? num(s, "weight") : null),
  },
  {
    id: "trend", version: 3, params: { sma_days: 50 },
    rule: "All NEAR when the last daily close is above its 50-day average, all USDC when below.",
    target: (x, _w, s) => {
      const n = num(s, "sma_days");
      const c = closes(x);
      if (c.length < n) return "not_enough_history";
      const sma = c.slice(-n).reduce((a, b) => a + b, 0) / n;
      const last = c[c.length - 1];
      return last > sma ? 1 : last < sma ? 0 : null;
    },
  },
  {
    id: "breakout", version: 3, params: { enter_days: 55, exit_days: 20 },
    rule: "Enter on a close above the prior 55-day high and keep buying toward all NEAR until a close below the prior "
      + "20-day low; then keep selling toward all USDC until the next entry. In or out is the side of the vault's last "
      + "on-chain trade request.",
    target: (x, _w, s) => {
      const e = num(s, "enter_days"), q = num(s, "exit_days");
      const k = x.market?.candles ?? [];
      if (k.length < e + 1) return "not_enough_history";
      const last = Number(k[k.length - 1][3]);
      const prior = k.slice(0, -1);
      const hi = Math.max(...prior.slice(-e).map((c) => Number(c[1])));
      const lo = Math.min(...prior.slice(-q).map((c) => Number(c[2])));
      if (last > hi) return 1;
      if (last < lo) return 0;
      const side = x.chain?.last_request?.side;
      return side === "buy" ? 1 : side === "sell" ? 0 : null;
    },
  },
  {
    id: "hold", version: 3, params: { weight: 0.5 },
    rule: "Move to 50/50 once, then never trade: once the vault has any on-chain trade request, it only holds.",
    target: (x, _w, s) => {
      if (!x.chain) return "no_chain_state";
      return x.chain.requests.buy + x.chain.requests.sell > 0 ? null : num(s, "weight");
    },
  },
  {
    id: "luck", version: 3, params: { p_trade: 0.25, min_frac: 0.1, max_frac: 0.5, seed: "sledgit-luck-v3" },
    rule: "Random trades under the same limits: each tick, with probability 0.25, buy or sell 10-50% of the remaining "
      + "cap (per trade and rolling 24 h). The randomness is sha256(seed|vault|seq|slot block hash): the vault's own "
      + "decision number and the hash of the first block at or after the scheduled slot, which nobody knows earlier.",
    target: () => null, // decided in decide(): it sizes from the cap, not a weight
  },
  {
    id: "vol-target", version: 3, params: { target_vol: 0.40, days: 30, max: 0.9, band: 0.10 },
    rule: "NEAR weight = 40% annual volatility divided by NEAR's realised volatility over the last 30 daily closes, "
      + "capped at 90%. Trades only when the target is more than 10 points from the current weight.",
    target: (x, w, s) => {
      const c = closes(x);
      const n = num(s, "days");
      if (c.length < n + 1) return "not_enough_history";
      const r = c.slice(-n - 1).slice(1).map((p, i) => Math.log(p / c[c.length - n - 1 + i]));
      const m = r.reduce((a, b) => a + b, 0) / n;
      const vol = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) * Math.sqrt(365);
      if (!(vol > 0)) return "no_volatility";
      const t = Math.min(num(s, "max"), num(s, "target_vol") / vol);
      return Math.abs(t - w) > num(s, "band") ? t : null;
    },
  },
];

export const strategyById = (id: string): Strategy => {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown strategy ${id} (${STRATEGIES.map((x) => x.id).join(" | ")})`);
  return s;
};

/** sha256 of this file with line endings normalised to LF, so a CRLF checkout hashes the same. */
export const RULES_SOURCE_SHA256 = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url), "utf8").replace(/\r\n/g, "\n")).digest("hex");

/** The published spec; its sha256 is the strategy hash recorded as prompt_sha256 in every receipt. */
export function spec(s: Strategy): Json {
  return {
    kind: "sledgit-rules", id: s.id, version: s.version, rule: s.rule, params: s.params, source_sha256: RULES_SOURCE_SHA256,
    min_trade: MIN_TRADE, decimals: DP,
    inputs: {
      price: "close of the last closed daily candle (Binance NEARUSDT 1d); the spot reference price is recorded but not read",
      candles: CANDLES, history: "the vault's own on-chain decision events before this decision", schedule: SCHEDULE,
    },
  };
}

export function strategyPrompt(s: Strategy): Prompt {
  const text = canonical(spec(s));
  return { text, sha256: createHash("sha256").update(text).digest("hex"), path: `rules:${s.id}` };
}

const floorDp = (n: number): string => {
  const f = Math.floor(n * 10 ** DP) / 10 ** DP;
  return f > 0 ? f.toFixed(DP).replace(/\.?0+$/, "") : "0";
};

const hold = (reason: string): Decision => ({ action: "hold", amount_in: "0", reason });

/** Room left under the token's per-trade and rolling 24 h caps, in token units. */
function room(x: RuleInput, token: string): number {
  const t = x.vault.policy.tokens.find((p) => p.token === token);
  if (!t) return 0;
  const spent = Number(x.vault.usage.spent_24h[token] ?? "0");
  return Math.max(0, Math.min(Number(t.max_per_trade), Number(t.max_per_day) - spent));
}

/** The decision for one tick. Pure: same input and vault, same output. */
export function decide(s: Strategy, x: RuleInput, vault: string): Decision {
  const c = closes(x);
  const p = c.length ? c[c.length - 1] : NaN;
  if (!(p > 0)) return hold("no_market");
  const { base, quote } = x.vault;
  const b = Number(x.vault.balances[base] ?? "0");
  const q = Number(x.vault.balances[quote] ?? "0");
  const value = b * p + q;
  if (!(value > 0)) return hold("empty_vault");
  const w = (b * p) / value;

  if (s.id === "luck") {
    if (!x.chain) return hold("no_chain_state");
    const [u1, u2, u3] = uniforms(`${s.params.seed}|${vault}|${x.chain.seq}|${x.chain.slot_block.hash}`);
    if (u1 >= num(s, "p_trade")) return hold("luck_no_trade");
    const buy = u2 < 0.5;
    const frac = num(s, "min_frac") + (num(s, "max_frac") - num(s, "min_frac")) * u3;
    const amount = buy ? Math.min(q, room(x, quote) * frac) : Math.min(b, room(x, base) * frac);
    const a = floorDp(amount);
    return a === "0" ? hold("cap_or_balance_empty") : { action: buy ? "buy" : "sell", amount_in: a, reason: `luck ${buy ? "buy" : "sell"}` };
  }

  const t = s.target(x, w, s);
  if (typeof t === "string") return hold(t);
  if (t === null) return hold("no_signal");
  const delta = t * value - b * p; // + buy NEAR, - sell NEAR (in USDC terms)
  if (Math.abs(delta) < MIN_TRADE * value) return hold("at_target");
  if (delta > 0) {
    const a = floorDp(Math.min(delta, q, room(x, quote)));
    return a === "0" ? hold("cap_or_balance_empty") : { action: "buy", amount_in: a, reason: `${s.id}: target ${t} from ${w.toFixed(3)}` };
  }
  const a = floorDp(Math.min(-delta / p, b, room(x, base)));
  return a === "0" ? hold("cap_or_balance_empty") : { action: "sell", amount_in: a, reason: `${s.id}: target ${t} from ${w.toFixed(3)}` };
}

/** A strategy as a Model, so the arena tick seals, previews, refuses and records it exactly like an LLM agent. */
export function rulesModel(s: Strategy, vaultId: string): Model {
  return {
    ref: { provider: "rules", id: s.id },
    async complete(_system: string, user: string): Promise<string> {
      const x = JSON.parse(user) as RuleInput;
      return JSON.stringify(decide(s, x, vaultId));
    },
  };
}
