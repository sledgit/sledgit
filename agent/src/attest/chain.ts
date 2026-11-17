// Chain reads the season check needs: every decision event a vault emitted (FastNEAR transactions API), a block by
// height (anchor check), token decimals, and a provenance reader. Plain fetch, fixed hosts, deadlines and size caps;
// no keys, no near-api-js, so the MCP server can use it too.
import type { NetworkId } from "../config.js";
import { checkDecimals } from "../decision.js";
import type { ChainReader } from "../provenance.js";
import { readCapped, type ChainBlock } from "./verify.js";
import { isVaultStandard } from "../events.js";

export const CHAIN_HOSTS: Record<NetworkId, { rpc: string; txApi: string }> = {
  testnet: { rpc: "https://rpc.testnet.fastnear.com", txApi: "https://tx.test.fastnear.com" },
  mainnet: { rpc: "https://free.rpc.fastnear.com", txApi: "https://tx.main.fastnear.com" },
};

/** A decision the vault itself recorded: request, refuse or skip, from a receipt that succeeded. */
export interface ChainDecision {
  seq: number;
  event: "request" | "refuse" | "skip";
  receipt_hash: string;
  token_in?: string;
  token_out?: string;
  amount_in?: string;
  note?: string;
  tx: string;
  block_time_secs: number;
  /** Block of the transaction itself: state at its end is what the tick could have read before deciding. */
  tx_block_height?: number;
}

const DECISION_EVENTS = ["request", "refuse", "skip"];
const MAX_PAGES = 40;
const BATCH = 20;
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 16 * 1024 * 1024;

