// Strategy profiles for the wider board's vault pages: what an account's public trades show about how it trades. Pure
// functions only. Hyperliquid's are computed in the browser from live fills; Polymarket's in the daily pull (the adapter
// fetches, pmProfile reshapes). Every reply is untrusted: numbers may be missing, text is cleaned and capped. This is
// inferred from trades; it is never the account's stated strategy.
import { DAY, isAddress, num, plainText } from "./wider";

// ---------------------------------------------------------------- Hyperliquid: replies

/** userFills returns at most 2000 of the latest fills; more than that is never read. */
export const MAX_FILLS = 2000;
export const MAX_POSITIONS = 200;

/** One fill, checked. sz is unsigned; side B buys, A sells. startPosition is the coin's position before the fill. */
export interface HlFill { coin: string; px: number; sz: number; side: "B" | "A"; time: number; startPosition: number; dir: string; crossed: boolean; fee: number | null; closedPnl: number | null; oid: number | null }

/** A userFills reply as checked fills, newest first as the API sends them; malformed rows are dropped and counted. */
export function hlFills(raw: unknown, max = MAX_FILLS): { fills: HlFill[]; dropped: number } {
  if (!Array.isArray(raw)) throw new Error("userFills: not an array");
  const fills: HlFill[] = [];
  let dropped = 0;
  for (const x of raw.slice(0, max)) {
    const r = x as Record<string, unknown> | null;
    const coin = plainText(r?.coin, 24, false), px = num(r?.px), sz = num(r?.sz), time = num(r?.time), p0 = num(r?.startPosition);
    if (!coin || px === null || px <= 0 || sz === null || sz <= 0 || time === null || p0 === null || (r?.side !== "B" && r?.side !== "A")) { dropped++; continue; }
    fills.push({ coin, px, sz, side: r.side, time, startPosition: p0, dir: plainText(r.dir, 24, false), crossed: r.crossed === true,
      fee: num(r.fee), closedPnl: num(r.closedPnl), oid: num(r.oid) });
  }
  return { fills, dropped: dropped + Math.max(0, raw.length - max) };
}

/** One open perp position. size is signed: positive long, negative short. */
export interface HlPosition { coin: string; size: number; entry: number | null; leverage: number | null; levType: string; value: number | null; upnl: number | null; liq: number | null }
export interface HlState { accountValue: number | null; notional: number | null; time: number | null; positions: HlPosition[] }

/** A clearinghouseState reply, checked. Positions without a coin or a size are dropped. */
export function hlState(raw: unknown): HlState {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("clearinghouseState: not an object");
  const m = r.marginSummary as Record<string, unknown> | undefined;
  const ps = Array.isArray(r.assetPositions) ? r.assetPositions.slice(0, MAX_POSITIONS) : [];
  const positions = ps.flatMap((x): HlPosition[] => {
    const p = (x as { position?: Record<string, unknown> } | null)?.position;
    const coin = plainText(p?.coin, 24, false), size = num(p?.szi);
    if (!p || !coin || size === null || size === 0) return [];
    const lev = p.leverage as { type?: unknown; value?: unknown } | undefined;
    return [{ coin, size, entry: num(p.entryPx), leverage: num(lev?.value), levType: lev?.type === "cross" || lev?.type === "isolated" ? lev.type : "",
      value: num(p.positionValue), upnl: num(p.unrealizedPnl), liq: num(p.liquidationPx) }];
  });
  return { accountValue: num(m?.accountValue), notional: num(m?.totalNtlPos), time: num(r.time), positions };
}

// ---------------------------------------------------------------- Hyperliquid: inferred style

export interface CoinShare { coin: string; share: number }

