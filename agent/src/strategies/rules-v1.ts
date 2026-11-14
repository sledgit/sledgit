// House strategies: deterministic rules, published with a hash ("open rules"). A rule reads only the tick's recorded
// inputs (reference price, vault balances, policy, usage, its own history, closed daily candles), so anyone can re-run
// a receipt and get the same decision. Ported from spikes/backtest/bt.py; sizes are clipped to the vault's caps.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonical, type Json } from "../receipt.js";
import type { Decision } from "../decision.js";
import type { Model } from "../models.js";
import type { Prompt } from "../arena.js";

/** The parts of a tick's inputs a rule reads (see arena.ts `inputs`). */
export interface RuleInput {
  reference_price: { price: string } | null;
  vault: {
    base: string; quote: string;
    balances: Record<string, string>;
    policy: { tokens: { token: string; max_per_trade: string; max_per_day: string }[] };
    usage: { spent_24h: Record<string, string> };
  };
  history: { ts?: string; outcome?: { status?: string } | null }[];
  market?: { candles: [number, string, string, string][]; as_of: string };
}

export interface Strategy {
  id: string;
  version: number;
  rule: string;
  params: Record<string, number | string>;
  /** Target NEAR weight (0..1), or null for "no change". */
  target(x: RuleInput, w: number): number | string | null;
}

/** Ignore moves smaller than this share of the vault (bt.py MIN_TRADE); keeps rules from paying gas for noise. */
const MIN_TRADE = 0.02;
/** Amounts are rounded down to this many decimals. */
const DP = 6;

const closes = (x: RuleInput) => (x.market?.candles ?? []).map((c) => Number(c[3]));

/** sha256 over seed parts; returns three uniforms in [0,1). */
function uniforms(seed: string): [number, number, number] {
  const h = createHash("sha256").update(seed).digest();
  const u = (i: number) => h.readUInt32BE(i * 4) / 2 ** 32;
  return [u(0), u(1), u(2)];
}

export const STRATEGIES: Strategy[] = [
  {
    id: "rebalancer", version: 1, params: { drift: 0.10 },
    rule: "Back to 50/50 when the NEAR weight drifts more than 10 points.",
    target: (_x, w) => (Math.abs(w - 0.5) > 0.10 ? 0.5 : null),
  },
  {
    id: "trend", version: 1, params: { sma_days: 50 },
    rule: "All NEAR when the last daily close is above its 50-day average, all USDC when below.",
    target: (x) => {
      const c = closes(x);
      if (c.length < 50) return "not_enough_history";
      const sma = c.slice(-50).reduce((a, b) => a + b, 0) / 50;
      const last = c[c.length - 1];
      return last > sma ? 1 : last < sma ? 0 : null;
    },
  },
  {
    id: "breakout", version: 1, params: { enter_days: 55, exit_days: 20 },
    rule: "Enter all NEAR on a close above the prior 55-day high; exit to USDC on a close below the prior 20-day low.",
    target: (x, w) => {
      const k = x.market?.candles ?? [];
      if (k.length < 56) return "not_enough_history";
      const last = Number(k[k.length - 1][3]);
      const prior = k.slice(0, -1);
      const hi = Math.max(...prior.slice(-55).map((c) => Number(c[1])));
      const lo = Math.min(...prior.slice(-20).map((c) => Number(c[2])));
      if (w <= 0.5 && last > hi) return 1;
      if (w > 0.5 && last < lo) return 0;
      return null;
    },
  },
  {
    id: "hold", version: 1, params: { weight: 0.5 },
    rule: "Move to 50/50 once, then never trade.",
    target: (x) => (x.history.some((h) => h.outcome?.status === "traded") ? null : 0.5),
  },
  {
    id: "luck", version: 1, params: { p_trade: 0.25, seed: "iron-trade-luck-v1" },
    rule: "Random trades under the same limits: each tick, with probability 0.25, buy or sell 10-50% of the cap. "
      + "The randomness is sha256(seed|vault|as_of hour|last decision time), so it is published and repeatable.",
    target: () => null, // decided in decide(): it sizes from the cap, not a weight
  },
];

export const strategyById = (id: string): Strategy => {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown strategy ${id} (${STRATEGIES.map((x) => x.id).join(" | ")})`);
  return s;
};

/** sha256 of this file: the exact rules in force, part of every strategy hash. */
export const RULES_SOURCE_SHA256 = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");

/** The published spec; its sha256 is the strategy hash recorded as prompt_sha256 in every receipt. */
export function spec(s: Strategy): Json {
  return { kind: "iron-trade-rules", id: s.id, version: s.version, rule: s.rule, params: s.params, source_sha256: RULES_SOURCE_SHA256,
    min_trade: MIN_TRADE, decimals: DP };
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

/** The decision for one tick. Pure: same input and vault, same output. `vault` seeds the luck baseline. */
export function decide(s: Strategy, x: RuleInput, vault: string): Decision {
  const p = Number(x.reference_price?.price);
  if (!(p > 0)) return hold("no_price");
  const { base, quote } = x.vault;
  const b = Number(x.vault.balances[base] ?? "0");
  const q = Number(x.vault.balances[quote] ?? "0");
  const value = b * p + q;
  if (!(value > 0)) return hold("empty_vault");
  const w = (b * p) / value;

  if (s.id === "luck") {
    const last = x.history.length ? x.history[x.history.length - 1].ts ?? "" : "";
    const [u1, u2, u3] = uniforms(`${s.params.seed}|${vault}|${x.market?.as_of ?? ""}|${last}`);
    if (u1 >= Number(s.params.p_trade)) return hold("luck_no_trade");
    const buy = u2 < 0.5;
    const frac = 0.1 + 0.4 * u3;
    const amount = buy ? Math.min(q, room(x, quote) * frac) : Math.min(b, room(x, base) * frac);
    const a = floorDp(amount);
    return a === "0" ? hold("cap_or_balance_empty") : { action: buy ? "buy" : "sell", amount_in: a, reason: `luck ${buy ? "buy" : "sell"}` };
  }

  const t = s.target(x, w);
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
