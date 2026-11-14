// Thin client for a Sledgit vault: views, agent calls, and reading the vault's own events from a transaction.
import { inspect } from "node:util";
import { Account, JsonRpcProvider, KeyPair, actions, teraToGas } from "near-api-js";
import { assertAccountsMatchNetwork, type AgentKey, type Network } from "./config.js";
import type { ChainReader } from "./provenance.js";
import { isVaultStandard } from "./events.js";

export const REFUSAL_CODES = [
  "frozen", "busy", "unsettled", "pair_not_allowed", "zero_amount", "trade_cap",
  "unpriceable", "daily_cap", "rate_limit", "intents_not_set_up", "season_ended",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Pair { token_in: string; token_out: string; pool_id: number; min_price_num: string; min_price_den: string }
export interface TokenLimit { token: string; max_per_trade: string; max_per_day: string }
export interface Policy { tokens: TokenLimit[]; pairs: Pair[]; max_trades_per_hour: number; max_slippage_bps: number }
export interface Usage { hour: string; trades: number; spent: [string, string][] }
export type Preview = { ok: true; pool_id: number; band_floor: string } | { ok: false; code: RefusalCode; reason: string };

export interface VaultEvent { event: string; data: Record<string, unknown> }

export type Outcome =
  | { status: "traded"; amount_out: string; venue: string }
  /** A signed intent: publish `multi_payload` to solvers before `deadline`; the cap is reserved until settled. */
  | { status: "authorized"; min_amount_out: string; deadline: string; multi_payload?: unknown }
  /** Signing gave no readable signature, but one may exist: only intents_settle after the deadline decides. */
  | { status: "unknown_until_settled"; deadline: string; reason: string }
  | { status: "cancelled" }
  | { status: "cancel_failed"; reason: string }
  | { status: "refused"; code: string; reason: string }
  | { status: "failed"; reason: string }
  | { status: "expired" }
  | { status: "skipped" }
  | { status: "frozen" }
  | { status: "pending"; note: string }
  | { status: "error"; reason: string };

export interface TxResult {
  tx: string; ok: boolean; events: VaultEvent[]; failure?: string; outcome: Outcome; malformed_events?: number;
  /** Logs from receipts that failed or reported no status: not counted as events (their state change was reverted). */
  failed_receipt_logs?: number;
}

/** Attached to every swap/intent/cancel call; contract minimums are 265 (request_swap), 230 (request_intent_swap), 255 (intents_cancel). */
const TG_AGENT_SWAP = 300;

/** Per-call RPC deadlines. near-api-js sets none, so a stalled connection would hang a tick forever. */
export const RPC_TIMEOUT_MS = 30_000;
export const RPC_SEND_TIMEOUT_MS = 150_000;
const SLOW_METHODS = new Set(["send_tx", "broadcast_tx_commit", "tx", "EXPERIMENTAL_tx_status"]);

export class RpcTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`RPC ${method} did not answer within ${Math.round(ms / 1000)} s`);
    this.name = "RpcTimeoutError";
  }
}

/** A JsonRpcProvider whose every request races a deadline. */
export function timedProvider(url: string, timeoutMs = RPC_TIMEOUT_MS, sendTimeoutMs = RPC_SEND_TIMEOUT_MS): JsonRpcProvider {
  const p = new JsonRpcProvider({ url });
  const send = p.sendJsonRpc.bind(p) as (method: string, params: unknown) => Promise<unknown>;
  const timed = (method: string, params: unknown): Promise<unknown> => {
    const ms = SLOW_METHODS.has(method) ? sendTimeoutMs : timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RpcTimeoutError(method, ms)), ms); });
    return Promise.race([send(method, params), deadline]).finally(() => clearTimeout(timer));
  };
  (p as unknown as { sendJsonRpc: typeof timed }).sendJsonRpc = timed;
  return p;
}

/** One log line -> a vault event, or null. Never throws: a malformed log is counted, not fatal. */
function parseEventLog(l: string): VaultEvent | null | "malformed" {
  if (!l.startsWith("EVENT_JSON:")) return null;
  try {
    const e = JSON.parse(l.slice("EVENT_JSON:".length)) as { standard?: string; event?: unknown; data?: unknown };
    if (!isVaultStandard(e?.standard) || typeof e.event !== "string") return null;
    const d = Array.isArray(e.data) && e.data[0] && typeof e.data[0] === "object" ? (e.data[0] as Record<string, unknown>) : {};
    return { event: e.event, data: d };
  } catch {
    return "malformed";
  }
}

