// Collect leaderboard inputs: every vault the trusted factories created, its own vault events (succeeded receipts
// only, up to a cutoff), gas per decision transaction, reference prices, and a proof check per registered entry.
// Network reads retry with backoff; if anything still fails, collection throws and nothing is written (fail closed).
// Read-only: no keys, no transactions.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { NetworkId } from "../config.js";
import { cachedProvenance, FACTORIES, type ChainReader } from "../provenance.js";
import { sha256Hex, type Receipt } from "../receipt.js";
import { houseCheck, type CheckRow } from "../strategies/rerun.js";
import { publishedByHash } from "../strategies/registry.js";
import { toUnits } from "../decision.js";
import type { ChainDecision } from "../attest/chain.js";
import { STAKE_APR } from "../strategies/benchmarks.js";
import { cmp } from "./compute.js";
import { isVaultStandard } from "../events.js";
import { PAIRS } from "../pairs.js";
import { ARCHIVAL_RPC } from "../strategies/schedule.js";
import {
  INPUTS_SCHEMA, type EntryMeta, type GasRow, type LeagueInputs, type ProofCheck, type RawEvent, type Reconciliation, type Season, type TokenInfo, type VaultInput,
} from "./types.js";

export const HOSTS: Record<NetworkId, { rpc: string; txApi: string }> = {
  testnet: { rpc: "https://rpc.testnet.fastnear.com", txApi: "https://tx.test.fastnear.com" },
  mainnet: { rpc: "https://free.rpc.fastnear.com", txApi: "https://tx.main.fastnear.com" },
};
const BINANCE = ["https://api.binance.com", "https://data-api.binance.vision"];
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 16 * 1024 * 1024;
/** Per-vault cap on transaction pages (~200 each). Past it the vault is marked incomplete (unranked); the build goes on. */
const MAX_PAGES = 100;
const BATCH = 20;
const HOUR = 3_600_000;
export const STAKE_APR_SOURCE =
  "assumption, not measured: 4.5% APR, the post-2024 NEAR staking rate the backtest uses (agent/src/strategies/benchmarks.ts STAKE_APR); testnet vaults cannot stake";

export interface Registry { network: NetworkId; season: Season; factories: string[]; tokens: TokenInfo["id"][]; entries: EntryMeta[] }

export interface CollectDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (s: string) => void;
  /** Season check for TEE entries (heavy: Intel collateral, NVIDIA) over exactly these receipts and seqs. Returns the
   * pill, a reason, and the vault the receipts belong to (the caller requires it to be the entry's own). */
  teeSeason: (receiptsText: string, attestDir: string, fromSeq: number, toSeq: number, cutoffMs?: number) => Promise<{ pill: boolean; detail: string; vault?: string }>;
  /** `house-rerun --check` (chain + feed + slot) over exactly these receipts, with the vault's decisions bounded by the cutoff. */
  rulesCheck: (receiptsText: string, net: NetworkId, decisions: (vault: string) => Promise<ChainDecision[]>) => Promise<CheckRow[]>;
}

async function withRetry<T>(what: string, fn: () => Promise<T>, d: CollectDeps, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await d.sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`${what}: ${(last as Error)?.message ?? String(last)} (after ${tries} tries)`);
}

