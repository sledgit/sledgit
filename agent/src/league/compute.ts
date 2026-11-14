// The leaderboard as a pure function of collected inputs: no clock, no network, no randomness. The same inputs give a
// byte-identical snapshot, so anyone can recompute it (league check) and compare derived_sha256.
// Valuation is at the reference price (Binance NEARUSDT; USD stablecoins at $1), never at the venue's fill price, so a
// fill below the reference shows up as cost, and a fill above it (an owner-chosen pool) can't add return.
import { canonical, sha256Hex } from "../receipt.js";
import { hold5050, stakeHold } from "../strategies/benchmarks.js";
import { byModel, modelFamily } from "./bymodel.js";
import {
  SNAPSHOT_SCHEMA, type DecisionRow, type EntryResult, type Flag, type LeagueInputs, type RawEvent, type SeriesPoint, type Snapshot, type TokenInfo,
  type VaultInput,
} from "./types.js";

const DAY = 86_400_000;
export const MIN_DAYS = 7;
/** In-season decisions an entry needs before it can be ranked. */
export const MIN_DECISIONS = 7;
/** Hourly steps (without trades or flows) needed before a 95% range is shown. */
export const MIN_RANGE_STEPS = 24;
/** A fill better than the reference by more than this is treated as owner money, not return. */
export const FILL_TOLERANCE = 0.02;
const DECISION_EVENTS = new Set(["request", "refuse", "skip"]);
const RANKABLE = new Set(["arena", "house"]);
/** Intent outcomes that can hide a real fill: the entry is unranked until its holdings reconcile. */
const UNRESOLVED = new Set(["intent_unresolved", "intent_closed"]);
/** Owner recoveries from the exchange (event standard 1.2.0): tokens move without a trade, so the replay can't value them. */
const RECOVERY = new Set(["exchange_withdraw", "exchange_withdraw_failed", "exchange_lostfound_claim", "exchange_lostfound_claim_failed"]);
/** `withdraw_near` logs `withdraw` with this token: native NEAR (gas money), never a league token. */
const NATIVE = "near";
/** Tokens on chain beyond the replay: "untracked_funds" above the larger of these, "untracked_dust" below. Both are info
 *  only: anyone can send tokens to a vault, so unranking on surplus would let a stranger knock out any entry; and an
 *  untracked token can't move the score unless the agent trades it, which drives the replay negative (unranked). */
export const UNTRACKED_DUST_USD = 1;
export const UNTRACKED_SHARE = 0.05;

export const METHOD: Record<string, string> = {
  season: "One published season start for every entry (season.start_ms). Decisions before it are history: listed, not scored. No per-entry season starts.",
  valuation: "Holdings are rebuilt from the vault's own events (deposit, withdraw, trade) in exact integer units and valued at the reference price: Binance NEARUSDT 1-minute close at the event's block time, hourly closes for the series; USD stablecoins at $1.",
  return: "Time-weighted return (twr) from the later of the season start and the vault's funding, to the cutoff. Owner deposits and withdrawals are neutralised: each flow closes a segment and the segments' growth is chained, so a withdrawal never resets the record. A vault below the minimum value at the cutoff keeps its record and is marked inactive (unranked).",
  fills: `Every trade is valued at the reference price. A fill below the reference is a cost. A fill above the reference by more than ${FILL_TOLERANCE * 100}% is treated as owner money (neutralised, shown as neutralised_usd), so an owner-chosen pool or solver can't add return. A Rhea trade on a pool outside season.canonical_pools unranks the entry.`,
  tokens: "Only the league's tokens are valued. Any deposit, withdrawal or trade involving another token unranks the entry; a trade between a league token and another token is neutralised as a flow, never counted as profit.",
  benchmarks: "Hold 50/50 and Stake & hold are COMPUTED, not vaults: they start from the entry's own start value, at its start time and reference price, rebalanced once to 50/50 and charged season.benchmark_cost_rate on that rebalance (a fixed published rate, never the entry's own). Stake & hold compounds the NEAR half daily at the stated APR (an assumption, see stake_apr.source). Funded position: the entry's own holdings at its start, never traded, no costs.",
  vs_hold: "(1 + entry twr) / (1 + Hold twr) - 1. vs_hold_after_gas also charges each decision's gas (at the reference price) against the vault's value at that moment; the ranking uses it.",
  range95: `95% range of vs_hold from hourly excess log returns (entry minus Hold) between marks with no trade and no owner flow, Student-t with n-1 degrees of freedom, around the observed cumulative difference; asymmetric (lo, hi). Null below ${MIN_RANGE_STEPS} such steps ("not enough data"). Independence is assumed, so it still understates uncertainty for slow strategies. beyond_noise: lo > 0.`,
  costs: "fill_vs_reference: reference value given up minus reference value received, per trade. Gas: tokens burnt by every transaction carrying a decision.",
  ranking: `Ranked only if: the vault is a genuine Sledgit vault; the entry is a registered arena or house entry (not a fixture, retired or unregistered vault); its record was read in full and reconciles with its balances; at least ${MIN_DAYS} days have passed since its value first reached season.min_value_usd in the season; it made at least ${MIN_DECISIONS} in-season decisions; it is still above the minimum value at the cutoff; and no unrank flag names it. Order: vs_hold_after_gas, ties by id (code-point order).`,
  schedule: "on_schedule: null if the entry publishes no schedule or the decision predates it; otherwise true only for the first decision inside a slot's window. missed_slots: scheduled slots in the season with no decision.",
  by_model: "One list, no operator labels: entries are grouped by model family (\"qwen3.6:35b-a3b\" and \"Qwen/Qwen3.6-35B-A3B-FP8\" are both Qwen3.6 35B) or published strategy, with proof tiers kept apart (attested, open rules, self-reported). For attested and open-rules entries the group comes from what the proof checked (the attested model id, the published strategy), not the registry text; a mismatch unranks the entry. Only registered genuine entries count; fixtures, retired and unregistered vaults don't. The average is of vs_hold_after_gas over RANKED entries only (the day-7 gate applies to each entry first). Entries that share an owner or an agent account are one source: they are averaged together first, so each source counts once. This only catches reused accounts: one operator using fresh accounts per entry still counts as several sources, and an owner can point its vault at another's agent. Treat n as accounts, not people. Spread is the lowest and highest source average (shown from two sources). With no ranked entry the group shows \"not enough data\"; the provisional figure averages every entry with a result the same way and is never scored.",
  completeness: "Each vault's decision seqs must be contiguous from 1. A gap, an unresolved intent outcome, or a transaction list that could not be read in full unranks the entry.",
  reconciliation: `A replayed holding below zero at any point (the vault spent tokens no deposit event recorded) unranks the entry and shows no return. At collection, every collected event (before and after the cutoff) is replayed against the balances on chain (wallet, exchange, intents): any deficit unranks (balance_mismatch); a surplus above the larger of $${UNTRACKED_DUST_USD} and ${UNTRACKED_SHARE * 100}% of the vault's value unranks (untracked_funds), below it is dust (info). Untracked tokens are never valued. A native NEAR withdrawal is not a league token.`,
};

