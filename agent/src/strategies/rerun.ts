// Re-running house receipts. `houseRerun` is offline: look the strategy hash up among the published versions and decide
// again from the recorded inputs. `houseCheck` also checks those inputs against the world: the receipt is the vault's
// own on-chain decision recording exactly the receipt's decision, the receipt's decision is exactly the rule's output,
// the vault is genuine, the candles are the published feed's, the balances, policy, usage and config the rule read are
// the chain's at the decision's transaction block, and (version 2 on) the chain state and slot block are what the chain
// says. Version 1 receipts read local history; the check compares it with chain.
import type { NetworkId } from "../config.js";
import { canonical, sha256Hex, type Json, type Receipt } from "../receipt.js";
import { fromUnits } from "../decision.js";
import { vaultDecisions, rpcReader, viewAt, txBlockHeight, type ChainDecision } from "../attest/chain.js";
import { expectedDecision, eventMatches } from "../attest/pill.js";
import { pinnedPair } from "../pairs.js";
import { cachedProvenance } from "../provenance.js";
import { publishedByHash } from "./registry.js";
import { summarise, checkSlotBlock, slotStart, SCHEDULE, type ChainState } from "./schedule.js";
import type { Candle } from "./market.js";

export interface RerunRow {
  receipt: string;
  strategy: string;
  version?: number;
  /** The strategy hash is a published version of this strategy. */
  hash_match: boolean;
  /** Deciding again from the recorded inputs gives the recorded output. */
  same: boolean;
  /** The receipt's decision is exactly what that output says (as the arena records it). */
  decision_consistent?: boolean;
  error?: string;
}

interface RulesReceipt {
  vault: string; network: string; agent?: string; model?: { provider?: string; id?: string }; prompt_sha256: string; model_output: string;
  inputs: Record<string, Json>; decision?: Json;
}

/** The output a rule produced and the decision the receipt claims must agree; otherwise the rule didn't decide it. */
export function decisionConsistent(r: Pick<RulesReceipt, "model_output" | "network" | "decision" | "model">): boolean {
  if (typeof r.model_output !== "string") return false;
  return canonical(expectedDecision({ model_output: r.model_output, network: r.network as Receipt["network"], model: { provider: r.model?.provider } }))
    === canonical(r.decision ?? null);
}

/** Offline re-run of every rules receipt. Lines that aren't rules receipts are counted, not silently dropped. */
export function houseRerun(text: string): { rows: RerunRow[]; skipped: number } {
  const rows: RerunRow[] = [];
  let skipped = 0;
  for (const line of text.split("\n").filter(Boolean)) {
    let r: RulesReceipt;
    try {
      r = JSON.parse(line) as RulesReceipt;
    } catch {
      rows.push({ receipt: sha256Hex(line), strategy: "?", hash_match: false, same: false, error: "unparseable line" });
      continue;
    }
    if (r.model?.provider !== "rules") { skipped++; continue; }
    const id = String(r.model.id);
    const p = publishedByHash(r.prompt_sha256);
    if (!p || p.id !== id) {
      rows.push({ receipt: sha256Hex(line), strategy: id, hash_match: false, same: false,
        error: p ? `hash belongs to ${p.id}, not ${id}` : "strategy hash is not a published version" });
      continue;
    }
    const { raw: _raw, ...inputs } = r.inputs;
    let same = false;
    let error: string | undefined;
    try {
      same = JSON.stringify(p.decide(inputs, r.vault)) === r.model_output;
    } catch (e) {
      error = `re-run failed: ${(e as Error).message}`;
    }
    const decision_consistent = decisionConsistent(r);
    if (!decision_consistent && !error) error = "the receipt's decision is not what the rule's output says";
    rows.push({ receipt: sha256Hex(line), strategy: id, version: p.version, hash_match: true, same, decision_consistent, ...(error ? { error } : {}) });
  }
  return { rows, skipped };
}

export interface CheckRow extends RerunRow {
  on_chain?: boolean;
  sledgit_vault?: boolean;
  candles_match?: boolean;
  reference_price_plausible?: boolean;
  balances_match_raw?: boolean;
  /** The on-chain event records exactly the receipt's decision (direction, token, amount). */
  event_matches_decision?: boolean;
  /** Balances, policy, usage and config the rule read equal the chain's at the decision's transaction block. */
  chain_state_matches?: boolean;
  state_block?: number;
  /** Version 2: recorded chain state equals the chain's. */
  chain_inputs_match?: boolean;
  slot_block_ok?: boolean;
  off_schedule?: boolean;
  /** Version 1: the recorded local history agrees with the vault's on-chain decisions. */
  local_history_matches_chain?: boolean;
  problems: string[];
  pass: boolean;
}

