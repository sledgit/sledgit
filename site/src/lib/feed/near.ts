import { LIVE_NETWORK, NETWORKS, tokenAmount, vaultBots, type NetworkConfig, type VaultConfig } from "../networks";
import type { ChainEvent, ChainRef, Decision, Feed, FeedEvent, FeedState, Standing, VaultBalance, VaultView } from "./types";

// NEAR feed, read from the browser: vault views over JSON-RPC, the vault's transactions from the
// FastNEAR transactions API (CORS-enabled, batch of 20), and the vault's NEP-297 events in their logs.
// Every failure is reported in a status event; nothing fails silently.
// Event standard "sledgit"; testnet vaults deployed before the rename log the legacy "irontrade".
export const EVENT_STANDARDS = ["sledgit", "irontrade"];
const POLL_MS = 30_000, MAX_PAGES = 10, BATCH = 20;
export const VENUE_NAME: Record<string, string> = { rhea: "Rhea", intents: "NEAR Intents" };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const host = new URL(url).host;
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`${host}: request failed (${msg(e)})`);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`${host}: HTTP ${r.status} ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${host}: response is not JSON (${msg(e)})`);
  }
}

interface RpcError { name?: string; cause?: { name?: string }; data?: unknown; message?: string }
async function rpc<T>(n: NetworkConfig, method: string, params: unknown): Promise<T> {
  const j = await postJson<{ result?: T; error?: RpcError }>(n.rpc, { jsonrpc: "2.0", id: "sledgit", method, params });
  if (j.error) {
    const detail = typeof j.error.data === "string" ? j.error.data : j.error.message ?? "";
    throw new Error(`RPC ${method}: ${j.error.cause?.name ?? j.error.name ?? "error"} ${detail}`.trim());
  }
  if (j.result === undefined) throw new Error(`RPC ${method}: empty response`);
  return j.result;
}

export async function view<T>(n: NetworkConfig, account: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>(n, "query", {
    request_type: "call_function", finality: "final", account_id: account, method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (r.error) throw new Error(`${account}.${method}: ${r.error}`);
  if (!r.result) throw new Error(`${account}.${method}: no result`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}

// Price of one unit of the traded token in the quote token, from the Rhea pool (fee included).
async function refPrice(n: NetworkConfig): Promise<number> {
  const [base, quote] = n.tokens;
  const out = await view<string>(n, n.rhea, "get_return", {
    pool_id: n.pool, token_in: base.id, amount_in: "1" + "0".repeat(base.decimals), token_out: quote.id,
  });
  return tokenAmount(n, quote.id, out);
}

async function accountTxs(n: NetworkConfig, account: string, errors: string[]): Promise<string[]> {
  const out: string[] = [];
  let resume: string | undefined;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) { errors.push(`${account}: only the newest ${out.length} transactions are shown`); break; }
    const r = await postJson<{ account_txs?: { transaction_hash: string }[]; resume_token?: string; message?: string }>(
      `${n.txApi}/v0/account`, { account_id: account, ...(resume ? { resume_token: resume } : {}) });
    if (!Array.isArray(r.account_txs)) throw new Error(`transactions API, ${account}: ${r.message ?? "unexpected response"}`);
    out.push(...r.account_txs.map(t => t.transaction_hash));
    if (!r.resume_token || !r.account_txs.length) break;
    resume = r.resume_token;
  }
  return [...new Set(out)];
}

interface TxOutcome { id: string; block_height: number; block_timestamp: number; outcome: { logs: string[]; executor_id: string; status?: unknown } }
export interface TxRecord { transaction: { hash: string }; receipts?: { execution_outcome: TxOutcome }[] }

async function fetchTxs(n: NetworkConfig, hashes: string[], errors: string[]): Promise<TxRecord[]> {
  const out: TxRecord[] = [];
  for (let i = 0; i < hashes.length; i += BATCH) {
    const chunk = hashes.slice(i, i + BATCH);
    const r = await postJson<{ transactions?: (TxRecord | null)[]; message?: string }>(`${n.txApi}/v0/transactions`, { tx_hashes: chunk });
    if (!Array.isArray(r.transactions)) throw new Error(`transactions API: ${r.message ?? "unexpected response"}`);
    const got = r.transactions.filter((t): t is TxRecord => !!t?.transaction);
    if (got.length < chunk.length) errors.push(`${chunk.length - got.length} transaction(s) not returned by the transactions API`);
    out.push(...got);
  }
  return out;
}

/** A failed receipt's state changes were reverted, so its logs are not events (as the league reader). */
const failed = (status: unknown) => typeof status === "object" && status !== null && "Failure" in status;

export function eventsOf(txs: TxRecord[], account: string, errors: string[]): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const tx of txs) for (const r of tx.receipts ?? []) {
    const o = r.execution_outcome;
    if (o.outcome.executor_id !== account || failed(o.outcome.status)) continue;
    for (const log of o.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let ev: { standard?: string; event?: string; data?: Record<string, unknown>[] };
      try {
        ev = JSON.parse(log.slice("EVENT_JSON:".length));
      } catch (e) {
        errors.push(`unreadable event in ${tx.transaction.hash}: ${msg(e)}`);
        continue;
      }
      if (!EVENT_STANDARDS.includes(String(ev.standard)) || !ev.event) continue;
      for (const data of ev.data?.length ? ev.data : [{}])
        out.push({ event: ev.event, data, txHash: tx.transaction.hash, receiptId: o.id, blockHeight: o.block_height,
          time: Math.floor(o.block_timestamp / 1e9) });
    }
  }
  return out.sort((a, b) => a.blockHeight - b.blockHeight);
}

