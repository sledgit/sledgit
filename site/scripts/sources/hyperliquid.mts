// Source adapter: Hyperliquid vaults (public, no key). Read-only HTTP: the vault list, then vaultDetails for a capped set,
// then BTC daily candles for the hold-BTC baseline. Normalising and scoring live in src/lib/wider.ts. Every adapter
// returns the same shape (common.mts), so another venue is one more file like this one.
import { aiClaim, DAY, HL, hlListItem, hlRecord, MIN_CAPITAL_USD, population, type HlListItem, type SourceRecord } from "../../src/lib/wider.ts";
import { sleep, type AdapterResult, type Options } from "./common.mts";

/** POST to the info API with a timeout; a 429 or 5xx is retried with backoff, anything else fails at once. */
async function info(body: unknown, tries = 4): Promise<unknown> {
  let last = "";
  for (let k = 0; k < tries; k++) {
    if (k) await sleep(2000 * 2 ** k);
    let r: Response;
    try {
      r = await fetch(HL.infoUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      last = `network: ${(e as Error).message}`;
      continue;
    }
    if (r.ok) return r.json();
    last = `HTTP ${r.status}`;
    if (r.status !== 429 && r.status < 500) break;
  }
  throw new Error(last);
}

export async function fetchHyperliquid(o: Options): Promise<AdapterResult> {
  o.log(`hyperliquid: fetching the vault list`);
  const r = await fetch(HL.listUrl, { signal: AbortSignal.timeout(90_000) });
  if (!r.ok) throw new Error(`vault list: HTTP ${r.status}`);
  const raw = await r.json();
  if (!Array.isArray(raw)) throw new Error("vault list: not an array");
  const list = raw.map(hlListItem).filter((x): x is HlListItem => x !== null);
  if (list.length < raw.length) o.log(`hyperliquid: ${raw.length - list.length} list item(s) malformed, dropped`);
  // Child vaults are HLP's own sub-accounts: their record is part of the parent's, so they are not listed separately.
  const open = list.filter(x => !x.isClosed && x.relationship !== "child");
  const eligible = open.filter(x => x.tvl >= o.minTvl);
  const old = (x: HlListItem) => x.createdMs === null || o.now - x.createdMs >= o.minAgeDays * DAY;
  const big = eligible.filter(old).sort((a, b) => b.tvl - a.tvl).slice(0, o.top);
  const claims = eligible.filter(x => aiClaim(x.name).claim);
  const pick = [...new Map([...big, ...claims].map(x => [x.address, x])).values()];
  o.log(`hyperliquid: ${list.length} listed, ${open.length} open, ${eligible.length} with TVL >= $${o.minTvl}; fetching ${pick.length} (${big.length} largest, ${claims.length} names claiming AI)`);

  const records: SourceRecord[] = [], failures: AdapterResult["failures"] = [];
  for (const [k, item] of pick.entries()) {
    if (k) await sleep(o.delayMs);
    try {
      records.push(hlRecord(item, await info({ type: "vaultDetails", vaultAddress: item.address })));
    } catch (e) {
      const error = (e as Error).message;
      failures.push({ address: item.address, error });
      o.log(`hyperliquid: ${item.address} failed: ${error}`);
    }
    if ((k + 1) % 20 === 0) o.log(`hyperliquid: ${k + 1}/${pick.length}`);
  }

  const from = Math.min(...records.flatMap(x => x.history.map(p => p.t)), o.now) - 2 * DAY;
  await sleep(o.delayMs);
  const candles = await info({ type: "candleSnapshot", req: { coin: "BTC", interval: "1d", startTime: from, endTime: o.now } });
  if (!Array.isArray(candles)) throw new Error("candleSnapshot: not an array");
  const btc = candles.map(c => ({ t: Number(c?.t), T: Number(c?.T), o: Number(c?.o), c: Number(c?.c) }))
    .filter(c => [c.t, c.T, c.o, c.c].every(Number.isFinite) && c.o > 0 && c.c > 0).sort((a, b) => a.t - b.t);
  if (btc.length < candles.length) o.log(`hyperliquid: ${candles.length - btc.length} BTC candle(s) malformed, dropped`);
  o.log(`hyperliquid: ${records.length} records, ${failures.length} failed, ${btc.length} BTC daily candles`);

  return {
    source: { id: HL.id, short: HL.short, label: HL.label, kind: "vault", list_url: HL.listUrl, detail_url: `${HL.infoUrl} (vaultDetails)`, explorer: "https://hypurrscan.io", baselines: ["usdc", "btc"] },
    records, btc, failures, population: population(list), population_label: "listed vaults",
    counts: { listed: list.length, open: open.length, eligible: eligible.length, requested: pick.length, failed: failures.length },
    notes: {
      label: "Self-reported records, no enforced limits",
      returns: `Time-weighted return from Hyperliquid's own all-time PnL history, not account value, so deposits and withdrawals never count as return. Each interval: r = ΔPnL / (value at its start + half the net flow), chained. Intervals starting at or below $${MIN_CAPITAL_USD}, and intervals that would lose more than their base (a flow the sampling hid), are skipped and counted. The history is sampled (about 100 points over a vault's life), so intervals can be days or weeks long.`,
      baselines: "Hold USDC is 0%. Hold BTC is BTC's price change over the same window (Hyperliquid BTC daily candles, linear within a day).",
      survivors: "Closed vaults and small ones are not scored, and the largest open vaults are the ones that kept depositors, so this sample is likely kinder than the whole.",
      selection: `Of ${list.length} vaults listed, ${open.length} are open (HLP's child sub-accounts excluded) and ${eligible.length} hold at least $${o.minTvl.toLocaleString("en-US")}. Fetched: the ${o.top} largest of those by TVL that are at least ${o.minAgeDays} days old, plus every one whose name claims AI. Vaults outside this set are not shown; descriptions are only checked for the fetched set.`,
    },
  };
}
