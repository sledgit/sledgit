// The scoreboard's numbers, read from a committed snapshot (the live network's by default): standings, quips, the
// ticker, the latest refusal. A network without a snapshot has none of them.
import { entryName, type LeagueDecision, type LeagueEntry, type LeagueSnapshot } from "./feed/league-data";
import { LIVE_LEAGUE, NETWORKS, shortAccount } from "./networks";

type League = LeagueSnapshot | null;
const DAY = 86_400_000;

/** vs Hold 50/50 after gas, as the reader computed it (null before an entry starts). */
export const vsHold = (e: LeagueEntry) => e.vs_hold_after_gas ?? e.vs_hold;

/** Arena and house entries in the snapshot's order, without the luck baseline (a benchmark, not an agent). */
export const boardEntries = (L: League = LIVE_LEAGUE) => (L?.entries ?? []).filter(e => (e.kind === "arena" || e.kind === "house") && e.id !== L?.luck_entry && e.start);

/** Entries beating hold, of how many, and the season day (null before a snapshot with a season start). */
export function score(L: League = LIVE_LEAGUE) {
  const es = boardEntries(L), start = L?.season.start_ms;
  return { beat: es.filter(e => (vsHold(e) ?? 0) > 0).length, total: es.length,
    day: L && start != null && Number.isFinite(start) ? Math.floor((L.as_of_ms - start) / DAY) + 1 : null };
}

/** Value against holding over time: value / hold - 1 at each hourly point. */
export const relSeries = (e: LeagueEntry) => e.series.filter(p => p.hold > 0).map(p => ({ t: p.t, v: p.value / p.hold - 1 }));

/** One short, factual line from the numbers. No promises. */
export function quip(e: LeagueEntry): { text: string; tone: "up" | "down" | "flat" } {
  const v = vsHold(e);
  if (v == null) return { text: "No record yet.", tone: "flat" };
  if (e.counts.trades === 0) return { text: v >= 0 ? "Held every time. Level with holding." : "Held every time.", tone: v > 0 ? "up" : "flat" };
  if (v > 0) return { text: "Ahead of holding, for now.", tone: "up" };
  if (e.counts.refusals > 0) return { text: `Lost to holding. Refused ${e.counts.refusals}×.`, tone: "down" };
  return { text: "Lost to holding.", tone: "down" };
}

const shown = (L: LeagueSnapshot, e: LeagueEntry) => (e.kind === "arena" || e.kind === "house" ? entryName(e) : shortAccount(NETWORKS[L.network], e.account));
const refused = (d: LeagueDecision) => d.event === "refuse" || String(d.note ?? "").startsWith("refused");

export interface Tick { key: string; who: string; text: string; refused: boolean; ok: boolean }
// The amount spent, in the token spent, at its network's decimals.
const amount = (L: LeagueSnapshot, d: LeagueDecision) => {
  const ts = NETWORKS[L.network].tokens;
  const t = ts.find(x => x.id === d.token_in) ?? ts[d.side === "buy" ? 1 : 0];
  return `${(Number(d.amount_in ?? 0) / 10 ** (t?.decimals ?? 24)).toFixed(2)} ${t?.symbol ?? ""}`;
};

/**
 * The latest decisions across every vault: trades and vault refusals first, a few holds for texture. A runner's own
 * pre-check (a skip noted "refused:...", e.g. insufficient_balance) never reached the vault, so it isn't shown, and
 * repeats from one entry collapse into one item.
 */
export function ticker(limit = 24, L: League = LIVE_LEAGUE): Tick[] {
  if (!L) return [];
  const all = L.entries.flatMap(e => e.decisions.map(d => ({ e, d })));
  all.sort((a, b) => b.d.block_time_ms - a.d.block_time_ms);
  const local = (d: LeagueDecision) => d.event === "skip" && String(d.note ?? "").startsWith("refused");
  const acts = all.filter(x => x.d.event === "trade" || x.d.event === "refuse").slice(0, limit);
  const holds = all.filter(x => x.d.event === "skip" && !local(x.d)).slice(0, 8);
  const seen = new Set<string>();
  return [...acts, ...holds].sort((a, b) => b.d.block_time_ms - a.d.block_time_ms).map(({ e, d }) => {
    const r = d.event === "refuse", code = d.code ?? "";
    return { key: `${d.tx}-${d.seq}`, who: shown(L, e), refused: r, ok: d.event === "trade",
      text: d.event === "trade" ? `${d.side?.toUpperCase()} ${amount(L, d)}` : r ? `REFUSED${code ? `: ${code}` : ""}` : "HOLD" };
  }).filter(t => { const k = `${t.who}|${t.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The latest refusal on record, else the latest decision. */
export function latestRefusal(L: League = LIVE_LEAGUE) {
  const all = (L?.entries ?? []).flatMap(e => e.decisions.map(d => ({ e, d }))).sort((a, b) => b.d.block_time_ms - a.d.block_time_ms);
  return all.find(x => x.d.event === "refuse") ?? all[0];
}

/** The id the receipt page looks up (see decisionOf in feed/near.ts). */
export const receiptId = (d: LeagueDecision) => `${d.tx}-${d.seq}`;

/** The live network's wording for the home page, ticker and season page. Testnet carries its price caveat. */
export function liveCopy(net: "testnet" | "mainnet", L: League) {
  const tn = net === "testnet", label = NETWORKS[net].label, Net = tn ? "Testnet" : "Mainnet";
  return {
    label, net: Net, launching: !boardEntries(L).length,
    eyebrow: tn ? "On NEAR · testnet now, mainnet later" : "On NEAR mainnet",
    season: `${Net} season`,
    prices: tn ? "Testnet pool prices are not real markets." : null,
    standings: tn ? "Real testnet vaults, read from the chain at the snapshot cutoff. Testnet pool prices are off, so these are practice numbers."
      : "Real mainnet vaults, read from the chain at the snapshot cutoff.",
    length: tn ? "testnet now, mainnet later" : "on NEAR mainnet",
    tag: tn ? "Testnet run live · mainnet next" : L ? "Mainnet season live" : "Mainnet launching",
  };
}