export function eventsFromLogs(logs: string[]): VaultEvent[] {
  return logs.map(parseEventLog).filter((e): e is VaultEvent => !!e && e !== "malformed");
}

interface OutcomeTree {
  transaction_outcome: { outcome: { logs: string[]; executor_id: string; status?: unknown } };
  receipts_outcome: { outcome: { logs: string[]; executor_id: string; status?: unknown } }[];
}

/** A receipt whose execution succeeded; NEAR keeps the logs of failed receipts, whose state changes were reverted. */
export const succeeded = (status: unknown): boolean =>
  !!status && typeof status === "object" && ("SuccessValue" in status || "SuccessReceiptId" in status);

/**
 * Events logged by `executor` only: a token or exchange contract in the same transaction cannot forge vault events.
 * `onlySucceeded` (verify) also drops events from receipts that failed or report no status, and counts them.
 */
export function eventsFromOutcome(r: OutcomeTree, executor: string, opts: { onlySucceeded?: boolean } = {}): { events: VaultEvent[]; malformed: number; failed: number } {
  const events: VaultEvent[] = [];
  let malformed = 0, failed = 0;
  for (const o of [r.transaction_outcome, ...r.receipts_outcome]) {
    if (o.outcome.executor_id !== executor) continue;
    if (opts.onlySucceeded && !succeeded(o.outcome.status)) { failed += o.outcome.logs.length; continue; }
    for (const l of o.outcome.logs) {
      const e = parseEventLog(l);
      if (e === "malformed") malformed++;
      else if (e) events.push(e);
    }
  }
  return { events, malformed, failed };
}

/** What the vault said happened. Events beat the tx status: a refusal is a successful tx that returns false. */
export function classify(events: VaultEvent[], failure?: string): Outcome {
  const find = (name: string) => events.find((e) => e.event === name)?.data;
  const refuse = find("refuse");
  if (refuse) return { status: "refused", code: String(refuse.code), reason: String(refuse.reason ?? "") };
  const trade = find("trade");
  if (trade) return { status: "traded", amount_out: String(trade.amount_out), venue: String(trade.venue) };
  const failed = find("failed");
  if (failed) return { status: "failed", reason: String(failed.reason) };
  const auth = find("intent_authorized");
  if (auth) {
    return { status: "authorized", min_amount_out: String(auth.min_amount_out), deadline: String(auth.deadline),
      ...(auth.multi_payload !== undefined ? { multi_payload: auth.multi_payload } : {}) };
  }
  const unsigned = find("intent_unsigned");
  if (unsigned) return { status: "unknown_until_settled", deadline: String(unsigned.deadline ?? ""), reason: String(unsigned.reason ?? "") };
  if (find("intent_cancelled")) return { status: "cancelled" };
  const cancelFailed = find("intent_cancel_failed");
  if (cancelFailed) return { status: "cancel_failed", reason: String(cancelFailed.reason ?? "") };
  if (find("intent_expired")) return { status: "expired" };
  if (find("skip")) return { status: "skipped" };
  if (find("freeze")) return { status: "frozen" };
  if (failure) return { status: "error", reason: failure };
  if (find("request")) return { status: "pending", note: "request accepted; no final event yet (check get_in_flight)" };
  return { status: "pending", note: events.map((e) => e.event).join(",") || "no vault events" };
}

export interface AccessKeyCheck { kind: "full_access" | "function_call"; warnings: string[] }

/** The agent methods a FunctionCall access key needs (all take 0 deposit). */
export const AGENT_METHODS = ["request_swap", "request_intent_swap", "log_skip", "intents_cancel", "intents_settle", "freeze"];
/** Below this an allowance blocks a 300 Tgas call in near-api-js's pre-check. */
// ~0.3 NEAR is the worst-case reserve near-api-js checks for a 300 Tgas call; 0.35 leaves a margin.
const MIN_ALLOWANCE = 35n * 10n ** 22n;

