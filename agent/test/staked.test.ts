// Staked house strategies: the decision rules, stake and unstake through receipts, verifiers and the league's
// valuation of the staking token. Offline: every network call is faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideStaked, stakedById, stakedModel, stakedPrompt, type StakedInput } from "../src/strategies/staked.js";
import { publishedByHash } from "../src/strategies/registry.js";
import { summarise } from "../src/strategies/schedule.js";
import { houseRerun, houseCheck } from "../src/strategies/rerun.js";
import { parseDecision } from "../src/decision.js";
import { expectedDecision, eventMatches } from "../src/attest/pill.js";
import { legs, PAIRS } from "../src/pairs.js";
import { tick } from "../src/arena.js";
import { classify, eventsFromLogs, type Vault, type TxResult } from "../src/vault.js";
import { NETWORKS } from "../src/config.js";
import { canonical, sha256Hex, type Receipt } from "../src/receipt.js";
import { compute, PriceGap } from "../src/league/compute.js";
import { decisionMismatch } from "../src/league/collect.js";
import type { LeagueInputs, RawEvent, TokenInfo, VaultInput } from "../src/league/types.js";
import type { ChainDecision } from "../src/attest/chain.js";
import type { Candle } from "../src/strategies/market.js";

const W = "wrap.near", U = PAIRS.mainnet.quote, S = "meta-pool.near";
const DAY = 86_400_000, H = 3_600_000;
const T0 = Date.UTC(2026, 10, 1);
const E24 = 10n ** 24n;
const VAULT = "stake.arena.sledgit.near";
const flat = (n: number, p = 3): Candle[] => Array.from({ length: n }, (_, i) => [T0 + i * DAY, String(p * 1.01), String(p * 0.99), String(p)]);
const chain = { seq: 2, decisions_before: 1, requests: { buy: 1, sell: 0 }, last_request: { seq: 1, side: "buy" as const }, slot: "x",
  off_schedule: false, slot_block: { height: 1, hash: "h", time_secs: 0 } };

function input(b: number, l: number, q: number, rate = 1.5): StakedInput {
  const cap = "1000";
  return {
    vault: { base: W, quote: U, stake: S, stake_rate: String(rate), balances: { [W]: String(b), [U]: String(q), [S]: String(l) },
      policy: { tokens: [W, U, S].map((token) => ({ token, max_per_trade: cap, max_per_day: cap })) }, usage: { spent_24h: {} } },
    market: { candles: flat(60) },
    chain,
  };
}

test("staked: buys land in wNEAR, idle wNEAR is staked, a short sell unstakes first", () => {
  const reb = stakedById("stake-rebalancer")!;
  // All USDC: buy toward 50/50 (total NEAR counts staked units at the rate).
  assert.equal(decideStaked(reb, input(0, 0, 100), VAULT).action, "buy");
  // 50/50 with the NEAR side idle in wNEAR: stake it.
  const st = decideStaked(reb, input(16, 0, 50), VAULT);
  assert.deepEqual([st.action, st.amount_in], ["stake", "16"]);
  // 50/50, fully staked: nothing to do.
  assert.equal(decideStaked(reb, input(0, 11, 50), VAULT).action, "hold");
  // NEAR-heavy and all staked: unstake what the sell needs, in staking-token units.
  const un = decideStaked(reb, input(0, 40, 10), VAULT);
  assert.equal(un.action, "unstake");
  // Value 40 * 1.5 * $3 + $10 = $190; half is $95, so sell $85 of NEAR = 85 / 3 / 1.5 staked units.
  near(Number(un.amount_in), 85 / 3 / 1.5, 1e-5);
  // NEAR-heavy with enough wNEAR: sell it.
  assert.equal(decideStaked(reb, input(50, 20, 10), VAULT).action, "sell");
  // No recorded rate: hold.
  assert.equal(decideStaked(reb, { ...input(16, 0, 50), vault: { ...input(16, 0, 50).vault, stake_rate: undefined } }, VAULT).reason, "no_stake_rate");
});

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test("staked: only published rules may stake; the verifier rebuilds the same decision from the pinned pair", () => {
  const out = JSON.stringify({ action: "stake", amount_in: "1", reason: "x" });
  assert.equal(parseDecision(out).ok, false, "an LLM can't stake");
  assert.equal(parseDecision(out, { stake: true }).ok, true);
  assert.equal(expectedDecision({ model_output: out, network: "mainnet", model: { provider: "nearai-tee" } }).error, "invalid_output:bad_action");
  assert.equal(expectedDecision({ model_output: out, network: "mainnet", model: { provider: "rules" } }).action, "stake");
  // Testnet has no staking token.
  assert.equal(expectedDecision({ model_output: out, network: "testnet", model: { provider: "rules" } }).error, "invalid_output:bad_action");
  assert.deepEqual(legs(PAIRS.mainnet, "stake"), [W, S]);
  assert.deepEqual(legs(PAIRS.mainnet, "unstake"), [S, W]);
  assert.equal(legs(PAIRS.testnet, "stake"), undefined);
});