async function getJson<T>(url: string, d: CollectDeps, body?: unknown): Promise<T> {
  const res = await d.fetch(url, {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`${new URL(url).host}: response over ${MAX_BYTES} bytes`);
  return JSON.parse(text) as T;
}

function rpcFor(net: NetworkId, d: CollectDeps) {
  const call = <T>(method: string, params: unknown) => withRetry(`rpc ${method}`, async () => {
    const r = await getJson<{ result?: T; error?: { message?: string; cause?: { name?: string } } }>(HOSTS[net].rpc, d,
      { jsonrpc: "2.0", id: "league", method, params });
    if (r.error || r.result === undefined) throw new Error(r.error?.cause?.name ?? r.error?.message ?? "no result");
    return r.result;
  }, d);
  const view = async <T>(account: string, method: string, args: object = {}): Promise<T> => {
    const r = await call<{ result?: number[] }>("query", { request_type: "call_function", finality: "final", account_id: account,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    return JSON.parse(Buffer.from(r.result ?? []).toString("utf8")) as T;
  };
  const reader: ChainReader = {
    viewAccount: (id) => call("query", { request_type: "view_account", finality: "final", account_id: id }),
    accessKeyCount: async (id) => (await call<{ keys?: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: id })).keys?.length ?? 0,
    view: (id, method) => view(id, method),
  };
  return { call, view, reader };
}

interface TxRecord {
  transaction?: { hash?: string };
  execution_outcome?: { block_timestamp?: number | string; outcome?: { tokens_burnt?: string } };
  receipts?: { execution_outcome?: { id?: string; block_height?: number; block_timestamp?: number | string; outcome?: { logs?: string[]; executor_id?: string; status?: unknown; tokens_burnt?: string } } }[];
}

const failed = (status: unknown) => typeof status === "object" && status !== null && "Failure" in status;

/** The vault's own events from succeeded receipts, plus gas for each transaction that carried a decision. */
export function parseTxs(vault: string, txs: TxRecord[], asOfMs: number): { events: RawEvent[]; gas: GasRow[]; later: number; after: RawEvent[] } {
  const events: RawEvent[] = [];
  const after: RawEvent[] = [];
  const gas: GasRow[] = [];
  let later = 0;
  for (const tx of txs) {
    let decision = false, last = 0;
    let burnt = BigInt(String(tx.execution_outcome?.outcome?.tokens_burnt ?? "0"));
    for (const rec of tx.receipts ?? []) {
      const o = rec.execution_outcome;
      burnt += BigInt(String(o?.outcome?.tokens_burnt ?? "0"));
      // Only receipts the vault executed, and only if they succeeded: anyone can log a vault-shaped event from elsewhere.
      if (!o?.outcome || o.outcome.executor_id !== vault || failed(o.outcome.status)) continue;
      const t = Math.floor(Number(o.block_timestamp) / 1e6);
      for (const log of o.outcome.logs ?? []) {
        if (!log.startsWith("EVENT_JSON:")) continue;
        let ev: { standard?: string; event?: string; data?: Record<string, unknown>[] };
        try {
          ev = JSON.parse(log.slice("EVENT_JSON:".length));
        } catch {
          continue;
        }
        if (!isVaultStandard(ev.standard) || typeof ev.event !== "string") continue;
        const row = (data: Record<string, unknown>): RawEvent => ({ event: ev.event!, data, tx: String(tx.transaction?.hash ?? ""),
          receipt_id: String(o.id ?? ""), block_height: Number(o.block_height), block_time_ms: t });
        // After the cutoff: not scored, but replayed for the reconciliation at collection.
        if (t > asOfMs) { later++; for (const data of ev.data ?? []) after.push(row(data)); continue; }
        if (ev.event === "request" || ev.event === "refuse" || ev.event === "skip") { decision = true; last = t; }
        for (const data of ev.data ?? []) events.push(row(data));
      }
    }
    if (decision) gas.push({ tx: String(tx.transaction?.hash ?? ""), tokens_burnt: burnt.toString(), block_time_ms: last });
  }
  events.sort((a, b) => a.block_height - b.block_height || cmp(a.receipt_id, b.receipt_id));
  after.sort((a, b) => a.block_height - b.block_height || cmp(a.receipt_id, b.receipt_id));
  gas.sort((a, b) => a.block_time_ms - b.block_time_ms || cmp(a.tx, b.tx));
  return { events, gas, later, after };
}

async function vaultTxs(net: NetworkId, vault: string, d: CollectDeps): Promise<{ txs: TxRecord[]; incomplete: string | null }> {
  const hashes: string[] = [];
  let resume: string | undefined;
  let incomplete: string | null = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) { incomplete = `more than ${MAX_PAGES} pages of transactions; not read in full`; break; }
    const r = await withRetry(`${vault} transactions`, () => getJson<{ account_txs?: { transaction_hash: string }[]; resume_token?: string }>(
      `${HOSTS[net].txApi}/v0/account`, d, { account_id: vault, ...(resume ? { resume_token: resume } : {}) }), d);
    if (!Array.isArray(r.account_txs)) throw new Error(`transactions API: no account_txs for ${vault}`);
    hashes.push(...r.account_txs.map((t) => t.transaction_hash));
    if (!r.resume_token || !r.account_txs.length) break;
    resume = r.resume_token;
  }
  const unique = [...new Set(hashes)].sort(cmp);
  const out: TxRecord[] = [];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const r = await withRetry("transactions", async () => {
      const x = await getJson<{ transactions?: (TxRecord | null)[] }>(`${HOSTS[net].txApi}/v0/transactions`, d, { tx_hashes: chunk });
      if (!Array.isArray(x.transactions) || x.transactions.filter(Boolean).length !== chunk.length) throw new Error("fewer transactions returned than asked");
      return x.transactions as TxRecord[];
    }, d);
    out.push(...r);
  }
  return { txs: out, incomplete };
}

