// Leaderboard data shapes. Inputs are what the collector read (chain events, reference prices, proof checks), pinned
// with a cutoff time; the snapshot is a pure function of them (compute.ts). Schema notes: deploy/testnet/league/SCHEMA.md.
import type { Provenance } from "../provenance.js";

export const INPUTS_SCHEMA = "sledgit-league-inputs/2";
export const SNAPSHOT_SCHEMA = "sledgit-league/3";

export type EntryKind = "arena" | "house" | "fixture" | "retired" | "unregistered";
export type ProofTier = "tee" | "rules" | "self";

/** Tick schedule an entry publishes: a slot every `every_s` at `offset_s` (UTC); a decision is on schedule if it lands
 * within `window_s` after a slot and is the slot's first. Decisions before `since_ms` (publication) are not judged. */
export interface Schedule { every_s: number; offset_s: number; window_s: number; since_ms: number }

/** One entry in the registry (deploy/<net>/league/entries.json). Names and claims; the chain decides the rest. */
export interface EntryMeta {
  id: string;
  account: string;
  name: string;
  kind: EntryKind;
  harness: string;
  model: string;
  description: string;
  /** House strategy id (rules) when kind = house. */
  strategy?: string;
  /** Receipts directory, relative to the registry file. */
  receipts?: string;
  /** Proof the operator claims; the collector checks it and records what actually holds. */
  proof_claim: ProofTier;
  schedule?: Schedule | null;
  /** Retired entries stay listed (their record is kept) but are never ranked. */
  retired?: boolean;
}

/** The league's season: one published start time for every entry (decisions before it are history, shown but not
 * scored), the pools a ranked vault may trade on, and the fixed cost rate charged to the computed benchmarks. */
export interface Season {
  id: string;
  start_ms: number;
  /** Rhea pool ids a ranked entry's trades may use. A trade on any other pool unranks the entry. */
  canonical_pools: number[];
  /** Cost rate charged to the benchmarks' one rebalance (they never trade otherwise), with its source. */
  benchmark_cost_rate: { value: number; source: string };
  /** Minimum vault value (reference USD) for the ranking clock, the day-7 gate and an active entry. */
  min_value_usd: number;
}

/** A vault event the vault itself logged, from a receipt that succeeded, at or before the cutoff. */
export interface RawEvent {
  event: string;
  data: Record<string, unknown>;
  tx: string;
  receipt_id: string;
  block_height: number;
  block_time_ms: number;
}

/** Gas for a transaction that carried one of the vault's decisions (paid by the agent account). */
export interface GasRow { tx: string; tokens_burnt: string; block_time_ms: number }

export interface ProofCheck {
  tier: ProofTier;
  detail: string;
  /** Decision seqs the proof covers (the season's, up to the cutoff). */
  seqs?: [number, number] | null;
  /** Rules entries: the strategy hash every checked receipt carries. */
  strategy_sha256?: string;
  /** Rules entries: how many published strategy versions the season's receipts use (more than one is flagged). */
  strategy_versions?: number;
  receipts_sha256?: string;
  /** Model evidence ids (chat ids, bundle hashes) the entry's receipts cite; reuse across vaults is flagged. */
  evidence_ids: string[];
  /** The model the proof actually binds: tee = the attested model id in every checked receipt; rules = "rules:<id>" of
   * the published strategy behind the receipts' hash. Groups use this, never the registry text (final review 2 F2-02). */
  verified_model?: string;
}

export interface VaultInput {
  entry: EntryMeta;
  provenance: Provenance;
  events: RawEvent[];
  gas: GasRow[];
  proof: ProofCheck;
  /** The transaction list could not be read in full (page cap): the record is incomplete, so the entry is unranked. */
  incomplete?: string | null;
  /** Replay of every collected event (cutoff or not) against the balances read at collection. Absent in inputs
   * collected before it existed. */
  reconciliation?: Reconciliation;
  /** Current views and balances at collection time. Shown on agent pages; not part of the derived hash. */
  observed: Record<string, unknown>;
}

/** Raw units per league token: `surplus` on chain beyond the replay (arrived without a deposit event), `deficit`
 * replayed but not on chain. `error` when the balances could not be reconciled. */
export type Reconciliation = { surplus: Record<string, string>; deficit: Record<string, string> } | { error: string };

export interface TokenInfo { id: string; symbol: string; decimals: number; ref: "NEAR" | "USD" }

export interface LeagueInputs {
  schema: typeof INPUTS_SCHEMA;
  network: "testnet" | "mainnet";
  /** Cutoff: events with a later block time, and prices after it, are not used. */
  as_of_ms: number;
  collected_at: string;
  reference: { source: string; symbol: string; note: string };
  tokens: TokenInfo[];
  /** Hourly reference closes [close time ms (bar open + 1 h), close] covering every season window, oldest first. */
  hourly: [number, number][];
  /** Reference price at exact moments: 1-minute bar close, keyed by the bar's open time (ms). */
  minute: Record<string, number>;
  stake_apr: { value: number; source: string };
  season: Season;
  factories: { id: string; locked: boolean; access_keys: number }[];
  vaults: VaultInput[];
  /** What was deliberately not read (e.g. children of a factory that still holds a key). */
  excluded: string[];
}

