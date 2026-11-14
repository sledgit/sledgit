// The owner's form ↔ the vault's Policy, exactly. validatePolicy mirrors Policy::validate in
// contracts/vault/src/policy.rs, so a form the site accepts is one the contract accepts.
import type { Token } from "../networks";
import { formatUnits, parseUnits, priceRatio, ratioPrice } from "./units";

export interface PolicyForm {
  tradeBase: string; dayBase: string;     // wNEAR caps, human units
  tradeQuote: string; dayQuote: string;   // USDC caps, human units
  sellFloor: string;                      // lowest USDC per wNEAR a sale may fill at
  buyFloor: string;                       // lowest wNEAR per USDC a purchase may fill at
  tradesPerHour: string; slippageBps: string;
}
export interface TokenLimitArgs { token: string; max_per_trade: string; max_per_day: string }
export interface PairArgs { token_in: string; token_out: string; pool_id: number; min_price_num: string; min_price_den: string }
export interface PolicyArgs { tokens: TokenLimitArgs[]; pairs: PairArgs[]; max_trades_per_hour: number; max_slippage_bps: number }
export interface PolicySpec { base: Token; quote: Token; pool: number }

const U128_MAX = (1n << 128n) - 1n;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const validAccount = (a: string) => a.length >= 2 && a.length <= 64 && ACCOUNT.test(a);

const int = (s: string, name: string, lo: number, hi: number, errors: string[]): number => {
  if (!/^(0|[1-9][0-9]*)$/.test(s.trim())) { errors.push(`${name}: a whole number`); return 0; }
  const n = Number(s.trim());
  if (n < lo || n > hi) errors.push(`${name}: between ${lo} and ${hi}`);
  return n;
};

/** `prev`: the vault's current policy. When a floor field still shows the value formFromPolicy derived from it, the exact
 *  on-chain num/den is kept, so re-proposing an untouched form never lowers a floor through rounding. */
export function buildPolicy(f: PolicyForm, spec: PolicySpec, prev?: PolicyArgs): { policy?: PolicyArgs; errors: string[] } {
  const errors: string[] = [];
  const amount = (s: string, t: Token, what: string) => {
    try { return parseUnits(s, t.decimals); } catch (e) { errors.push(`${what}: ${(e as Error).message}`); return 0n; }
  };
  const ratio = (s: string, a: Token, b: Token, what: string) => {
    try { return priceRatio(s, a.decimals, b.decimals); } catch (e) { errors.push(`${what}: ${(e as Error).message}`); return { num: 0n, den: 1n }; }
  };
  const tb = amount(f.tradeBase, spec.base, `${spec.base.symbol} per trade`), db = amount(f.dayBase, spec.base, `${spec.base.symbol} per 24 h`);
  const tq = amount(f.tradeQuote, spec.quote, `${spec.quote.symbol} per trade`), dq = amount(f.dayQuote, spec.quote, `${spec.quote.symbol} per 24 h`);
  const keep = (a: Token, b: Token, shown: string) => {
    const q = prev?.pairs.find(x => x.token_in === a.id && x.token_out === b.id);
    return q && ratioPrice(BigInt(q.min_price_num), BigInt(q.min_price_den), a.decimals, b.decimals) === shown.trim()
      ? { num: BigInt(q.min_price_num), den: BigInt(q.min_price_den) } : undefined;
  };
  const sell = keep(spec.base, spec.quote, f.sellFloor) ?? ratio(f.sellFloor, spec.base, spec.quote, "sell floor");
  const buy = keep(spec.quote, spec.base, f.buyFloor) ?? ratio(f.buyFloor, spec.quote, spec.base, "buy floor");
  const tph = int(f.tradesPerHour, "trades per hour", 1, 60, errors);
  const bps = int(f.slippageBps, "slippage", 0, 500, errors);
  const policy: PolicyArgs = {
    tokens: [
      { token: spec.base.id, max_per_trade: tb.toString(), max_per_day: db.toString() },
      { token: spec.quote.id, max_per_trade: tq.toString(), max_per_day: dq.toString() },
    ],
    pairs: [
      { token_in: spec.base.id, token_out: spec.quote.id, pool_id: spec.pool, min_price_num: sell.num.toString(), min_price_den: sell.den.toString() },
      { token_in: spec.quote.id, token_out: spec.base.id, pool_id: spec.pool, min_price_num: buy.num.toString(), min_price_den: buy.den.toString() },
    ],
    max_trades_per_hour: tph, max_slippage_bps: bps,
  };
  if (errors.length) return { errors };
  const v = validatePolicy(policy);
  return v.length ? { errors: v } : { policy, errors: [] };
}

