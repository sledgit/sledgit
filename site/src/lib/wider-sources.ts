// Normalisers for the wider board's other venues: Polymarket traders and dYdX's MegaVault. Pure functions, like the
// Hyperliquid one in wider.ts: the adapters in scripts/sources/ fetch, these check and reshape. Every reply is untrusted.
import { aiClaim, DAY, isAddress, num, plainText, type Candle, type HistoryPoint, type Population, type SourceRecord } from "./wider";

// ---------------------------------------------------------------- Polymarket

export const PM = {
  id: "polymarket",
  short: "pm",
  label: "Polymarket",
  base: "https://data-api.polymarket.com/v2",
  explorer: (addr: string) => `https://polygonscan.com/address/${addr}`,
} as const;

/** One row of the public trader leaderboard, checked. Null when the wallet or numbers are malformed. */
export interface PmLeader { address: string; name: string; pnlAllTime: number; volume: number }

// A profile that never set a name shows the wallet and a timestamp ("0xA2cd…Ba0-1729178570395"): that is not a name.
const DEFAULT_NAME = /^0x[0-9a-fA-F]{40}(-\d+)?$/;

export function pmLeader(x: unknown): PmLeader | null {
  const r = x as Record<string, unknown> | null;
  if (!r || !isAddress(r.user_id)) return null;
  const pnl = num(r.pnl), volume = num(r.volume);
  if (pnl === null || volume === null) return null;
  const name = plainText(r.user_name, 80, false);
  return { address: r.user_id.toLowerCase(), name: DEFAULT_NAME.test(name) ? "" : name, pnlAllTime: pnl, volume };
}

/** The board's wallets by the sign of their all-time realized PnL. Nothing on Polymarket closes, so closed is 0. */
export function pmPopulation(list: PmLeader[]): Population {
  return { listed: list.length, with_pnl: list.length, negative: list.filter(x => x.pnlAllTime < 0).length, positive: list.filter(x => x.pnlAllTime > 0).length,
    zero: list.filter(x => x.pnlAllTime === 0).length, closed: 0, closed_negative: 0 };
}

/** Deposits and withdrawals from the activity feed as signed USDC flows (ms, amount), plus the profile text the rows carry. */
export interface PmFlows { flows: [number, number][]; pseudonym: string; bio: string; dropped: number }
export function pmFlows(rows: unknown): PmFlows {
  const flows: [number, number][] = [];
  let pseudonym = "", bio = "", dropped = 0;
  for (const x of Array.isArray(rows) ? rows : []) {
    const r = x as Record<string, unknown>;
    const t = num(r?.timestamp), amt = num(r?.usdc_size), sign = r?.type === "DEPOSIT" ? 1 : r?.type === "WITHDRAWAL" ? -1 : 0;
    if (t === null || amt === null || amt < 0 || !sign) { dropped++; continue; }
    flows.push([t * 1000, sign * amt]);
    pseudonym ||= plainText(r.pseudonym, 80, false);
    bio ||= plainText(r.bio, 600);
  }
  return { flows: flows.sort((a, b) => a[0] - b[0]), pseudonym, bio, dropped };
}

/** Days covered by a user-pnl reply's points: the adapter's 30-day check, before it fetches more. */
export function pmPnlDays(d: unknown): number {
  const pts = pmPnlPoints(d);
  return pts.length > 1 ? (pts[pts.length - 1][0] - pts[0][0]) / DAY : 0;
}

/** [t ms, cumulative economic PnL] from a user-pnl reply. Null PnL means "not covered", so the point is dropped, never zeroed. */
function pmPnlPoints(d: unknown): [number, number][] {
  const data = (d as { data?: { points?: unknown } } | null)?.data;
  const pts = Array.isArray(data?.points) ? data.points : [];
  return pts.map(p => [num((p as Record<string, unknown>)?.timestamp), num((p as Record<string, unknown>)?.economic_pnl)])
    .filter((p): p is [number, number] => p[0] !== null && p[1] !== null).map(([t, v]): [number, number] => [t * 1000, v]).sort((a, b) => a[0] - b[0]);
}