/** Binance NEARUSDT klines; closes keyed by bar open time. */
async function klines(interval: "1m" | "1h", startMs: number, endMs: number, d: CollectDeps): Promise<[number, number][]> {
  const out: [number, number][] = [];
  let from = startMs;
  const step = interval === "1m" ? 60_000 : HOUR;
  while (from <= endMs) {
    const rows = await withRetry(`reference ${interval}`, async () => {
      const errs: string[] = [];
      for (const h of BINANCE) {
        try {
          return await getJson<unknown[][]>(`${h}/api/v3/klines?symbol=NEARUSDT&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`, d);
        } catch (e) {
          errs.push((e as Error).message);
        }
      }
      throw new Error(errs.join("; "));
    }, d);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const k of rows) {
      const t = Number(k[0]), c = Number(k[4]);
      if (!Number.isFinite(c) || !(c > 0) || !Number.isFinite(t)) throw new Error("malformed kline");
      out.push([t, c]);
    }
    const next = Number(rows[rows.length - 1][0]) + step;
    if (next <= from) break;
    from = next;
  }
  return out;
}

function receiptsOf(dir: string): { text: string; receipts: Receipt[] } {
  const f = join(dir, "receipts.jsonl");
  if (!existsSync(f)) return { text: "", receipts: [] };
  const text = readFileSync(f, "utf8");
  return { text, receipts: text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Receipt) };
}

const DECISIONS = ["request", "refuse", "skip"];

/** A receipt's decision is what the vault recorded: hold ↔ skip; buy/sell/stake/unstake ↔ request or refuse with the
 * same tokens (buy: quote -> base, sell: base -> quote, stake: base -> staking token, unstake: the reverse) and the same
 * raw amount. Returns a problem, or null. */
export function decisionMismatch(r: Receipt, ev: RawEvent, tokens: TokenInfo[]): string | null {
  const d = (r.decision ?? {}) as { action?: string; amount_in?: string };
  const ref = (x: TokenInfo["ref"]) => tokens.find((t) => t.ref === x);
  const LEGS: Record<string, [TokenInfo["ref"], TokenInfo["ref"]]> = { buy: ["USD", "NEAR"], sell: ["NEAR", "USD"], stake: ["NEAR", "STAKE"], unstake: ["STAKE", "NEAR"] };
  if (d.action === "hold") return ev.event === "skip" ? null : `receipt says hold, the vault recorded ${ev.event}`;
  const leg = Object.hasOwn(LEGS, String(d.action)) ? LEGS[String(d.action)] : undefined;
  if (!leg) return `receipt has no valid decision (${String(d.action)})`;
  if (ev.event !== "request" && ev.event !== "refuse") return `receipt says ${d.action}, the vault recorded ${ev.event}`;
  const tin = ref(leg[0]), tout = ref(leg[1]);
  if (!tin || String(ev.data.token_in) !== tin.id) return `receipt's ${d.action} spends ${tin?.id ?? "?"}, the vault's request spends ${String(ev.data.token_in)}`;
  if (ev.data.token_out !== undefined && (!tout || String(ev.data.token_out) !== tout.id))
    return `receipt's ${d.action} buys ${tout?.id ?? "?"}, the vault's request buys ${String(ev.data.token_out)}`;
  let want: bigint;
  try {
    want = toUnits(String(d.amount_in), tin.decimals);
  } catch (e) {
    return `receipt amount ${String(d.amount_in)}: ${(e as Error).message}`;
  }
  return String(ev.data.amount_in) === want.toString() ? null : `receipt amount ${String(d.amount_in)} is not the vault's ${String(ev.data.amount_in)} raw units`;
}