const TESTNET_CAVEAT =
  "Testnet: decisions use the mainnet reference price but fill on testnet pools whose prices differ widely, so the fill-vs-reference gap dominates and these returns are not performance. They show that the records, limits and proofs work.";

/** Round for output; a non-finite number is a bug, never a silent 0. */
const r8 = (x: number): number => {
  if (!Number.isFinite(x)) throw new Error(`non-finite number in the leaderboard: ${x}`);
  return Math.round(x * 1e8) / 1e8;
};
/** Code-point order: the same on every machine, whatever the locale. */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const minuteKey = (t: number) => String(Math.floor(t / 60_000) * 60_000);

/** A raw token amount from an event: digits only. Anything else fails the computation. */
function raw(x: unknown, what: string): bigint {
  const s = String(x ?? "");
  if (!/^[0-9]{1,40}$/.test(s)) throw new Error(`malformed amount in ${what}: ${JSON.stringify(x)?.slice(0, 40)}`);
  return BigInt(s);
}
const toNum = (units: bigint, decimals: number): number => Number(units) / 10 ** decimals;

export class PriceGap extends Error {}

/** Reference price at an exact time: the 1-minute bar containing it. A missing bar is an error, never a guess. */
export function priceAt(inp: LeagueInputs, t: number): number {
  const p = inp.minute[minuteKey(t)];
  if (p === undefined || !Number.isFinite(p) || !(p > 0)) throw new PriceGap(`no reference price for ${new Date(t).toISOString()}`);
  return p;
}

function tokenOf(inp: LeagueInputs, id: string): TokenInfo | undefined { return inp.tokens.find((t) => t.id === id); }

/** Holdings in raw units per league token. */
type Holdings = Map<string, bigint>;
function value(h: Holdings, inp: LeagueInputs, p: number): number {
  let v = 0;
  for (const [t, x] of h) { const k = tokenOf(inp, t)!; v += toNum(x, k.decimals) * (k.ref === "USD" ? 1 : p); }
  return v;
}
function nearValue(h: Holdings, inp: LeagueInputs, p: number): number {
  let v = 0;
  for (const [t, x] of h) { const k = tokenOf(inp, t)!; if (k.ref === "NEAR") v += toNum(x, k.decimals) * p; }
  return v;
}
const add = (h: Holdings, t: string, x: bigint) => h.set(t, (h.get(t) ?? 0n) + x);