// Read-only; retries transient failures.
async function post<T>(url: string, body: unknown, f: typeof fetch): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
      return JSON.parse(await readCapped(res, MAX_BYTES, new URL(url).host)) as T;
    } catch (e) {
      if (i >= 2 || !/HTTP (429|5\d\d)|fetch failed|timeout|aborted/i.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function rpc<T>(net: NetworkId, method: string, params: unknown, f: typeof fetch): Promise<T> {
  const r = await post<{ result?: T; error?: { message?: string; cause?: { name?: string } } }>(CHAIN_HOSTS[net].rpc,
    { jsonrpc: "2.0", id: "it", method, params }, f);
  if (r.error || r.result === undefined) throw new Error(`rpc ${method}: ${r.error?.cause?.name ?? r.error?.message ?? "no result"}`);
  return r.result;
}

interface TxRecord {
  transaction?: { hash?: string };
  execution_outcome?: { block_height?: number | string };
  receipts?: { execution_outcome?: { block_timestamp?: number | string; outcome?: { logs?: string[]; executor_id?: string; status?: unknown } } }[];
}

/** Every decision event `vault` emitted, oldest first. Throws if the history can't be read in full. */
export async function vaultDecisions(net: NetworkId, vault: string, f: typeof fetch = fetch): Promise<ChainDecision[]> {
  const hashes: string[] = [];
  let resume: string | undefined;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error(`${vault}: more than ${MAX_PAGES} pages of transactions; history not read in full`);
    const r = await post<{ account_txs?: { transaction_hash: string }[]; resume_token?: string }>(`${CHAIN_HOSTS[net].txApi}/v0/account`,
      { account_id: vault, ...(resume ? { resume_token: resume } : {}) }, f);
    if (!Array.isArray(r.account_txs)) throw new Error(`transactions API: no account_txs for ${vault}`);
    hashes.push(...r.account_txs.map((t) => t.transaction_hash));
    if (!r.resume_token || !r.account_txs.length) break;
    resume = r.resume_token;
  }
  const unique = [...new Set(hashes)];
  const out: ChainDecision[] = [];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const r = await post<{ transactions?: (TxRecord | null)[] }>(`${CHAIN_HOSTS[net].txApi}/v0/transactions`, { tx_hashes: chunk }, f);
    if (!Array.isArray(r.transactions) || r.transactions.filter(Boolean).length !== chunk.length) {
      throw new Error("transactions API returned fewer transactions than asked; history not read in full");
    }
    for (const tx of r.transactions as TxRecord[]) {
      for (const rec of tx.receipts ?? []) {
        const o = rec.execution_outcome;
        // Only the vault's own receipts that succeeded: a failed receipt's logs never took effect.
        if (o?.outcome?.executor_id !== vault || (typeof o.outcome.status === "object" && o.outcome.status !== null && "Failure" in o.outcome.status)) continue;
        for (const log of o.outcome.logs ?? []) {
          if (!log.startsWith("EVENT_JSON:")) continue;
          let ev: { standard?: string; event?: string; data?: Record<string, unknown>[] };
          try {
            ev = JSON.parse(log.slice("EVENT_JSON:".length));
          } catch {
            continue;
          }
          if (!isVaultStandard(ev.standard) || !DECISION_EVENTS.includes(String(ev.event))) continue;
          for (const d of ev.data ?? []) {
            out.push({ seq: Number(d.seq), event: ev.event as ChainDecision["event"], receipt_hash: String(d.receipt_hash ?? ""),
              ...(d.token_in !== undefined ? { token_in: String(d.token_in) } : {}),
              ...(d.token_out !== undefined ? { token_out: String(d.token_out) } : {}),
              ...(d.amount_in !== undefined ? { amount_in: String(d.amount_in) } : {}),
              ...(d.note !== undefined ? { note: String(d.note) } : {}),
              tx: String(tx.transaction?.hash ?? ""), block_time_secs: Math.floor(Number(o.block_timestamp) / 1e9),
              ...(Number.isSafeInteger(Number(tx.execution_outcome?.block_height)) ? { tx_block_height: Number(tx.execution_outcome!.block_height) } : {}) });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export async function blockAt(net: NetworkId, height: number, f: typeof fetch = fetch): Promise<ChainBlock> {
  type B = { header?: { hash?: string; timestamp?: number | string } };
  // Pruned blocks fall back to the archival node.
  const r = await rpc<B>(net, "block", { block_id: height }, f).catch(() => archival<B>(net, "block", { block_id: height }, f));
  if (typeof r.header?.hash !== "string") throw new Error(`no block #${height}`);
  return { hash: r.header.hash, time_secs: Math.floor(Number(r.header.timestamp) / 1e9) };
}

const view = async <T>(net: NetworkId, account: string, method: string, f: typeof fetch): Promise<T> => {
  const r = await rpc<{ result?: number[] }>(net, "query",
    { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: "e30=" }, f);
  return JSON.parse(Buffer.from(r.result ?? []).toString("utf8")) as T;
};

/** Archival RPC: past state (any block) is only served by archival nodes. */
export const ARCHIVAL_RPC: Record<NetworkId, string> = {
  testnet: "https://archival-rpc.testnet.fastnear.com",
  mainnet: "https://archival-rpc.mainnet.fastnear.com",
};

async function archival<T>(net: NetworkId, method: string, params: unknown, f: typeof fetch): Promise<T> {
  let last = "";
  for (let i = 0; i < 6; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // public archival RPC answers 429 under bursts
    try {
      const r = await post<{ result?: T; error?: { message?: string; cause?: { name?: string } } }>(ARCHIVAL_RPC[net],
        { jsonrpc: "2.0", id: "it", method, params }, f);
      if (r.error || r.result === undefined) throw new Error(`rpc ${method}: ${r.error?.cause?.name ?? r.error?.message ?? "no result"}`);
      return r.result;
    } catch (e) {
      last = (e as Error).message;
      if (!/HTTP 429|HTTP 5\d\d|fetch failed|timeout|aborted/i.test(last)) break; // only transient errors are retried
    }
  }
  throw new Error(last);
}

/** A view call against the state at the end of block `height` (archival). */
export async function viewAt<T>(net: NetworkId, account: string, method: string, args: Record<string, unknown>, height: number,
  f: typeof fetch = fetch): Promise<T> {
  const r = await archival<{ result?: number[] }>(net, "query", { request_type: "call_function", block_id: height, account_id: account,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }, f);
  return JSON.parse(Buffer.from(r.result ?? []).toString("utf8")) as T;
}

/** The block a transaction was included in, from the archival node (sender is needed by the tx method). */
export async function txBlockHeight(net: NetworkId, txHash: string, sender: string, f: typeof fetch = fetch): Promise<number> {
  const r = await archival<{ transaction_outcome?: { block_hash?: string } }>(net, "tx", { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" }, f);
  const hash = r.transaction_outcome?.block_hash;
  if (!hash) throw new Error(`no block for transaction ${txHash.slice(0, 12)}`);
  const b = await archival<{ header?: { height?: number } }>(net, "block", { block_id: hash }, f);
  if (!Number.isSafeInteger(b.header?.height)) throw new Error(`no height for block ${hash.slice(0, 12)}`);
  return b.header!.height!;
}

/** The vault's own decision counter (get_config.seq), final. */
export async function vaultSeq(net: NetworkId, vault: string, f: typeof fetch = fetch): Promise<number> {
  const seq = Number((await view<{ seq?: unknown }>(net, vault, "get_config", f)).seq);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(`${vault}: get_config.seq unreadable`);
  return seq;
}

export async function tokenDecimals(net: NetworkId, token: string, f: typeof fetch = fetch): Promise<number> {
  return checkDecimals((await view<{ decimals?: number }>(net, token, "ft_metadata", f)).decimals as number);
}

/** provenance.ts's reader over plain RPC. */
export function rpcReader(net: NetworkId, f: typeof fetch = fetch): ChainReader {
  return {
    viewAccount: (id) => rpc(net, "query", { request_type: "view_account", finality: "final", account_id: id }, f),
    accessKeyCount: async (id) => (await rpc<{ keys?: unknown[] }>(net, "query", { request_type: "view_access_key_list", finality: "final", account_id: id }, f)).keys?.length ?? 0,
    view: (id, method) => view(net, id, method, f),
  };
}
