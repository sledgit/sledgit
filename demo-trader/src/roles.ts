// The demo-trader desk: screener -> analyst -> risk -> budget, then the broker is the vault itself (arena.ts tick:
// preview_swap, then request_swap or log_skip, with a receipt either way). Pure: the decision is a function of the
// tick's recorded inputs, so anyone can re-run a receipt. A signal to test, not a claim that it beats holding.
import type { Decision } from "../../agent/src/decision.js";

/** Published parameters; their hash is part of the prompt hash every receipt records. */
export const PARAMS = {
  sma_fast: 20,
  sma_slow: 50,
  /** Target NEAR weight when the desk is bullish / bearish. Tilts, never all in or all out. */
  weight_up: 0.7,
  weight_down: 0.3,
  /** Kronos agrees when this share of sample paths ends above (or below) the last close, and the median moves this much. */
  kronos_share: 0.625,
  kronos_min_move_pct: 0.5,
  /** At most this share of the vault per decision, and nothing below min_trade of it (gas for noise). */
  max_step: 0.25,
  min_trade: 0.02,
  decimals: 6,
} as const;

export type Candle = [number, string, string, string];
export interface KronosSignal { median_close: number; last_close: number; change_pct: number; up_share: number; paths: number; pred_len: number }

/** The parts of the tick inputs (agent/src/arena.ts) the desk reads. */
export interface DeskInput {
  reference_price: { price: string } | null;
  vault: {
    base: string; quote: string; busy: boolean;
    balances: Record<string, string>;
    policy: { tokens: { token: string; max_per_trade: string; max_per_day: string }[]; max_trades_per_hour: number };
    usage: { trades_this_hour: number; spent_24h: Record<string, string> };
  };
  market?: {
    daily?: { candles: Candle[] };
    kronos?: { status: "ok"; forecast: KronosSignal } | { status: "unavailable"; code: string } | { status: "off" };
  };
}

export type View = "up" | "down" | "flat";
export interface Trace { screener: string; analyst: string; risk: string; budget: string }

const hold = (t: Partial<Trace>, why: string): { decision: Decision; trace: Partial<Trace> } =>
  ({ decision: { action: "hold", amount_in: "0", reason: line({ ...t }, why) }, trace: t });

/** One line, under the 200-character reason limit: each role's verdict in order. */
function line(t: Partial<Trace>, tail: string): string {
  return [t.screener && `screen ${t.screener}`, t.analyst && `analyst ${t.analyst}`, t.risk && `risk ${t.risk}`, t.budget && `budget ${t.budget}`, tail]
    .filter(Boolean).join(" | ").slice(0, 200);
}

const sma = (c: number[], n: number) => c.slice(-n).reduce((a, b) => a + b, 0) / n;

export function trendView(candles: Candle[]): { view: View; note: string } {
  const c = candles.map((k) => Number(k[3]));
  const last = c[c.length - 1];
  const fast = sma(c, PARAMS.sma_fast), slow = sma(c, PARAMS.sma_slow);
  if (last > fast && fast > slow) return { view: "up", note: "trend up" };
  if (last < fast && fast < slow) return { view: "down", note: "trend down" };
  return { view: "flat", note: "trend mixed" };
}

export function kronosView(k: KronosSignal): { view: View; note: string } {
  const pct = `${Math.round(k.up_share * 100)}% up ${k.change_pct >= 0 ? "+" : ""}${k.change_pct.toFixed(1)}%`;
  if (k.up_share >= PARAMS.kronos_share && k.change_pct >= PARAMS.kronos_min_move_pct) return { view: "up", note: `kronos ${pct}` };
  if (k.up_share <= 1 - PARAMS.kronos_share && k.change_pct <= -PARAMS.kronos_min_move_pct) return { view: "down", note: `kronos ${pct}` };
  return { view: "flat", note: `kronos ${pct}` };
}

