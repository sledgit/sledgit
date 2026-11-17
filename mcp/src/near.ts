// Read-only NEAR access for the MCP server: JSON-RPC views and transactions, and the FastNEAR transactions API for an
// account's history. No keys, no signing. Every call has a deadline and every failure names its endpoint.
import { isVaultStandard } from "../../agent/src/events.js";

export type NetworkId = "testnet" | "mainnet";

export interface Net {
  id: NetworkId;
  rpc: string;
  /** Archival RPC: regular RPC prunes transactions after a few days. */
  archival: string;
  /** FastNEAR transactions API: an account's transaction hashes, then the transactions with their receipts. */
  txApi: string;
  explorer: string;
  /** The arena pair, as in agent/src/config.ts (kept equal by a test). */
  base: string;
  quote: string;
}

export const NETS: Record<NetworkId, Net> = {
  testnet: {
    id: "testnet",
    rpc: "https://rpc.testnet.fastnear.com",
    archival: "https://archival-rpc.testnet.fastnear.com",
    txApi: "https://tx.test.fastnear.com",
    explorer: "https://testnet.nearblocks.io/txns/",
    base: "wrap.testnet",
    quote: "usdc.itachicara.testnet",
  },
  mainnet: {
    id: "mainnet",
    rpc: "https://free.rpc.fastnear.com",
    archival: "https://archival-rpc.mainnet.fastnear.com",
    txApi: "https://tx.main.fastnear.com",
    explorer: "https://nearblocks.io/txns/",
    base: "wrap.near",
    quote: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // native USDC, Rhea pool 4512
  },
};

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** Streamed when present, so an oversized body is refused while it arrives rather than after. */
  body?: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
}
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<FetchResponse>;

export const TIMEOUT_MS = 20_000;
/** Largest response accepted from any endpoint, in bytes, enforced while the body streams in. */
export const MAX_BODY = 8 * 1024 * 1024;

/** A response body, refused as soon as it passes MAX_BODY bytes (a declared length over it is refused unread). */
async function readBody(res: FetchResponse, host: string): Promise<string> {
  const tooBig = new Error(`${host}: response larger than ${MAX_BODY} bytes`);
  if (Number(res.headers?.get("content-length") ?? "0") > MAX_BODY) throw tooBig;
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_BODY) throw tooBig;
    return text;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw tooBig; }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT = /^[0-9a-f]{64}$/;

/**
 * NEAR account id rules (2–64 chars, lowercase segments) plus the network: testnet ids end in .testnet, mainnet ids
 * don't. Whether an id is a Sledgit vault is the provenance check's job, not this one's.
 */
export function checkAccount(id: string, net: Net, what = "account"): string {
  if (typeof id !== "string" || id.length < 2 || id.length > 64 || !ACCOUNT.test(id)) throw new Error(`${what} is not a valid NEAR account id: ${JSON.stringify(id).slice(0, 80)}`);
  const ok = net.id === "testnet" ? id.endsWith(".testnet") : !id.endsWith(".testnet") && (id.includes(".") || IMPLICIT.test(id));
  if (!ok) throw new Error(`${what} ${id} is not a ${net.id} account`);
  return id;
}

export const isTxHash = (h: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h);

export class Near {
  constructor(readonly net: Net, private readonly fetchFn: Fetch = fetch as unknown as Fetch, private readonly timeoutMs = TIMEOUT_MS) {}

