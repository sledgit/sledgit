// Daily NEAR/USDT candles from Binance's public API (the same reference source as price.ts), closed bars only.
// A house strategy decides from these plus the vault state; both go into the receipt, so anyone can re-run it.
import { checkPrice, PriceError } from "../price.js";

/** [open time (ms, UTC midnight), high, low, close]; prices as plain decimal strings exactly as served. */
export type Candle = [number, string, string, string];

export interface Market { source: string; interval: "1d"; candles: Candle[]; as_of: string }

const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
const DAY = 86_400_000;
export const CANDLES = 60;

/** Closed, consecutive daily bars, oldest first, every price plausible. Throws PriceError otherwise. */
export function checkCandles(raw: unknown, now: number): Candle[] {
  if (!Array.isArray(raw)) throw new PriceError("bad_price", "klines is not an array");
  const out: Candle[] = [];
  for (const k of raw) {
    if (!Array.isArray(k) || typeof k[0] !== "number" || typeof k[6] !== "number") throw new PriceError("bad_price", "malformed kline");
    if (k[6] >= now) continue; // still open
    out.push([k[0], checkPrice(k[2]), checkPrice(k[3]), checkPrice(k[4])]);
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i][0] - out[i - 1][0] !== DAY) throw new PriceError("bad_price", "daily candles are not consecutive");
  }
  return out;
}

/** The last CANDLES closed daily bars. `as_of` is the fetch hour (UTC), which also seeds the luck baseline. */
export async function dailyCandles(now = Date.now()): Promise<Market> {
  const errors: string[] = [];
  for (const host of HOSTS) {
    const url = `${host}/api/v3/klines?symbol=NEARUSDT&interval=1d&limit=${CANDLES + 1}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((e: Error) => e);
    if (res instanceof Error) { errors.push(`${host}: ${res.message}`); continue; }
    if (!res.ok) { errors.push(`${host}: HTTP ${res.status}`); continue; }
    const text = await res.text();
    if (text.length > 64 * 1024) throw new PriceError("bad_price", `${host} returned an oversized body`);
    const candles = checkCandles(JSON.parse(text), now).slice(-CANDLES);
    return { source: url, interval: "1d", candles, as_of: new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString() };
  }
  throw new PriceError("unavailable", `no candles: ${errors.join("; ")}`);
}