/** The entry's own decisions read from chain (by the cutoff), in the shape the house check reads. */
function chainDecisions(events: RawEvent[]): ChainDecision[] {
  return events.filter((e) => DECISIONS.includes(e.event)).map((e) => ({
    seq: Number(e.data.seq), event: e.event as ChainDecision["event"], receipt_hash: String(e.data.receipt_hash ?? ""),
    ...(e.data.token_in !== undefined ? { token_in: String(e.data.token_in) } : {}),
    ...(e.data.token_out !== undefined ? { token_out: String(e.data.token_out) } : {}), ...(e.data.amount_in !== undefined ? { amount_in: String(e.data.amount_in) } : {}),
    ...(e.data.note !== undefined ? { note: String(e.data.note) } : {}), tx: e.tx, block_time_secs: Math.floor(e.block_time_ms / 1000),
  })).sort((a, b) => a.seq - b.seq);
}

/** Check the claimed proof against the receipts and the entry's own on-chain decisions in the season, by the cutoff.
 * Every in-season decision needs its receipt; every receipt must be for this vault and decide exactly what the vault
 * recorded; then the tier's own check runs (house-rerun --check, or the TEE season check) over exactly those receipts. */
export async function checkProof(entry: EntryMeta, registryDir: string, events: RawEvent[], ctx: { net: NetworkId; seasonStartMs: number; tokens: TokenInfo[]; asOfMs?: number },
  d: CollectDeps): Promise<ProofCheck> {
  const dir = entry.receipts ? resolve(registryDir, entry.receipts) : "";
  const all = dir ? receiptsOf(dir) : { text: "", receipts: [] };
  const season = events.filter((e) => DECISIONS.includes(e.event) && e.block_time_ms >= ctx.seasonStartMs).sort((a, b) => Number(a.data.seq) - Number(b.data.seq));
  const want = new Map(season.map((e) => [String(e.data.receipt_hash), e]));
  // Only receipts for this season's decisions on chain by the cutoff: later ticks never change a snapshot.
  const kept = all.text.split("\n").filter((l) => l.trim() && want.has(sha256Hex(l)));
  const text = kept.length ? `${kept.join("\n")}\n` : "";
  const receipts = kept.map((l) => JSON.parse(l) as Receipt);
  const evidence = receipts.flatMap((r) => (r.attestation ? [`chat:${r.attestation.chat_id}`, `bundle:${r.attestation.bundle_sha256}`] : []));
  const seqs: [number, number] | null = season.length ? [Number(season[0].data.seq), Number(season[season.length - 1].data.seq)] : null;
  const versions = [...new Set(receipts.map((r) => String(r.prompt_sha256)))];
  const base = { evidence_ids: [...new Set(evidence)].sort(cmp), seqs, ...(text ? { receipts_sha256: sha256Hex(text) } : {}),
    ...(receipts.length ? { strategy_sha256: String(receipts[receipts.length - 1].prompt_sha256), strategy_versions: versions.length } : {}) };
  const self = (detail: string): ProofCheck => ({ tier: "self", detail, ...base });
  if (entry.proof_claim === "self") return self("self-reported: harness and model are the operator's word");
  if (!season.length) return self("no decision in the season yet");
  const inFile = new Set(kept.map((l) => sha256Hex(l)));
  const missing = season.filter((e) => !inFile.has(String(e.data.receipt_hash)));
  if (missing.length) return self(`${missing.length} in-season decision(s) have no receipt in the file (first: seq ${String(missing[0].data.seq)})`);
  for (const [k, line] of kept.entries()) {
    const r = receipts[k];
    if (r.vault !== entry.account) return self(`a receipt belongs to ${String(r.vault)}, not this vault`);
    const bad = decisionMismatch(r, want.get(sha256Hex(line))!, ctx.tokens);
    if (bad) return self(`seq ${String(want.get(sha256Hex(line))!.data.seq)}: ${bad}`);
  }
  const span = `seqs ${seqs![0]}-${seqs![1]}`;

  if (entry.proof_claim === "rules") {
    const own = chainDecisions(events);
    let rows: CheckRow[];
    try {
      rows = await d.rulesCheck(text, ctx.net, async (v) => {
        if (v !== entry.account) throw new Error(`receipt names ${v}, not this vault`);
        return own;
      });
    } catch (e) {
      return self(`house-rerun --check failed: ${(e as Error).message.slice(0, 160)}`);
    }
    if (rows.length !== kept.length) return self(`house-rerun --check covered ${rows.length} of ${kept.length} receipt(s) (not all are rules receipts)`);
    const bad = rows.filter((r) => !r.pass);
    if (bad.length) return self(`house-rerun --check: ${bad.length} of ${rows.length} receipt(s) fail (${bad[0].problems[0] ?? "different decision"})`);
    const strategies = [...new Set(versions.map((h) => publishedByHash(String(h))?.id ?? "?"))];
    if (strategies.length !== 1 || strategies[0] === "?") return self(`receipts don't name exactly one published strategy (${strategies.join(", ")})`);
    return { tier: "rules", verified_model: `rules:${strategies[0]}`, detail: `house-rerun --check passes for ${rows.length} of ${rows.length} in-season decision(s) (${span}): published strategy, recorded inputs match chain and feed, and each receipt decides what the vault recorded`,
      strategy_sha256: receipts[receipts.length - 1].prompt_sha256, strategy_versions: versions.length, ...base };
  }
  if (entry.proof_claim === "tee") {
    const r = await d.teeSeason(text, join(dir, "attestations"), seqs![0], seqs![1], ctx.asOfMs);
    if (r.vault !== undefined && r.vault !== entry.account) return self(`TEE season check ran on ${r.vault}, not this vault`);
    if (!r.pill) return self(`TEE season check failed: ${r.detail}`);
    const models = [...new Set(receipts.map((x) => String((x.model as { id?: string } | undefined)?.id ?? "")))];
    if (models.length !== 1 || !models[0]) return self(`receipts don't name exactly one attested model (${models.join(", ")})`);
    return { tier: "tee", verified_model: models[0], detail: `${r.detail} (${span}, as of the cutoff)`, ...base };
  }
  return self(`unknown proof claim ${String(entry.proof_claim)}`);
}

