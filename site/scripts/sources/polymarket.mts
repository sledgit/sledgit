// Source adapter: Polymarket traders (Data API v2, public, no key). Read-only GET: the all-time volume leaderboard, then
// for a capped set of wallets their daily PnL series, deposits and withdrawals, current positions value, and one page of
// latest trades and of positions for the profile. Scored in dollars (src/lib/wider.ts); flows only feed the account-value
// estimate (src/lib/wider-sources.ts); the profile is src/lib/wider-profile.ts.
import { aiClaim, type SourceRecord } from "../../src/lib/wider.ts";
import { PM, pmFlows, pmLeader, pmPnlDays, pmPopulation, pmRecord, type PmLeader } from "../../src/lib/wider-sources.ts";
import { PM_PROFILE_POSITIONS, PM_PROFILE_TRADES, pmProfile } from "../../src/lib/wider-profile.ts";
import { getJson, sleep, type AdapterResult, type Options } from "./common.mts";

const BOARD = `${PM.base}/leaderboard?time_period=all&sort_by=VOLUME&limit=1000`;
const MAX_FLOW_PAGES = 10;

/** Every deposit and withdrawal of a wallet, oldest first, following the cursor (at most MAX_FLOW_PAGES pages of 1000). */
async function flows(addr: string, delayMs: number): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_FLOW_PAGES; page++) {
    const q = new URLSearchParams({ user: addr, type: "DEPOSIT,WITHDRAWAL", exclude_deposits_withdrawals: "false", start: "1", limit: "1000", sort_direction: "ASC" });
    if (cursor) q.set("cursor", cursor);
    const r = (await getJson(`${PM.base}/activity?${q}`)) as { data?: unknown; pagination?: { next_cursor?: unknown; has_more?: unknown } };
    if (!Array.isArray(r?.data)) throw new Error("activity: no data array");
    rows.push(...r.data);
    cursor = typeof r.pagination?.next_cursor === "string" && r.pagination.has_more === true ? r.pagination.next_cursor : null;
    if (!cursor) return rows;
    await sleep(delayMs);
  }
  throw new Error(`activity: more than ${MAX_FLOW_PAGES * 1000} deposits and withdrawals`);
}

