// Opt-in: the wider board's data files, public/league/wider-<source>.json plus wider-index.json listing them. Not part of
// prebuild, so builds stay offline. Read-only HTTP, no keys. Without the index the /wider/ page says it has no data.
//   npm run wider                      every source
//   npm run wider -- polymarket        one source (or several: hyperliquid,dydx; ids or short codes: hl, pm, dydx)
// Each fetch also appends a dated snapshot to data/wider-history/<source>/ (scripts/wider-history.ts).
// Knobs: WIDER_TOP (Hyperliquid, 60), WIDER_PM_TOP (Polymarket, 50), WIDER_MIN_TVL (10000), WIDER_DELAY_MS (1100), WIDER_PM_DELAY_MS (350).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_RULE, MIN_DAYS, MIN_RANGE_STEPS, order, scoreRecord, type WiderFile, type WiderIndex, type WiderVault } from "../src/lib/wider.ts";
import type { AdapterResult, Options } from "./sources/common.mts";
import { fetchDydx } from "./sources/dydx.mts";
import { fetchHyperliquid } from "./sources/hyperliquid.mts";
import { fetchPolymarket } from "./sources/polymarket.mts";
import { appendSnapshot, snapshotRows } from "./wider-history.ts";

if (process.env.WIDER_FETCH !== "1" && !process.argv.includes("--fetch")) {
  console.log("wider: skipped (opt-in: npm run wider)");
  process.exit(0);
}

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const league = join(site, "public/league"), indexPath = join(league, "wider-index.json"), historyDir = join(site, "data/wider-history");
const MAX_BYTES = 1.5 * 1024 * 1024;
const int = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const now = Date.now();
const log = (s: string) => console.log(s);
const base: Omit<Options, "top" | "delayMs"> = { minTvl: int("WIDER_MIN_TVL", 10_000), minAgeDays: MIN_DAYS, now, log };

// The info API allows about 1200 weight a minute and vaultDetails weighs 20: one call a second stays under it.
const SOURCES: { id: string; short: string; run: () => Promise<AdapterResult> }[] = [
  { id: "hyperliquid", short: "hl", run: () => fetchHyperliquid({ ...base, top: int("WIDER_TOP", 60), delayMs: Math.max(250, int("WIDER_DELAY_MS", 1100)) }) },
  { id: "polymarket", short: "pm", run: () => fetchPolymarket({ ...base, top: int("WIDER_PM_TOP", 50), delayMs: Math.max(150, int("WIDER_PM_DELAY_MS", 350)) }) },
  { id: "dydx", short: "dydx", run: () => fetchDydx({ ...base, top: 1, delayMs: 500 }) },
];

const args = process.argv.slice(2).filter(a => !a.startsWith("--fetch")).flatMap(a => a.replace(/^--source=/, "").split(",")).map(a => a.trim().toLowerCase()).filter(Boolean);
const unknown = args.filter(a => !SOURCES.some(s => s.id === a || s.short === a));
if (unknown.length) { console.error(`wider: unknown source(s) ${unknown.join(", ")}; known: ${SOURCES.map(s => `${s.id} (${s.short})`).join(", ")}`); process.exit(2); }
const pick = args.length ? SOURCES.filter(s => args.includes(s.id) || args.includes(s.short)) : SOURCES;

function build(res: AdapterResult): WiderFile {
  const scored: WiderVault[] = [];
  let unscorable = 0;
  for (const r of res.records) {
    const v = scoreRecord(r, res.btc);
    if (v) scored.push(v); else { unscorable++; log(`wider: ${r.id} has no funded history, not scored`); }
  }
  const vaults = order(scored);
  return {
    version: 1, source: res.source, fetched_at: new Date(now).toISOString(),
    rule: {
      ...res.notes, ai: AI_RULE,
      rank: `Ranked only with at least ${MIN_DAYS} days of history, by return. Others are listed, not ranked.`,
      range: `95% range from the scored intervals' log returns (excess over BTC for vs BTC), Student-t, as on the main board. Null below ${MIN_RANGE_STEPS} intervals: not enough data to separate skill from luck. Intervals are assumed independent, so it understates uncertainty.`,
    },
    counts: { ...res.counts, failed: res.counts.failed + unscorable, scored: vaults.length, ranked: vaults.filter(v => v.ranked).length },
    population: res.population, population_label: res.population_label, failures: res.failures, vaults,
  };
}

// The index keeps entries for sources not fetched this run; a damaged index is rebuilt from what this run fetches.
let index: WiderIndex = { version: 1, sources: [] };
if (existsSync(indexPath)) {
  try {
    const old = JSON.parse(readFileSync(indexPath, "utf8")) as WiderIndex;
    if (old?.version === 1 && Array.isArray(old.sources)) index = old;
  } catch (e) { log(`wider: existing index unreadable (${(e as Error).message}), rebuilding`); }
}

let failed = 0;
mkdirSync(league, { recursive: true });
for (const s of pick) {
  let res: AdapterResult;
  try { res = await s.run(); } catch (e) { failed++; console.error(`wider: ${s.id} failed, its file is left as it was: ${(e as Error).message}`); continue; }
  const doc = build(res), body = JSON.stringify(doc), file = `wider-${s.id}.json`;
  if (body.length > MAX_BYTES) log(`wider: warning: ${file} is ${(body.length / 1048576).toFixed(2)} MB, over the 1.5 MB budget`);
  writeFileSync(join(league, file), body);
  appendSnapshot(historyDir, s.id, doc.fetched_at.slice(0, 10), snapshotRows(doc.fetched_at.slice(0, 10), s.id, res.records), log);
  const entry = { id: s.id, short: s.short, label: res.source.label, file, fetched_at: doc.fetched_at, counts: doc.counts, bytes: body.length };
  index.sources = [...index.sources.filter(x => x.id !== s.id), entry].sort((a, b) => SOURCES.findIndex(x => x.id === a.id) - SOURCES.findIndex(x => x.id === b.id));
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
  log(`wider: ${s.id}: ${doc.vaults.length} scored (${doc.counts.ranked} ranked), ${doc.counts.failed} failed, ${(body.length / 1024).toFixed(0)} KB → public/league/${file}`);
}
process.exit(failed ? 1 : 0);