export interface Balance { token: string; wallet: string; exchange: string; intents: string }

/** Replayed holdings from every collected event (by the cutoff and after it, raw units) against the balances read at
 * collection, so later activity never skips the check. `result` goes into the inputs; `observed` is the detail. */
export function reconcile(events: RawEvent[], after: RawEvent[], balances: Balance[]): { result: Reconciliation; observed: Record<string, unknown> } {
  const h = new Map<string, bigint>();
  const add = (t: string, x: bigint) => h.set(t, (h.get(t) ?? 0n) + x);
  for (const e of [...events, ...after]) {
    const d = e.data;
    // `amount` is what a deposit accepted (any `returned` excess went back); deposit_refused moves nothing.
    if (e.event === "deposit") add(String(d.token), BigInt(String(d.amount)));
    if (e.event === "withdraw") add(String(d.token), -BigInt(String(d.amount)));
    if (e.event === "trade") { add(String(d.token_in), -BigInt(String(d.amount_in))); add(String(d.token_out), BigInt(String(d.amount_out))); }
  }
  const surplus: Record<string, string> = {}, deficit: Record<string, string> = {};
  const diff = balances.map((b) => ({ token: b.token, replay: h.get(b.token) ?? 0n, chain: BigInt(b.wallet) + BigInt(b.exchange) + BigInt(b.intents) }))
    .filter((x) => x.replay !== x.chain);
  for (const x of diff) {
    if (x.chain > x.replay) surplus[x.token] = (x.chain - x.replay).toString();
    else deficit[x.token] = (x.replay - x.chain).toString();
  }
  const status = Object.keys(deficit).length ? "mismatch" : diff.length ? "untracked" : "ok";
  return { result: { surplus, deficit }, observed: { status, events_replayed: events.length + after.length,
    ...(diff.length ? { diff: diff.map((x) => ({ token: x.token, replay: x.replay.toString(), chain: x.chain.toString() })) } : {}) } };
}

/** Attempts before a difference is recorded: a transaction in flight, or not yet indexed, shows as one. */
const RECONCILE_TRIES = 3;
const settled = (r: Reconciliation) => !("error" in r) && !Object.keys(r.surplus).length && !Object.keys(r.deficit).length;

