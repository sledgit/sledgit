// The wider board: public trading records from outside NEAR, scored against simple baselines. Pure functions only (no
// network, no clock): the build script (scripts/wider-files.mts) fetches, this module normalises and scores, the page
// only displays. Everything a source returns is untrusted: text is cleaned and capped, numbers are checked.

export const DAY = 86_400_000;
export const MIN_DAYS = 30;
/** Intervals whose starting capital (or Modified Dietz base) is at or below this many dollars are skipped, not scored. */
export const MIN_CAPITAL_USD = 1000;
/** Below this many scored intervals the 95% range is null: not enough data to separate skill from luck. */
export const MIN_RANGE_STEPS = 24;

import type { PmProfile } from "./wider-profile";

// ---------------------------------------------------------------- types

export interface Range95 { lo: number; hi: number; n: number }

/** One point of a record's history: account value and cumulative PnL in USD at time t (ms). */
export interface HistoryPoint { t: number; value: number; pnl: number }

/** What every source adapter produces: one normalised record per vault or wallet. */
export interface SourceRecord {
  id: string;
  source: string;
  /** A pooled vault with depositors, or one trader's own account. */
  kind: "vault" | "trader";
  /** Whether holding BTC is a fair alternative. Not for prediction markets, whose accounts hold USDC-settled positions. */
  btcBaseline: boolean;
  /** How it is scored: a time-weighted return on account value, or dollars only when the venue publishes no usable
   *  account-value history (Polymarket). In dollars, return and drawdown % are null and the range is in USD. */
  basis: "return" | "usd";
  name: string;
  address: string;
  leader: string | null;
  description: string;
  tvl: number;
  createdMs: number | null;
  commission: number | null;
  followers: number | null;
  volumeUsd: number | null;
  nTrades: number | null;
  ai: AiClaim;
  explorer: string;
  /** Polymarket only: a profile from the wallet's latest trades and positions, or why the pull could not build one. */
  profile?: PmProfile | { error: string };
  history: HistoryPoint[];
}

export interface AiClaim { claim: boolean; words: string[]; where: ("name" | "description")[] }

/** One scored vault as the page reads it. series: [t ms, cumulative return, BTC cumulative return or null]. */
export interface WiderVault extends Omit<SourceRecord, "history"> {
  startMs: number;
  endMs: number;
  days: number;
  intervals: number;
  skipped: number;
  /** Time-weighted return; null when scored in dollars. */
  ret: number | null;
  /** Dollar PnL over the same window: can disagree in sign with ret when the capital changed size. */
  pnlUsd: number;
  btc: number | null;
  vsBtc: number | null;
  /** Largest fall from a running peak: of 1 + return as a fraction, or null when scored in dollars. */
  maxDd: number | null;
  /** The same in dollars of cumulative PnL (negative), for records scored in dollars; null otherwise. */
  maxDdUsd: number | null;
  range: { usdc: Range95 | null; btc: Range95 | null };
  ranked: boolean;
  unranked_reason: string | null;
  series: [number, number, number | null][];
}

export interface WiderSource {
  id: string;
  /** Short code for the page URL (?src=hl,pm). */
  short: string;
  label: string;
  kind: "vault" | "trader";
  list_url: string;
  detail_url: string;
  explorer: string;
  baselines: ("usdc" | "btc")[];
}

export interface WiderFile {
  version: 1;
  source: WiderSource;
  fetched_at: string;
  rule: { label: string; ai: string; returns: string; baselines: string; rank: string; range: string; selection: string; survivors: string };
  counts: { listed: number; open: number; eligible: number; requested: number; failed: number; scored: number; ranked: number };
  /** Every listed account by the sign of its all-time PnL in the venue's list: the population the board samples. Null when the venue has no list. */
  population: Population | null;
  /** What the population counts, in a phrase: "listed vaults", "highest-volume wallets". */
  population_label: string;
  failures: { address: string; error: string }[];
  vaults: WiderVault[];
}

/** wider-index.json: which per-source files exist, so the page can load them. */
export interface WiderIndex {
  version: 1;
  sources: { id: string; short: string; label: string; file: string; fetched_at: string; counts: WiderFile["counts"]; bytes: number }[];
}

