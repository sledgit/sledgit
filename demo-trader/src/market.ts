// What the desk reads, recorded in every receipt's inputs as `market`: the agent's daily candles (the same feed the
// house strategies use) and, when on, a Kronos forecast with everything needed to re-run it (candles hash, exact
// refetch URL, weights hashes, parameters, seed).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { dailyCandles } from "../../agent/src/strategies/market.js";
import { checkPrice, PriceError } from "../../agent/src/price.js";
import type { Json } from "../../agent/src/receipt.js";

/** Pinned Kronos weights (Hugging Face NeoQuasar/*, MIT); anything else is refused. See ../NOTICE.md. */
export const KRONOS_WEIGHTS = {
  model: { repo: "NeoQuasar/Kronos-small", sha256: "b082dfcbd8e8c142a725c8bbb99781802f38fec81210e13479effb32b3c3e020" },
  tokenizer: { repo: "NeoQuasar/Kronos-Tokenizer-base", sha256: "59d85f6af76a2c3b8240ea06cb21db4213b4eeca053f246b23e29cf832fc6bee" },
} as const;
export const KRONOS_PARAMS = { interval: "1h", context: 512, pred_len: 24, paths: 8, seed: 0, T: 1.0, top_p: 0.9 } as const;

const HOUR = 3_600_000;
const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

/** [open ms, open, high, low, close, volume], closed bars only, consecutive. */
export type HourBar = [number, string, string, string, string, string];

export function checkHourly(raw: unknown, now: number): HourBar[] {
  if (!Array.isArray(raw)) throw new PriceError("bad_price", "klines is not an array");
  const out: HourBar[] = [];
  for (const k of raw) {
    if (!Array.isArray(k) || typeof k[0] !== "number" || typeof k[6] !== "number") throw new PriceError("bad_price", "malformed kline");
    if (k[6] >= now) continue;
    if (typeof k[5] !== "string" || !/^\d{1,15}(\.\d{1,18})?$/.test(k[5])) throw new PriceError("bad_price", "bad volume");
    out.push([k[0], checkPrice(k[1]), checkPrice(k[2]), checkPrice(k[3]), checkPrice(k[4]), k[5]]);
  }
  for (let i = 1; i < out.length; i++) if (out[i][0] - out[i - 1][0] !== HOUR) throw new PriceError("bad_price", "hourly candles are not consecutive");
  return out;
}