export class Vault {
  readonly provider: JsonRpcProvider;
  /** ES-private, so JSON.stringify/inspect of a Vault can never reach the signer's key. */
  #account?: Account;
  #publicKey?: string;
  /** The node's chain_id, once assertChain has run. */
  chainId?: string;

  constructor(readonly net: Network, readonly id: string, key?: AgentKey, opts: { timeoutMs?: number; sendTimeoutMs?: number } = {}) {
    this.provider = timedProvider(net.rpc, opts.timeoutMs, opts.sendTimeoutMs);
    if (key) this.useKey(key);
  }

  useKey(key: AgentKey): void {
    const kp = KeyPair.fromString(key.secretKey as `ed25519:${string}`);
    this.#publicKey = kp.getPublicKey().toString();
    this.#account = new Account(key.accountId, this.provider, key.secretKey as `ed25519:${string}`);
  }

  get agentId(): string | undefined {
    return this.#account?.accountId;
  }

  toJSON() {
    return { net: this.net.id, id: this.id, agent: this.agentId };
  }

  [inspect.custom]() {
    return `Vault(${this.net.id} ${this.id}${this.agentId ? ` as ${this.agentId}` : ""})`;
  }

  /**
   * The RPC must serve the selected network: a mainnet RPC in SLEDGIT_RPC cannot turn a testnet run into mainnet
   * signing. Also checks the vault id's suffix. Run before loading any key.
   */
  async assertChain(): Promise<void> {
    assertAccountsMatchNetwork(this.net, [this.id]);
    const { chain_id } = await this.provider.viewNodeStatus();
    if (chain_id !== this.net.id) throw new Error(`RPC serves chain_id ${JSON.stringify(chain_id)}, but the selected network is ${this.net.id}`);
    this.chainId = chain_id;
  }