/** Registered entries are always in the snapshot; an unregistered vault only if it has an event before the cutoff
 * (or its record couldn't be read in full, which is flagged rather than hidden). Final review 2 F2-05. */
export function inSnapshot(kind: string | undefined, eventsBeforeCutoff: number, incomplete: unknown): boolean {
  return kind !== "unregistered" || eventsBeforeCutoff > 0 || Boolean(incomplete);
}

export async function collect(registryPath: string, asOfMs: number, d: CollectDeps): Promise<LeagueInputs> {
  const reg = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const net = reg.network;
  const S = reg.season;
  if (!S || !Number.isFinite(S.start_ms) || !Array.isArray(S.canonical_pools) || !(S.min_value_usd >= 0) || !Number.isFinite(S.benchmark_cost_rate?.value))
    throw new Error("registry: season { id, start_ms, canonical_pools, benchmark_cost_rate, min_value_usd } is required");
  const ids = new Set<string>(), accts = new Set<string>();
  for (const e of reg.entries) {
    if (!/^[a-z0-9-]{1,64}$/.test(e.id)) throw new Error(`registry: bad id ${e.id}`);
    if (ids.has(e.id) || accts.has(e.account)) throw new Error(`registry: duplicate id or account ${e.id} / ${e.account}`);
    ids.add(e.id); accts.add(e.account);
  }
  const registryDir = dirname(registryPath);
  const { view, reader } = rpcFor(net, d);
  const prov = cachedProvenance(net, reader);

  const factories: LeagueInputs["factories"] = [];
  const accounts = new Set<string>();
  for (const f of reg.factories) {
    const known = FACTORIES[net].find((k) => k.id === f);
    if (!known) throw new Error(`${f} is not a known factory in provenance.ts`);
    const keys = await reader.accessKeyCount(f);
    factories.push({ id: f, locked: known.locked && keys === 0, access_keys: keys });
    for (let from = 0; ; from += 100) {
      const page = await view<string[]>(f, "get_vaults", { from_index: from, limit: 100 });
      page.forEach((a) => accounts.add(a));
      if (page.length < 100) break;
    }
  }
  for (const e of reg.entries) accounts.add(e.account);
  const entryOf = (account: string): EntryMeta => {
    const e = reg.entries.find((x) => x.account === account);
    if (e) return e.retired ? { ...e, kind: "retired" } : e;
    // Not in the registry: listed apart, under an id that can never collide with a registered one.
    return { id: `u-${account}`, account, name: account, kind: "unregistered", harness: "unknown", model: "unknown",
      description: "A vault from the factory with no registry entry. Its name was chosen by whoever created it.", proof_claim: "self" };
  };
  const excluded = FACTORIES[net].filter((k) => !reg.factories.includes(k.id)).map((k) =>
    `children of ${k.id} not read: ${k.locked ? "not in this league" : "the factory still holds a key, so its vaults are legacy"}`);

  const tokens: TokenInfo[] = [];
  for (const [i, id] of reg.tokens.entries()) {
    const m = await view<{ decimals?: number; symbol?: string }>(id, "ft_metadata");
    if (typeof m.decimals !== "number" || m.decimals < 0 || m.decimals > 38) throw new Error(`${id}: bad decimals`);
    const ref = id === PAIRS[net].stake?.token ? "STAKE" : i === 0 ? "NEAR" : i === 1 ? "USD" : null;
    if (!ref) throw new Error(`registry: ${id} is not the network's base, quote or staking token`);
    tokens.push({ id, symbol: String(m.symbol ?? id), decimals: m.decimals, ref });
  }

  const vaults: VaultInput[] = [];
  for (const account of [...accounts].sort(cmp)) {
    const entry = entryOf(account);
    d.log(`reading ${account}`);
    const provenance = await prov(account);
    let { txs, incomplete } = await vaultTxs(net, account, d);
    let parsed = parseTxs(account, txs, asOfMs);
    // An unregistered vault with nothing on chain before the cutoff (e.g. created after it) isn't part of this snapshot:
    // anyone can create one, so counting it would let a stranger change a past snapshot's hash (final-review-2 F2-05).
    if (!inSnapshot(entry.kind, parsed.events.length, incomplete)) {
      d.log(`skipping ${account}: no event before the cutoff (${parsed.later} after)`);
      continue;
    }
    const observed: Record<string, unknown> = {};
    for (const m of ["get_config", "get_policy", "get_usage", "get_intents"]) {
      try {
        observed[m.replace("get_", "")] = await view(account, m);
      } catch (e) {
        observed[`${m.replace("get_", "")}_error`] = (e as Error).message.slice(0, 160);
      }
    }
    // Balances where the vault's tokens can sit: its own wallet, its Rhea deposit, its NEAR Intents balance. A read
    // error stops the build (fail closed); a difference from the replay is the entry's flag, after a re-read.
    const cfg = (observed.config ?? {}) as { exchange_id?: string; intents_id?: string };
    const readBalances = async (): Promise<Balance[]> => {
      const ex = cfg.exchange_id ? await view<Record<string, string>>(cfg.exchange_id, "get_deposits", { account_id: account }) : null;
      const it = cfg.intents_id ? await view<string[]>(cfg.intents_id, "mt_batch_balance_of", { account_id: account, token_ids: tokens.map((t) => `nep141:${t.id}`) }) : null;
      const out: Balance[] = [];
      for (const [i, t] of tokens.entries())
        out.push({ token: t.id, wallet: await view<string>(t.id, "ft_balance_of", { account_id: account }), exchange: ex?.[t.id] ?? "0", intents: it?.[i] ?? "0" });
      return out;
    };
    let balances: Balance[] = [];
    let rc: { result: Reconciliation; observed: Record<string, unknown> };
    if (incomplete) rc = { result: { error: "incomplete record" }, observed: { status: "not checked: incomplete record" } };
    else if (!observed.config) rc = { result: { error: "vault config not readable" }, observed: { status: "not checked: vault config not readable" } };
    else {
      balances = await readBalances();
      rc = reconcile(parsed.events, parsed.after, balances);
      for (let k = 1; k < RECONCILE_TRIES && !incomplete && !settled(rc.result); k++) {
        d.log(`${account}: balances differ from the replay; reading again`);
        await d.sleep(15_000 * k);
        ({ txs, incomplete } = await vaultTxs(net, account, d));
        parsed = parseTxs(account, txs, asOfMs);
        balances = await readBalances();
        rc = incomplete ? { result: { error: "incomplete record" }, observed: { status: "not checked: incomplete record" } }
          : reconcile(parsed.events, parsed.after, balances);
      }
    }
    const { events, gas } = parsed;
    const proof = incomplete ? { tier: "self" as const, detail: `not checked: ${incomplete}`, evidence_ids: [] }
      : await checkProof(entry, registryDir, events, { net, seasonStartMs: S.start_ms, tokens, asOfMs }, d);
    observed.balances = balances;
    observed.reconciliation = rc.observed;
    vaults.push({ entry, provenance, events, gas, proof, ...(incomplete ? { incomplete } : {}), reconciliation: rc.result, observed });
  }

  // Reference prices: hourly closes over every window, and the 1-minute bar at each event, gas and the cutoff.
  const times = new Set<number>([asOfMs, S.start_ms]);
  for (const v of vaults) { v.events.forEach((e) => times.add(e.block_time_ms)); v.gas.forEach((g) => times.add(g.block_time_ms)); }
  const first = Math.min(...times);
  // Hourly marks carry the bar's close time: a close is only known once the hour is over.
  const hourly = (await klines("1h", Math.floor(first / HOUR) * HOUR, asOfMs, d)).map(([t, c]): [number, number] => [t + HOUR, c]).filter(([t]) => t <= asOfMs);
  const minute: Record<string, number> = {};
  const wanted = [...new Set([...times].map((t) => Math.floor(t / 60_000) * 60_000))].sort((a, b) => a - b);
  for (const m of wanted) {
    const k = await klines("1m", m, m, d);
    const hit = k.find(([t]) => t === m);
    if (!hit) throw new Error(`no 1-minute reference bar at ${new Date(m).toISOString()}`);
    minute[String(m)] = hit[1];
  }
  const stake_rates = await stakeRates(net, tokens, vaults, asOfMs, d);
  return {
    schema: INPUTS_SCHEMA, network: net, as_of_ms: asOfMs, collected_at: new Date().toISOString(),
    reference: { source: `${BINANCE[0]}/api/v3/klines?symbol=NEARUSDT`, symbol: "NEARUSDT",
      note: "1-minute closes at event times, hourly closes for the series; the quote stablecoin is valued at $1" },
    tokens, hourly, minute, stake_apr: { value: STAKE_APR, source: STAKE_APR_SOURCE },
    ...(Object.keys(stake_rates).length ? { stake_rates } : {}), season: S, factories, vaults, excluded,
  };
}