export interface TradeStyle {
  fills: number;
  /** Distinct orders among the fills: one order can fill in many pieces. */
  orders: number;
  fromMs: number | null;
  toMs: number | null;
  volumeUsd: number;
  /** Share of traded notional on the long side of zero (a flip through zero is split at zero). Null with no volume. */
  longShare: number | null;
  /** Share of traded notional that crossed the book (taker). */
  takerShare: number | null;
  /** Every coin by its share of traded notional, largest first (at most 50). */
  coins: CoinShare[];
  nCoins: number;
  /** Orders per day over the sampled window; null when the window is under a day. */
  perDay: number | null;
  /** Median time from opening a position (from flat) to closing it (to flat, or a flip), for round trips seen whole. */
  medianHoldMs: number | null;
  roundTrips: number;
  /** Share of new positions on the opposite side to the coin's previous position; null when none had a previous one. */
  flipRate: number | null;
  /** New positions opened after an earlier one on the same coin: flipRate's denominator. */
  reopens: number;
  /** Leverage from the open positions: notional-weighted mean and max of the set leverage, and gross notional / value. */
  avgLev: number | null;
  maxLev: number | null;
  grossLev: number | null;
  openPositions: number;
  summary: string;
}

const sgn = (x: number, eps: number) => (x > eps ? 1 : x < -eps ? -1 : 0);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Words for a share: "all" at 99% or more, "mostly" from 65%, else "mixed". */
const lean = (s: number | null, a: string, b: string, both: string) =>
  s === null ? null : s >= 0.99 ? `all ${a}` : s >= 0.65 ? `mostly ${a}` : s <= 0.01 ? `all ${b}` : s <= 0.35 ? `mostly ${b}` : both;