const str = (x: unknown) => (x == null ? undefined : String(x));

export function decisionOf(e: ChainEvent, botId: string, n: NetworkConfig): Decision | null {
  if (e.event !== "trade" && e.event !== "refuse" && e.event !== "skip") return null;
  const d = e.data, seq = typeof d.seq === "number" ? d.seq : undefined;
  const chain: ChainRef = {
    txHash: e.txHash, receiptId: e.receiptId, seq, receiptHash: str(d.receipt_hash), venue: str(d.venue),
    tokenIn: str(d.token_in), amountIn: str(d.amount_in), tokenOut: str(d.token_out), amountOut: str(d.amount_out), code: str(d.code),
  };
  const base: Decision = { type: "decision", id: `${e.txHash}-${seq ?? e.receiptId.slice(0, 8)}`, kind: e.event, botId, at: e.time,
    reason: "", tx: e.txHash, venue: chain.venue ? VENUE_NAME[chain.venue] ?? chain.venue : undefined, chain };
  if (e.event === "skip") return { ...base, reason: str(d.note) ?? "no reason given" };
  if (e.event === "refuse") return { ...base, reason: `${chain.code ?? "refused"}: ${str(d.reason) ?? ""}`.replace(/: $/, "") };
  const [asset, quote] = n.tokens;
  const staking = n.tokens.find(t => t.rate && (t.id === chain.tokenIn || t.id === chain.tokenOut));
  if (staking) return { ...base, side: chain.tokenOut === staking.id ? "stake" : "unstake", reason: `swap on Rhea pool ${d.pool_id ?? "?"}` };
  const buy = chain.tokenOut === asset.id;
  const assetRaw = buy ? chain.amountOut : chain.amountIn, quoteRaw = buy ? chain.amountIn : chain.amountOut;
  const known = (buy ? chain.tokenIn : chain.tokenOut) === quote.id && assetRaw && quoteRaw;
  const usd = known ? tokenAmount(n, quote.id, quoteRaw) : undefined;
  const price = known && usd != null ? usd / tokenAmount(n, asset.id, assetRaw) : undefined;
  return { ...base, side: buy ? "buy" : "sell", usd, price,
    reason: chain.venue === "intents" ? "intent signed by the vault's MPC key, settled on NEAR Intents" : `swap on Rhea pool ${d.pool_id ?? n.pool}` };
}