const KLINE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

async function klines(f: typeof fetch, interval: "1d" | "1m", start: number, limit: number): Promise<unknown[]> {
  let err = "";
  for (const h of KLINE_HOSTS) {
    try {
      const res = await f(`${h}/api/v3/klines?symbol=NEARUSDT&interval=${interval}&startTime=${start}&limit=${limit}`,
        { signal: AbortSignal.timeout(15_000), redirect: "error" });
      if (!res.ok) { err = `${h}: HTTP ${res.status}`; continue; }
      const t = await res.text();
      if (t.length > 256 * 1024) { err = `${h}: oversized`; continue; }
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v;
      err = `${h}: not an array`;
    } catch (e) {
      err = `${h}: ${(e as Error).message}`;
    }
  }
  throw new Error(`klines unavailable (${err})`);
}

/** The recorded candles are exactly the feed's closed daily bars (high, low, close as served). */
async function candlesMatch(c: Candle[], f: typeof fetch): Promise<string | null> {
  if (!c.length) return "no candles recorded";
  const got = await klines(f, "1d", c[0][0], c.length);
  if (got.length < c.length) return `feed returned ${got.length} of ${c.length} candles`;
  for (let i = 0; i < c.length; i++) {
    const k = got[i] as unknown[];
    if (k[0] !== c[i][0] || k[2] !== c[i][1] || k[3] !== c[i][2] || k[4] !== c[i][3]) return `candle ${i} (${new Date(c[i][0]).toISOString().slice(0, 10)}) differs from the feed`;
  }
  return null;
}

/** The recorded reference price lies inside that minute's 1m bar. */
async function pricePlausible(rp: { price?: string; fetched_at?: string } | null, f: typeof fetch): Promise<string | null> {
  if (!rp?.price || !rp.fetched_at) return "no reference price recorded";
  const t = Date.parse(rp.fetched_at);
  if (!Number.isFinite(t)) return "reference price has no valid time";
  const k = (await klines(f, "1m", Math.floor(t / 60_000) * 60_000, 1))[0] as unknown[] | undefined;
  if (!k) return "no 1m bar for the reference price's minute";
  const p = Number(rp.price);
  return p >= Number(k[3]) && p <= Number(k[2]) ? null : `reference price ${rp.price} is outside that minute's range ${String(k[3])}-${String(k[2])}`;
}

/** What a rule read from chain, as the arena records it in inputs.raw. */
export interface VaultState { config: Json; policy: Json; usage: Json; balances: Record<string, string>; stake_rate?: string }

export interface CheckDeps {
  fetch?: typeof fetch;
  decisions?: (net: NetworkId, vault: string) => Promise<ChainDecision[]>;
  /** The vault's state at the end of a block (default: archival RPC). */
  stateAt?: (net: NetworkId, vault: string, tokens: string[], height: number, stake?: { token: string; rate_method: string }) => Promise<VaultState>;
  /** The block a transaction was included in, when the indexer didn't say (default: archival RPC). */
  txBlock?: (net: NetworkId, tx: string, sender: string) => Promise<number>;
  /** Report non-rules lines as skipped instead of failing (CLI --skip-non-rules). */
  skipNonRules?: boolean;
}

export async function archivalState(net: NetworkId, vault: string, tokens: string[], height: number, f: typeof fetch = fetch,
  stake?: { token: string; rate_method: string }): Promise<VaultState> {
  // One read at a time: the public archival RPC rate-limits bursts.
  const config = await viewAt<Json>(net, vault, "get_config", {}, height, f);
  const policy = await viewAt<Json>(net, vault, "get_policy", {}, height, f);
  const usage = await viewAt<Json>(net, vault, "get_usage", {}, height, f);
  const balances: Record<string, string> = {};
  for (const t of tokens) balances[t] = String(await viewAt<string>(net, t, "ft_balance_of", { account_id: vault }, height, f));
  if (!stake) return { config, policy, usage, balances };
  return { config, policy, usage, balances, stake_rate: String(await viewAt<string>(net, stake.token, stake.rate_method, {}, height, f)) };
}