export interface DecisionRow {
  seq: number;
  event: "request" | "refuse" | "skip" | "trade" | "failed";
  tx: string;
  block_time_ms: number;
  receipt_hash: string;
  in_season: boolean;
  on_schedule: boolean | null;
  code?: string;
  note?: string;
  side?: "buy" | "sell";
  token_in?: string;
  amount_in?: string;
  token_out?: string;
  amount_out?: string;
  ref_price?: number;
  fill_price?: number;
  cost_usd?: number;
  /** Venue and pool of a trade (Rhea pool id, or "intents"). */
  venue?: string;
  pool_id?: number;
}

/** A reader flag. `unrank` flags take the entry (or every listed entry) out of the ranking. */
export interface Flag { ids: string[]; kind: string; severity: "unrank" | "info"; text: string }

export interface SeriesPoint { t: number; value: number; hold: number; stake: number }

export interface EntryResult {
  id: string;
  account: string;
  name: string;
  kind: EntryKind;
  harness: string;
  model: string;
  description: string;
  strategy_sha256: string | null;
  proof: { tier: ProofTier; detail: string; claimed: ProofTier; verified_model?: string };
  provenance: { status: Provenance["status"]; reason: string };
  /** Seq range scored this season, or null if no decision yet. */
  season_seqs: [number, number] | null;
  /** sha256 of the canonical events in the agent file: the site checks the file against it. */
  events_sha256: string;
  start: { time_ms: number; value_usd: number; price: number } | null;
  end: { value_usd: number; price: number } | null;
  /** Time-weighted return of the vault at the reference price (deposits and withdrawals neutralised). */
  twr: number | null;
  hold_twr: number | null;
  stake_twr: number | null;
  /** The entry's own start holdings, never traded, no costs. */
  funded_twr: number | null;
  vs_hold: number | null;
  vs_stake: number | null;
  vs_funded: number | null;
  /** vs_hold after the agent's gas, the ranking metric. */
  vs_hold_after_gas: number | null;
  /** 95% range of vs_hold (Student-t on hourly excess log returns), or null below the minimum sample. */
  range95: { lo: number; hi: number; n: number } | null;
  /** The range lies wholly above 0: the result vs hold is beyond noise. */
  beyond_noise: boolean | null;
  costs: { traded_ref_usd: number; fill_vs_reference_usd: number; fill_vs_reference_pct: number | null; gas_near: number; gas_usd: number;
    neutralised_usd: number; benchmark_rebalance_usd: number; benchmark_cost_rate: number; benchmark_cost_rate_source: string };
  counts: { decisions: number; trades: number; skips: number; refusals: number; failed: number; off_schedule: number; missed_slots: number };
  /** The vault's value fell below the season minimum by the cutoff (e.g. emptied): its record stays, it isn't ranked. */
  inactive: boolean;
  refusals_by_code: Record<string, number>;
  days: number;
  ranked: boolean;
  unranked_reason: string | null;
  series: SeriesPoint[];
  decisions: DecisionRow[];
}

/** The by-model view: one row per (model family or published strategy, proof tier). No operator labels. */
export interface ModelGroup {
  family: string;
  tier: ProofTier;
  label: string;
  /** House strategy id when the group is a published rules strategy, else null. */
  strategy: string | null;
  entries: string[];
  /** Distinct sources: entries sharing an owner or an agent count as one. */
  sources: number;
  ranked_entries: number;
  /** Mean of vs_hold_after_gas over ranked entries, each source averaged first; null = not enough data. */
  avg_vs_hold_after_gas: number | null;
  /** Lowest and highest source average, when at least two sources are scored. */
  spread: { lo: number; hi: number } | null;
  scored_sources: number;
  /** The same average over every entry with a result, ranked or not: shown as provisional, never scored. */
  provisional_vs_hold_after_gas: number | null;
  decisions: number;
  trades: number;
  refusals: number;
  status: "not enough data" | "one source" | "averaged";
}

export interface Snapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  network: "testnet" | "mainnet";
  as_of_ms: number;
  inputs_sha256: string;
  /** sha256 of the canonical derived part (entries, benchmarks, flags): equal inputs give an equal hash. */
  derived_sha256: string;
  caveat: string | null;
  method: Record<string, string>;
  season: Season;
  benchmarks: { start_ms: number | null; hold_twr: number | null; stake_twr: number | null; stake_vs_hold: number | null; stake_apr: { value: number; source: string } };
  luck_entry: string | null;
  by_model: ModelGroup[];
  flags: Flag[];
  excluded: string[];
  entries: EntryResult[];
}
