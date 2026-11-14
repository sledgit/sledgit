// Prebuild: hourly NEAR price candles for the agent pages' "Trades on wNEAR / USDC" chart. Site-only: nothing here feeds
// the snapshot or its derived_sha256. Candles come from the league's reference source (Binance NEARUSDT 1h klines,
// public, no key) and must close exactly at the reader's own hourly closes (deploy/testnet/league/inputs.json), or they
// are dropped. Optional: if Binance can't be reached the build still passes, and the chart draws the closes as a line.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOUR = 3_600_000;
const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(site, "../deploy/testnet/league");
const outData = join(site, "src/data/league-candles.json"), outPublic = join(site, "public/league/testnet-candles.json");

const snapshot = JSON.parse(readFileSync(join(src, "snapshot.json"), "utf8"));
const inputsPath = join(src, "inputs.json");
const inputs = existsSync(inputsPath) ? JSON.parse(readFileSync(inputsPath, "utf8")) : null;

const from = Math.floor(snapshot.season.start_ms / HOUR) * HOUR, to = snapshot.as_of_ms;
// The reader's hourly closes, keyed by close time, over the season.
const closes = (inputs?.hourly ?? []).filter(([t]) => t > from && t <= to);
const base = {
  source: "Binance NEARUSDT 1h klines (public REST)", symbol: "NEARUSDT", interval: "1h",
  derived_sha256: snapshot.derived_sha256, from_ms: from, to_ms: to, closes,
};

async function fetchKlines() {
  const out = [];
  let start = from;
  while (start + HOUR <= to) {
    let rows, errs = [];
    for (const h of HOSTS) {
      try {
        const r = await fetch(`${h}/api/v3/klines?symbol=NEARUSDT&interval=1h&startTime=${start}&endTime=${to}&limit=1000`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`${h}: HTTP ${r.status}`);
        rows = await r.json();
        break;
      } catch (e) { errs.push(e.message); }
    }
    if (!rows) throw new Error(errs.join("; "));
    if (!Array.isArray(rows) || !rows.length) break;
    for (const k of rows) {
      const [t, o, hi, lo, c] = [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4])];
      if (![t, o, hi, lo, c].every(Number.isFinite)) throw new Error("malformed kline");
      if (t + HOUR <= to) out.push({ t, o, h: hi, l: lo, c }); // closed bars only
    }
    const next = Number(rows[rows.length - 1][0]) + HOUR;
    if (next <= start) break;
    start = next;
  }
  return out;
}

// Every candle must close at the reader's close for that hour; a mismatch means another source or a revised bar.
function check(candles) {
  const ref = new Map(closes.map(([t, c]) => [t, c]));
  for (const k of candles) {
    const c = ref.get(k.t + HOUR);
    if (c !== undefined && Math.abs(c - k.c) > 1e-9) throw new Error(`close at ${new Date(k.t).toISOString()} is ${k.c}, the reader has ${c}`);
  }
  if (!candles.length) throw new Error("no candles in the season window");
}

function write(doc) {
  const body = JSON.stringify(doc);
  mkdirSync(dirname(outData), { recursive: true }); mkdirSync(dirname(outPublic), { recursive: true });
  writeFileSync(outData, body); writeFileSync(outPublic, body);
}

// Reuse a previous fetch for the same snapshot: no network on rebuilds, and the same bytes every time.
const prev = existsSync(outData) ? JSON.parse(readFileSync(outData, "utf8")) : null;
if (prev?.derived_sha256 === snapshot.derived_sha256 && prev.candles?.length && !process.env.CANDLES_REFRESH) {
  write({ ...prev, closes });
  console.log(`candles: ${prev.candles.length} hourly bars (cached for ${snapshot.derived_sha256.slice(0, 12)})`);
} else if (process.env.CANDLES_OFFLINE) {
  write({ ...base, candles: [], error: "offline build" });
  console.log(`candles: offline, the chart shows ${closes.length} hourly closes`);
} else {
  try {
    const candles = await fetchKlines();
    check(candles);
    write({ ...base, candles });
    console.log(`candles: ${candles.length} hourly bars from Binance, closes match the reader's`);
  } catch (e) {
    write({ ...base, candles: [], error: e.message });
    console.warn(`candles: not available (${e.message}); the chart shows ${closes.length} hourly closes instead`);
  }
}