export interface Population { listed: number; with_pnl: number; negative: number; positive: number; zero: number; closed: number; closed_negative: number }

// ---------------------------------------------------------------- text

const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

/** Plain text from an untrusted string: no tags, no control or bidi characters, collapsed spaces, capped length. */
export function plainText(s: unknown, max: number, newlines = true): string {
  if (typeof s !== "string") return "";
  let t = s.replace(/\r\n?/g, "\n").replace(/<[^>]*>/g, " ").replace(CONTROL, " ").replace(/[ \t]+/g, " ");
  t = newlines ? t.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n") : t.replace(/\s+/g, " ");
  t = t.trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

// ---------------------------------------------------------------- the AI-claim rule

export const AI_RULE = "A vault claims AI when its name or description contains AI as a capitalised word (also at a camel-case boundary, as in AIQuantPulse or FuturAI), or any of the words agent, bot, GPT, LLM, Claude, Qwen, Grok, DeepSeek or Gemini (any case, whole word, plural allowed). The tag means the vault says it is AI, not that it is.";

// "AI" in capitals: not after another capital (MAIN, FAIR), and followed by a non-letter, the end, or a new capitalised word.
const AI_CAPS = /(?<![A-Z])AI(?=$|[^A-Za-z]|[A-Z][a-z])/g;
const AI_WORDS = /(?<![A-Za-z])(agent|bot|gpt|llm|claude|qwen|grok|deepseek|gemini)s?(?![A-Za-z])/gi;
const CANON: Record<string, string> = { agent: "agent", bot: "bot", gpt: "GPT", llm: "LLM", claude: "Claude", qwen: "Qwen", grok: "Grok", deepseek: "DeepSeek", gemini: "Gemini" };

function aiWords(text: string): string[] {
  const out: string[] = [];
  if (text.match(AI_CAPS)) out.push("AI");
  for (const m of text.matchAll(AI_WORDS)) out.push(CANON[m[1].toLowerCase()]);
  return out;
}

/** Whether a name or description claims AI, and which words matched. */
export function aiClaim(name: string, description = ""): AiClaim {
  const n = aiWords(name), d = aiWords(description);
  const words = [...new Set([...n, ...d])];
  const where: AiClaim["where"] = [];
  if (n.length) where.push("name");
  if (d.length) where.push("description");
  return { claim: words.length > 0, words, where };
}

// ---------------------------------------------------------------- returns

export interface Returns {
  /** [t, cumulative return] from the first funded point. */
  points: [number, number][];
  /** log(1 + r) of each scored interval, with its start and end time. */
  steps: { t0: number; t1: number; log: number }[];
  skipped: number;
}

/**
 * Time-weighted return from cumulative PnL, so deposits and withdrawals never count as return. For each interval,
 * r = ΔPnL / (V_prev + F/2), where F = ΔV − ΔPnL is the net flow (Modified Dietz, flows assumed mid-interval). With no
 * flow this is ΔPnL / V_prev. Leading points before the account first holds more than minCapital are not part of the
 * record; later intervals whose base is at or below minCapital are skipped (cumulative return carried flat) and counted,
 * as are intervals that would lose more than their base: impossible for a real account, so the sampling hid a flow.
 */
export function chainReturns(h: HistoryPoint[], minCapital = MIN_CAPITAL_USD): Returns {
  const pts = h.filter(p => Number.isFinite(p.t) && Number.isFinite(p.value) && Number.isFinite(p.pnl)).sort((a, b) => a.t - b.t);
  const first = pts.findIndex(p => p.value > minCapital);
  if (first < 0) return { points: [], steps: [], skipped: 0 };
  let cum = 1, skipped = 0;
  const points: [number, number][] = [[pts[first].t, 0]], steps: Returns["steps"] = [];
  for (let i = first + 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dPnl = b.pnl - a.pnl, flow = b.value - a.value - dPnl, base = a.value + flow / 2;
    const r = dPnl / base;
    if (!(a.value > minCapital) || !(base > minCapital) || r < -1) { skipped++; points.push([b.t, cum - 1]); continue; }
    cum *= 1 + r;
    steps.push({ t0: a.t, t1: b.t, log: r > -1 ? Math.log1p(r) : -Infinity });
    points.push([b.t, cum - 1]);
  }
  return { points, steps, skipped };
}

/** Largest fall from a running peak of 1 + cumulative return, as a negative fraction (0 when it never fell). */
export function maxDrawdown(cum: number[]): number {
  let peak = -Infinity, dd = 0;
  for (const c of cum) { const v = 1 + c; if (v > peak) peak = v; if (peak > 0) dd = Math.min(dd, v / peak - 1); }
  return dd;
}

// ---------------------------------------------------------------- baselines

export interface Candle { t: number; T: number; o: number; c: number }

/** Price at t from daily candles: linear from the open to the close inside the candle; the last close after the last. */
export function priceAt(candles: Candle[], t: number): number | null {
  if (!candles.length || t < candles[0].t) return null;
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (candles[m].t <= t) lo = m; else hi = m - 1; }
  const k = candles[lo];
  if (t >= k.T) return k.c;
  return k.o + ((k.c - k.o) * (t - k.t)) / (k.T - k.t || 1);
}