/**
 * A trader as a SourceRecord, scored in dollars. Polymarket publishes cumulative PnL but no account-value history. An
 * estimate is kept for size only: net deposits so far plus cumulative economic PnL (cash plus positions), never below the
 * open positions (positionsValue, from /v2/value) or zero. It understates when funds arrive outside the deposit feed,
 * which is why returns are not computed from it.
 */
export function pmRecord(item: PmLeader, pnl: unknown, f: PmFlows, positionsValue: number | null): SourceRecord {
  const pts = pmPnlPoints(pnl);
  if (pts.length < 2) throw new Error("user-pnl: fewer than 2 points");
  let k = 0, net = 0;
  const history: HistoryPoint[] = pts.map(([t, p]) => {
    while (k < f.flows.length && f.flows[k][0] <= t) net += f.flows[k++][1];
    return { t, value: net + p, pnl: p };
  });
  const last = (pnl as { data?: { points?: unknown[] } })?.data?.points;
  const lastVol = Array.isArray(last) && last.length ? num((last[last.length - 1] as Record<string, unknown>)?.volume_usdc) : null;
  const name = item.name || f.pseudonym || `${item.address.slice(0, 6)}…${item.address.slice(-4)}`;
  return {
    id: `${PM.id}:${item.address}`, source: PM.id, kind: "trader", btcBaseline: false, basis: "usd", name, address: item.address, leader: null,
    description: f.bio, tvl: Math.max(0, history[history.length - 1].value, positionsValue ?? 0), createdMs: null, commission: null, followers: null,
    volumeUsd: lastVol, nTrades: null, ai: aiClaim(name, f.bio), explorer: PM.explorer(item.address), history,
  };
}

// ---------------------------------------------------------------- dYdX MegaVault

export const DYDX = {
  id: "dydx",
  short: "dydx",
  label: "dYdX",
  pnlUrl: "https://indexer.dydx.trade/v4/vault/v1/megavault/historicalPnl?resolution=day",
  candlesUrl: "https://indexer.dydx.trade/v4/candles/perpetualMarkets/BTC-USD?resolution=1DAY",
  // MegaVault's main subaccount, as the indexer lists it (/v4/addresses/<address>).
  address: "dydx18tkxrnrkqc2t0lr3zxr5g6a4hdvqksylxqje4r",
  explorer: (addr: string) => `https://www.mintscan.io/dydx/address/${addr}`,
} as const;

/** MegaVault's daily history (equity and cumulative PnL) as a SourceRecord. */
export function dydxRecord(d: unknown): SourceRecord {
  const rows = (d as { megavaultPnl?: unknown } | null)?.megavaultPnl;
  if (!Array.isArray(rows)) throw new Error("megavault historicalPnl: no megavaultPnl array");
  const history = rows.map(r => {
    const x = r as Record<string, unknown>;
    return { t: typeof x?.blockTime === "string" ? Date.parse(x.blockTime) : NaN, value: num(x?.equity) ?? NaN, pnl: num(x?.totalPnl) ?? NaN };
  }).filter(p => [p.t, p.value, p.pnl].every(Number.isFinite)).sort((a, b) => a.t - b.t);
  if (history.length < 2) throw new Error("megavault historicalPnl: fewer than 2 points");
  const name = "MegaVault";
  return {
    id: `${DYDX.id}:megavault`, source: DYDX.id, kind: "vault", btcBaseline: true, basis: "return", name, address: DYDX.address, leader: null,
    description: "", tvl: history[history.length - 1].value, createdMs: null, commission: null, followers: null, volumeUsd: null, nTrades: null,
    ai: aiClaim(name), explorer: DYDX.explorer(DYDX.address), history,
  };
}

/** dYdX's BTC-USD daily candles in the board's Candle shape. */
export function dydxCandles(d: unknown): Candle[] {
  const rows = (d as { candles?: unknown } | null)?.candles;
  return (Array.isArray(rows) ? rows : []).map(r => {
    const x = r as Record<string, unknown>, t = typeof x?.startedAt === "string" ? Date.parse(x.startedAt) : NaN;
    return { t, T: t + DAY, o: num(x?.open) ?? NaN, c: num(x?.close) ?? NaN };
  }).filter(c => [c.t, c.o, c.c].every(Number.isFinite) && c.o > 0 && c.c > 0).sort((a, b) => a.t - b.t);
}
