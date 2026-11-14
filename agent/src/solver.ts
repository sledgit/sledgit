// NEAR Intents solver relay (JSON-RPC): quote, publish a signed intent, poll its status. Needs a Partner Portal JWT.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

export const RELAY = "https://solver-relay-v2.chaindefuser.com/rpc";
const TIMEOUT_MS = 20_000;

export interface Quote { quote_hash: string; amount_in: string; amount_out: string; expiration_time?: string }
export type RelayStatus = "PENDING" | "TX_BROADCASTED" | "SETTLED" | "NOT_FOUND_OR_NOT_VALID" | string;

/** The JWT from a 0600 file (default ~/.config/sledgit/near-intents.jwt). Never printed. */
export function relayKey(path = process.env.SLEDGIT_INTENTS_JWT_FILE ?? `${homedir()}/.config/sledgit/near-intents.jwt`): string {
  if (statSync(path).mode & 0o077) throw new Error(`${path} must be readable by you only (chmod 600)`);
  const key = readFileSync(path, "utf8").trim();
  if (!key) throw new Error(`${path} is empty`);
  return key;
}

async function rpc<T>(key: string, method: string, params: unknown, f: typeof fetch = fetch): Promise<T> {
  const res = await f(RELAY, {
    method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json", "X-API-Key": key },
    body: JSON.stringify({ id: Date.now(), jsonrpc: "2.0", method, params: [params] }),
  });
  if (!res.ok) throw new Error(`relay ${method}: HTTP ${res.status}`);
  const body = await res.json() as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`relay ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result as T;
}

/** The best quote for an exact input, or null when no solver answers. */
export async function bestQuote(key: string, tokenIn: string, tokenOut: string, amountIn: bigint, deadlineMs = 120_000,
  f?: typeof fetch): Promise<Quote | null> {
  const quotes = await rpc<Quote[] | null>(key, "quote", {
    defuse_asset_identifier_in: `nep141:${tokenIn}`, defuse_asset_identifier_out: `nep141:${tokenOut}`,
    exact_amount_in: amountIn.toString(), min_deadline_ms: deadlineMs }, f);
  // The relay can also answer with errors such as {type: "INSUFFICIENT_AMOUNT"}: keep priced quotes only.
  const priced = (quotes ?? []).filter(q => q.quote_hash && /^\d+$/.test(String(q.amount_out ?? "")));
  if (!priced.length) return null;
  return priced.reduce((a, b) => (BigInt(b.amount_out) > BigInt(a.amount_out) ? b : a));
}

export async function publish(key: string, quoteHash: string, signed: unknown, f?: typeof fetch): Promise<string> {
  const r = await rpc<{ status: string; reason?: string; intent_hash?: string }>(key, "publish_intent",
    { quote_hashes: [quoteHash], signed_data: signed }, f);
  if (r.status !== "OK" || !r.intent_hash) throw new Error(`relay refused the intent: ${r.reason ?? r.status}`);
  return r.intent_hash;
}

/** Polls until settled, invalid, or the deadline passes. */
export async function waitSettled(key: string, intentHash: string, deadline: Date, f?: typeof fetch,
  sleep = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<{ status: RelayStatus; tx?: string }> {
  for (;;) {
    const r = await rpc<{ status: RelayStatus; data?: { hash?: string } }>(key, "get_status", { intent_hash: intentHash }, f);
    if (r.status === "SETTLED" || r.status === "NOT_FOUND_OR_NOT_VALID") return { status: r.status, tx: r.data?.hash };
    if (Date.now() > deadline.getTime() + 30_000) return { status: r.status };
    await sleep(2_000);
  }
}