/** The contract's Policy::validate, plus the u128 bound the JSON strings must respect. */
export function validatePolicy(p: PolicyArgs): string[] {
  const e: string[] = [];
  const big = (s: string, what: string) => {
    if (!/^(0|[1-9][0-9]*)$/.test(s)) { e.push(`${what}: not an integer string`); return 0n; }
    const v = BigInt(s); if (v > U128_MAX) e.push(`${what}: above u128`); return v;
  };
  if (p.tokens.length < 1 || p.tokens.length > 8) e.push("policy: 1-8 tokens");
  if (p.pairs.length < 1 || p.pairs.length > 16) e.push("policy: 1-16 pairs");
  if (!Number.isInteger(p.max_trades_per_hour) || p.max_trades_per_hour < 1 || p.max_trades_per_hour > 60) e.push("policy: 1-60 trades per hour");
  if (!Number.isInteger(p.max_slippage_bps) || p.max_slippage_bps < 0 || p.max_slippage_bps > 500) e.push("policy: slippage above 5%");
  p.tokens.forEach((t, i) => {
    if (!validAccount(t.token)) e.push(`policy: bad token id ${t.token}`);
    const trade = big(t.max_per_trade, `${t.token} per trade`), day = big(t.max_per_day, `${t.token} per 24 h`);
    if (trade === 0n) e.push("policy: zero per-trade cap");
    if (trade > day) e.push("policy: per-trade cap above daily cap");
    if (p.tokens.slice(0, i).some(u => u.token === t.token)) e.push("policy: duplicate token");
  });
  p.pairs.forEach((q, i) => {
    if (q.token_in === q.token_out) e.push("policy: pair trades a token for itself");
    if (!p.tokens.some(t => t.token === q.token_in) || !p.tokens.some(t => t.token === q.token_out)) e.push("policy: pair token not in tokens");
    if (!Number.isInteger(q.pool_id) || q.pool_id < 0) e.push("policy: bad pool id");
    if (big(q.min_price_num, "price num") === 0n || big(q.min_price_den, "price den") === 0n) e.push("policy: pair needs a price band");
    if (p.pairs.slice(0, i).some(r => r.token_in === q.token_in && r.token_out === q.token_out)) e.push("policy: duplicate pair");
  });
  return e;
}

/** A policy read from the chain, back in human units for display (and for prefilling a change). */
export function describePolicy(p: PolicyArgs, tokens: Token[]): { caps: { symbol: string; trade: string; day: string }[]; bands: string[] } {
  const tok = (id: string) => tokens.find(t => t.id === id);
  return {
    caps: p.tokens.map(t => {
      const k = tok(t.token);
      return k ? { symbol: k.symbol, trade: formatUnits(BigInt(t.max_per_trade), k.decimals), day: formatUnits(BigInt(t.max_per_day), k.decimals) }
        : { symbol: t.token, trade: `${t.max_per_trade} (raw)`, day: `${t.max_per_day} (raw)` };
    }),
    bands: p.pairs.map(q => {
      const a = tok(q.token_in), b = tok(q.token_out);
      if (!a || !b) return `${q.token_in} → ${q.token_out}: ${q.min_price_num}/${q.min_price_den} (raw), pool ${q.pool_id}`;
      return `${a.symbol} → ${b.symbol}: at least ${ratioPrice(BigInt(q.min_price_num), BigInt(q.min_price_den), a.decimals, b.decimals)} ${b.symbol} per ${a.symbol}, pool ${q.pool_id}`;
    }),
  };
}

export function formFromPolicy(p: PolicyArgs, spec: PolicySpec): PolicyForm | null {
  const lim = (id: string) => p.tokens.find(t => t.token === id);
  const pair = (a: string, b: string) => p.pairs.find(q => q.token_in === a && q.token_out === b);
  const b = lim(spec.base.id), q = lim(spec.quote.id), s = pair(spec.base.id, spec.quote.id), u = pair(spec.quote.id, spec.base.id);
  // Only a policy the form can represent exactly: these two tokens, these two pairs, on this pool. Anything else would be
  // silently rewritten by a proposal from the form, so it's left to the CLI.
  if (!b || !q || !s || !u || p.tokens.length !== 2 || p.pairs.length !== 2 || s.pool_id !== spec.pool || u.pool_id !== spec.pool) return null;
  return {
    tradeBase: formatUnits(BigInt(b.max_per_trade), spec.base.decimals), dayBase: formatUnits(BigInt(b.max_per_day), spec.base.decimals),
    tradeQuote: formatUnits(BigInt(q.max_per_trade), spec.quote.decimals), dayQuote: formatUnits(BigInt(q.max_per_day), spec.quote.decimals),
    sellFloor: ratioPrice(BigInt(s.min_price_num), BigInt(s.min_price_den), spec.base.decimals, spec.quote.decimals),
    buyFloor: ratioPrice(BigInt(u.min_price_num), BigInt(u.min_price_den), spec.quote.decimals, spec.base.decimals),
    tradesPerHour: String(p.max_trades_per_hour), slippageBps: String(p.max_slippage_bps),
  };
}