interface Applied { kind: "flow" | "trade" | null; foreign: boolean }
/** Apply one event to the holdings. Tokens outside the league's set are not held; touching one is `foreign`. */
function apply(h: Holdings, inp: LeagueInputs, e: RawEvent): Applied {
  const d = e.data;
  const known = (t: unknown) => tokenOf(inp, String(t)) !== undefined;
  if (e.event === "deposit" || e.event === "withdraw") {
    const amt = raw(d.amount, `${e.event} ${e.tx}`);
    if (e.event === "withdraw" && d.token === NATIVE) return { kind: null, foreign: false };
    if (!known(d.token)) return { kind: "flow", foreign: true };
    add(h, String(d.token), e.event === "deposit" ? amt : -amt);
    return { kind: "flow", foreign: false };
  }
  if (e.event === "trade") {
    const ain = raw(d.amount_in, `trade ${e.tx}`), aout = raw(d.amount_out, `trade ${e.tx}`);
    const kin = known(d.token_in), kout = known(d.token_out);
    if (kin) add(h, String(d.token_in), -ain);
    if (kout) add(h, String(d.token_out), aout);
    // A trade with a token the league doesn't value moves value in or out unseen: a flow, never return.
    return { kind: kin && kout ? "trade" : "flow", foreign: !(kin && kout) };
  }
  return { kind: null, foreign: false };
}

/** Two-sided Student-t quantile at 97.5% (Cornish-Fisher expansion; error < 0.002 for df >= 3). */
function t975(df: number): number {
  const z = 1.959963985;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
}

/** Slot index for t if t is inside a slot's window, else null. */
function slotOf(s: NonNullable<VaultInput["entry"]["schedule"]>, t: number): number | null {
  const k = Math.floor((t / 1000 - s.offset_s) / s.every_s);
  return t / 1000 - (s.offset_s + k * s.every_s) < s.window_s ? k : null;
}

const byChain = (a: RawEvent, b: RawEvent) => a.block_height - b.block_height || cmp(a.receipt_id, b.receipt_id);

interface Rows { rows: DecisionRow[]; trades: { in_ref: number; cost: number }[]; flags: Flag[]; negative: boolean }

