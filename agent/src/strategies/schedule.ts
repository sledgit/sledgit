// When house strategies tick, and the on-chain state they decide from. One slot a day at 00:05 UTC (daily candles close
// at 00:00); a tick counts as on schedule inside a 2 h window and only once per slot. The luck draw uses the hash of the
// first block at or after the slot, which nobody knows before the slot and nobody can change after it.
import type { NetworkId } from "../config.js";
import { vaultDecisions, type ChainDecision } from "../attest/chain.js";

export const SCHEDULE = { cadence: "daily", slot_utc: "00:05", window_minutes: 120 } as const;
const SLOT_OFFSET_MS = 5 * 60_000;
const DAY = 86_400_000;

/** Archival RPC: slot blocks must stay readable after ordinary nodes drop them. */
export const ARCHIVAL_RPC: Record<NetworkId, string> = {
  testnet: "https://archival-rpc.testnet.fastnear.com",
  mainnet: "https://archival-rpc.mainnet.fastnear.com",
};

/** The latest slot start at or before `now` (ms). */
export const slotStart = (now: number): number => {
  const s = Math.floor(now / DAY) * DAY + SLOT_OFFSET_MS;
  return s <= now ? s : s - DAY;
};
export const nextSlot = (now: number): number => slotStart(now) + DAY;

export interface SlotBlock { height: number; hash: string; time_secs: number }

/** What a house rule reads from chain, recorded in the receipt as `chain` so a verifier can recompute it. */
export interface ChainState {
  /** The on-chain seq this decision gets (the vault's seq + 1). */
  seq: number;
  /** Decisions the vault recorded before this one; always seq - 1. */
  decisions_before: number;
  requests: { buy: number; sell: number };
  last_request: { seq: number; side: "buy" | "sell" } | null;
  slot: string;
  off_schedule: boolean;
  slot_block: SlotBlock;
}

/** Decision history summary from the vault's own events. `base` is the token a sell spends. */
export function summarise(decisions: ChainDecision[], base: string): Pick<ChainState, "decisions_before" | "requests" | "last_request"> {
  const requests = { buy: 0, sell: 0 };
  let last: ChainState["last_request"] = null;
  for (const d of decisions) {
    if (d.event !== "request") continue;
    const side = d.token_in === base ? "sell" : "buy";
    requests[side]++;
    last = { seq: d.seq, side };
  }
  return { decisions_before: decisions.length, requests, last_request: last };
}

type Fetch = typeof fetch;

async function rpcBlock(net: NetworkId, params: unknown, f: Fetch): Promise<SlotBlock | null> {
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    // Back off between attempts: public archival RPC answers 429 under bursts.
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    try {
      const res = await f(ARCHIVAL_RPC[net], { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "it", method: "block", params }), signal: AbortSignal.timeout(20_000), redirect: "error" });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const r = JSON.parse(await res.text()) as { result?: { header?: { height?: number; hash?: string; timestamp?: number | string } }; error?: { cause?: { name?: string } } };
      if (r.error?.cause?.name === "UNKNOWN_BLOCK") return null; // a skipped height
      const h = r.result?.header;
      if (!h || typeof h.hash !== "string" || typeof h.height !== "number") { lastErr = "malformed block"; continue; }
      return { height: h.height, hash: h.hash, time_secs: Math.floor(Number(h.timestamp) / 1e9) };
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(`block lookup failed: ${lastErr}`);
}

/** The first existing block at height >= h (heights can be skipped). */
async function blockFrom(net: NetworkId, h: number, f: Fetch): Promise<SlotBlock> {
  for (let i = 0; i < 20; i++) {
    const b = await rpcBlock(net, { block_id: h + i }, f);
    if (b) return b;
  }
  throw new Error(`no block in heights ${h}..${h + 19}`);
}

/** The last existing block at height <= h. */
async function blockUpTo(net: NetworkId, h: number, f: Fetch): Promise<SlotBlock> {
  for (let i = 0; i < 20; i++) {
    const b = await rpcBlock(net, { block_id: h - i }, f);
    if (b) return b;
  }
  throw new Error(`no block in heights ${h - 19}..${h}`);
}

/** The first block whose timestamp is at or after `slotMs`. */
export async function slotBlock(net: NetworkId, slotMs: number, f: Fetch = fetch): Promise<SlotBlock> {
  const target = Math.floor(slotMs / 1000);
  const head = await rpcBlock(net, { finality: "final" }, f);
  if (!head) throw new Error("no final block");
  if (head.time_secs < target) throw new Error("the slot is not final yet");
  let hi = head;
  let step = 4096;
  let lo = await blockUpTo(net, Math.max(1, hi.height - step), f);
  while (lo.time_secs >= target) {
    if (lo.height <= 1) throw new Error("the slot is before the first block");
    hi = lo;
    step *= 2;
    lo = await blockUpTo(net, Math.max(1, hi.height - step), f);
  }
  // lo.time < target <= hi.time
  while (hi.height - lo.height > 1) {
    const mid = await blockFrom(net, Math.floor((lo.height + hi.height) / 2), f);
    if (mid.height >= hi.height) break; // only skipped heights between lo and hi
    if (mid.time_secs >= target) hi = mid; else lo = mid;
  }
  return hi;
}

/** Re-check a recorded slot block: same hash, at or after the slot, and its predecessor before it. */
export async function checkSlotBlock(net: NetworkId, slotMs: number, b: SlotBlock, f: Fetch = fetch): Promise<string | null> {
  const target = Math.floor(slotMs / 1000);
  const got = await rpcBlock(net, { block_id: b.height }, f);
  if (!got) return `no block at height ${b.height}`;
  if (got.hash !== b.hash) return `block ${b.height} hash differs`;
  if (got.time_secs < target) return "slot block is before the slot";
  const prev = await blockUpTo(net, b.height - 1, f);
  if (prev.time_secs >= target) return "an earlier block is already at or after the slot";
  return null;
}

/** Everything a house rule needs from chain for the tick at `now`. Throws when the history can't be read in full. */
export async function chainState(net: NetworkId, vault: string, base: string, configSeq: number, now: number,
  f: Fetch = fetch, decisions?: ChainDecision[]): Promise<ChainState> {
  const hist = decisions ?? await vaultDecisions(net, vault, f);
  if (hist.length !== configSeq) throw new Error(`${vault}: read ${hist.length} decisions but the vault's seq is ${configSeq}; history incomplete`);
  const slot = slotStart(now);
  const inWindow = now - slot < SCHEDULE.window_minutes * 60_000;
  const already = hist.some((d) => d.block_time_secs * 1000 >= slot);
  return {
    seq: configSeq + 1,
    ...summarise(hist, base),
    slot: new Date(slot).toISOString(),
    off_schedule: !inWindow || already,
    slot_block: await slotBlock(net, slot, f),
  };
}
