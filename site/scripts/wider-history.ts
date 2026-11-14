// History we own: each wider fetch also appends one dated snapshot per source to data/wider-history/<source>/<date>.jsonl.gz
// (outside public/, so it is never served). A past day's file is never overwritten: if today's file already exists the
// write is skipped and says so. One gzipped JSON line per record: { date, source, id, value, pnl, tvl }.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { SourceRecord } from "../src/lib/wider";

export interface SnapshotRow { date: string; source: string; id: string; value: number | null; pnl: number | null; tvl: number | null }

const DATE = /^\d{4}-\d{2}-\d{2}$/, SOURCE = /^[a-z0-9-]{1,32}$/;
const fin = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** One row per record: its latest account value and cumulative PnL, and its TVL, as fetched. */
export function snapshotRows(date: string, source: string, records: SourceRecord[]): SnapshotRow[] {
  return records.map(r => { const p = r.history[r.history.length - 1]; return { date, source, id: r.id, value: fin(p?.value), pnl: fin(p?.pnl), tvl: fin(r.tvl) }; });
}

/** Write <dir>/<source>/<date>.jsonl.gz unless it exists. Returns whether it wrote. Exclusive create, so a race cannot overwrite either. */
export function appendSnapshot(dir: string, source: string, date: string, rows: SnapshotRow[], log: (s: string) => void = console.log): { written: boolean; path: string } {
  if (!SOURCE.test(source)) throw new Error(`history: bad source id ${JSON.stringify(source)}`);
  if (!DATE.test(date)) throw new Error(`history: bad date ${JSON.stringify(date)}`);
  const sub = join(dir, source), path = join(sub, `${date}.jsonl.gz`);
  if (existsSync(path)) { log(`history: ${source}/${date}.jsonl.gz already exists, not overwritten`); return { written: false, path }; }
  mkdirSync(sub, { recursive: true });
  try {
    writeFileSync(path, gzipSync(rows.map(r => JSON.stringify(r)).join("\n") + "\n"), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") { log(`history: ${source}/${date}.jsonl.gz appeared meanwhile, not overwritten`); return { written: false, path }; }
    throw e;
  }
  log(`history: ${rows.length} row(s) → ${source}/${date}.jsonl.gz`);
  return { written: true, path };
}