test("staked: stake and unstake requests are not buys or sells in the history a rule reads", () => {
  const d = (seq: number, token_in: string, token_out: string): ChainDecision => ({ seq, event: "request", receipt_hash: `r${seq}`, token_in, token_out, tx: "t", block_time_secs: seq });
  const hist = [d(1, U, W), d(2, W, S), d(3, S, W), d(4, W, U)];
  assert.deepEqual(summarise(hist, W, S).requests, { buy: 1, sell: 1 });
  assert.deepEqual(summarise(hist, W, S).last_request, { seq: 4, side: "sell" });
  // Without a staking token nothing changes.
  assert.deepEqual(summarise([d(1, U, W), d(4, W, U)], W).requests, { buy: 1, sell: 1 });
});

test("staked: the on-chain event must name the right direction; a sell event can't stand for a stake", async () => {
  const r = { network: "mainnet", decision: { action: "stake", amount_in: "2", reason: "x" } } as unknown as Receipt;
  const ev = (token_out: string): ChainDecision => ({ seq: 1, event: "request", receipt_hash: "h", token_in: W, token_out, amount_in: (2n * E24).toString(), tx: "t", block_time_secs: 1 });
  assert.equal((await eventMatches(r, ev(S), async () => 24)).ok, true);
  assert.equal((await eventMatches(r, ev(U), async () => 24)).ok, false);
  const raw = (token_out: string): RawEvent => ({ event: "request", data: { seq: 1, token_in: W, token_out, amount_in: (2n * E24).toString() }, tx: "t", receipt_id: "r", block_height: 1, block_time_ms: 1 });
  const tokens: TokenInfo[] = [{ id: W, symbol: "wNEAR", decimals: 24, ref: "NEAR" }, { id: U, symbol: "USDC", decimals: 6, ref: "USD" }, { id: S, symbol: "STNEAR", decimals: 24, ref: "STAKE" }];
  assert.equal(decisionMismatch(r, raw(S), tokens), null);
  assert.match(String(decisionMismatch(r, raw(U), tokens)), /buys/);
});

// ---------------------------------------------------------------- tick and houseCheck

function fakeVault(o: { w: bigint; u: bigint; s: bigint; rate: bigint }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.1.0", event, data: [data] })}`;
  const tx = (method: string, events: string[]) => async (...args: unknown[]): Promise<TxResult> => {
    calls.push({ method, args });
    const e = eventsFromLogs(events);
    return { tx: `tx-${method}`, ok: true, events: e, outcome: classify(e) };
  };
  const cap = (100n * E24).toString();
  const v = {
    id: VAULT, agentId: "agent.near", net: NETWORKS.mainnet, chainId: "mainnet",
    config: async () => ({ agent_id: "agent.near", frozen: false, seq: 1 }),
    policy: async () => ({ tokens: [{ token: W, max_per_trade: cap, max_per_day: cap }, { token: U, max_per_trade: "100000000", max_per_day: "100000000" },
      { token: S, max_per_trade: cap, max_per_day: cap }], pairs: [], max_trades_per_hour: 2, max_slippage_bps: 100 }),
    usage: async () => ({ hour: "1", trades: 0, spent: [] }),
    intents: async () => ({ open_intent: null }), inFlight: async () => null,
    decimals: async (t: string) => (t === U ? 6 : 24),
    balance: async (t: string) => (t === W ? o.w : t === U ? o.u : o.s),
    view: async (m: string, _a: unknown, c: string) => { assert.deepEqual([m, c], ["get_st_near_price", S]); return o.rate.toString(); },
    preview: async () => ({ ok: true, pool_id: 3514, band_floor: "7" }),
    logSkip: tx("log_skip", [ev("skip", { seq: 2 })]),
    requestSwap: tx("request_swap", [ev("request", { seq: 2 }), ev("trade", { amount_out: "100", venue: "rhea" })]),
  };
  return { vault: v as unknown as Vault, calls };
}