// Rebuild holdings from events. A hold benchmark keeps every deposit and withdrawal but never trades.
function replay(n: NetworkConfig, events: ChainEvent[], price: number | null, rates: Map<string, number> = new Map()) {
  const have = new Map<string, bigint>(), hold = new Map<string, bigint>(), unknown = new Set<string>();
  const add = (m: Map<string, bigint>, t: string, a: bigint) => m.set(t, (m.get(t) ?? 0n) + a);
  const unitPrice = (t: string) => (t === n.tokens[1]?.id ? 1 : t === n.tokens[0]?.id ? price ?? NaN
    : rates.has(t) ? rates.get(t)! * (price ?? NaN) : (unknown.add(t), NaN));
  const value = (m: Map<string, bigint>) => [...m].reduce((s, [t, a]) => s + (a === 0n ? 0 : tokenAmount(n, t, a.toString()) * unitPrice(t)), 0);
  const series: { value: number; hold: number }[] = [];
  let deposited = 0;
  for (const e of events) {
    const d = e.data, big = (k: string) => BigInt(String(d[k] ?? "0"));
    switch (e.event) {
      case "deposit": {
        const t = String(d.token), a = big("amount");
        add(have, t, a); add(hold, t, a); deposited += tokenAmount(n, t, a.toString()) * unitPrice(t);
        break;
      }
      case "withdraw": add(have, String(d.token), -big("amount")); add(hold, String(d.token), -big("amount")); break;
      case "trade": add(have, String(d.token_in), -big("amount_in")); add(have, String(d.token_out), big("amount_out")); break;
      default: continue; // moves between the vault, Rhea and Intents don't change what it owns
    }
    series.push({ value: value(have), hold: value(hold) });
  }
  return { series, deposited, replayValue: value(have), holdValue: value(hold), unknown: [...unknown] };
}

async function balances(n: NetworkConfig, account: string, intentsId: string | undefined): Promise<VaultBalance[]> {
  const ids = n.tokens.map(t => t.id);
  const [wallet, exchange, intents] = await Promise.all([
    Promise.all(ids.map(id => view<string>(n, id, "ft_balance_of", { account_id: account }))),
    view<Record<string, string>>(n, n.rhea, "get_deposits", { account_id: account }),
    intentsId ? view<string[]>(n, intentsId, "mt_batch_balance_of", { account_id: account, token_ids: ids.map(i => `nep141:${i}`) })
      : Promise.resolve(ids.map(() => "0")),
  ]);
  return ids.map((token, i) => ({ token, wallet: wallet[i], exchange: exchange[token] ?? "0", intents: intents[i] ?? "0" }));
}

async function loadVault(n: NetworkConfig, v: VaultConfig, price: number | null) {
  const errors: string[] = [];
  const views = ["get_config", "get_policy", "get_usage", "get_intents"] as const;
  const [viewRes, eventsRes] = await Promise.all([
    Promise.allSettled(views.map(m => view<Record<string, unknown>>(n, v.account, m))),
    accountTxs(n, v.account, errors).then(h => fetchTxs(n, h, errors)).then(txs => eventsOf(txs, v.account, errors))
      .catch((e: unknown) => { errors.push(`events: ${msg(e)}`); return [] as ChainEvent[]; }),
  ]);
  const [config, policy, usage, intents] = viewRes.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    errors.push(`${views[i]}: ${msg(r.reason)}`);
    return undefined;
  });
  const intentsId = str(config?.intents_id) ?? n.intents;
  let bal: VaultBalance[] = [];
  try {
    bal = await balances(n, v.account, intentsId);
  } catch (e) {
    errors.push(`balances: ${msg(e)}`);
  }
  // Staking tokens: today's redemption rate (the replay values past events at it too).
  const rates = new Map<string, number>();
  for (const t of n.tokens.filter(x => x.rate)) {
    try {
      rates.set(t.id, tokenAmount(n, n.tokens[0].id, await view<string>(n, t.id, t.rate!)));
    } catch (e) {
      errors.push(`${t.symbol} rate: ${msg(e)}`);
    }
  }
  const r = replay(n, eventsRes, price, rates);
  if (r.unknown.length) errors.push(`no price for ${r.unknown.join(", ")}: left out of the valuation`);
  const value = bal.length
    ? bal.reduce((s, b) => s + [b.wallet, b.exchange, b.intents].reduce((x, raw) => x + tokenAmount(n, b.token, raw), 0)
        * (b.token === n.tokens[1].id ? 1 : rates.has(b.token) ? rates.get(b.token)! * (price ?? NaN) : price ?? NaN), 0)
    : null;
  const vv: VaultView = { botId: v.id, account: v.account, config, policy, usage, intents, balances: bal, events: eventsRes, price,
    deposited: r.deposited, value, replayValue: r.replayValue, holdValue: r.holdValue, errors };
  return { view: vv, series: r.series, decisions: eventsRes.map(e => decisionOf(e, v.id, n)).filter((d): d is Decision => !!d) };
}

function standingOf(v: VaultView, decisions: Decision[], equity: number, hold: number): Standing {
  return {
    botId: v.botId, equity, vsHold: hold > 0 ? equity / hold - 1 : NaN, vsStake: NaN, ci: 0, execPct: 0, ranked: false,
    trades: decisions.filter(d => d.kind === "trade").length, refused: decisions.filter(d => d.kind === "refuse").length,
    decisions: decisions.length,
  };
}