const DAY = 86_400_000;

/** Redemption-rate samples for each STAKE token a vault touched: one at the start of each UTC day from the day before
 * its first event to the cutoff, and one at the cutoff. Each is read at a recorded block height (archival RPC). */
export async function stakeRates(net: NetworkId, tokens: TokenInfo[], vaults: VaultInput[], asOfMs: number, d: CollectDeps): Promise<Record<string, [number, number, string][]>> {
  const out: Record<string, [number, number, string][]> = {};
  for (const k of tokens.filter((t) => t.ref === "STAKE")) {
    const method = PAIRS[net].stake?.token === k.id ? PAIRS[net].stake!.rate_method : undefined;
    if (!method) throw new Error(`${k.id}: no redemption-rate method`);
    const touched = vaults.flatMap((v) => v.events).filter((e) => [e.data.token, e.data.token_in, e.data.token_out].includes(k.id)).map((e) => e.block_time_ms);
    if (!touched.length) continue;
    const targets: number[] = [];
    for (let t = Math.floor(Math.min(...touched) / DAY) * DAY - DAY; t < asOfMs; t += DAY) targets.push(t);
    targets.push(asOfMs);
    const rows: [number, number, string][] = [];
    for (const t of targets) {
      const b = await blockBefore(net, t, d);
      const rate = await archivalView<string>(net, k.id, method, b.height, d);
      if (!/^[0-9]{1,40}$/.test(String(rate))) throw new Error(`${k.id}.${method} at ${b.height}: ${String(rate).slice(0, 40)}`);
      if (!rows.length || rows[rows.length - 1][1] !== b.height) rows.push([b.time_ms, b.height, String(rate)]);
    }
    out[k.id] = rows;
  }
  return out;
}