/** The style in one plain line: "Mostly short, all taker, ~5x, 12 coins". */
export function styleLine(s: Pick<TradeStyle, "fills" | "longShare" | "takerShare" | "avgLev" | "nCoins" | "openPositions">): string {
  if (!s.fills) return "No fills in the sample";
  const lev = s.avgLev !== null ? `~${s.avgLev < 1.5 ? 1 : Math.round(s.avgLev)}x` : s.openPositions ? null : "no open positions";
  const parts = [lean(s.longShare, "long", "short", "long and short"), lean(s.takerShare, "taker", "maker", "maker and taker"), lev, `${s.nCoins} coin${s.nCoins === 1 ? "" : "s"}`];
  const line = parts.filter(Boolean).join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * How an account trades, from its fills (any order) and, for leverage, its open positions. Long and short come from the
 * position each fill moves through: the part of the move above zero is long, below zero short. Round trips and flips are
 * tracked per coin in time order; a position already open when the sample starts has no known opening time, so its
 * close is not a round trip.
 */
export function tradeStyle(fills: HlFill[], state: HlState | null = null): TradeStyle {
  const fs = fills.filter(f => [f.px, f.sz, f.time, f.startPosition].every(Number.isFinite)).map((f, i) => ({ f, i }))
    // Oldest first; the reply is newest first, so equal times keep the reverse of their reply order.
    .sort((a, b) => a.f.time - b.f.time || b.i - a.i).map(x => x.f);
  let vol = 0, long = 0, taker = 0;
  const byCoin = new Map<string, number>(), orders = new Set<number | string>();
  const track = new Map<string, { openAt: number | null; last: number }>();
  const holds: number[] = [];
  let opens = 0, flips = 0;
  for (const [k, f] of fs.entries()) {
    const s = f.side === "B" ? f.sz : -f.sz, p0 = f.startPosition, p1 = p0 + s, usd = f.px * f.sz;
    const lo = Math.min(p0, p1), hi = Math.max(p0, p1);
    vol += usd;
    long += hi > lo ? (usd * (Math.max(hi, 0) - Math.max(lo, 0))) / (hi - lo) : 0;
    if (f.crossed) taker += usd;
    byCoin.set(f.coin, (byCoin.get(f.coin) ?? 0) + usd);
    orders.add(f.oid ?? `fill-${k}`);
    // Flat means within a billionth of the sizes involved, so float residue never reads as a position.
    const eps = 1e-9 * Math.max(1, Math.abs(p0), f.sz), a = sgn(p0, eps), b = sgn(p1, eps);
    const t = track.get(f.coin) ?? { openAt: null, last: 0 };
    if (a !== 0 && b !== a) {
      if (t.openAt !== null) holds.push(f.time - t.openAt);
      t.openAt = null; t.last = a;
    }
    if (b !== 0 && b !== a) {
      if (t.last !== 0) { opens++; if (b !== t.last) flips++; }
      t.openAt = f.time;
    }
    track.set(f.coin, t);
  }
  const coins = [...byCoin].map(([coin, v]) => ({ coin, share: vol > 0 ? v / vol : 0 })).sort((a, b) => b.share - a.share);
  const fromMs = fs.length ? fs[0].time : null, toMs = fs.length ? fs[fs.length - 1].time : null;
  const days = fromMs !== null && toMs !== null ? (toMs - fromMs) / DAY : 0;
  const pos = state?.positions ?? [];
  const lev = pos.filter(p => p.leverage !== null && p.leverage > 0);
  const w = lev.map(p => Math.abs(p.value ?? (p.entry ?? 0) * p.size)), wsum = w.reduce((x, y) => x + y, 0);
  const avgLev = !lev.length ? null : wsum > 0 ? lev.reduce((x, p, i) => x + p.leverage! * w[i], 0) / wsum : lev.reduce((x, p) => x + p.leverage!, 0) / lev.length;
  const av = state?.accountValue ?? null, ntl = state?.notional ?? null;
  const out = {
    fills: fs.length, orders: orders.size, fromMs, toMs, volumeUsd: vol,
    longShare: vol > 0 ? long / vol : null, takerShare: vol > 0 ? taker / vol : null,
    coins: coins.slice(0, 50), nCoins: coins.length, perDay: days >= 1 ? orders.size / days : null,
    medianHoldMs: median(holds), roundTrips: holds.length, flipRate: opens ? flips / opens : null, reopens: opens,
    avgLev, maxLev: lev.length ? Math.max(...lev.map(p => p.leverage!)) : null,
    grossLev: av !== null && av > 0 && ntl !== null ? ntl / av : null, openPositions: pos.length,
  };
  return { ...out, summary: styleLine(out) };
}

// ---------------------------------------------------------------- Polymarket: profile from the daily pull

/** Trades and positions read per wallet for its profile (one page each). */
export const PM_PROFILE_TRADES = 1000;
export const PM_PROFILE_POSITIONS = 1000;
const TOP_MARKETS = 5;
const CONDITION = /^0x[0-9a-fA-F]{64}$/;

export interface PmProfile {
  asOf: number;
  /** Trades in the sample (the latest page), and whether more exist beyond it. */
  trades: number;
  more: boolean;
  fromMs: number | null;
  toMs: number | null;
  /** Distinct markets in the sample. */
  markets: number;
  /** The largest markets by traded dollars, with their share. */
  largest: { title: string; share: number }[];
  /** Shares of traded dollars: buys; trades on Yes/No outcomes; of those, on Yes. Null with no volume. */
  buyShare: number | null;
  yesNoShare: number | null;
  yesShare: number | null;
  avgTradeUsd: number | null;
  /** Open positions (resolved ones excluded): count (a lower bound when more), mean and total current value. */
  open: { count: number; more: boolean; avgValueUsd: number | null; valueUsd: number | null };
  summary: string;
}

const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
const page = (d: unknown) => {
  const r = d as { data?: unknown; pagination?: { has_more?: unknown } } | null;
  return { rows: Array.isArray(r?.data) ? (r.data as unknown[]) : null, more: r?.pagination?.has_more === true };
};

/** A wallet's latest trades and its positions (Data API v2 replies) as a profile. */
export function pmProfile(trades: unknown, positions: unknown, asOf: number): PmProfile {
  const T = page(trades), P = page(positions);
  if (!T.rows) throw new Error("trades: no data array");
  if (!P.rows) throw new Error("positions: no data array");
  let vol = 0, buy = 0, yn = 0, yes = 0, n = 0, from = Infinity, to = -Infinity;
  const mk = new Map<string, { title: string; usd: number }>();
  for (const x of T.rows.slice(0, PM_PROFILE_TRADES)) {
    const r = x as Record<string, unknown> | null;
    const size = num(r?.size), price = num(r?.price), t = num(r?.timestamp), cid = r?.condition_id;
    if (size === null || size <= 0 || price === null || price < 0 || price > 1 || t === null || typeof cid !== "string" || !CONDITION.test(cid)) continue;
    const usd = size * price, out = plainText(r!.outcome, 40, false).toLowerCase();
    n++; vol += usd; from = Math.min(from, t * 1000); to = Math.max(to, t * 1000);
    if (r!.side === "BUY") buy += usd;
    if (out === "yes" || out === "no") { yn += usd; if (out === "yes") yes += usd; }
    const m = mk.get(cid.toLowerCase()) ?? { title: plainText(r!.title, 120, false), usd: 0 };
    m.usd += usd;
    mk.set(cid.toLowerCase(), m);
  }
  const open = P.rows.slice(0, PM_PROFILE_POSITIONS).flatMap(x => {
    const r = x as Record<string, unknown> | null, v = num(r?.current_value), s = num(r?.current_size);
    return r?.status === "OPEN" && s !== null && s > 0 ? [v ?? 0] : [];
  });
  const valueUsd = open.length ? open.reduce((a, b) => a + b, 0) : null;
  const p: Omit<PmProfile, "summary"> = {
    asOf, trades: n, more: T.more, fromMs: n ? from : null, toMs: n ? to : null, markets: mk.size,
    largest: [...mk.values()].sort((a, b) => b.usd - a.usd).slice(0, TOP_MARKETS).map(m => ({ title: m.title || "(untitled market)", share: r4(vol > 0 ? m.usd / vol : 0)! })),
    buyShare: r4(vol > 0 ? buy / vol : null), yesNoShare: r4(vol > 0 ? yn / vol : null), yesShare: r4(yn > 0 ? yes / yn : null),
    avgTradeUsd: n ? Math.round(vol / n) : null,
    open: { count: open.length, more: P.more, avgValueUsd: open.length ? Math.round(valueUsd! / open.length) : null, valueUsd: valueUsd === null ? null : Math.round(valueUsd) },
  };
  return { ...p, summary: pmLine(p) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The profile in one plain line: "Mostly buys, 70% on Yes, 120 markets, 45 open positions". */
export function pmLine(p: Pick<PmProfile, "trades" | "buyShare" | "yesShare" | "yesNoShare" | "markets" | "open">): string {
  if (!p.trades) return "No trades in the sample";
  const parts = [
    lean(p.buyShare, "buys", "sells", "buys and sells"),
    p.yesShare !== null && (p.yesNoShare ?? 0) >= 0.2 ? `${pct(p.yesShare)} on Yes` : "mostly named outcomes, not Yes/No",
    `${p.markets} market${p.markets === 1 ? "" : "s"}`,
    `${p.open.count}${p.open.more ? "+" : ""} open position${p.open.count === 1 ? "" : "s"}`,
  ];
  const line = parts.filter(Boolean).join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// ---------------------------------------------------------------- the page's ?src=&id= parameters

/** Venues with a vault page, by id and short code, and the shape of their ids. */
const PAGE_IDS: Record<string, { short: string; id: (s: string) => boolean }> = {
  hyperliquid: { short: "hl", id: isAddress },
  polymarket: { short: "pm", id: isAddress },
  dydx: { short: "dydx", id: s => s === "megavault" },
};

/** The page link for a record: /wider/vault/?src=<source>&id=<address>. */
export const vaultHref = (v: { id: string; source: string }) =>
  `/wider/vault/?src=${encodeURIComponent(v.source)}&id=${encodeURIComponent(v.id.slice(v.source.length + 1))}`;

/** A vault page's query, checked before anything is fetched: a known venue and an id of its shape. */
export function parseVaultQuery(src: string | null, id: string | null): { ok: true; source: string; id: string } | { ok: false; error: string } {
  const s = (src ?? "").trim().toLowerCase(), i = (id ?? "").trim().toLowerCase();
  const source = Object.keys(PAGE_IDS).find(k => k === s || PAGE_IDS[k].short === s);
  if (!source) return { ok: false, error: s ? "unknown venue" : "no venue given" };
  if (!PAGE_IDS[source].id(i)) return { ok: false, error: source === "dydx" ? "the only dYdX record is megavault" : "the id must be 0x and 40 hex characters" };
  return { ok: true, source, id: i };
}