export interface PolicyChange { field: string; from: string; to: string; weaker: boolean; loud: boolean }

/** Every difference between the current and a proposed policy, each marked weaker (less protection) or not. Loud: a
 *  floor lowered by more than 10% or removed from a pair, a cap more than doubled, a new token or pair, a pool changed. */
export function diffPolicy(cur: PolicyArgs, next: PolicyArgs, tokens: Token[]): PolicyChange[] {
  const out: PolicyChange[] = [];
  const tok = (id: string) => tokens.find(t => t.id === id);
  const amt = (v: string, id: string) => { const k = tok(id); return k ? `${formatUnits(BigInt(v), k.decimals)} ${k.symbol}` : `${v} (raw)`; };
  const name = (id: string) => tok(id)?.symbol ?? id;
  for (const t of new Set([...cur.tokens.map(x => x.token), ...next.tokens.map(x => x.token)])) {
    const a = cur.tokens.find(x => x.token === t), b = next.tokens.find(x => x.token === t);
    if (!a && b) { out.push({ field: `${name(t)}: new token`, from: "not tradable", to: `${amt(b.max_per_trade, t)} / trade · ${amt(b.max_per_day, t)} / 24 h`, weaker: true, loud: true }); continue; }
    if (a && !b) { out.push({ field: `${name(t)}: token removed`, from: `${amt(a.max_per_trade, t)} / trade`, to: "not tradable", weaker: false, loud: false }); continue; }
    for (const k of ["max_per_trade", "max_per_day"] as const) {
      const x = BigInt(a![k]), y = BigInt(b![k]);
      if (x !== y) out.push({ field: `${name(t)} ${k === "max_per_trade" ? "per trade" : "per 24 h"}`, from: amt(a![k], t), to: amt(b![k], t), weaker: y > x, loud: y > 2n * x });
    }
  }
  const key = (q: PairArgs) => `${q.token_in}>${q.token_out}`;
  for (const k of new Set([...cur.pairs.map(key), ...next.pairs.map(key)])) {
    const a = cur.pairs.find(q => key(q) === k), b = next.pairs.find(q => key(q) === k);
    const [i, o] = k.split(">");
    const label = `${name(i)} → ${name(o)}`;
    const floor = (q: PairArgs) => { const x = tok(q.token_in), y = tok(q.token_out);
      return x && y ? `${ratioPrice(BigInt(q.min_price_num), BigInt(q.min_price_den), x.decimals, y.decimals)} ${y.symbol} per ${x.symbol}` : `${q.min_price_num}/${q.min_price_den} (raw)`; };
    if (!a && b) { out.push({ field: `${label}: new pair`, from: "not allowed", to: `pool ${b.pool_id}, floor ${floor(b)}`, weaker: true, loud: true }); continue; }
    if (a && !b) { out.push({ field: `${label}: pair removed`, from: `pool ${a.pool_id}`, to: "not allowed", weaker: false, loud: false }); continue; }
    if (a!.pool_id !== b!.pool_id) out.push({ field: `${label} pool`, from: `pool ${a!.pool_id}`, to: `pool ${b!.pool_id}`, weaker: true, loud: true });
    // floor a/b vs c/d: lower if c*b < a*d
    const an = BigInt(a!.min_price_num), ad = BigInt(a!.min_price_den), bn = BigInt(b!.min_price_num), bd = BigInt(b!.min_price_den);
    if (an * bd !== bn * ad) {
      const lower = bn * ad < an * bd;
      out.push({ field: `${label} price floor`, from: floor(a!), to: floor(b!), weaker: lower, loud: lower && bn * ad * 10n < an * bd * 9n });
    }
  }
  if (cur.max_trades_per_hour !== next.max_trades_per_hour) out.push({ field: "trades per hour", from: String(cur.max_trades_per_hour), to: String(next.max_trades_per_hour),
    weaker: next.max_trades_per_hour > cur.max_trades_per_hour, loud: next.max_trades_per_hour > 2 * cur.max_trades_per_hour });
  if (cur.max_slippage_bps !== next.max_slippage_bps) out.push({ field: "max slippage", from: `${cur.max_slippage_bps} bps`, to: `${next.max_slippage_bps} bps`,
    weaker: next.max_slippage_bps > cur.max_slippage_bps, loud: next.max_slippage_bps > cur.max_slippage_bps });
  return out;
}