  private async post<T>(url: string, body: unknown): Promise<T> {
    const host = new URL(url).host;
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const name = (e as Error)?.name;
      throw new Error(name === "TimeoutError" || name === "AbortError" ? `${host}: no answer within ${this.timeoutMs / 1000} s` : `${host}: request failed (${(e as Error).message})`);
    }
    const text = await readBody(res, host);
    if (!res.ok) throw new Error(`${host}: HTTP ${res.status} ${text.slice(0, 160)}`);
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new Error(`${host}: response is not JSON (${(e as Error).message})`);
    }
  }

  async rpc<T>(method: string, params: unknown, url = this.net.rpc): Promise<T> {
    const j = await this.post<{ result?: T; error?: { name?: string; cause?: { name?: string; info?: unknown }; data?: unknown; message?: string } }>(
      url, { jsonrpc: "2.0", id: "sledgit-mcp", method, params });
    if (j.error) {
      const detail = typeof j.error.data === "string" ? j.error.data : j.error.message ?? "";
      throw new Error(`RPC ${method}: ${j.error.cause?.name ?? j.error.name ?? "error"} ${detail}`.trim());
    }
    if (j.result === undefined) throw new Error(`RPC ${method}: empty response`);
    return j.result;
  }

  /** A contract view at final finality. */
  async view<T>(account: string, method: string, args: object = {}): Promise<T> {
    const r = await this.rpc<{ result?: number[]; error?: string }>("query", {
      request_type: "call_function", finality: "final", account_id: account, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (r.error) throw new Error(`${account}.${method}: ${r.error}`);
    if (!r.result) throw new Error(`${account}.${method}: no result`);
    return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
  }

  async accessKeys(account: string): Promise<{ public_key: string; access_key: { permission: unknown } }[]> {
    const r = await this.rpc<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>("query", {
      request_type: "view_access_key_list", finality: "final", account_id: account });
    return r.keys;
  }

  /** The outcome tree of a finished transaction. */
  tx(hash: string, sender: string): Promise<OutcomeTree> {
    // Regular RPC prunes old transactions and then waits instead of failing, so the archival node goes first.
    const p = { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" };
    return this.rpc<OutcomeTree>("tx", p, this.net.archival).catch(() => this.rpc<OutcomeTree>("tx", p));
  }

  /** Newest-first transaction hashes touching `account`, up to `max`. */
  async accountTxs(account: string, max: number): Promise<string[]> {
    const out: string[] = [];
    let resume: string | undefined;
    while (out.length < max) {
      const r = await this.post<{ account_txs?: { transaction_hash: string }[]; resume_token?: string; message?: string }>(
        `${this.net.txApi}/v0/account`, { account_id: account, ...(resume ? { resume_token: resume } : {}) });
      if (!Array.isArray(r.account_txs)) throw new Error(`transactions API, ${account}: ${r.message ?? "unexpected response"}`);
      out.push(...r.account_txs.map((t) => t.transaction_hash));
      if (!r.resume_token || !r.account_txs.length) break;
      resume = r.resume_token;
    }
    return [...new Set(out)].slice(0, max);
  }

  /** Transactions with their receipts, 20 per request (the API's batch limit). */
  async txs(hashes: string[]): Promise<ApiTx[]> {
    const out: ApiTx[] = [];
    for (let i = 0; i < hashes.length; i += 20) {
      const chunk = hashes.slice(i, i + 20);
      const r = await this.post<{ transactions?: (ApiTx | null)[]; message?: string }>(`${this.net.txApi}/v0/transactions`, { tx_hashes: chunk });
      if (!Array.isArray(r.transactions)) throw new Error(`transactions API: ${r.message ?? "unexpected response"}`);
      out.push(...r.transactions.filter((t): t is ApiTx => !!t?.transaction));
    }
    return out;
  }
}

export interface Outcome { logs: string[]; executor_id: string; status?: unknown }

export interface OutcomeTree {
  transaction: { hash: string; signer_id: string };
  transaction_outcome: { outcome: Outcome };
  receipts_outcome: { id: string; outcome: Outcome }[];
}

export interface ApiTx {
  transaction: { hash: string; signer_id: string };
  receipts?: { execution_outcome: { id: string; block_height: number; block_timestamp: number; outcome: Outcome } }[];
}

/** A receipt whose execution succeeded; NEAR keeps the logs of failed receipts, whose state changes were reverted. */
export const succeeded = (status: unknown): boolean =>
  !!status && typeof status === "object" && ("SuccessValue" in status || "SuccessReceiptId" in status);

export interface VaultEvent { event: string; data: Record<string, unknown> }

/** Vault NEP-297 events from one log line; anything else is null. A malformed EVENT_JSON log is reported. */
export function parseEvent(log: string): VaultEvent | null | "malformed" {
  if (!log.startsWith("EVENT_JSON:")) return null;
  let e: { standard?: unknown; event?: unknown; data?: unknown };
  try {
    e = JSON.parse(log.slice("EVENT_JSON:".length)) as typeof e;
  } catch {
    return "malformed";
  }
  if (!isVaultStandard(e?.standard) || typeof e.event !== "string") return null;
  const d = Array.isArray(e.data) && e.data[0] && typeof e.data[0] === "object" ? (e.data[0] as Record<string, unknown>) : {};
  return { event: e.event, data: d };
}

/**
 * Events logged by `executor` only, so a token or exchange in the same transaction can't forge vault events. Events
 * from receipts that failed (or report no status) are not counted: their state changes were reverted.
 */
export function vaultEvents(logsByExecutor: { executor: string; logs: string[]; status?: unknown }[], executor: string): { events: VaultEvent[]; malformed: number; failed: number } {
  const events: VaultEvent[] = [];
  let malformed = 0, failed = 0;
  for (const o of logsByExecutor) {
    if (o.executor !== executor) continue;
    if (!succeeded(o.status)) { failed += o.logs.length; continue; }
    for (const l of o.logs) {
      const e = parseEvent(l);
      if (e === "malformed") malformed++;
      else if (e) events.push(e);
    }
  }
  return { events, malformed, failed };
}

export const treeLogs = (t: OutcomeTree) => [t.transaction_outcome, ...t.receipts_outcome].map((o) => ({ executor: o.outcome.executor_id, logs: o.outcome.logs, status: o.outcome.status }));
export const apiLogs = (t: ApiTx) => (t.receipts ?? []).map((r) => ({ executor: r.execution_outcome.outcome.executor_id, logs: r.execution_outcome.outcome.logs, status: r.execution_outcome.outcome.status }));