  /**
   * The agent key should be a FunctionCall key for this vault with a small allowance. A FullAccess key works but a
   * leak then hands over the whole agent account; we warn. A FunctionCall key for another receiver cannot sign
   * vault calls at all, so that is an error.
   */
  async checkAccessKey(): Promise<AccessKeyCheck> {
    if (!this.#account || !this.#publicKey) throw new Error("no agent key loaded");
    const { permission } = await this.provider.viewAccessKey({ accountId: this.#account.accountId, publicKey: this.#publicKey });
    if (permission === "FullAccess") {
      return { kind: "full_access", warnings: [
        `warning: the agent key is a FullAccess key; use a FunctionCall key for ${this.id} on a small agent account (see SKILL.md section 8)`,
      ] };
    }
    const fc = permission.FunctionCall;
    if (fc.receiver_id !== this.id) throw new Error(`the agent key is a FunctionCall key for ${fc.receiver_id}, not for the vault ${this.id}`);
    const warnings: string[] = [];
    const missing = fc.method_names.length ? AGENT_METHODS.filter((m) => !fc.method_names.includes(m)) : [];
    if (missing.length) warnings.push(`warning: the agent key cannot call ${missing.join(", ")}`);
    if (fc.method_names.length === 0) warnings.push("warning: the agent key allows every method on the vault; restrict it to the agent methods");
    // near-api-js checks an allowance against a worst-case gas price (~0.3 NEAR per 300 Tgas call), so below that the
    // agent is blocked. Mainnet agents use a finite allowance (1 NEAR); testnet agents use none (SKILL.md section 8).
    if (fc.allowance !== null && fc.allowance !== undefined && BigInt(fc.allowance) < MIN_ALLOWANCE) {
      warnings.push("warning: the agent key's allowance is under 0.35 NEAR, near the ~0.3 NEAR worst-case reserve a 300 Tgas call needs; rotate to a fresh agent account with the owner's set_agent");
    }
    return { kind: "function_call", warnings };
  }

  async view<T>(method: string, args: Record<string, unknown> = {}, contractId = this.id): Promise<T> {
    return (await this.provider.callFunction({ contractId, method, args })) as T;
  }

  config = () => this.view<Record<string, unknown> & { agent_id: string; frozen: boolean; seq: number }>("get_config");
  policy = () => this.view<Policy>("get_policy");
  usage = () => this.view<Usage>("get_usage");
  inFlight = () => this.view<unknown>("get_in_flight");
  intents = () => this.view<Record<string, unknown> & { open_intent: unknown }>("get_intents");

  preview(tokenIn: string, tokenOut: string, amountIn: bigint, minOut: bigint): Promise<Preview> {
    return this.view<Preview>("preview_swap", {
      token_in: tokenIn, token_out: tokenOut, amount_in: amountIn.toString(), min_amount_out: minOut.toString(),
    });
  }

  async balance(token: string, who = this.id): Promise<bigint> {
    return BigInt(await this.view<string>("ft_balance_of", { account_id: who }, token));
  }

  async decimals(token: string): Promise<number> {
    const m = await this.view<{ decimals: number }>("ft_metadata", {}, token);
    if (!Number.isInteger(m.decimals)) throw new Error(`${token}: ft_metadata has no decimals`);
    return m.decimals;
  }

  /** Refuse to sign unless the vault names this key's account as its agent. */
  async assertAgent(): Promise<void> {
    const cfg = await this.config();
    if (!this.#account) throw new Error("no agent key loaded");
    if (cfg.agent_id !== this.#account.accountId) {
      throw new Error(`vault agent is ${cfg.agent_id}, key is for ${this.#account.accountId}`);
    }
  }

  /** The vault's own events in a finished transaction (for verify). */
  async txEvents(txHash: string, sender: string): Promise<VaultEvent[]> {
    const r = await this.provider.viewTransactionStatus({ txHash, accountId: sender, waitUntil: "FINAL" });
    return eventsFromOutcome(r as unknown as OutcomeTree, this.id, { onlySucceeded: true }).events;
  }

  /** Read-only chain access for provenance checks (verify). */
  reader(): ChainReader {
    return {
      viewAccount: (id) => this.provider.viewAccount({ accountId: id, blockQuery: { finality: "final" } }),
      accessKeyCount: async (id) => (await this.provider.viewAccessKeyList({ accountId: id, finalityQuery: { finality: "final" } })).keys.length,
      view: <T>(id: string, method: string) => this.view<T>(method, {}, id),
    };
  }

  requestSwap(tokenIn: string, tokenOut: string, amountIn: bigint, minOut: bigint, receiptHash: string) {
    return this.call("request_swap", { token_in: tokenIn, token_out: tokenOut, amount_in: amountIn.toString(),
      min_amount_out: minOut.toString(), receipt_hash: receiptHash }, TG_AGENT_SWAP);
  }
  requestIntentSwap(tokenIn: string, tokenOut: string, amountIn: bigint, minOut: bigint, receiptHash: string) {
    return this.call("request_intent_swap", { token_in: tokenIn, token_out: tokenOut, amount_in: amountIn.toString(),
      min_amount_out: minOut.toString(), receipt_hash: receiptHash }, TG_AGENT_SWAP);
  }
  logSkip = (receiptHash: string, note: string) => this.call("log_skip", { receipt_hash: receiptHash, note }, 30);
  freeze = () => this.call("freeze", {}, 30);
  intentsCancel = () => this.call("intents_cancel", {}, TG_AGENT_SWAP);
  intentsSettle = () => this.call("intents_settle", {}, 100);

  async call(method: string, args: Record<string, unknown>, tgas: number): Promise<TxResult> {
    if (!this.#account) throw new Error("no agent key loaded");
    const r = await this.#account.signAndSendTransaction({
      receiverId: this.id,
      actions: [actions.functionCall(method, args, teraToGas(tgas), 0n)],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    return txResult(r as unknown as OutcomeTree & { status: Record<string, unknown>; transaction: { hash: string } }, this.id);
  }
}

/**
 * The runner's view of a sent transaction. Same rule as verify: NEAR keeps the logs of reverted receipts, so only events
 * from succeeded receipts count, and the rest are reported as failed_receipt_logs.
 */
export function txResult(r: OutcomeTree & { status: Record<string, unknown>; transaction: { hash: string } }, executor: string): TxResult {
  const { events, malformed, failed } = eventsFromOutcome(r, executor, { onlySucceeded: true });
  const failure = "Failure" in r.status ? JSON.stringify(r.status.Failure) : undefined;
  return { tx: r.transaction.hash, ok: !failure, events, failure, outcome: classify(events, failure),
    ...(malformed ? { malformed_events: malformed } : {}), ...(failed ? { failed_receipt_logs: failed } : {}) };
}