const floorDp = (n: number): string => {
  const f = Math.floor(n * 10 ** PARAMS.decimals) / 10 ** PARAMS.decimals;
  return f > 0 ? f.toFixed(PARAMS.decimals).replace(/\.?0+$/, "") : "0";
};

/** Room under the token's per-trade and rolling 24 h caps, in token units. */
function room(x: DeskInput, token: string): number {
  const t = x.vault.policy.tokens.find((p) => p.token === token);
  if (!t) return 0;
  return Math.max(0, Math.min(Number(t.max_per_trade), Number(t.max_per_day) - Number(x.vault.usage.spent_24h[token] ?? "0")));
}

/** `useKronos`: the desk was started with the Kronos signal, so it needs one (fails closed to hold without it). */
export function desk(x: DeskInput, useKronos: boolean): { decision: Decision; trace: Partial<Trace> } {
  // Screener: is there a clean market and a vault that can act?
  const t: Partial<Trace> = {};
  const candles = x.market?.daily?.candles ?? [];
  const p = Number(x.reference_price?.price);
  if (candles.length < PARAMS.sma_slow) return hold({ screener: "no_history" }, "hold");
  if (!(p > 0)) return hold({ screener: "no_price" }, "hold");
  if (x.vault.busy) return hold({ screener: "vault_busy" }, "hold");
  const b = Number(x.vault.balances[x.vault.base] ?? "0"), q = Number(x.vault.balances[x.vault.quote] ?? "0");
  const value = b * p + q;
  if (!(value > 0)) return hold({ screener: "empty_vault" }, "hold");
  t.screener = "ok";

  // Analyst: daily trend, and when Kronos is on, both must agree.
  const tr = trendView(candles);
  let view = tr.view, note = tr.note;
  if (useKronos) {
    const k = x.market?.kronos;
    if (!k || k.status !== "ok") return hold({ ...t, analyst: `kronos_${k?.status === "unavailable" ? k.code : "missing"}` }, "hold");
    const kv = kronosView(k.forecast);
    note = `${tr.note}, ${kv.note}`;
    if (kv.view !== tr.view) view = "flat";
  }
  t.analyst = `${note} -> ${view}`;
  if (view === "flat") return hold(t, "hold");

  // Risk: the vault enforces the caps; the desk only refuses what it already knows would be refused.
  const w = (b * p) / value;
  const target = view === "up" ? PARAMS.weight_up : PARAMS.weight_down;
  // Only ever in the view's direction: a down view never buys NEAR because the vault is under 0.3.
  const buy = view === "up";
  if (buy ? w >= target : w <= target) return hold({ ...t, budget: `at_target w=${w.toFixed(2)}` }, "hold");
  if (x.vault.usage.trades_this_hour >= x.vault.policy.max_trades_per_hour) return hold({ ...t, risk: "hourly_limit" }, "hold");
  const capRoom = buy ? room(x, x.vault.quote) : room(x, x.vault.base);
  if (!(capRoom > 0)) return hold({ ...t, risk: "cap_used" }, "hold");
  t.risk = "ok";

  // Budget: toward the target, at most max_step of the vault, within balance and caps.
  const gapUsd = Math.min(Math.abs(target - w), PARAMS.max_step) * value;
  if (gapUsd < PARAMS.min_trade * value) return hold({ ...t, budget: `at_target w=${w.toFixed(2)}` }, "hold");
  // The gap is float arithmetic (0.2 * 5 = 0.99999...); balances and caps are exact, so each is floored on its own.
  const gap = buy ? gapUsd : gapUsd / p;
  const a = floorDp(Math.min(Number(floorDp(gap + 1e-9)), Number(floorDp(buy ? q : b)), Number(floorDp(capRoom))));
  if (a === "0") return hold({ ...t, budget: "nothing_to_spend" }, "hold");
  t.budget = `${buy ? "buy" : "sell"} ${a} w=${w.toFixed(2)}->${target}`;
  return { decision: { action: buy ? "buy" : "sell", amount_in: a, reason: line(t, "to broker") }, trace: t };
}
