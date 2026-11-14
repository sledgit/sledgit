// Mainnet reference price for NEAR/USDT from Binance's public API (no key). Same source for every model.
export interface RefPrice { source: string; symbol: string; price: string; fetched_at: string }

const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

/** Plausible NEAR/USD range. Outside it the feed is broken or hostile, and the tick holds without asking a model. */
export const PRICE_MIN = 0.01;
export const PRICE_MAX = 10_000;

/** A reference-price failure with a fixed code (`bad_price`, `unavailable`), safe to record. */
export class PriceError extends Error {
  constructor(readonly code: "bad_price" | "unavailable", detail: string) {
    super(detail);
  }
}

/** Plain decimal only ("0x10", "1e9", " 2.5 ", "Infinity" are rejected), inside [PRICE_MIN, PRICE_MAX]. */
export function checkPrice(price: unknown): string {
  if (typeof price !== "string" || !/^\d{1,9}(\.\d{1,18})?$/.test(price)) throw new PriceError("bad_price", "price is not a plain decimal");
  const n = Number(price);
  if (!(n >= PRICE_MIN && n <= PRICE_MAX)) throw new PriceError("bad_price", `price ${price} outside ${PRICE_MIN}..${PRICE_MAX}`);
  return price;
}

export async function nearUsdt(): Promise<RefPrice> {
  const errors: string[] = [];
  for (const host of HOSTS) {
    const url = `${host}/api/v3/ticker/price?symbol=NEARUSDT`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((e: Error) => e);
    if (res instanceof Error) { errors.push(`${host}: ${res.message}`); continue; }
    if (!res.ok) { errors.push(`${host}: HTTP ${res.status}`); continue; }
    const text = await res.text();
    if (text.length > 4096) throw new PriceError("bad_price", `${host} returned an oversized body`);
    const body = JSON.parse(text) as { symbol?: string; price?: string };
    if (body.symbol !== "NEARUSDT") throw new PriceError("bad_price", `${host} returned the wrong symbol`);
    return { source: url, symbol: body.symbol, price: checkPrice(body.price), fetched_at: new Date().toISOString() };
  }
  throw new PriceError("unavailable", `no reference price: ${errors.join("; ")}`);
}
