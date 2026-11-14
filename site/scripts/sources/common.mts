// What every wider-board source adapter returns, and a read-only GET helper. Adapters fetch; src/lib normalises.
import type { Candle, Population, SourceRecord, WiderFile, WiderSource } from "../../src/lib/wider.ts";

export interface AdapterResult {
  source: WiderSource;
  records: SourceRecord[];
  /** BTC daily candles for the hold-BTC baseline; empty for a venue without one. */
  btc: Candle[];
  counts: { listed: number; open: number; eligible: number; requested: number; failed: number };
  failures: { address: string; error: string }[];
  population: Population | null;
  population_label: string;
  /** The venue-specific parts of the method notes. */
  notes: Pick<WiderFile["rule"], "label" | "returns" | "baselines" | "selection" | "survivors">;
}

export interface Options { top: number; minTvl: number; minAgeDays: number; delayMs: number; now: number; log: (s: string) => void }

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** GET JSON with a timeout; a 429 or 5xx is retried with backoff, any other non-2xx fails at once. */
export async function getJson(url: string, { tries = 4, timeoutMs = 30_000 } = {}): Promise<unknown> {
  let last = "";
  for (let k = 0; k < tries; k++) {
    if (k) await sleep(2000 * 2 ** k);
    let r: Response;
    try {
      r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
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