export function createNearFeed(id: NetworkConfig["id"]): Feed {
  const n = NETWORKS[id], bots = vaultBots(n);
  const subs = new Set<(e: FeedEvent) => void>();
  let stopped = false, busy = false, first = true, lastRows = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  const seen = new Set<string>();
  const emit = (e: FeedEvent) => { if (!stopped) subs.forEach(f => f(e)); };
  const status = (state: FeedState, message: string, errors: string[] = []) =>
    emit({ type: "status", status: { state, message, errors, updated: Math.floor(Date.now() / 1000) } });

  async function load() {
    if (busy || stopped) return;
    busy = true;
    try {
      const errors: string[] = [];
      let price: number | null = null;
      try {
        price = await refPrice(n);
      } catch (e) {
        errors.push(`reference price from ${n.rhea} pool ${n.pool}: ${msg(e)}`);
      }
      const now = Math.floor(Date.now() / 1000);
      if (price != null) emit({ type: "tick", price, at: now, candle: { o: price, h: price, l: price, c: price, t: now } });
      const res = await Promise.allSettled(n.vaults.map(v => loadVault(n, v, price)));
      const ok = res.flatMap((r, i) => {
        if (r.status === "fulfilled") { errors.push(...r.value.view.errors.map(e => `${n.vaults[i].name}: ${e}`)); return [r.value]; }
        errors.push(`${n.vaults[i].name} (${n.vaults[i].account}): ${msg(r.reason)}`);
        return [];
      });
      if (first && ok.length) {
        // Replay the record so the sparklines start at the first deposit.
        const len = Math.max(...ok.map(o => o.series.length));
        for (let i = 0; i < len - 1; i++)
          emit({ type: "standings", rows: ok.filter(o => o.series.length).map(o => {
            const p = o.series[Math.min(i, o.series.length - 1)];
            return standingOf(o.view, o.decisions, p.value, p.hold);
          }) });
      }
      for (const o of ok) {
        emit({ type: "vault", vault: o.view });
        for (const d of o.decisions) if (!seen.has(d.id)) { seen.add(d.id); emit(d); }
      }
      const rows = ok.map(o => standingOf(o.view, o.decisions, o.view.value ?? o.view.replayValue, o.view.holdValue));
      if (rows.length && JSON.stringify(rows) !== lastRows) { lastRows = JSON.stringify(rows); emit({ type: "standings", rows }); }
      if (ok.length) first = false;
      if (!ok.length) status("error", `Could not read any vault from ${n.label}.`, errors);
      else status("ready", `${ok.length} vault${ok.length > 1 ? "s" : ""} read from ${n.label}.`, errors);
    } catch (e) {
      status("error", `Reading ${n.label} failed.`, [msg(e)]);
    } finally {
      busy = false;
    }
  }

  return {
    name: n.label, network: id, simulated: false, bots, candleSec: 14_400,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    start() {
      if (!n.vaults.length || !n.txApi) return status("offline", LIVE_NETWORK === n.id ? `Season 1 is launching on ${n.label}: no vaults yet.`
        : "Not live yet: Season 1 starts on mainnet after audits.");
      status("loading", `Reading vaults from ${n.label}…`);
      void load();
      timer = setInterval(() => void load(), POLL_MS);
    },
    stop() { stopped = true; if (timer) clearInterval(timer); },
    setSpeed() {},
  };
}

// One transaction's vault events, from any contract it touched (the verify page).
export async function txEvents(n: NetworkConfig, hash: string): Promise<{ events: (ChainEvent & { executor: string })[]; errors: string[] }> {
  const errors: string[] = [];
  const txs = await fetchTxs(n, [hash], errors);
  if (!txs.length) return { events: [], errors: errors.length ? errors : [`${hash}: not found on ${n.label}`] };
  const executors = new Set(txs.flatMap(t => (t.receipts ?? []).map(r => r.execution_outcome.outcome.executor_id)));
  const events = [...executors].flatMap(a => eventsOf(txs, a, errors).map(e => ({ ...e, executor: a })));
  return { events, errors };
}

// Raw account queries for the verify page: access keys and which code the account runs.
export const accountQuery = <T,>(n: NetworkConfig, request_type: "view_account" | "view_access_key_list", account_id: string) =>
  rpc<T>(n, "query", { request_type, finality: "final", account_id });