async function stakedTick(dryRun = false) {
  const s = stakedById("stake-rebalancer")!;
  // 16 wNEAR idle, 50 USDC, rate 1.5: the rule stakes the wNEAR.
  const { vault, calls } = fakeVault({ w: 16n * E24, u: 50_000_000n, s: 0n, rate: 3n * E24 / 2n });
  const dir = mkdtempSync(join(tmpdir(), "it-staked-"));
  const r = await tick({ vault, model: stakedModel(s, VAULT), prompt: stakedPrompt(s),
    price: async () => ({ source: "t", symbol: "NEARUSDT", price: "3", fetched_at: "2026-12-31T00:30:00.000Z" }),
    market: async () => ({ source: "t", interval: "1d", candles: flat(60), as_of: "x" }),
    chain: chain as never, historySize: 0, receiptsPath: join(dir, "receipts.jsonl"), outcomesPath: join(dir, "outcomes.jsonl"),
    dryRun, stake: PAIRS.mainnet.stake! });
  return { r, calls, line: readFileSync(join(dir, "receipts.jsonl"), "utf8").trim() };
}

test("staked: a tick records the staking token, its rate and balance, and sends stake as wNEAR -> stNEAR", async () => {
  const { r, calls, line } = await stakedTick();
  assert.equal(r.decision.action, "stake");
  const sent = calls.find((c) => c.method === "request_swap")!;
  assert.deepEqual(sent.args.slice(0, 3), [W, S, 16n * E24]);
  const rc = JSON.parse(line);
  assert.equal(rc.inputs.vault.stake, S);
  assert.equal(rc.inputs.vault.stake_rate, "1.5");
  assert.equal(rc.inputs.raw.stake_rate, (3n * E24 / 2n).toString());
  assert.equal(rc.inputs.raw.balances[S], "0");
  assert.equal(publishedByHash(rc.prompt_sha256)?.staked, true);
  // Offline re-run gives the same decision.
  const rows = houseRerun(line).rows;
  assert.equal(rows[0].same, true);
  assert.equal(rows[0].decision_consistent, true);
});

test("staked: house-rerun --check reads the staking rate at the decision's block and catches a forged one", async () => {
  const { line } = await stakedTick(true);
  const rc = JSON.parse(line);
  const decisions = async () => [{ seq: 1, event: "request", receipt_hash: "r1", token_in: U, token_out: W, tx: "t1", block_time_secs: 1 },
    { seq: 2, event: "request", receipt_hash: sha256Hex(line), token_in: W, token_out: S, amount_in: (16n * E24).toString(), tx: "t2", block_time_secs: 2 }] as ChainDecision[];
  // Feed: the recorded candles and a wide 1m bar. RPC: an account that isn't a genuine vault (checked separately).
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/v3/klines")) {
      const q = new URL(u).searchParams;
      if (q.get("interval") === "1m") return new Response(JSON.stringify([[Number(q.get("startTime")), "1", "100", "0.01", "2", "0"]]));
      return new Response(JSON.stringify(flat(60).map((c) => [c[0], "0", c[1], c[2], c[3], "0", c[0] + DAY - 1])));
    }
    const p = (JSON.parse(String(init?.body)) as { params: { request_type?: string } }).params;
    if (p.request_type === "view_account") return new Response(JSON.stringify({ result: { global_contract_hash: "x" } }));
    if (p.request_type === "view_access_key_list") return new Response(JSON.stringify({ result: { keys: [] } }));
    return new Response(JSON.stringify({ result: { result: [...Buffer.from("{}")] } }));
  }) as unknown as typeof fetch;
  const state = (rate: string) => async (_n: unknown, _v: unknown, tokens: string[], _h: number, st?: { token: string }) => {
    assert.deepEqual(tokens, [W, U, S]);
    assert.equal(st?.token, S);
    return { config: rc.inputs.raw.config, policy: rc.inputs.raw.policy, usage: rc.inputs.raw.usage, balances: rc.inputs.raw.balances, stake_rate: rate };
  };
  const good = (await houseCheck(line, "mainnet", { fetch: fakeFetch, decisions, stateAt: state(rc.inputs.raw.stake_rate), txBlock: async () => 9 }))[0];
  assert.equal(good.event_matches_decision, true);
  assert.equal(good.chain_state_matches, true);
  assert.equal(good.chain_inputs_match, true, "stake requests left out of the history");
  const bad = (await houseCheck(line, "mainnet", { fetch: fakeFetch, decisions, stateAt: state("1"), txBlock: async () => 9 }))[0];
  assert.equal(bad.chain_state_matches, false);
  assert.ok(bad.problems.some((p) => /staking rate/.test(p)));
  // The human rate must match the raw one in the same receipt.
  const forged = JSON.parse(line);
  forged.inputs.vault.stake_rate = "2";
  const fl = canonical(forged);
  const d2 = async () => (await decisions()).map((d) => (d.seq === 2 ? { ...d, receipt_hash: sha256Hex(fl) } : d));
  const f2 = (await houseCheck(fl, "mainnet", { fetch: fakeFetch, decisions: d2, stateAt: state(rc.inputs.raw.stake_rate), txBlock: async () => 9 }))[0];
  assert.ok(f2.problems.some((p) => /staking rate differs from the raw rate/.test(p)), f2.problems.join("; "));
});