/** Two-sided Student-t quantile at 97.5% (Cornish-Fisher expansion), the same as the league reader's. */
export function t975(df: number): number {
  const z = 1.959963985;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
}

/**
 * The league reader's 95% range, applied to per-interval excess log returns: Student-t with n−1 degrees of freedom
 * around the observed total, asymmetric (lo, hi). Null below MIN_RANGE_STEPS intervals or with a non-finite step.
 */
export function range95(ex: number[], total: number): Range95 | null {
  if (ex.length < MIN_RANGE_STEPS || !ex.every(Number.isFinite) || !(total > -1)) return null;
  const n = ex.length, m = ex.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(ex.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  const L = Math.log1p(total), w = t975(n - 1) * sd * Math.sqrt(n);
  return { lo: Math.exp(L - w) - 1, hi: Math.exp(L + w) - 1, n };
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r6r = (r: Range95 | null) => (r ? { lo: r6(r.lo), hi: r6(r.hi), n: r.n } : null);

/** Score one record against holding USDC (0%) and holding BTC over the same window. Null when nothing is scorable. */
export function scoreRecord(rec: SourceRecord, candles: Candle[], minDays = MIN_DAYS): WiderVault | null {
  if (rec.basis === "usd") return scoreUsd(rec, minDays);
  const btc = rec.btcBaseline ? candles : [];
  const R = chainReturns(rec.history);
  if (R.points.length < 2) return null;
  const startMs = R.points[0][0], endMs = R.points[R.points.length - 1][0];
  const ret = R.points[R.points.length - 1][1], days = (endMs - startMs) / DAY;
  const pnlAt = (t: number) => rec.history.find(p => p.t === t)?.pnl ?? 0;
  const b0 = priceAt(btc, startMs), b1 = priceAt(btc, endMs);
  const btcRet = b0 && b1 ? b1 / b0 - 1 : null;
  const vsBtc = btcRet === null ? null : (1 + ret) / (1 + btcRet) - 1;
  // Excess over BTC per scored interval; null if any interval falls outside the candles.
  let exBtc: number[] | null = [];
  for (const s of R.steps) {
    const p0 = priceAt(btc, s.t0), p1 = priceAt(btc, s.t1);
    if (!p0 || !p1) { exBtc = null; break; }
    exBtc.push(s.log - Math.log(p1 / p0));
  }
  const why = days < minDays ? `${days.toFixed(0)} days of history; ranking needs ${minDays}` : null;
  const { history: _h, ...meta } = rec;
  return {
    ...meta,
    startMs, endMs, days: r6(days), intervals: R.steps.length, skipped: R.skipped,
    ret: r6(ret), pnlUsd: Math.round(pnlAt(endMs) - pnlAt(startMs)), btc: btcRet === null ? null : r6(btcRet), vsBtc: vsBtc === null ? null : r6(vsBtc),
    maxDd: r6(maxDrawdown(R.points.map(p => p[1]))), maxDdUsd: null,
    range: { usdc: r6r(range95(R.steps.map(s => s.log), ret)), btc: exBtc && vsBtc !== null ? r6r(range95(exBtc, vsBtc)) : null },
    ranked: why === null, unranked_reason: why,
    series: thin(R.points, MAX_SERIES).map(([t, c]) => { const p = b0 ? priceAt(btc, t) : null; return [t, r6(c), p && b0 ? r6(p / b0 - 1) : null]; }),
  };
}

/** The 95% range of a dollar total from its per-interval changes: Student-t, symmetric. Null below MIN_RANGE_STEPS. */
export function rangeUsd(steps: number[], total: number): Range95 | null {
  if (steps.length < MIN_RANGE_STEPS || !steps.every(Number.isFinite)) return null;
  const n = steps.length, m = steps.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(steps.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)), w = t975(n - 1) * sd * Math.sqrt(n);
  return { lo: Math.round(total - w), hi: Math.round(total + w), n };
}

/**
 * Score a record in dollars: PnL over the window against holding USDC ($0), its range from the per-interval changes,
 * and the largest fall of cumulative PnL from its running peak. series: [t, PnL in USD since the start, null].
 */
function scoreUsd(rec: SourceRecord, minDays: number): WiderVault | null {
  const pts = rec.history.filter(p => Number.isFinite(p.t) && Number.isFinite(p.pnl)).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const p0 = pts[0].pnl, cum = pts.map(p => p.pnl - p0), steps = cum.slice(1).map((c, i) => c - cum[i]);
  const startMs = pts[0].t, endMs = pts[pts.length - 1].t, days = (endMs - startMs) / DAY, total = cum[cum.length - 1];
  let peak = -Infinity, dd = 0;
  for (const c of cum) { peak = Math.max(peak, c); dd = Math.min(dd, c - peak); }
  const why = days < minDays ? `${days.toFixed(0)} days of history; ranking needs ${minDays}` : null;
  const { history: _h, ...meta } = rec;
  return {
    ...meta,
    startMs, endMs, days: r6(days), intervals: steps.length, skipped: 0,
    ret: null, pnlUsd: Math.round(total), btc: null, vsBtc: null, maxDd: null, maxDdUsd: Math.round(dd),
    range: { usdc: rangeUsd(steps, total), btc: null },
    ranked: why === null, unranked_reason: why,
    series: thin(pts, MAX_SERIES).map(p => [p.t, Math.round(p.pnl - p0), null]),
  };
}

/** Points kept per chart series: daily histories are thinned (evenly, first and last kept) so each file stays small. */
export const MAX_SERIES = 240;
export function thin<T>(xs: T[], max: number): T[] {
  if (xs.length <= max || max < 2) return xs;
  const step = (xs.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => xs[Math.round(k * step)]);
}

/** Whether a record beat holding USDC: a return above 0%, or for a record scored in dollars a PnL above $0. */
export const beatUsdc = (v: WiderVault) => (v.ret ?? v.pnlUsd) > 0;

/** Ranked first (by return, or PnL for records scored in dollars, then vs BTC), then the rest by days of history. */
export function order(vs: WiderVault[]): WiderVault[] {
  return [...vs].sort((a, b) => Number(b.ranked) - Number(a.ranked) || (a.ranked ? (b.ret ?? b.pnlUsd) - (a.ret ?? a.pnlUsd) : b.days - a.days) || (b.vsBtc ?? -9) - (a.vsBtc ?? -9));
}

// ---------------------------------------------------------------- Hyperliquid normaliser

export const HL = {
  id: "hyperliquid",
  short: "hl",
  label: "Hyperliquid",
  listUrl: "https://stats-data.hyperliquid.xyz/Mainnet/vaults",
  infoUrl: "https://api.hyperliquid.xyz/info",
  explorer: (addr: string) => `https://hypurrscan.io/address/${addr}`,
} as const;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (a: unknown): a is string => typeof a === "string" && ADDR.test(a);
export const num = (x: unknown): number | null => { const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN; return Number.isFinite(n) ? n : null; };

/** One entry of the public vault list, checked. Null when the address or TVL is malformed. */
export interface HlListItem { name: string; address: string; leader: string | null; tvl: number; isClosed: boolean; relationship: string; createdMs: number | null; pnlAllTime: number | null }
export function hlListItem(x: unknown): HlListItem | null {
  const s = (x as { summary?: Record<string, unknown> } | null)?.summary;
  if (!s || !isAddress(s.vaultAddress)) return null;
  const tvl = num(s.tvl);
  if (tvl === null) return null;
  const rel = (s.relationship as { type?: unknown } | undefined)?.type;
  const pnls = (x as { pnls?: unknown }).pnls, all = Array.isArray(pnls) ? pnls.find(p => Array.isArray(p) && p[0] === "allTime") : undefined;
  const pnlAllTime = Array.isArray(all?.[1]) && all[1].length ? num(all[1][all[1].length - 1]) : null;
  return { name: plainText(s.name, 80, false), address: s.vaultAddress.toLowerCase(), leader: isAddress(s.leader) ? s.leader.toLowerCase() : null, tvl,
    isClosed: s.isClosed === true, relationship: typeof rel === "string" ? rel : "unknown", createdMs: num(s.createTimeMillis), pnlAllTime };
}

/** The whole list by the sign of each vault's all-time PnL (closed vaults included). */
export function population(list: HlListItem[]): Population {
  const w = list.filter(x => x.pnlAllTime !== null), neg = (x: HlListItem) => (x.pnlAllTime ?? 0) < 0;
  return { listed: list.length, with_pnl: w.length, negative: w.filter(neg).length, positive: w.filter(x => x.pnlAllTime! > 0).length,
    zero: w.filter(x => x.pnlAllTime === 0).length, closed: list.filter(x => x.isClosed).length, closed_negative: w.filter(x => x.isClosed && neg(x)).length };
}

/** A vaultDetails reply as a SourceRecord, from its allTime pnlHistory and accountValueHistory (matched by timestamp). */
export function hlRecord(item: HlListItem, d: unknown): SourceRecord {
  const v = d as Record<string, unknown>;
  if (!v || typeof v !== "object") throw new Error("vaultDetails: not an object");
  const portfolio = Array.isArray(v.portfolio) ? (v.portfolio as unknown[]) : [];
  const all = portfolio.find(p => Array.isArray(p) && p[0] === "allTime") as [string, Record<string, unknown>] | undefined;
  if (!all) throw new Error("vaultDetails: no allTime portfolio");
  const pairs = (k: string) => (Array.isArray(all[1][k]) ? (all[1][k] as unknown[]) : [])
    .map(p => (Array.isArray(p) ? [num(p[0]), num(p[1])] : [null, null]))
    .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
  const values = new Map(pairs("accountValueHistory"));
  const history = pairs("pnlHistory").filter(([t]) => values.has(t)).map(([t, pnl]) => ({ t, value: values.get(t)!, pnl }));
  const name = plainText(v.name, 80, false) || item.name;
  const description = plainText(v.description, 600);
  const commission = num(v.leaderCommission);
  return {
    id: `${HL.id}:${item.address}`, source: HL.id, kind: "vault", btcBaseline: true, basis: "return", name, address: item.address,
    leader: isAddress(v.leader) ? v.leader.toLowerCase() : item.leader, description, tvl: item.tvl, createdMs: item.createdMs,
    commission: commission !== null && commission >= 0 && commission <= 1 ? commission : null,
    // The API returns at most 100 followers, so 100 means "100 or more".
    followers: Array.isArray(v.followers) ? v.followers.length : null,
    volumeUsd: num(all[1].vlm), nTrades: null,
    ai: aiClaim(name, description), explorer: HL.explorer(item.address), history,
  };
}

// ---------------------------------------------------------------- venue filter (the page's ?src= parameter)

export interface Venue { id: string; short: string }

/** The venues a ?src= value selects: short codes or ids, comma-separated; unknown ones ignored. Absent or all-unknown means
 *  every venue; "none" means none. */
export function parseSrc(q: string | null, venues: Venue[]): string[] {
  if (q === null) return venues.map(v => v.id);
  if (q === "none") return [];
  const want = new Set(q.toLowerCase().split(",").map(s => s.trim()));
  const on = venues.filter(v => want.has(v.short) || want.has(v.id)).map(v => v.id);
  return on.length ? on : venues.map(v => v.id);
}

/** The ?src= value for a selection: null (no parameter) when every venue is on, "none" when none is. */
export function srcParam(on: string[], venues: Venue[]): string | null {
  const set = new Set(on), pick = venues.filter(v => set.has(v.id));
  if (pick.length === venues.length) return null;
  return pick.length ? pick.map(v => v.short).join(",") : "none";
}
