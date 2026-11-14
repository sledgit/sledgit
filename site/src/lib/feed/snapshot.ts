import { benchBots, NETWORKS, tokenAmount, vaultBots, type NetworkConfig } from "../networks";
import { decisionOf } from "./near";
import { agentsFor, leagueFor, TN_BENCH, type LeagueAgentData, type LeagueEntry, type LeagueSnapshot } from "./league-data";
import type { ChainEvent, Decision, Feed, FeedEvent, Standing, VaultBalance, VaultView } from "./types";

// A network's feed from its committed leaderboard snapshot: standings, decisions and vault records exactly as the
// leaderboard reader computed them from the chain (agent/src/league), at a stated cutoff. Nothing is recomputed here.

const nz = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? NaN : x);

function standing(e: LeagueEntry, at?: number): Standing {
  const p = at === undefined ? undefined : e.series[at];
  const vsHold = p ? (p.hold > 0 ? p.value / p.hold - 1 : NaN) : nz(e.vs_hold_after_gas ?? e.vs_hold);
  const vsStake = p ? (p.stake > 0 ? p.value / p.stake - 1 : NaN) : nz(e.vs_stake);
  return {
    botId: e.id, equity: p ? p.value : nz(e.end?.value_usd), vsHold, vsStake, ci: 0,
    execPct: (e.costs.fill_vs_reference_pct ?? 0) * 100, ranked: e.ranked,
    trades: e.counts.trades, refused: e.counts.refusals, decisions: e.counts.decisions,
  };
}

// The computed Hold and Stake rows exist on testnet only (see benchBots).
function benchRows(S: LeagueSnapshot): Standing[] {
  const b = S.benchmarks;
  if (S.network !== "testnet" || b.hold_twr == null || b.stake_twr == null) return [];
  const row = (id: string, twr: number, vsHold: number, vsStake: number): Standing =>
    ({ botId: id, equity: 100 * (1 + twr), vsHold, vsStake, ci: 0, execPct: 0, ranked: false, trades: 0, refused: 0, decisions: 0 });
  return [row(TN_BENCH.hold, b.hold_twr, 0, (1 + b.hold_twr) / (1 + b.stake_twr) - 1), row(TN_BENCH.stake, b.stake_twr, nz(b.stake_vs_hold), 0)];
}

function vaultView(n: NetworkConfig, e: LeagueEntry, a: LeagueAgentData): { view: VaultView; events: ChainEvent[] } {
  const events: ChainEvent[] = a.events.map(x => ({ event: x.event, data: x.data, txHash: x.tx, receiptId: x.receipt_id, blockHeight: x.block_height, time: Math.floor(x.block_time_ms / 1000) }));
  const o = a.observed as { config?: Record<string, unknown>; policy?: Record<string, unknown>; usage?: Record<string, unknown>; intents?: Record<string, unknown>; balances?: VaultBalance[]; balances_error?: string };
  const price = e.end?.price ?? null;
  const ref = (token: string) => (token === n.tokens[1]?.id ? 1 : token === n.tokens[0]?.id ? price ?? NaN : NaN);
  const balances = o.balances ?? [];
  const value = balances.length ? balances.reduce((s, b) => s + [b.wallet, b.exchange, b.intents].reduce((x, raw) => x + tokenAmount(n, b.token, raw ?? "0"), 0) * ref(b.token), 0) : null;
  const deposited = events.filter(x => x.event === "deposit").reduce((s, x) => s + tokenAmount(n, String(x.data.token), String(x.data.amount)) * ref(String(x.data.token)), 0);
  const errors = [...(o.balances_error ? [o.balances_error] : [])];
  return {
    events,
    view: { botId: e.id, account: e.account, config: o.config, policy: o.policy, usage: o.usage, intents: o.intents, balances, events, price,
      deposited, value, replayValue: nz(e.end?.value_usd), holdValue: e.start && e.funded_twr != null ? e.start.value_usd * (1 + e.funded_twr) : NaN, errors, league: e },
  };
}

export function createSnapshotFeed(network: "testnet" | "mainnet"): Feed {
  const n = NETWORKS[network], S = leagueFor(network), agents = agentsFor(network);
  if (!S) throw new Error(`no ${n.label} snapshot: build deploy/${network}/league/snapshot.json first`);
  const subs = new Set<(e: FeedEvent) => void>();
  let stopped = false;
  const emit = (e: FeedEvent) => { if (!stopped) subs.forEach(f => f(e)); };
  return {
    name: n.label, network, simulated: false, candleSec: 3_600, bots: [...vaultBots(n), ...benchBots(n)],
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    start() {
      queueMicrotask(() => {
        const decisions: Decision[] = [];
        for (const e of S.entries) {
          const { view, events } = vaultView(n, e, agents[e.id]);
          emit({ type: "vault", vault: view });
          for (const ev of events) { const d = decisionOf(ev, e.id, n); if (d) decisions.push(d); }
        }
        for (const d of decisions.sort((a, b) => a.at - b.at)) emit(d);
        // Replay each entry's series so the sparklines show its path, then the final standings.
        const len = Math.max(0, ...S.entries.map(e => e.series.length));
        for (let i = 0; i < len - 1; i++) emit({ type: "standings", rows: S.entries.filter(e => e.series.length).map(e => standing(e, Math.min(i, e.series.length - 1))) });
        emit({ type: "standings", rows: [...S.entries.filter(e => e.start).map(e => standing(e)), ...benchRows(S)] });
        const price = S.entries.find(e => e.end)?.end?.price;
        if (price) emit({ type: "tick", price, at: Math.floor(S.as_of_ms / 1000), candle: { o: price, h: price, l: price, c: price, t: Math.floor(S.as_of_ms / 1000) } });
        emit({ type: "status", status: { state: "ready", message: `Leaderboard snapshot of ${n.label} at ${new Date(S.as_of_ms).toISOString().slice(0, 16).replace("T", " ")} UTC · ${S.derived_sha256.slice(0, 12)}`,
          errors: [], updated: Math.floor(S.as_of_ms / 1000) } }); // the reader's flags are shown on the leaderboard and agent pages
      });
    },
    stop() { stopped = true; },
    setSpeed() {},
  };
}