/** Compare what the receipt says the rule read with the chain; returns problems. */
function stateProblems(raw: Partial<VaultState> | undefined, chain: VaultState): string[] {
  const out: string[] = [];
  for (const k of ["config", "policy", "usage"] as const) {
    if (canonical((raw?.[k] ?? null) as Json) !== canonical(chain[k])) {
      const hourNote = k === "usage" && (raw?.usage as { hour?: unknown } | undefined)?.hour !== (chain.usage as { hour?: unknown } | null)?.hour
        ? " (the read and the transaction straddle an hour boundary, so usage can't be checked exactly)" : "";
      out.push(`recorded ${k} differs from the chain's at the decision's transaction block${hourNote}`);
    }
  }
  for (const [t, v] of Object.entries(chain.balances)) {
    if (raw?.balances?.[t] !== v) out.push(`recorded ${t} balance ${String(raw?.balances?.[t])} differs from the chain's ${v} at the decision's transaction block`);
  }
  if (chain.stake_rate !== undefined && raw?.stake_rate !== chain.stake_rate)
    out.push(`recorded staking rate ${String(raw?.stake_rate)} differs from the chain's ${chain.stake_rate} at the decision's transaction block`);
  return out;
}

/** houseRerun plus checks against chain and feed. Every row must pass. */
export async function houseCheck(text: string, net: NetworkId, deps: CheckDeps = {}): Promise<CheckRow[]> {
  const f = deps.fetch ?? fetch;
  const load = deps.decisions ?? ((n: NetworkId, v: string) => vaultDecisions(n, v, f));
  const provenance = cachedProvenance(net, rpcReader(net, f));
  const history = new Map<string, Promise<ChainDecision[]>>();
  const decisionsOf = (v: string) => { let p = history.get(v); if (!p) { p = load(net, v); history.set(v, p); } return p; };
  const stateAt = deps.stateAt ?? ((n: NetworkId, v: string, t: string[], h: number, st?: { token: string; rate_method: string }) => archivalState(n, v, t, h, f, st));
  const txBlock = deps.txBlock ?? ((n: NetworkId, tx: string, sender: string) => txBlockHeight(n, tx, sender, f));
  const offline = houseRerun(text).rows;
  const lines = text.split("\n").filter(Boolean);
  const out: CheckRow[] = [];
  // A line that isn't a rules receipt is a decision no rule made: it fails the check unless explicitly skipped.
  if (!deps.skipNonRules) {
    const rules = new Set(offline.map((r) => r.receipt));
    for (const l of lines) {
      if (rules.has(sha256Hex(l))) continue;
      out.push({ receipt: sha256Hex(l), strategy: "?", hash_match: false, same: false, problems: ["not a rules receipt: no published rule made this decision"], pass: false });
    }
  }
  for (const row of offline) {
    const line = lines.find((l) => sha256Hex(l) === row.receipt)!;
    const c: CheckRow = { ...row, problems: row.error ? [row.error] : [], pass: false };
    out.push(c);
    if (!row.hash_match || !row.same || !row.decision_consistent) { if (!row.same && !row.error) c.problems.push("re-run gives a different decision"); continue; }
    try {
      const r = JSON.parse(line) as RulesReceipt;
      const published = publishedByHash(r.prompt_sha256);
      if (r.network !== net) c.problems.push(`receipt is for ${r.network}, not ${net}`);
      const prov = await provenance(r.vault);
      c.sledgit_vault = prov.sledgit_vault;
      if (!prov.sledgit_vault) c.problems.push(`vault: ${prov.reason}`);
      const all = await decisionsOf(r.vault);
      const mine = all.find((d) => d.receipt_hash === row.receipt);
      c.on_chain = !!mine;
      if (!mine) { c.problems.push("the vault recorded no decision with this receipt hash"); continue; }
      const before = all.filter((d) => d.seq < mine.seq);
      // The vault recorded exactly the decision the rule made (decision_consistent ties the receipt's decision to it).
      const em = await eventMatches(r as unknown as Receipt, mine, async (t) => {
        const d = pinnedPair(r.network)?.decimals[t];
        if (d === undefined) throw new Error(`${t} is not in the ${r.network} pair`);
        return d;
      });
      c.event_matches_decision = em.ok === true;
      if (em.ok !== true) c.problems.push(`the vault's on-chain event doesn't record this decision (${em.detail ?? ""})`);
      // What the rule read must be the chain's state at the decision's transaction block, not just self-consistent.
      try {
        const pair = pinnedPair(r.network);
        if (!pair) throw new Error(`unknown network ${r.network}`);
        const h = mine.tx_block_height ?? await txBlock(net, mine.tx, String(r.agent ?? ""));
        c.state_block = h;
        // A staked strategy reads the pinned staking token and its rate; the receipt can't name another.
        const st = published?.staked ? pair.stake : undefined;
        if (published?.staked && !st) throw new Error(`${r.network} has no staking token`);
        const rv = r.inputs.vault as { stake?: string; stake_rate?: string } | undefined;
        if (st && rv?.stake !== st.token) c.problems.push(`receipt's staking token ${String(rv?.stake)} is not ${st.token}`);
        const rr = (r.inputs.raw as { stake_rate?: string } | undefined)?.stake_rate;
        if (st && (!rr || !/^[0-9]{1,40}$/.test(rr) || fromUnits(BigInt(rr), pair.decimals[pair.base]) !== rv?.stake_rate))
          c.problems.push("recorded staking rate differs from the raw rate in the same receipt");
        const sp = stateProblems(r.inputs.raw as unknown as Partial<VaultState> | undefined,
          await stateAt(net, r.vault, [pair.base, pair.quote, ...(st ? [st.token] : [])], h, st));
        c.chain_state_matches = sp.length === 0;
        c.problems.push(...sp);
      } catch (e) {
        c.chain_state_matches = false;
        c.problems.push(`chain state at the decision's block unreadable: ${(e as Error).message.slice(0, 160)}`);
      }
      // The balances a rule read must be the raw chain values it recorded, converted with the recorded decimals.
      const v = r.inputs.vault as { balances?: Record<string, string> };
      const raw = r.inputs.raw as { balances?: Record<string, string>; decimals?: Record<string, number> } | undefined;
      const bal = Object.entries(v?.balances ?? {});
      c.balances_match_raw = bal.length > 0 && bal.every(([t, h]) => raw?.balances?.[t] !== undefined && raw.decimals?.[t] !== undefined
        && fromUnits(BigInt(raw.balances[t]), raw.decimals[t]) === h);
      if (!c.balances_match_raw) c.problems.push("recorded balances differ from the raw chain balances in the same receipt");
      const market = r.inputs.market as { candles?: Candle[] } | undefined;
      const cm = await candlesMatch(market?.candles ?? [], f);
      c.candles_match = cm === null;
      if (cm) c.problems.push(cm);
      const pp = await pricePlausible(r.inputs.reference_price as { price?: string; fetched_at?: string } | null, f);
      c.reference_price_plausible = pp === null;
      if (pp) c.problems.push(pp);
      if (published?.reads_chain) {
        const ch = r.inputs.chain as unknown as ChainState | undefined;
        if (!ch) { c.chain_inputs_match = false; c.problems.push("receipt has no chain state"); continue; }
        const base = String((r.inputs.vault as { base?: string }).base);
        const want = { seq: mine.seq, ...summarise(before, base, published.staked ? pinnedPair(r.network)?.stake?.token : undefined) };
        const got = { seq: ch.seq, decisions_before: ch.decisions_before, requests: ch.requests, last_request: ch.last_request };
        c.chain_inputs_match = JSON.stringify(got) === JSON.stringify(want);
        if (!c.chain_inputs_match) c.problems.push(`recorded chain state ${JSON.stringify(got)} differs from the chain's ${JSON.stringify(want)}`);
        // The decision's own block time fixes its slot; the receipt can't claim another one.
        const slot = slotStart(mine.block_time_secs * 1000);
        if (ch.slot !== new Date(slot).toISOString()) c.problems.push(`recorded slot ${ch.slot} is not the slot of the decision's block (${new Date(slot).toISOString()})`);
        const sb = await checkSlotBlock(net, slot, ch.slot_block, f);
        c.slot_block_ok = sb === null;
        if (sb) c.problems.push(sb);
        const off = mine.block_time_secs * 1000 - slot >= SCHEDULE.window_minutes * 60_000 || before.some((d) => d.block_time_secs * 1000 >= slot);
        c.off_schedule = off;
        if (off && !ch.off_schedule) c.problems.push("receipt says on schedule, but the decision landed off schedule");
      } else {
        // Version 1 decided from the operator's local outcomes file: it must agree with the vault's own record.
        const local = (r.inputs.history as { outcome?: { status?: string } | null }[] | undefined) ?? [];
        const recent = before.slice(-5);
        const agrees = local.length === recent.length
          && local.every((h, i) => (h.outcome?.status === "traded") === (recent[i].event === "request"));
        c.local_history_matches_chain = agrees;
        if (!agrees) c.problems.push(`recorded local history (${local.length} rows) disagrees with the vault's last ${recent.length} on-chain decisions`);
      }
    } catch (e) {
      c.problems.push(`check failed: ${(e as Error).message}`);
    }
  }
  for (const c of out) c.pass = c.problems.length === 0;
  return out;
}
