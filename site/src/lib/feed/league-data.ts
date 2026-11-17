// The committed leaderboard snapshots (deploy/<network>/league/snapshot.json, schema 3), brought in at
// build time by scripts/league-files.mjs. The site displays them; it never computes standings or proofs itself.
import testnet from "@/data/league-testnet.json";
import mainnet from "@/data/league-mainnet.json";
import type { NetworkId } from "../networks";

export type LeagueProof = "tee" | "rules" | "self";

export interface LeagueDecision {
  seq: number; event: "request" | "refuse" | "skip" | "trade" | "failed"; tx: string; block_time_ms: number; receipt_hash: string;
  in_season: boolean; on_schedule: boolean | null; code?: string; note?: string; side?: "buy" | "sell" | "stake" | "unstake";
  token_in?: string; amount_in?: string; token_out?: string; amount_out?: string; ref_price?: number; fill_price?: number; cost_usd?: number;
  venue?: string; pool_id?: number;
}

export interface LeagueEntry {
  id: string; account: string; name: string; kind: "arena" | "house" | "fixture" | "retired" | "unregistered"; harness: string; model: string; description: string;
  strategy_sha256: string | null;
  proof: { tier: LeagueProof; detail: string; claimed: LeagueProof };
  provenance: { status: "genuine" | "legacy" | "unverified"; reason: string };
  season_seqs: [number, number] | null; events_sha256: string;
  start: { time_ms: number; value_usd: number; price: number } | null;
  end: { value_usd: number; price: number } | null;
  twr: number | null; hold_twr: number | null; stake_twr: number | null; funded_twr: number | null;
  vs_hold: number | null; vs_stake: number | null; vs_funded: number | null; vs_hold_after_gas: number | null;
  range95: { lo: number; hi: number; n: number } | null; beyond_noise: boolean | null;
  costs: { traded_ref_usd: number; fill_vs_reference_usd: number; fill_vs_reference_pct: number | null; gas_near: number; gas_usd: number;
    neutralised_usd: number; benchmark_rebalance_usd: number; benchmark_cost_rate: number; benchmark_cost_rate_source: string };
  counts: { decisions: number; trades: number; skips: number; refusals: number; failed: number; off_schedule: number; missed_slots: number };
  inactive: boolean;
  refusals_by_code: Record<string, number>;
  days: number; ranked: boolean; unranked_reason: string | null;
  series: { t: number; value: number; hold: number; stake: number }[];
  decisions: LeagueDecision[];
}

export interface LeagueSnapshot {
  schema: string; network: "testnet" | "mainnet"; as_of_ms: number; inputs_sha256: string; derived_sha256: string;
  caveat: string | null; method: Record<string, string>;
  season: { id: string; start_ms: number; canonical_pools: number[]; benchmark_cost_rate: { value: number; source: string }; min_value_usd: number };
  benchmarks: { start_ms: number | null; hold_twr: number | null; stake_twr: number | null; stake_vs_hold: number | null; stake_apr: { value: number; source: string } };
  luck_entry: string | null; flags: LeagueFlag[]; excluded: string[]; entries: LeagueEntry[];
  /** By-model view (schema 3); absent in older snapshots. */
  by_model?: LeagueModelGroup[];
}

/** One row of the by-model view: a model family (or published strategy) at one proof tier. No operator labels. */
export interface LeagueModelGroup {
  family: string; tier: LeagueProof; label: string; strategy: string | null; entries: string[];
  sources: number; ranked_entries: number; avg_vs_hold_after_gas: number | null; spread: { lo: number; hi: number } | null;
  scored_sources: number; provisional_vs_hold_after_gas: number | null; decisions: number; trades: number; refusals: number;
  status: "not enough data" | "one source" | "averaged";
}

/** A reader flag; `unrank` flags take every entry in `ids` out of the ranking. */
export interface LeagueFlag { ids: string[]; kind: string; severity: "unrank" | "info"; text: string }

export interface LeagueAgentData { events: { event: string; data: Record<string, unknown>; tx: string; receipt_id: string; block_height: number; block_time_ms: number }[]; observed: Record<string, unknown> }

type LeagueData = { snapshot: LeagueSnapshot; agents: Record<string, LeagueAgentData> };
const tn = testnet as unknown as LeagueData;
const mn = mainnet as unknown as LeagueData | null; // null until deploy/mainnet/league/snapshot.json exists
export const TESTNET_LEAGUE: LeagueSnapshot = tn.snapshot;
export const TESTNET_AGENTS: Record<string, LeagueAgentData> = tn.agents;
export const MAINNET_LEAGUE: LeagueSnapshot | null = mn?.snapshot ?? null;

/** A network's snapshot: null for the simulation, and for mainnet before its first snapshot. */
export const leagueFor = (n: NetworkId): LeagueSnapshot | null => (n === "testnet" ? TESTNET_LEAGUE : n === "mainnet" ? MAINNET_LEAGUE : null);
export const agentsFor = (n: NetworkId): Record<string, LeagueAgentData> => (n === "testnet" ? tn.agents : n === "mainnet" ? mn?.agents ?? {} : {});

/** The snapshot that holds this entry, on any network. */
export const leagueOf = (id: string) => [TESTNET_LEAGUE, MAINNET_LEAGUE].find(l => l?.entries.some(e => e.id === id)) ?? null;
export const entryOf = (id: string) => leagueOf(id)?.entries.find(e => e.id === id);

/** Flags that name this entry (including ones shared with other vaults). */
export const flagsFor = (id: string): LeagueFlag[] => leagueOf(id)?.flags.filter(f => f.ids.includes(id)) ?? [];

/** Display names that differ from the snapshot's (the snapshot itself is hashed and never edited). */
const DISPLAY_NAME: Record<string, string> = { "tn-iron-trader-demo": "Demo trader" };
export const entryName = (e: Pick<LeagueEntry, "id" | "name">) => DISPLAY_NAME[e.id] ?? e.name;

/** Leaderboard section for an entry that isn't a ranked arena/house entry. */
export function sectionOf(id: string): "fixture" | "retired" | "unregistered" | null {
  const k = entryOf(id)?.kind;
  return k === "fixture" || k === "retired" || k === "unregistered" ? k : null;
}

/** Computed benchmark rows (no vault): ids shown in the leaderboard's benchmark section. */
export const TN_BENCH = { hold: "tn-bench-hold", stake: "tn-bench-stake" } as const;