/** Decision rows (all, newest first later), per-trade costs in the season, and the entry's own data flags. */
function decisionRows(inp: LeagueInputs, v: VaultInput): Rows {
  const evs = [...v.events].sort(byChain);
  const id = v.entry.id, start = inp.season.start_ms;
  const rows: DecisionRow[] = [];
  const trades: Rows["trades"] = [];
  const flags: Flag[] = [];
  const usedSlots = new Set<number>();
  const pools = new Set(inp.season.canonical_pools);
  for (const e of evs) {
    const d = e.data;
    if (!DECISION_EVENTS.has(e.event) && e.event !== "trade" && e.event !== "failed") continue;
    const seq = Number(d.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error(`${id}: malformed seq in ${e.event} ${e.tx}`);
    const row: DecisionRow = { seq, event: e.event as DecisionRow["event"], tx: e.tx, block_time_ms: e.block_time_ms,
      receipt_hash: String(d.receipt_hash ?? ""), in_season: e.block_time_ms >= start, on_schedule: null };
    const sch = v.entry.schedule;
    if (sch && DECISION_EVENTS.has(e.event) && e.block_time_ms >= sch.since_ms) {
      const k = slotOf(sch, e.block_time_ms);
      row.on_schedule = k !== null && !usedSlots.has(k);
      if (k !== null) usedSlots.add(k);
    }
    if (d.code !== undefined) row.code = String(d.code);
    if (d.note !== undefined && String(d.note) !== "") row.note = String(d.note);
    for (const k of ["token_in", "amount_in", "token_out", "amount_out"] as const) if (d[k] !== undefined) row[k] = String(d[k]);
    if (e.event === "trade" && row.token_in && row.token_out) {
      row.venue = String(d.venue ?? "rhea");
      if (d.pool_id !== undefined) row.pool_id = Number(d.pool_id);
      const tin = tokenOf(inp, row.token_in), tout = tokenOf(inp, row.token_out);
      if (tin && tout) {
        const p = priceAt(inp, e.block_time_ms);
        const ain = toNum(raw(row.amount_in, `trade ${e.tx}`), tin.decimals), aout = toNum(raw(row.amount_out, `trade ${e.tx}`), tout.decimals);
        const inRef = ain * (tin.ref === "USD" ? 1 : p), outRef = aout * (tout.ref === "USD" ? 1 : p);
        row.side = tin.ref === "NEAR" ? "sell" : "buy";
        row.ref_price = p;
        row.fill_price = r8(row.side === "sell" ? (ain > 0 ? aout / ain : 0) : (aout > 0 ? ain / aout : 0));
        row.cost_usd = r8(inRef - outRef);
        if (row.in_season) trades.push({ in_ref: inRef, cost: inRef - outRef });
      }
      if (row.in_season && row.venue === "rhea" && !(row.pool_id !== undefined && pools.has(row.pool_id)))
        flags.push({ ids: [id], kind: "non_canonical_pool", severity: "unrank", text: `trade #${seq} used Rhea pool ${row.pool_id ?? "?"}, not a season pool (${[...pools].join(", ")})` });
    } else if (e.event === "refuse" || e.event === "request") {
      row.side = tokenOf(inp, String(row.token_in ?? ""))?.ref === "NEAR" ? "sell" : "buy";
    }
    rows.push(row);
  }
  // Completeness: decision seqs contiguous from 1.
  const seqs = [...new Set(rows.filter((r) => DECISION_EVENTS.has(r.event)).map((r) => r.seq))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let s = 1, i = 0; seqs.length && s <= seqs[seqs.length - 1]; s++) { if (seqs[i] === s) i++; else gaps.push(s); }
  if (gaps.length) flags.push({ ids: [id], kind: "seq_gap", severity: "unrank", text: `decision seq(s) ${gaps.slice(0, 5).join(", ")}${gaps.length > 5 ? "…" : ""} missing from the vault's record` });
  for (const e of evs) if (UNRESOLVED.has(e.event) && e.block_time_ms >= start)
    flags.push({ ids: [id], kind: "intent_unresolved", severity: "unrank", text: `${e.event} at seq ${String(e.data.seq ?? "?")}: an intent outcome is unresolved, so a fill may be missing` });
  for (const e of evs) if (RECOVERY.has(e.event) && e.block_time_ms >= start)
    flags.push({ ids: [id], kind: "exchange_recovery", severity: "unrank", text: `${e.event}: tokens recovered from the exchange outside a trade, so this record isn't scored` });
  if (evs.some((e) => (e.event === "deposit" || e.event === "withdraw" || e.event === "trade") && e.block_time_ms >= start
    && !(e.event === "withdraw" && e.data.token === NATIVE)
    && [e.data.token, e.data.token_in, e.data.token_out].some((t) => t !== undefined && !tokenOf(inp, String(t)))))
    flags.push({ ids: [id], kind: "foreign_token", severity: "unrank", text: "moved a token outside the league's set (not valued; neutralised as a flow)" });
  const neg = negativeHolding(inp, evs);
  if (neg) flags.push({ ids: [id], kind: "negative_holding", severity: "unrank",
    text: `replayed ${neg.symbol} holding goes below zero at ${neg.tx}: the vault moved tokens no deposit event recorded (untracked funds), so its return isn't scored` });
  return { rows, trades, flags, negative: neg !== null };
}

/** First event (by the cutoff, chain order) after which a replayed league-token holding is below zero, or null. */
function negativeHolding(inp: LeagueInputs, sorted: RawEvent[]): { symbol: string; tx: string } | null {
  const h: Holdings = new Map();
  for (const e of sorted) {
    if (e.block_time_ms > inp.as_of_ms) break;
    apply(h, inp, e);
    for (const [t, x] of h) if (x < 0n) return { symbol: tokenOf(inp, t)!.symbol, tx: e.tx };
  }
  return null;
}

function entryResult(inp: LeagueInputs, v: VaultInput, R: Rows): EntryResult {
  const e = v.entry, S = inp.season;
  const decisions = R.rows.filter((r) => DECISION_EVENTS.has(r.event));
  const season = decisions.filter((r) => r.in_season);
  const refusals: Record<string, number> = {};
  for (const r of season) if (r.event === "refuse") refusals[r.code ?? "unknown"] = (refusals[r.code ?? "unknown"] ?? 0) + 1;
  const tradedRef = R.trades.reduce((s, t) => s + t.in_ref, 0);
  const fillCost = R.trades.reduce((s, t) => s + t.cost, 0);
  // Missed slots: scheduled slots from the later of the season start and the schedule's publication, to the cutoff.
  let missed = 0;
  const sch = e.schedule;
  if (sch) {
    const used = new Set(season.filter((r) => r.on_schedule).map((r) => slotOf(sch, r.block_time_ms)));
    const from = Math.max(S.start_ms, sch.since_ms) / 1000;
    for (let k = Math.ceil((from - sch.offset_s) / sch.every_s); sch.offset_s + k * sch.every_s + sch.window_s <= inp.as_of_ms / 1000; k++) if (!used.has(k)) missed++;
  }
  const seqs = season.map((r) => r.seq);
  const base: EntryResult = {
    id: e.id, account: e.account, name: e.name, kind: e.kind, harness: e.harness, model: e.model, description: e.description,
    strategy_sha256: v.proof.strategy_sha256 ?? null,
    proof: { tier: v.proof.tier, detail: v.proof.detail, claimed: e.proof_claim, ...(v.proof.verified_model ? { verified_model: v.proof.verified_model } : {}) },
    provenance: { status: v.provenance.status, reason: v.provenance.reason },
    season_seqs: seqs.length ? [Math.min(...seqs), Math.max(...seqs)] : null,
    events_sha256: sha256Hex(canonical(v.events)),
    start: null, end: null, twr: null, hold_twr: null, stake_twr: null, funded_twr: null, vs_hold: null, vs_stake: null, vs_funded: null,
    vs_hold_after_gas: null, range95: null, beyond_noise: null,
    costs: { traded_ref_usd: r8(tradedRef), fill_vs_reference_usd: r8(fillCost), fill_vs_reference_pct: tradedRef > 0 ? r8(fillCost / tradedRef) : null,
      gas_near: 0, gas_usd: 0, neutralised_usd: 0, benchmark_rebalance_usd: 0, benchmark_cost_rate: r8(S.benchmark_cost_rate.value),
      benchmark_cost_rate_source: S.benchmark_cost_rate.source },
    counts: { decisions: season.length, trades: R.trades.length, skips: season.filter((r) => r.event === "skip").length,
      refusals: season.filter((r) => r.event === "refuse").length, failed: R.rows.filter((r) => r.in_season && r.event === "failed").length,
      off_schedule: season.filter((r) => r.on_schedule === false).length, missed_slots: missed },
    refusals_by_code: refusals, days: 0, inactive: false, ranked: false, unranked_reason: null, series: [], decisions: [...R.rows].reverse(),
  };
  if (v.incomplete) { base.unranked_reason = `record incomplete: ${v.incomplete}`; return base; }
  // Holdings below zero value borrowed, untracked tokens: no return is shown at all.
  if (R.negative) { base.unranked_reason = "negative_holding: replayed holdings go below zero (untracked funds)"; return base; }

  // The window opens at the later of the season start and the first deposit.
  const evs = [...v.events].filter((x) => x.block_time_ms <= inp.as_of_ms).sort(byChain);
  const funded = evs.find((x) => x.event === "deposit")?.block_time_ms;
  if (funded === undefined) { base.unranked_reason = "not funded yet"; return base; }
  const start = Math.max(S.start_ms, funded);
  const h: Holdings = new Map();
  let i = 0;
  // Events strictly before the start build the opening position; at the start itself, a funding deposit counts.
  while (i < evs.length && (evs[i].block_time_ms < start || (evs[i].block_time_ms === start && evs[i].event === "deposit"))) { apply(h, inp, evs[i]); i++; }
  const opening = new Map(h);
  const p0 = priceAt(inp, start);
  const v0 = value(h, inp, p0);
  if (!(v0 > 0)) { base.unranked_reason = "nothing in the vault at the season start"; return base; }

  // Walk events, gas and hourly closes to the cutoff. Flows (and fill gains beyond the tolerance) close a segment.
  const gas = v.gas.filter((g) => g.block_time_ms >= start && g.block_time_ms <= inp.as_of_ms);
  const hourly = inp.hourly.filter(([t]) => t > start && t <= inp.as_of_ms);
  const pEnd = priceAt(inp, inp.as_of_ms);
  const marks: [number, number][] = [...hourly, [inp.as_of_ms, pEnd]];
  let growth = 1, segStart = v0, gasFactor = 1, gasNear = 0, gasUsd = 0, neutral = 0, gi = 0;
  let rankFrom: number | null = v0 >= S.min_value_usd ? start : null;
  const series: SeriesPoint[] = [];
  const vals: number[] = [v0];
  const noisy: boolean[] = [false];
  let stepNoisy = false;
  const segValue = (vt: number) => (segStart > 0 ? growth * (vt / segStart) : growth);
  for (const [t, p] of marks) {
    for (;;) {
      const ev = i < evs.length && evs[i].block_time_ms <= t ? evs[i] : null;
      const g = gi < gas.length && gas[gi].block_time_ms <= t ? gas[gi] : null;
      if (!ev && !g) break;
      if (ev && (!g || ev.block_time_ms <= g.block_time_ms)) {
        const pe = priceAt(inp, ev.block_time_ms);
        const before = value(h, inp, pe);
        const a = apply(h, inp, ev);
        const after = value(h, inp, pe);
        if (a.kind === "flow") {
          // Close the segment at the value just before the flow; the next one starts from the value after it.
          if (segStart > 0) growth *= before / segStart;
          segStart = after;
          stepNoisy = true;
        } else if (a.kind === "trade") {
          const gain = after - before;
          const inRef = tradeInRef(ev, inp, pe);
          const allowed = inRef * FILL_TOLERANCE;
          if (gain > allowed) {
            // Better than the reference beyond the tolerance: owner money, not return.
            const excess = gain - allowed;
            neutral += excess;
            if (segStart > 0) growth *= (after - excess) / segStart;
            segStart = after;
          }
          stepNoisy = true;
        }
        if (rankFrom === null && value(h, inp, pe) >= S.min_value_usd) rankFrom = ev.block_time_ms;
        i++;
      } else if (g) {
        const pg = priceAt(inp, g.block_time_ms);
        const n = toNum(raw(g.tokens_burnt, `gas ${g.tx}`), 24), usdG = n * pg, vt = value(h, inp, pg);
        gasNear += n; gasUsd += usdG;
        if (vt > 0) gasFactor *= Math.max(0, 1 - usdG / vt);
        gi++;
      }
    }
    const vt = value(h, inp, p);
    if (rankFrom === null && vt >= S.min_value_usd) rankFrom = t;
    vals.push(vt);
    noisy.push(stepNoisy);
    stepNoisy = false;
    series.push({ t, value: r8(v0 * segValue(vt)), hold: 0, stake: 0 });
  }
  const end = value(h, inp, pEnd);
  const twr = segValue(end) - 1;

  // Benchmarks: the start value at the start price, one rebalance to 50/50 at the season's fixed cost rate.
  const rebalance = Math.abs(v0 / 2 - nearValue(opening, inp, p0));
  const benchCost = rebalance * S.benchmark_cost_rate.value;
  const closes: [number, number][] = [[start, p0], ...marks];
  const hold = hold5050(v0 - benchCost, closes), stake = stakeHold(v0 - benchCost, closes, inp.stake_apr.value);
  for (let k = 0; k < series.length; k++) { series[k].hold = r8(hold[k + 1].value); series[k].stake = r8(stake[k + 1].value); }
  const holdTwr = hold[hold.length - 1].value / v0 - 1;
  const stakeTwr = stake[stake.length - 1].value / v0 - 1;
  const fundedTwr = value(opening, inp, pEnd) / v0 - 1;

  // 95% range: hourly excess log returns over steps with no trade and no flow, Student-t, around the observed sum.
  const ex: number[] = [];
  for (let k = 1; k < vals.length; k++) {
    if (noisy[k]) continue;
    const a = vals[k - 1], b = vals[k], ha = hold[k - 1].value, hb = hold[k].value;
    if (a > 0 && b > 0 && ha > 0 && hb > 0) ex.push(Math.log(b / a) - Math.log(hb / ha));
  }
  const vsHold = (1 + twr) / (1 + holdTwr) - 1;
  let range: EntryResult["range95"] = null;
  if (ex.length >= MIN_RANGE_STEPS) {
    const n = ex.length, m = ex.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(ex.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
    const L = Math.log(1 + vsHold), w = t975(n - 1) * sd * Math.sqrt(n);
    range = { lo: r8(Math.exp(L - w) - 1), hi: r8(Math.exp(L + w) - 1), n };
  }

  const inactive = end < S.min_value_usd;
  const days = rankFrom === null ? 0 : (inp.as_of_ms - rankFrom) / DAY;
  let why: string | null = null;
  if (v.provenance.status !== "genuine") why = `not a genuine Sledgit vault (${v.provenance.status})`;
  else if (!RANKABLE.has(e.kind)) why = { fixture: "test fixture: scripted decisions", retired: "retired entry: record kept, not ranked",
    unregistered: "unregistered vault: not a league entry" }[e.kind as "fixture" | "retired" | "unregistered"] ?? "not a league entry";
  else if (inactive) why = `inactive: the vault holds less than $${S.min_value_usd} at the cutoff`;
  else if (rankFrom === null) why = `never held $${S.min_value_usd} in the season`;
  else if (days < MIN_DAYS) why = `${days.toFixed(1)} days at the minimum value; ranking starts at day ${MIN_DAYS}`;
  else if (season.length < MIN_DECISIONS) why = `${season.length} in-season decision(s); ranking needs ${MIN_DECISIONS}`;
  return {
    ...base,
    start: { time_ms: start, value_usd: r8(v0), price: p0 },
    end: { value_usd: r8(end), price: pEnd },
    twr: r8(twr), hold_twr: r8(holdTwr), stake_twr: r8(stakeTwr),
    vs_hold: r8(vsHold), vs_stake: r8((1 + twr) / (1 + stakeTwr) - 1),
    funded_twr: r8(fundedTwr), vs_funded: r8((1 + twr) / (1 + fundedTwr) - 1),
    vs_hold_after_gas: r8(((1 + twr) * gasFactor) / (1 + holdTwr) - 1), range95: range, beyond_noise: range ? range.lo > 0 : null,
    costs: { ...base.costs, gas_near: r8(gasNear), gas_usd: r8(gasUsd), neutralised_usd: r8(neutral), benchmark_rebalance_usd: r8(benchCost) },
    days: r8(days), inactive, ranked: why === null, unranked_reason: why, series,
  };
}

/** Chain balances vs the replay at collection: a deficit (replayed tokens not there) or a surplus beyond dust (tokens
 * that arrived without a deposit event) unranks; so does a reconciliation that couldn't be made. */
function reconciliationFlags(inp: LeagueInputs, v: VaultInput, r: EntryResult): Flag[] {
  const rc = v.reconciliation, id = v.entry.id;
  if (!rc || v.incomplete) return [];
  if ("error" in rc) return [{ ids: [id], kind: "unreconciled", severity: "unrank", text: `balances not reconciled with the replay: ${rc.error}` }];
  const p = priceAt(inp, inp.as_of_ms);
  const list = (m: Record<string, string>) => Object.keys(m).sort(cmp).map((t) => {
    const k = tokenOf(inp, t);
    if (!k) throw new Error(`${id}: reconciliation names ${t}, not a league token`);
    return { sym: k.symbol, usd: toNum(raw(m[t], `reconciliation ${id}`), k.decimals) * (k.ref === "USD" ? 1 : p) };
  });
  const out: Flag[] = [];
  const def = list(rc.deficit);
  if (def.length) out.push({ ids: [id], kind: "balance_mismatch", severity: "unrank",
    text: `on-chain ${def.map((x) => x.sym).join(", ")} below the replayed holdings: the record doesn't match the vault` });
  const sur = list(rc.surplus);
  if (sur.length) {
    const usd = sur.reduce((s, x) => s + x.usd, 0), dust = Math.max(UNTRACKED_DUST_USD, UNTRACKED_SHARE * (r.end?.value_usd ?? 0));
    out.push({ ids: [id], kind: usd > dust ? "untracked_funds" : "untracked_dust", severity: "info",
      text: `$${r8(usd)} of ${sur.map((x) => x.sym).join(", ")} on chain beyond the replayed holdings (sent without a deposit event; not valued)` });
  }
  return out;
}

/** Reference value of what a trade gave up, at price p. */
function tradeInRef(e: RawEvent, inp: LeagueInputs, p: number): number {
  const t = tokenOf(inp, String(e.data.token_in));
  return t ? toNum(raw(e.data.amount_in, `trade ${e.tx}`), t.decimals) * (t.ref === "USD" ? 1 : p) : 0;
}

/** The derived part of a snapshot: what derived_sha256 covers. */
export function derivedBody(s: Pick<Snapshot, "season" | "entries" | "benchmarks" | "flags" | "luck_entry" | "by_model">): unknown {
  return { season: s.season, entries: s.entries, benchmarks: s.benchmarks, flags: s.flags, luck_entry: s.luck_entry, by_model: s.by_model };
}

/** A snapshot's body hashes to its own derived_sha256 (an edited body with the old hash field fails). */
export function selfConsistent(s: Snapshot): boolean {
  return sha256Hex(canonical(derivedBody(s))) === s.derived_sha256;
}

export function compute(inp: LeagueInputs): Snapshot {
  const ids = inp.vaults.map((v) => v.entry.id);
  const dup = ids.find((x, k) => ids.indexOf(x) !== k);
  if (dup) throw new Error(`entry id ${dup} appears twice: ids must be unique`);
  const parts = inp.vaults.map((v) => ({ v, R: decisionRows(inp, v) }));
  const flags: Flag[] = parts.flatMap((p) => p.R.flags);
  if (inp.vaults.some((v) => v.incomplete)) for (const v of inp.vaults) if (v.incomplete) flags.push({ ids: [v.entry.id], kind: "incomplete", severity: "unrank", text: v.incomplete });

  // The same receipt hash recorded twice (anywhere), or model evidence cited by more than one vault: every vault involved
  // is unranked, and the flag is shown on each of their pages.
  const seen = new Map<string, string[]>();
  for (const p of parts) for (const r of p.R.rows) if (DECISION_EVENTS.has(r.event) && r.receipt_hash && r.in_season) {
    seen.set(r.receipt_hash, [...(seen.get(r.receipt_hash) ?? []), `${p.v.entry.id}#${r.seq}`]);
  }
  for (const [hh, where] of [...seen].sort(([a], [b]) => cmp(a, b))) if (where.length > 1)
    flags.push({ ids: [...new Set(where.map((w) => w.split("#")[0]))].sort(cmp), kind: "duplicate_receipt", severity: "unrank", text: `receipt hash ${hh.slice(0, 12)}… recorded by ${where.join(", ")}` });
  const evd = new Map<string, Set<string>>();
  for (const v of inp.vaults) for (const id of v.proof.evidence_ids) evd.set(id, (evd.get(id) ?? new Set()).add(v.entry.id));
  for (const [id, who] of [...evd].sort(([a], [b]) => cmp(a, b))) if (who.size > 1)
    flags.push({ ids: [...who].sort(cmp), kind: "evidence_reuse", severity: "unrank", text: `model evidence ${id.slice(0, 24)} cited by more than one vault` });
  for (const { v } of parts) {
    const id = v.entry.id;
    if (v.provenance.status !== "genuine") flags.push({ ids: [id], kind: "provenance", severity: "unrank", text: v.provenance.reason });
    if (v.proof.verified_model && modelFamily(v.proof.verified_model) !== modelFamily(v.entry.model))
      flags.push({ ids: [id], kind: "label_mismatch", severity: "unrank", text: `registry says ${v.entry.model}, but the proof binds ${v.proof.verified_model}` });
    if (v.proof.tier !== v.entry.proof_claim) flags.push({ ids: [id], kind: "proof", severity: "info", text: `claims ${v.entry.proof_claim}, proven ${v.proof.tier} (${v.proof.detail})` });
    if ((v.proof.strategy_versions ?? 0) > 1) flags.push({ ids: [id], kind: "strategy_change", severity: "info", text: `the season's receipts use ${v.proof.strategy_versions} published strategy versions (strategy changed mid-season)` });
  }

  const results = parts.map(({ v, R }) => entryResult(inp, v, R));
  for (const { v } of parts) flags.push(...reconciliationFlags(inp, v, results.find((r) => r.id === v.entry.id)!));
  const unrank = new Map<string, string>();
  for (const f of flags) if (f.severity === "unrank") for (const id of f.ids) if (!unrank.has(id)) unrank.set(id, `${f.kind}: ${f.text}`);
  for (const r of results) {
    if (r.counts.off_schedule) flags.push({ ids: [r.id], kind: "off_schedule", severity: "info", text: `${r.counts.off_schedule} decision(s) outside its published schedule` });
    if (r.counts.missed_slots) flags.push({ ids: [r.id], kind: "missed_slots", severity: "info", text: `${r.counts.missed_slots} scheduled slot(s) with no decision` });
    if (r.costs.neutralised_usd > 0) flags.push({ ids: [r.id], kind: "fill_above_reference", severity: "info", text: `fills better than the reference by more than ${FILL_TOLERANCE * 100}%: $${r.costs.neutralised_usd} neutralised as owner money` });
    if (r.ranked && unrank.has(r.id)) { r.ranked = false; r.unranked_reason = unrank.get(r.id)!; }
  }
  flags.sort((a, b) => cmp(a.ids.join(","), b.ids.join(",")) || cmp(a.kind, b.kind) || cmp(a.text, b.text));

  // Order: ranked by vs_hold_after_gas, then unranked arena/house entries, then the rest; ties by id (code points).
  const order = (r: EntryResult) => (r.ranked ? 0 : RANKABLE.has(r.kind) && r.provenance.status === "genuine" ? 1 : 2);
  results.sort((a, b) => order(a) - order(b) || (b.vs_hold_after_gas ?? -Infinity) - (a.vs_hold_after_gas ?? -Infinity) || cmp(a.id, b.id));

  const starts = results.filter((r) => RANKABLE.has(r.kind) && r.start).map((r) => r.start!.time_ms);
  const b0 = starts.length ? Math.min(...starts) : null;
  let holdTwr: number | null = null, stakeTwr: number | null = null;
  if (b0 !== null) {
    const closes: [number, number][] = [[b0, priceAt(inp, b0)], ...inp.hourly.filter(([t]) => t > b0 && t <= inp.as_of_ms), [inp.as_of_ms, priceAt(inp, inp.as_of_ms)]];
    const hb = hold5050(100, closes), sb = stakeHold(100, closes, inp.stake_apr.value);
    holdTwr = r8(hb[hb.length - 1].value / 100 - 1);
    stakeTwr = r8(sb[sb.length - 1].value / 100 - 1);
  }
  const luck = inp.vaults.find((v) => v.entry.kind === "house" && v.entry.strategy === "luck")?.entry.id ?? null;
  const out = {
    season: inp.season, entries: results,
    benchmarks: { start_ms: b0, hold_twr: holdTwr, stake_twr: stakeTwr,
      stake_vs_hold: holdTwr !== null && stakeTwr !== null ? r8((1 + stakeTwr) / (1 + holdTwr) - 1) : null, stake_apr: inp.stake_apr },
    flags, luck_entry: luck, by_model: byModel(results, inp.vaults),
  };
  return {
    schema: SNAPSHOT_SCHEMA, network: inp.network, as_of_ms: inp.as_of_ms,
    inputs_sha256: sha256Hex(canonical(withoutObserved(inp))),
    derived_sha256: sha256Hex(canonical(derivedBody(out))),
    caveat: inp.network === "testnet" ? TESTNET_CAVEAT : null,
    method: METHOD,
    ...out, excluded: inp.excluded,
  };
}

/** Inputs minus what's only observed (current views) and when it was collected: what the derived numbers depend on. */
export function withoutObserved(inp: LeagueInputs): unknown {
  const { collected_at: _c, ...rest } = inp;
  return { ...rest, vaults: inp.vaults.map(({ observed: _o, ...v }) => v) };
}