// ---------------------------------------------------------------- league valuation

const TOKENS: TokenInfo[] = [{ id: W, symbol: "wNEAR", decimals: 24, ref: "NEAR" }, { id: U, symbol: "USDC", decimals: 6, ref: "USD" }, { id: S, symbol: "STNEAR", decimals: 24, ref: "STAKE" }];
let h = 0;
const ev = (event: string, t: number, data: Record<string, unknown>): RawEvent => ({ event, data, tx: `tx${++h}`, receipt_id: `r${String(h).padStart(5, "0")}`, block_height: h, block_time_ms: t });
const skips = (n: number, from: number, seq0: number) => Array.from({ length: n }, (_, k) => ev("skip", from + k * DAY + H, { seq: seq0 + k, receipt_hash: `s${seq0 + k}`, note: "" }));
const swap = (t: number, seq: number, tin: string, ain: bigint, tout: string, aout: bigint, pool: number) => [
  ev("request", t, { seq, receipt_hash: `q${seq}`, token_in: tin, token_out: tout, amount_in: ain.toString() }),
  ev("trade", t, { seq, receipt_hash: `q${seq}`, venue: "rhea", pool_id: pool, token_in: tin, amount_in: ain.toString(), token_out: tout, amount_out: aout.toString() }),
];

function league(events: RawEvent[], rates: [number, number, string][] | undefined, days = 10): LeagueInputs {
  const asOf = T0 + days * DAY;
  const hourly: [number, number][] = [];
  for (let t = T0 + H; t <= asOf; t += H) hourly.push([t, 3]);
  const minute: Record<string, number> = {};
  for (const t of [asOf, T0, ...events.map((e) => e.block_time_ms)]) minute[String(Math.floor(t / 60_000) * 60_000)] = 3;
  const v: VaultInput = { entry: { id: "st", account: VAULT, name: "st", kind: "house", harness: "h", model: "m", description: "", proof_claim: "rules", schedule: null },
    provenance: { sledgit_vault: true, status: "genuine", reason: "t" }, events, gas: [], proof: { tier: "rules", detail: "ok", evidence_ids: [] }, observed: {} };
  return { schema: "sledgit-league-inputs/2", network: "mainnet", as_of_ms: asOf, collected_at: "x", reference: { source: "t", symbol: "NEARUSDT", note: "" },
    tokens: TOKENS, hourly, minute, stake_apr: { value: 0.045, source: "a" }, ...(rates ? { stake_rates: { [S]: rates } } : {}),
    season: { id: "s", start_ms: T0, canonical_pools: [4512, 3514], benchmark_cost_rate: { value: 0.003, source: "f" }, min_value_usd: 1 },
    factories: [], vaults: [v], excluded: [] };
}

test("league: stNEAR is valued at its recorded redemption rate; the rate's growth is return, a stake is a swap", () => {
  // $30 of wNEAR, all staked on day 0 at rate 1.5; the rate rises 1% by day 9. NEAR stays at $3.
  const events = [ev("deposit", T0, { token: W, amount: (10n * E24).toString() }),
    ...swap(T0 + H, 1, W, 10n * E24, S, 10n * E24 * 2n / 3n, 3514), ...skips(8, T0 + DAY, 2)];
  const rates: [number, number, string][] = [[T0 - DAY, 1, (15n * E24 / 10n).toString()], [T0 + 9 * DAY, 2, (1515n * E24 / 1000n).toString()]];
  const s = compute(league(events, rates));
  const e = s.entries[0];
  assert.equal(e.decisions.find((d) => d.event === "trade")!.side, "stake");
  assert.ok(Math.abs(e.twr! - 0.01) < 1e-6, String(e.twr));
  assert.ok(Math.abs(e.costs.fill_vs_reference_usd) < 1e-6, "a fill at the rate costs nothing");
  assert.equal(e.ranked, true, e.unranked_reason ?? "");
  assert.ok(!s.flags.some((f) => f.kind === "foreign_token"));
  // Without samples the build fails closed.
  assert.throws(() => compute(league(events, undefined)), PriceGap);
});
