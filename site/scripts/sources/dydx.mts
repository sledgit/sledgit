// Source adapter: dYdX MegaVault (the dYdX indexer, public, no key). Read-only GET: MegaVault's daily equity and
// cumulative PnL, and BTC-USD daily candles for the hold-BTC baseline. MegaVault is one protocol vault that splits its
// capital across per-market sub-vaults; those are its parts, like Hyperliquid's HLP children, so they are not listed.
import { DAY, MIN_CAPITAL_USD } from "../../src/lib/wider.ts";
import { DYDX, dydxCandles, dydxRecord } from "../../src/lib/wider-sources.ts";
import { getJson, sleep, type AdapterResult, type Options } from "./common.mts";

export async function fetchDydx(o: Options): Promise<AdapterResult> {
  o.log("dydx: fetching MegaVault's daily history");
  const failures: AdapterResult["failures"] = [];
  const records = [];
  try { records.push(dydxRecord(await getJson(DYDX.pnlUrl))); } catch (e) { failures.push({ address: DYDX.address, error: (e as Error).message }); }
  await sleep(o.delayMs);
  const from = new Date(Math.min(...records.flatMap(r => r.history.map(p => p.t)), o.now) - 2 * DAY).toISOString();
  const btc = dydxCandles(await getJson(`${DYDX.candlesUrl}&fromISO=${encodeURIComponent(from)}&limit=1000`));
  o.log(`dydx: ${records.length} record, ${btc.length} BTC daily candles`);
  return {
    source: { id: DYDX.id, short: DYDX.short, label: DYDX.label, kind: "vault", list_url: DYDX.pnlUrl, detail_url: DYDX.candlesUrl, explorer: "https://www.mintscan.io/dydx", baselines: ["usdc", "btc"] },
    records, btc, failures, population: null, population_label: "",
    counts: { listed: 1, open: 1, eligible: 1, requested: 1, failed: failures.length },
    notes: {
      label: "Venue-reported record of one protocol vault, no enforced limits",
      returns: `Time-weighted return from MegaVault's daily equity and cumulative PnL, as the dYdX indexer reports them: r = ΔPnL / (equity at the start of the day + half the day's net flow), chained, so deposits and withdrawals never count as return. Days starting at or below $${MIN_CAPITAL_USD} are skipped and counted. The indexer serves about the last 90 days, so the window is short.`,
      baselines: "Hold USDC is 0%. Hold BTC is BTC-USD's price change over the same window (dYdX daily candles, linear within a day).",
      survivors: "One vault, the protocol's own market-making pool, not a sample of traders: it says nothing about dYdX traders in general. No population figure exists for it.",
      selection: "MegaVault only. Its per-market sub-vaults are parts of it and are not listed separately. dYdX has no public list of other vaults.",
    },
  };
}