async function hourly(now: number): Promise<{ url: string; bars: HourBar[] }> {
  const errors: string[] = [];
  for (const host of HOSTS) {
    const url = `${host}/api/v3/klines?symbol=NEARUSDT&interval=1h&limit=${KRONOS_PARAMS.context + 1}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((e: Error) => e);
    if (res instanceof Error) { errors.push(`${host}: ${res.message}`); continue; }
    if (!res.ok) { errors.push(`${host}: HTTP ${res.status}`); continue; }
    const text = await res.text();
    if (text.length > 512 * 1024) throw new PriceError("bad_price", `${host} returned an oversized body`);
    const bars = checkHourly(JSON.parse(text), now).slice(-KRONOS_PARAMS.context);
    if (bars.length !== KRONOS_PARAMS.context) throw new PriceError("bad_price", `only ${bars.length} closed hourly bars`);
    // The exact window, so a verifier can refetch the same bars and compare the hash.
    return { url: `${host}/api/v3/klines?symbol=NEARUSDT&interval=1h&startTime=${bars[0][0]}&endTime=${bars[bars.length - 1][0]}&limit=${KRONOS_PARAMS.context}`, bars };
  }
  throw new PriceError("unavailable", `no hourly candles: ${errors.join("; ")}`);
}

export interface KronosEnv { python: string; src: string; model: string; tokenizer: string }

/** DEMO_TRADER_KRONOS_{PYTHON,SRC,MODEL,TOKENIZER}: the venv python, the Kronos checkout, and the two weight dirs. */
export function kronosEnv(env: NodeJS.ProcessEnv): KronosEnv {
  // legacy: remove after the server redeploy (IRON_TRADER_KRONOS_*)
  const get = (n: string) => env[`DEMO_TRADER_KRONOS_${n}`] ?? env[`IRON_TRADER_KRONOS_${n}`];
  const k = { python: get("PYTHON"), src: get("SRC"), model: get("MODEL"), tokenizer: get("TOKENIZER") };
  const missing = Object.entries(k).filter(([, v]) => !v).map(([n]) => `DEMO_TRADER_KRONOS_${n.toUpperCase()}`);
  if (missing.length) throw new Error(`--kronos needs ${missing.join(", ")} (see demo-trader/README.md)`);
  return k as KronosEnv;
}

function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}

class KronosError extends Error { constructor(readonly code: string, detail = code) { super(detail); } }

/** Runs kronos/forecast.py in the isolated venv (python -I), stdin in, one JSON object out. */
function runForecast(k: KronosEnv, script: string, bars: HourBar[]): Promise<Record<string, number>> {
  return new Promise((res, rej) => {
    const p = spawn(k.python, ["-I", script, "--kronos-src", k.src, "--model", k.model, "--tokenizer", k.tokenizer],
      { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HF_HUB_OFFLINE: "1" } });
    let out = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); rej(new KronosError("timeout")); }, 300_000);
    p.stdout.on("data", (d) => { out += d; if (out.length > 16_384) p.kill("SIGKILL"); });
    p.stderr.resume();
    p.on("error", (e) => { clearTimeout(timer); rej(new KronosError("spawn", e.message)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return rej(new KronosError("exit", `forecast.py exited ${code}`));
      try {
        const r = JSON.parse(out) as Record<string, unknown>;
        const nums = ["last_close", "median_close", "change_pct", "up_share", "paths", "pred_len"];
        if (!nums.every((n) => typeof r[n] === "number" && Number.isFinite(r[n]))) throw new Error("fields");
        res(r as Record<string, number>);
      } catch {
        rej(new KronosError("bad_output"));
      }
    });
    const { pred_len, paths, seed, T, top_p } = KRONOS_PARAMS;
    p.stdin.end(JSON.stringify({ candles: bars, pred_len, paths, seed, T, top_p }));
  });
}

/** The Kronos part of `market`. Never throws: a failure is recorded as `unavailable` and the desk holds. */
export async function kronosSignal(k: KronosEnv, now = Date.now()): Promise<Json> {
  const base = { model: KRONOS_WEIGHTS.model.repo, tokenizer: KRONOS_WEIGHTS.tokenizer.repo, params: KRONOS_PARAMS as unknown as Json };
  try {
    for (const [dir, w] of [[k.model, KRONOS_WEIGHTS.model], [k.tokenizer, KRONOS_WEIGHTS.tokenizer]] as const) {
      const f = join(dir, "model.safetensors");
      if (!existsSync(f) || (await sha256File(f)) !== w.sha256) throw new KronosError("weights_mismatch", `${f} is not ${w.repo} as pinned`);
    }
    const { url, bars } = await hourly(now);
    const input = { source: url, n: bars.length, first_open_ms: bars[0][0], last_open_ms: bars[bars.length - 1][0],
      candles_sha256: createHash("sha256").update(JSON.stringify(bars)).digest("hex") };
    const f = await runForecast(k, new URL("../kronos/forecast.py", import.meta.url).pathname, bars);
    // A list, not {tokenizer: <hex>}: secret scanners read a hex value under a "token…" key as a credential.
    return { status: "ok", ...base, weights: [KRONOS_WEIGHTS.model, KRONOS_WEIGHTS.tokenizer], input, forecast: f } as unknown as Json;
  } catch (e) {
    const code = e instanceof KronosError ? e.code : e instanceof PriceError ? `price_${e.code}` : "other";
    return { status: "unavailable", code, ...base } as unknown as Json;
  }
}

/** The market function handed to the agent runner. */
export function deskMarket(kronos: KronosEnv | null): () => Promise<Json> {
  return async () => {
    const daily = await dailyCandles();
    return { daily: daily as unknown as Json, kronos: kronos ? await kronosSignal(kronos) : { status: "off" } };
  };
}
