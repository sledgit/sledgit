// Pure helpers for the trades chart and the decision log: price bars, decision markers, runs of identical holds.
import type { LeagueDecision } from "./feed/league-data";

export const HOUR = 3_600_000;

/** One hourly reference bar; t is the bar's open time (ms). */
export interface Bar { t: number; o: number; h: number; l: number; c: number }

/** The site-only price file written by scripts/candle-files.mjs. closes are [close time ms, close]. */
export interface PriceFile { from_ms: number; to_ms: number; candles: Bar[]; closes: [number, number][]; error?: string }

export type MarkKind = "buy" | "sell" | "refuse";
export interface Mark { d: LeagueDecision; kind: MarkKind; t: number; stack: number }

const refused = (d: LeagueDecision) => d.event === "refuse" || String(d.note ?? "").startsWith("refused");

/** Trades and refusals inside [t0, t1], oldest first; `stack` counts earlier marks on the same side of the same hour. */
export function marksOf(decisions: LeagueDecision[], t0: number, t1: number): Mark[] {
  const out: Mark[] = [], seen = new Map<string, number>();
  const list = decisions.filter(d => (d.event === "trade" || refused(d)) && d.block_time_ms >= t0 && d.block_time_ms <= t1)
    .sort((a, b) => a.block_time_ms - b.block_time_ms || a.seq - b.seq);
  for (const d of list) {
    const kind: MarkKind = refused(d) ? "refuse" : d.side === "sell" ? "sell" : "buy";
    // buys sit below the bar; sells and refusals share the space above it
    const key = `${Math.floor(d.block_time_ms / HOUR)}:${kind === "buy" ? "below" : "above"}`;
    const stack = seen.get(key) ?? 0;
    seen.set(key, stack + 1);
    out.push({ d, kind, t: d.block_time_ms, stack });
  }
  return out;
}

/** The bar containing time t (by open time), else the nearest one. */
export function barAt(bars: Bar[], t: number): Bar | undefined {
  let best: Bar | undefined;
  for (const b of bars) {
    if (t >= b.t && t < b.t + HOUR) return b;
    if (!best || Math.abs(b.t + HOUR / 2 - t) < Math.abs(best.t + HOUR / 2 - t)) best = b;
  }
  return best;
}

/** Closes as flat bars (o = h = l = c), so the chart can place markers the same way when only closes are known. */
export const closeBars = (closes: [number, number][]): Bar[] => closes.map(([t, c]) => ({ t: t - HOUR, o: c, h: c, l: c, c }));

export type Run<T> = { one: T } | { run: T[] };

/** Collapses consecutive items with the same hold key into one run (min `min` long). A null key is never collapsed. */
export function holdRuns<T>(list: T[], holdKey: (x: T) => string | null, min = 3): Run<T>[] {
  const out: Run<T>[] = [];
  let i = 0;
  while (i < list.length) {
    const k = holdKey(list[i]);
    let j = i + 1;
    if (k !== null) while (j < list.length && holdKey(list[j]) === k) j++;
    if (j - i >= min) out.push({ run: list.slice(i, j) });
    else for (let x = i; x < j; x++) out.push({ one: list[x] });
    i = j;
  }
  return out;
}