export async function fetchPolymarket(o: Options): Promise<AdapterResult> {
  o.log("polymarket: fetching the all-time volume leaderboard");
  const raw = (await getJson(BOARD, { timeoutMs: 60_000 })) as { data?: unknown };
  if (!Array.isArray(raw?.data)) throw new Error("leaderboard: no data array");
  const list = raw.data.map(pmLeader).filter((x): x is PmLeader => x !== null);
  if (list.length < raw.data.length) o.log(`polymarket: ${raw.data.length - list.length} leaderboard row(s) malformed, dropped`);
  const claims = list.filter(x => x.name && aiClaim(x.name).claim);
  o.log(`polymarket: ${list.length} wallets on the board, ${claims.length} names claiming AI; walking it for the ${o.top} highest-volume with ${o.minAgeDays}+ days`);

  const records: SourceRecord[] = [], failures: AdapterResult["failures"] = [];
  const done = new Set<string>();
  let old = 0, young = 0, requested = 0;
  // One wallet: the PnL series first (it decides the 30-day rule), then flows and positions value only if needed.
  const one = async (item: PmLeader, needOld: boolean) => {
    done.add(item.address);
    requested++;
    try {
      const pnl = await getJson(`${PM.base}/user-pnl?user=${item.address}&interval=all&fidelity=1d`, { timeoutMs: 60_000 });
      if (needOld && pmPnlDays(pnl) < o.minAgeDays) { young++; return; }
      await sleep(o.delayMs);
      const f = pmFlows(await flows(item.address, o.delayMs));
      if (f.dropped) o.log(`polymarket: ${item.address}: ${f.dropped} activity row(s) malformed, dropped`);
      await sleep(o.delayMs);
      const v = (await getJson(`${PM.base}/value?user=${item.address}`)) as { data?: { value?: unknown } };
      const pv = typeof v?.data?.value === "number" && Number.isFinite(v.data.value) ? v.data.value : null;
      const rec = pmRecord(item, pnl, f, pv);
      // The profile is extra: a failure is recorded on the record and logged, the record is still scored.
      try {
        await sleep(o.delayMs);
        const trades = await getJson(`${PM.base}/trades?user=${item.address}&limit=${PM_PROFILE_TRADES}`, { timeoutMs: 60_000 });
        await sleep(o.delayMs);
        const positions = await getJson(`${PM.base}/positions?user=${item.address}&limit=${PM_PROFILE_POSITIONS}`, { timeoutMs: 60_000 });
        rec.profile = pmProfile(trades, positions, o.now);
      } catch (e) {
        rec.profile = { error: (e as Error).message };
        o.log(`polymarket: ${item.address}: profile not built: ${rec.profile.error}`);
      }
      records.push(rec);
      if (needOld) old++;
    } catch (e) {
      const error = (e as Error).message;
      failures.push({ address: item.address, error });
      o.log(`polymarket: ${item.address} failed: ${error}`);
    }
  };
  // Walk the board until `top` wallets with enough history are in, reading at most 3 × top wallets.
  for (const item of list) {
    if (old >= o.top || requested >= o.top * 3) break;
    if (requested) await sleep(o.delayMs);
    await one(item, true);
    if (requested % 10 === 0) o.log(`polymarket: ${requested} read, ${old} kept`);
  }
  const walked = requested;
  for (const item of claims) if (!done.has(item.address)) { await sleep(o.delayMs); await one(item, false); }
  o.log(`polymarket: ${records.length} records, ${failures.length} failed, ${young} skipped as under ${o.minAgeDays} days`);

  return {
    source: { id: PM.id, short: PM.short, label: PM.label, kind: "trader", list_url: BOARD, detail_url: `${PM.base}/user-pnl, /activity (deposits and withdrawals), /value, /trades and /positions`,
      explorer: "https://polygonscan.com", baselines: ["usdc"] },
    records, btc: [], failures, population: pmPopulation(list), population_label: "highest-volume wallets (by realized PnL)",
    counts: { listed: list.length, open: list.length, eligible: walked, requested, failed: failures.length },
    notes: {
      label: "Venue-reported records of individual wallets, no enforced limits",
      returns: "Scored in dollars, not as a return. Polymarket publishes each wallet's cumulative PnL by day (economic PnL: realized and unrealized, plus fee rebates and rewards) but no account-value history. A value rebuilt from deposits and withdrawals proved unusable as a base: many wallets receive funds the deposit feed does not list, and market makers withdraw down to a few thousand dollars while trading millions, so a chained return explodes. Each wallet is scored on its PnL over the window against holding USDC ($0); the 95% range comes from the daily PnL changes, and max drawdown is the largest fall of cumulative PnL from its peak, in dollars. Account value is shown as an estimate only (deposits minus withdrawals plus PnL, at least the open positions).",
      baselines: "Hold USDC ($0) is the only baseline: a prediction-market account holds USDC-settled positions, so holding BTC was not the alternative its owner faced. Return and vs hold BTC are n/a on these rows; beating hold USDC means a PnL above $0 over the window.",
      survivors: `The wallets read are the highest-volume ones on Polymarket's all-time board, many of them market makers. Wallets that stopped trading early never reach that board, so this sample is survivors. One person can run many wallets, and a wallet is not a strategy. The population figure uses each wallet's all-time realized PnL as the board reports it, not this page's return.`,
      selection: `Polymarket's all-time leaderboard sorted by volume (volume counted in shares, not dollars), first ${list.length.toLocaleString("en-US")} wallets. Read in order until ${o.top} had at least ${o.minAgeDays} days of PnL history (${walked} read, ${young} younger ones skipped), plus every wallet in those ${list.length.toLocaleString("en-US")} whose name claims AI. Bios are only checked for the wallets read. Names and pseudonyms are the public profile names; profile photos and linked accounts are not shown.`,
    },
  };
}