async function archival<T>(net: NetworkId, method: string, params: unknown, d: CollectDeps): Promise<T> {
  return withRetry(`archival ${method}`, async () => {
    const r = await getJson<{ result?: T; error?: { message?: string; cause?: { name?: string } } }>(ARCHIVAL_RPC[net], d, { jsonrpc: "2.0", id: "league", method, params });
    if (r.error || r.result === undefined) throw new Error(r.error?.cause?.name ?? r.error?.message ?? "no result");
    return r.result;
  }, d);
}

async function archivalView<T>(net: NetworkId, account: string, method: string, height: number, d: CollectDeps): Promise<T> {
  const r = await archival<{ result?: number[] }>(net, "query", { request_type: "call_function", block_id: height, account_id: account,
    method_name: method, args_base64: "e30=" }, d);
  return JSON.parse(Buffer.from(r.result ?? []).toString("utf8")) as T;
}

/** A block at or just before t (ms): estimated from the head's pace, then stepped back until its time is <= t. */
async function blockBefore(net: NetworkId, t: number, d: CollectDeps): Promise<{ height: number; time_ms: number }> {
  type B = { header: { height: number; timestamp: number | string } };
  const at = async (q: unknown) => { const b = await archival<B>(net, "block", q, d); return { height: b.header.height, time_ms: Math.floor(Number(b.header.timestamp) / 1e6) }; };
  const head = await at({ finality: "final" });
  if (head.time_ms <= t) return head;
  const past = await at({ block_id: Math.max(1, head.height - 100_000) });
  const pace = (head.time_ms - past.time_ms) / Math.max(1, head.height - past.height);
  let h = Math.max(1, head.height - Math.ceil((head.time_ms - t) / pace));
  for (let i = 0; i < 12; i++) {
    const b = await at({ block_id: h }).catch(() => null); // a skipped height
    if (b && b.time_ms <= t) return b;
    h = Math.max(1, h - (b ? Math.ceil((b.time_ms - t) / pace) + 10 : 1));
  }
  throw new Error(`no block found before ${new Date(t).toISOString()}`);
}
