// Leaderboard math on fixed inputs: returns with flows, benchmarks, costs, the 95% range, the ranking gate, determinism,
// what is never counted, and one regression test per finding of the Phase 4 review (audits/phase-4-review.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cmp, compute, PriceGap, selfConsistent } from "../src/league/compute.js";
import { checkProof, decisionMismatch, inSnapshot, parseTxs, reconcile, type CollectDeps } from "../src/league/collect.js";
import type { EntryMeta, LeagueInputs, RawEvent, Snapshot, TokenInfo, VaultInput } from "../src/league/types.js";
import { canonical, sha256Hex, type Receipt } from "../src/receipt.js";
import type { CheckRow } from "../src/strategies/rerun.js";

const H = 3_600_000, DAY = 24 * H;
const T0 = Date.UTC(2026, 9, 20, 0, 0);
const NEAR = "wrap.testnet", USD = "usdc.itachicara.testnet", FAKE = "fake.owner.testnet";
const e18 = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 18n; // 24-decimal tokens
const genuine = { sledgit_vault: true, status: "genuine" as const, reason: "test" };
const TOKENS: TokenInfo[] = [{ id: NEAR, symbol: "wNEAR", decimals: 24, ref: "NEAR" }, { id: USD, symbol: "USDC", decimals: 24, ref: "USD" }];

function entry(id: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return { id, account: `${id}.arena.irontrade.testnet`, name: id, kind: "house", harness: "h", model: "m", description: "",
    proof_claim: "rules", schedule: null, ...over };
}
let h = 0;
const ev = (event: string, t: number, data: Record<string, unknown>): RawEvent => ({ event, data, tx: `tx${++h}`, receipt_id: `r${String(h).padStart(5, "0")}`, block_height: h, block_time_ms: t });
/** n daily skips from `from`, seqs starting at `seq0`: enough in-season decisions to pass the ranking gate. */
const skips = (n: number, from: number, seq0 = 1) => Array.from({ length: n }, (_, k) => ev("skip", from + k * DAY + H, { seq: seq0 + k, receipt_hash: sha256Hex(`s${h}-${k}-${seq0}`), note: "" }));

/** Prices: 2.0 at T0 moving linearly to `end` at T0 + days (or any function); every minute key used is present. */
function inputs(vaults: VaultInput[], days: number, end: number | ((t: number) => number) = 3, startMs = T0): LeagueInputs {
  const asOf = T0 + days * DAY;
  const px = typeof end === "function" ? end : (t: number) => 2 + ((end - 2) * (t - T0)) / (asOf - T0);
  const hourly: [number, number][] = [];
  for (let t = T0 + H; t <= asOf; t += H) hourly.push([t, px(t)]);
  const minute: Record<string, number> = {};
  const times = [asOf, startMs, ...vaults.flatMap((v) => [...v.events.map((e) => e.block_time_ms), ...v.gas.map((g) => g.block_time_ms)])];
  for (const t of times) minute[String(Math.floor(t / 60_000) * 60_000)] = px(Math.floor(t / 60_000) * 60_000);
  return { schema: "sledgit-league-inputs/2", network: "testnet", as_of_ms: asOf, collected_at: "x",
    reference: { source: "test", symbol: "NEARUSDT", note: "" }, tokens: TOKENS, hourly, minute, stake_apr: { value: 0.045, source: "assumption" },
    season: { id: "t", start_ms: startMs, canonical_pools: [1103], benchmark_cost_rate: { value: 0.003, source: "fixed" }, min_value_usd: 1 },
    factories: [], vaults, excluded: [] };
}
const vault = (e: EntryMeta, events: RawEvent[], over: Partial<VaultInput> = {}): VaultInput =>
  ({ entry: e, provenance: genuine, events, gas: [], proof: { tier: e.proof_claim, detail: "ok", evidence_ids: [] }, observed: {}, ...over });
const byId = (s: Snapshot, id: string) => s.entries.find((x) => x.id === id)!;
const near = (a: number | null, b: number, tol = 1e-4) => assert.ok(a !== null && Math.abs(a - b) < tol, `${a} vs ${b}`);
const trade = (t: number, seq: number, tin: string, ain: bigint, tout: string, aout: bigint, pool = 1103) => [
  ev("request", t, { seq, receipt_hash: sha256Hex(`req${seq}${t}`), token_in: tin, amount_in: ain.toString() }),
  ev("trade", t, { seq, receipt_hash: sha256Hex(`req${seq}${t}`), venue: "rhea", pool_id: pool, token_in: tin, amount_in: ain.toString(), token_out: tout, amount_out: aout.toString() }),
];

test("league: a funded vault that never trades earns the price move; Hold 50/50 earns half, less a fixed rebalance cost", () => {
  const s = compute(inputs([vault(entry("a"), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }), ...skips(7, T0)])], 8));
  const a = byId(s, "a");
  assert.equal(a.start!.value_usd, 2);
  near(a.twr, 0.5);                    // 1 NEAR: 2 -> 3
  near(a.hold_twr, 0.25 * (1 - 0.0015) - 0.0015, 1e-3); // 50/50, $1 rebalanced at 0.3%
  assert.equal(a.costs.benchmark_cost_rate, 0.003);
  assert.equal(a.vs_funded, 0);
  assert.ok(a.stake_twr! > a.hold_twr!, "staking adds yield on the NEAR half");
  assert.equal(a.ranked, true, a.unranked_reason ?? "");
});

test("league: a fill below the reference is a cost; the benchmark pays the season's fixed rate, never the entry's", () => {
  const t = T0 + 2 * H;
  const px = 2 + (t - T0) / (8 * DAY);
  const s = compute(inputs([vault(entry("b"), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }),
    ...trade(t, 1, NEAR, e18(0.5), USD, e18(0.9 * 0.5 * px))])], 8));
  const b = byId(s, "b");
  assert.equal(b.decisions.find((x) => x.event === "trade")!.side, "sell");
  near(b.costs.fill_vs_reference_pct, 0.1);
  assert.equal(b.costs.benchmark_cost_rate, 0.003, "not the entry's 10%");
  assert.equal(b.counts.trades, 1);
  assert.equal(b.counts.decisions, 1, "the trade event belongs to the request decision, not a second decision");
});

test("league: ranking gate: under 7 days, too few decisions, fixtures, retired, unregistered and non-genuine are never ranked", () => {
  const dep = () => [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() })];
  const s = compute(inputs([
    vault(entry("young"), [...dep(), ...skips(3, T0)]),
    vault(entry("fix", { kind: "fixture" }), [...dep(), ...skips(7, T0)]),
    vault(entry("old", { kind: "retired" }), [...dep(), ...skips(7, T0)]),
    vault(entry("u-x.arena.irontrade.testnet", { kind: "unregistered" }), [...dep(), ...skips(7, T0)]),
    vault(entry("legacy"), [...dep(), ...skips(7, T0)], { provenance: { sledgit_vault: false, status: "legacy", reason: "factory holds a key" } }),
  ], 3));
  assert.match(byId(s, "young").unranked_reason!, /day 7/);
  assert.match(byId(compute(inputs([vault(entry("quiet"), [...dep(), ...skips(2, T0)])], 8)), "quiet").unranked_reason!, /ranking needs 7/);
  assert.match(byId(s, "fix").unranked_reason!, /fixture/);
  assert.match(byId(s, "old").unranked_reason!, /retired/);
  assert.match(byId(s, "u-x.arena.irontrade.testnet").unranked_reason!, /unregistered/);
  assert.match(byId(s, "legacy").unranked_reason!, /not a genuine/);
  assert.ok(s.flags.some((f) => f.ids.includes("legacy") && f.kind === "provenance"));
  assert.ok(s.entries.every((e) => !e.ranked));
});

test("league: deterministic: the same inputs, in any order, give the same derived hash and bytes; the body hashes to it", () => {
  const v = [
    vault(entry("x"), [ev("deposit", T0, { token: NEAR, amount: e18(2).toString() }), ev("skip", T0 + H, { seq: 1, receipt_hash: "b".repeat(64), note: "hold" })]),
    vault(entry("y", { kind: "arena", proof_claim: "self" }), [ev("deposit", T0 + 30 * 60_000, { token: USD, amount: e18(5).toString() })]),
  ];
  const s1 = compute(inputs(v, 8)), s2 = compute(inputs(v, 8)), s3 = compute(inputs([...v].reverse(), 8));
  assert.equal(canonical(s1), canonical(s2));
  assert.equal(s1.derived_sha256, s3.derived_sha256);
  assert.ok(selfConsistent(s1));
});

test("league: a missing reference price fails the computation instead of guessing", () => {
  const inp = inputs([vault(entry("g"), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() })])], 8);
  delete inp.minute[String(T0)];
  assert.throws(() => compute(inp), PriceGap);
});

test("league: only the vault's own succeeded receipts count, and nothing after the cutoff (counted as later)", () => {
  const vaultId = "v.arena.irontrade.testnet";
  const log = (event: string, seq: number) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.1.0", event, data: [{ seq, receipt_hash: "1".repeat(64) }] })}`;
  const rec = (executor: string, t: number, logs: string[], status: unknown = { SuccessValue: "" }) =>
    ({ execution_outcome: { id: `id${t}${executor}`, block_height: t, block_timestamp: t * 1e6, outcome: { executor_id: executor, logs, status, tokens_burnt: "1000" } } });
  const { events, gas, later } = parseTxs(vaultId, [
    { transaction: { hash: "t1" }, receipts: [rec(vaultId, 1000, [log("skip", 1)])] },
    { transaction: { hash: "t2" }, receipts: [rec("evil.testnet", 2000, [log("skip", 2)])] },                 // another contract
    { transaction: { hash: "t3" }, receipts: [rec(vaultId, 3000, [log("skip", 3)], { Failure: {} })] },     // failed receipt
    { transaction: { hash: "t4" }, receipts: [rec(vaultId, 9000, [log("skip", 4)])] },                      // after the cutoff
  ], 5000);
  assert.deepEqual(events.map((e) => e.data.seq), [1]);
  assert.deepEqual(gas.map((g) => g.tx), ["t1"]);
  assert.equal(later, 1);
});

test("league: decisions carry on_schedule; only the first in a slot counts; missed slots are counted", () => {
  const sched = { every_s: 3600, offset_s: 0, window_s: 1800, since_ms: 0 };
  const s = compute(inputs([vault(entry("w", { schedule: sched }), [
    ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }),
    ev("skip", T0 + H + 60_000, { seq: 1, receipt_hash: "1".repeat(64), note: "" }),
    ev("skip", T0 + H + 120_000, { seq: 2, receipt_hash: "2".repeat(64), note: "" }), // same slot again: off
  ])], 1));
  const w = byId(s, "w");
  assert.deepEqual(w.decisions.filter((d) => d.event === "skip").sort((a, b) => a.seq - b.seq).map((d) => d.on_schedule), [true, false]);
  assert.equal(w.counts.off_schedule, 1);
  assert.equal(w.counts.missed_slots, 23, "24 closed slots in the day, 1 used");
});

// --- Phase 4 review regressions --------------------------------------------------------------------------------------

test("P4-1: a full withdrawal keeps the season's loss on the record (no reset), and the entry is inactive", () => {
  const price = (t: number) => (t < T0 + 4 * DAY ? 2 : 1); // NEAR halves on day 4
  const base = () => [ev("deposit", T0, { token: NEAR, amount: e18(500).toString() }), ...skips(7, T0)];
  near(byId(compute(inputs([vault(entry("x"), base())], 8, price)), "x").twr, -0.5);
  const all = byId(compute(inputs([vault(entry("x"), [...base(), ev("withdraw", T0 + 6 * DAY, { token: NEAR, amount: e18(500).toString() })])], 8, price)), "x");
  near(all.twr, -0.5);
  assert.equal(all.inactive, true);
  assert.equal(all.ranked, false);
  const dust = byId(compute(inputs([vault(entry("x"), [...base(), ev("withdraw", T0 + 6 * DAY, { token: NEAR, amount: (e18(500) - 1n).toString() })])], 8, price)), "x");
  near(dust.twr, -0.5);
  assert.equal(dust.inactive, true);
});

test("P4-2: a fill far better than the reference is neutralised as owner money; an off-season pool unranks", () => {
  const s = compute(inputs([vault(entry("pool"), [ev("deposit", T0, { token: USD, amount: e18(1000).toString() }), ...trade(T0 + H, 1, USD, e18(100), NEAR, e18(500)),
    ...skips(7, T0 + H, 2)])], 8, () => 2));
  const p = byId(s, "pool");
  assert.ok(p.twr! <= 0.0021, `twr ${p.twr}: at most the 2% tolerance on $100`);
  assert.ok(p.costs.neutralised_usd > 800);
  assert.ok(s.flags.some((f) => f.kind === "fill_above_reference" && f.ids.includes("pool")));
  const off = compute(inputs([vault(entry("pool"), [ev("deposit", T0, { token: USD, amount: e18(1000).toString() }), ...trade(T0 + H, 1, USD, e18(100), NEAR, e18(50), 9999),
    ...skips(7, T0 + H, 2)])], 8, () => 2));
  assert.ok(off.flags.some((f) => f.kind === "non_canonical_pool"));
  assert.equal(byId(off, "pool").ranked, false);
});

test("P4-3: one tiny bad fill can't tax the benchmark: Hold pays the fixed rate on its own rebalance", () => {
  const s = compute(inputs([vault(entry("tax", { kind: "arena", proof_claim: "self" }), [ev("deposit", T0, { token: USD, amount: e18(1000).toString() }),
    ...trade(T0 + H, 1, USD, e18(1), NEAR, e18(0.005)), ...skips(7, T0 + H, 2)])], 8, () => 2));
  const t = byId(s, "tax");
  near(t.hold_twr, -0.0015, 1e-6);                     // $500 rebalanced at 0.3% on $1000
  assert.ok(Math.abs(t.vs_hold_after_gas!) < 0.002, `vs_hold ${t.vs_hold_after_gas} (was +97.8%)`);
});

test("P4-4: a token outside the league's set is never profit, and unranks the entry", () => {
  const s = compute(inputs([vault(entry("fake"), [ev("deposit", T0, { token: USD, amount: e18(1000).toString() }), ev("deposit", T0 + H, { token: FAKE, amount: "1000000" }),
    ev("request", T0 + 2 * H, { seq: 1, receipt_hash: "c".repeat(64), token_in: FAKE, amount_in: "1000000" }),
    ev("trade", T0 + 2 * H, { seq: 1, receipt_hash: "c".repeat(64), venue: "rhea", pool_id: 1103, token_in: FAKE, amount_in: "1000000", token_out: NEAR, amount_out: e18(500).toString() }),
    ...skips(7, T0 + 2 * H, 2)])], 8, () => 2));
  near(byId(s, "fake").twr, 0, 1e-9);
  assert.ok(s.flags.some((f) => f.kind === "foreign_token" && f.ids.includes("fake")));
  assert.equal(byId(s, "fake").ranked, false);
});

test("P4-5: an edited snapshot body with the old hash field is caught", () => {
  const s = compute(inputs([vault(entry("a"), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }), ...skips(7, T0)])], 8));
  assert.ok(selfConsistent(s));
  const t = JSON.parse(JSON.stringify(s)) as Snapshot;
  t.entries[0].twr = 9.99;
  assert.equal(selfConsistent(t), false);
});

const deps = (over: Partial<CollectDeps> = {}): CollectDeps => ({ fetch, sleep: async () => {}, log: () => {},
  teeSeason: async () => ({ pill: true, detail: "mock", vault: "qwen36-tee.arena.irontrade.testnet" }),
  rulesCheck: async (text) => text.split("\n").filter(Boolean).map((l): CheckRow => ({ receipt: sha256Hex(l), strategy: "x", hash_match: true, same: true, problems: [], pass: true })),
  ...over });
const ctx = { net: "testnet" as const, seasonStartMs: 0, tokens: TOKENS };
/** The on-chain event a receipt line's decision corresponds to. */
function eventFor(line: string, seq: number): RawEvent {
  const r = JSON.parse(line) as Receipt;
  const d = r.decision as unknown as { action: string; amount_in: string };
  if (d.action === "hold") return ev("skip", T0 + seq * H, { seq, receipt_hash: sha256Hex(line) });
  const [w, f = ""] = d.amount_in.split(".");
  return ev("request", T0 + seq * H, { seq, receipt_hash: sha256Hex(line), token_in: d.action === "buy" ? USD : NEAR,
    amount_in: (BigInt(w) * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24))).toString() });
}
const repoFile = (p: string) => new URL(`../../${p}`, import.meta.url);

test("P4-6: the TEE tier is bound to the entry: receipt-less decisions or another vault's receipts never earn it", async () => {
  const { readFileSync } = await import("node:fs");
  const dir = repoFile("deploy/testnet/league/").pathname;
  const q = readFileSync(repoFile("deploy/testnet/receipts-arena/qwen36-tee/receipts.jsonl"), "utf8").split("\n").filter(Boolean);
  const cat = entry("teecat", { kind: "arena", proof_claim: "tee", receipts: "../receipts-arena/qwen36-tee" });
  const withExtra = [eventFor(q[q.length - 1], 1), ...Array.from({ length: 50 }, (_, i) => ev("request", T0 + (i + 2) * H, { seq: i + 2, receipt_hash: "ab".repeat(32) }))];
  const a = await checkProof(cat, dir, withExtra, ctx, deps());
  assert.equal(a.tier, "self", a.detail);
  assert.match(a.detail, /no receipt/);
  const b = await checkProof(cat, dir, [eventFor(q[q.length - 1], 1)], ctx, deps());
  assert.equal(b.tier, "self", b.detail);
  assert.match(b.detail, /belongs to qwen36-tee/);
});

test("P4-7: the rules tier needs this vault's own receipts deciding exactly what the vault recorded", async () => {
  const { readFileSync } = await import("node:fs");
  const dir = repoFile("deploy/testnet/league/").pathname;
  const lines = readFileSync(repoFile("deploy/testnet/receipts-house/trend/receipts.jsonl"), "utf8").split("\n").filter(Boolean);
  const own = lines.map((l, i) => eventFor(l, i + 1));
  const trend = entry("tn-house-trend", { account: "house-trend.arena.irontrade.testnet", receipts: "../receipts-house/trend" });
  // Copy-trader: another account posts 999-unit requests citing trend's "hold" receipts.
  const copy = lines.map((l, i) => ev("request", T0 + (i + 1) * H, { seq: i + 1, receipt_hash: sha256Hex(l), token_in: USD, amount_in: "999" }));
  assert.equal((await checkProof(entry("copycat", { kind: "arena", receipts: "../receipts-house/trend" }), dir, copy, ctx, deps())).tier, "self");
  // The real vault, with matching events: rules (the mocked house check passes every row).
  const t = await checkProof(trend, dir, own, ctx, deps());
  assert.equal(t.tier, "rules", t.detail);
  // Same vault, but one on-chain decision differs from its receipt: self.
  const bent = own.map((e, i) => (i === 0 ? { ...e, event: "request", data: { ...e.data, token_in: USD, amount_in: "999" } } : e));
  assert.equal((await checkProof(trend, dir, bent, ctx, deps())).tier, "self");
  // A failing house check (feed or chain mismatch) loses the tier.
  const f = await checkProof(trend, dir, own, ctx, deps({ rulesCheck: async (text) => text.split("\n").filter(Boolean)
    .map((l) => ({ receipt: sha256Hex(l), strategy: "x", hash_match: true, same: true, problems: ["candle 0 differs from the feed"], pass: false })) }));
  assert.equal(f.tier, "self", f.detail);
});

test("P4-7: decisionMismatch maps hold to skip and buy/sell to the same token and raw amount", () => {
  const r = (action: string, amount_in: string) => ({ decision: { action, amount_in, reason: "" } }) as unknown as Receipt;
  assert.equal(decisionMismatch(r("hold", "0"), ev("skip", 0, { seq: 1 }), TOKENS), null);
  assert.equal(decisionMismatch(r("sell", "0.5"), ev("request", 0, { seq: 1, token_in: NEAR, amount_in: e18(0.5).toString() }), TOKENS), null);
  assert.notEqual(decisionMismatch(r("sell", "0.5"), ev("request", 0, { seq: 1, token_in: NEAR, amount_in: e18(0.6).toString() }), TOKENS), null);
  assert.notEqual(decisionMismatch(r("buy", "1"), ev("request", 0, { seq: 1, token_in: NEAR, amount_in: e18(1).toString() }), TOKENS), null);
  assert.notEqual(decisionMismatch(r("hold", "0"), ev("request", 0, { seq: 1, token_in: NEAR, amount_in: "1" }), TOKENS), null);
});

test("P4-9: the season start is the league's, not the entry's: an entry can't restart after a loss", () => {
  const price = (t: number) => (t < T0 + 2 * DAY ? 2 : t < T0 + 3 * DAY ? 1 : 2);
  const evs = () => [ev("deposit", T0, { token: NEAR, amount: e18(500).toString() }), ...skips(7, T0, 1)];
  const a = byId(compute(inputs([vault(entry("s"), evs())], 11, price)), "s");
  const b = byId(compute(inputs([vault({ ...entry("s"), season_from_seq: 3 } as unknown as EntryMeta, evs())], 11, price)), "s");
  assert.equal(a.twr, b.twr, "a per-entry start has no effect");
});

test("P4-10: dust ages nothing: the ranking clock starts when the vault first holds the minimum", () => {
  const s = compute(inputs([vault(entry("dust"), [ev("deposit", T0, { token: USD, amount: e18(0.01).toString() }), ...skips(7, T0),
    ev("deposit", T0 + 8 * DAY - H, { token: USD, amount: e18(1000).toString() })])], 8, () => 2));
  const d = byId(s, "dust");
  assert.equal(d.ranked, false);
  assert.match(d.unranked_reason!, /days at the minimum value/);
});

test("P4-11: a duplicate receipt unranks every vault involved, and the flag names each of them", () => {
  const rh = "c".repeat(64);
  const mk = (id: string) => vault(entry(id), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }), ev("skip", T0 + H, { seq: 1, receipt_hash: rh, note: "" }), ...skips(7, T0 + DAY, 2)],
    { proof: { tier: "self", detail: "", evidence_ids: ["chat:abc"] } });
  const s = compute(inputs([mk("p"), mk("q")], 9));
  assert.deepEqual(s.flags.find((x) => x.kind === "duplicate_receipt")!.ids, ["p", "q"]);
  assert.ok(s.flags.some((x) => x.kind === "evidence_reuse" && x.ids.length === 2));
  assert.equal(byId(s, "p").ranked, false);
  assert.equal(byId(s, "q").ranked, false);
});

test("P4-12: a gap in the decision seqs, or an unresolved intent, unranks the entry", () => {
  const s = compute(inputs([vault(entry("gap"), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }), ...skips(3, T0, 1), ...skips(5, T0 + 3 * DAY, 5)])], 9));
  assert.ok(s.flags.some((f) => f.kind === "seq_gap" && f.ids.includes("gap")));
  assert.equal(byId(s, "gap").ranked, false);
  const u = compute(inputs([vault(entry("ui"), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }), ...skips(8, T0), ev("intent_unresolved", T0 + 2 * H, { seq: 1 })])], 9));
  assert.ok(u.flags.some((f) => f.kind === "intent_unresolved"));
  assert.equal(byId(u, "ui").ranked, false);
});

test("P4-13: an incomplete record is unranked with a reason, not a failed build", () => {
  const s = compute(inputs([vault(entry("big"), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }), ...skips(7, T0)], { incomplete: "more than 100 pages of transactions" })], 8));
  assert.equal(byId(s, "big").ranked, false);
  assert.match(byId(s, "big").unranked_reason!, /incomplete/);
});

test("P4-14: two entries with one id fail the computation", () => {
  const dep = [ev("deposit", T0, { token: USD, amount: e18(10).toString() })];
  assert.throws(() => compute(inputs([vault(entry("tn-house-trend"), dep), vault(entry("tn-house-trend", { kind: "unregistered" }), dep)], 8)), /twice/);
});

test("P4-15: the 95% range needs 24 quiet hourly steps, uses Student-t, and is asymmetric", () => {
  const zig = (t: number) => 2 + ((t / H) % 2) * 0.1;
  assert.equal(byId(compute(inputs([vault(entry("c"), [ev("deposit", T0, { token: NEAR, amount: e18(500).toString() })])], 3 / 24, zig)), "c").range95, null);
  const long = byId(compute(inputs([vault(entry("c"), [ev("deposit", T0, { token: NEAR, amount: e18(500).toString() })])], 3, zig)), "c");
  assert.ok(long.range95 && long.range95.n >= 24 && long.range95.lo < long.vs_hold! && long.range95.hi > long.vs_hold!, JSON.stringify(long.range95));
  assert.notEqual(Math.abs(long.range95.hi - long.vs_hold!).toFixed(8), Math.abs(long.vs_hold! - long.range95.lo).toFixed(8), "asymmetric");
});

test("P4-16: a malformed amount fails the computation instead of counting as 0", () => {
  assert.throws(() => compute(inputs([vault(entry("m"), [ev("deposit", T0, { token: NEAR, amount: "1e24" })])], 8)), /malformed amount/);
});

test("P4-17: ordering is by code point, independent of the locale", () => {
  assert.ok(cmp("z", "t") > 0 && cmp("T", "t") < 0 && cmp("a", "a") === 0);
});

test("league: the committed testnet snapshot is exactly what its committed inputs compute, and hashes to itself", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = repoFile("deploy/testnet/league/");
  const inp = JSON.parse(readFileSync(new URL("inputs.json", dir), "utf8")) as LeagueInputs;
  const committed = JSON.parse(readFileSync(new URL("snapshot.json", dir), "utf8")) as Snapshot;
  const s = compute(inp);
  assert.equal(s.derived_sha256, committed.derived_sha256);
  assert.equal(s.inputs_sha256, committed.inputs_sha256);
  assert.ok(selfConsistent(committed), "the committed body hashes to its derived_sha256");
  // Every agent file belongs to this snapshot and carries exactly the events its entry was computed from.
  for (const f of readdirSync(new URL("agents/", dir)).filter((x) => x.endsWith(".json"))) {
    const a = JSON.parse(readFileSync(new URL(`agents/${f}`, dir), "utf8")) as { derived_sha256: string; entry: { id: string; events_sha256: string }; events: unknown[] };
    assert.equal(a.derived_sha256, committed.derived_sha256, f);
    assert.equal(canonical(a.entry), canonical(committed.entries.find((e) => e.id === a.entry.id)), f);
    assert.equal(sha256Hex(canonical(a.events)), a.entry.events_sha256, f);
  }
});

test("round-3 events: an owner recovery from the exchange unranks the entry (the replay can't value it)", () => {
  const s = compute(inputs([vault(entry("rc"), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }), ...skips(8, T0),
    ev("exchange_lostfound_claim", T0 + 2 * H, { token: NEAR, amount: "5", to: "rc" })])], 9));
  assert.ok(s.flags.some((f) => f.kind === "exchange_recovery" && f.ids.includes("rc")));
  assert.equal(byId(s, "rc").ranked, false);
});

test("F2-05: a vault created after the cutoff (no event before it) can't join or change a past snapshot", () => {
  assert.equal(inSnapshot("unregistered", 0, undefined), false, "post-cutoff stranger vault is left out");
  assert.equal(inSnapshot("unregistered", 3, undefined), true, "an unregistered vault with history is listed apart");
  assert.equal(inSnapshot("unregistered", 0, "page cap"), true, "an unreadable record is shown as incomplete, not hidden");
  assert.equal(inSnapshot(undefined, 0, undefined), true, "registered entries always stay");
  assert.equal(inSnapshot("fixture", 0, undefined), true);
});

test("F2-02: a registry label that disagrees with what the proof binds unranks the entry, with a flag", () => {
  const dep = () => [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() })];
  const e = entry("liar", { model: "anthropic/claude-opus-5", proof_claim: "tee" });
  const v = vault(e, [...dep(), ...skips(8, T0)], { proof: { tier: "tee", detail: "ok", evidence_ids: [], verified_model: "Qwen/Qwen3.6-35B-A3B-FP8" } });
  const ok = entry("honest", { model: "qwen3.6:35b-a3b", proof_claim: "tee" });
  const w = vault(ok, [...dep(), ...skips(8, T0)], { proof: { tier: "tee", detail: "ok", evidence_ids: [], verified_model: "Qwen/Qwen3.6-35B-A3B-FP8" } });
  const s = compute(inputs([v, w], 9));
  assert.match(byId(s, "liar").unranked_reason ?? "", /label_mismatch/);
  assert.ok(s.flags.some((f) => f.kind === "label_mismatch" && f.ids.includes("liar")));
  assert.ok(!s.flags.some((f) => f.kind === "label_mismatch" && f.ids.includes("honest")));
});

// ---------------------------------------------------------------- untracked funds and reconciliation (review H-1, M-2, L-2)

/** 10 USDC deposited with an event, 1000 USDC sent by plain ft_transfer (no event), then traded: the replay goes negative. */
function leveraged(id: string) {
  const t = T0 + 2 * H, px = 2 + (t - T0) / (8 * DAY);
  return vault(entry(id), [ev("deposit", T0, { token: USD, amount: e18(10).toString() }),
    ...trade(t, 1, USD, e18(1000), NEAR, e18(1000 / px)), ...skips(7, T0 + DAY, 2)]);
}

test("H-1: trading tokens no deposit recorded drives the replay below zero: unranked, flagged, no return shown", () => {
  const s = compute(inputs([leveraged("lev"), vault(entry("ok"), [ev("deposit", T0, { token: NEAR, amount: e18(1).toString() }), ...skips(7, T0)])], 8));
  const x = byId(s, "lev");
  assert.equal(x.ranked, false);
  assert.match(x.unranked_reason ?? "", /negative_holding/);
  assert.equal(x.twr, null, "a leveraged replay's return is never shown");
  assert.equal(x.vs_hold_after_gas, null);
  assert.ok(s.flags.some((f) => f.kind === "negative_holding" && f.severity === "unrank" && f.ids.includes("lev") && /USDC/.test(f.text)));
  assert.equal(byId(s, "ok").ranked, true, "other entries are unaffected");
});

test("H-1: a replay that dips below zero and recovers is still flagged", () => {
  const v = vault(entry("dip"), [ev("deposit", T0, { token: NEAR, amount: e18(10).toString() }),
    ev("withdraw", T0 + H, { token: NEAR, amount: e18(20).toString() }), ev("deposit", T0 + 2 * H, { token: NEAR, amount: e18(20).toString() }), ...skips(7, T0)]);
  assert.equal(byId(compute(inputs([v], 8)), "dip").ranked, false);
});

const rx = (event: string, t: number, data: Record<string, unknown>) => ev(event, t, data);
const bal = (usd: bigint, near: bigint = 0n) => [{ token: NEAR, wallet: near.toString(), exchange: "0", intents: "0" }, { token: USD, wallet: usd.toString(), exchange: "0", intents: "0" }];

test("H-1: reconciliation replays events after the cutoff too, so later activity never skips it", () => {
  const before = [rx("deposit", T0, { token: USD, amount: "100" })];
  // Frequent skips (and a trade) after the cutoff: the check still runs over everything collected.
  const after = [rx("skip", T0 + DAY, { seq: 1 }), rx("trade", T0 + DAY, { seq: 2, token_in: USD, amount_in: "40", token_out: NEAR, amount_out: "7" }), rx("skip", T0 + 2 * DAY, { seq: 3 })];
  assert.deepEqual(reconcile(before, after, bal(60n, 7n)).result, { surplus: {}, deficit: {} });
  const extra = reconcile(before, after, bal(1060n, 7n));
  assert.deepEqual(extra.result, { surplus: { [USD]: "1000" }, deficit: {} });
  assert.equal(extra.observed.status, "untracked");
  assert.deepEqual(reconcile(before, after, bal(50n, 7n)).result, { surplus: {}, deficit: { [USD]: "10" } });
  // A capped deposit counts only what it accepted; deposit_refused and native NEAR withdrawals move no league token.
  const capped = [rx("deposit", T0, { token: USD, amount: "100", returned: "5", code: "deposit_cap" }), rx("deposit_refused", T0 + H, { token: USD, amount: "9", code: "deposit_cap" }),
    rx("withdraw", T0 + 2 * H, { token: "near", amount: "1000000", to: "o" })];
  assert.deepEqual(reconcile(capped, [], bal(100n)).result, { surplus: {}, deficit: {} });
});

test("H-1: parseTxs keeps the events after the cutoff apart, for the reconciliation only", () => {
  const vaultId = "v.arena.sledgit.testnet";
  const log = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.2.0", event, data: [data] })}`;
  const rec = (t: number, logs: string[]) => ({ execution_outcome: { id: `id${t}`, block_height: t, block_timestamp: t * 1e6, outcome: { executor_id: vaultId, logs, status: { SuccessValue: "" }, tokens_burnt: "0" } } });
  const p = parseTxs(vaultId, [
    { transaction: { hash: "t1" }, receipts: [rec(1000, [log("deposit", { token: USD, amount: "100" })])] },
    { transaction: { hash: "t2" }, receipts: [rec(9000, [log("withdraw", { token: USD, amount: "30", to: "o" })])] },
  ], 5000);
  assert.deepEqual(p.events.map((e) => e.event), ["deposit"]);
  assert.deepEqual(p.after.map((e) => e.event), ["withdraw"]);
  assert.equal(p.later, 1);
  assert.deepEqual(reconcile(p.events, p.after, bal(70n)).result, { surplus: {}, deficit: {} });
});

test("M-2: a balance difference unranks only that entry, with a flag in the snapshot; the rest still compute", () => {
  const dep = (id: string, rc?: VaultInput["reconciliation"]) =>
    vault(entry(id), [ev("deposit", T0, { token: NEAR, amount: e18(500).toString() }), ...skips(7, T0)], rc ? { reconciliation: rc } : {});
  const s = compute(inputs([
    dep("clean", { surplus: {}, deficit: {} }),
    dep("gift", { surplus: { [USD]: e18(200).toString() }, deficit: {} }),   // $200 on a ~$1500 vault: untracked funds
    dep("dust", { surplus: { [USD]: "1", [NEAR]: "1" }, deficit: {} }),       // 1 raw unit each, sent by anyone
    dep("short", { surplus: {}, deficit: { [NEAR]: "1" } }),
    dep("blind", { error: "vault config not readable" }),
    dep("legacy"),                                                           // inputs from before the reconciliation
  ], 8));
  const kinds = (id: string) => s.flags.filter((f) => f.ids.includes(id)).map((f) => `${f.kind}:${f.severity}`);
  assert.equal(byId(s, "clean").ranked, true);
  assert.equal(byId(s, "legacy").ranked, true);
  assert.equal(byId(s, "dust").ranked, true, byId(s, "dust").unranked_reason ?? "");
  assert.deepEqual(kinds("dust"), ["untracked_dust:info"]);
  // A gift can't unrank anyone (strangers can send tokens); it's shown as info.
  assert.equal(byId(s, "gift").ranked, true, byId(s, "gift").unranked_reason ?? "");
  assert.deepEqual(kinds("gift"), ["untracked_funds:info"]);
  assert.equal(byId(s, "short").ranked, false);
  assert.deepEqual(kinds("short"), ["balance_mismatch:unrank"]);
  assert.equal(byId(s, "blind").ranked, false);
  assert.deepEqual(kinds("blind"), ["unreconciled:unrank"]);
  assert.ok(byId(s, "gift").twr !== null, "a surplus is not valued, so the replayed return is still shown");
  assert.ok(selfConsistent(s));
});

test("L-2: withdraw_near (token \"near\") is native NEAR leaving, not a foreign token, and not a holding", () => {
  const base = () => [ev("deposit", T0, { token: NEAR, amount: e18(500).toString() }), ...skips(7, T0)];
  const a = byId(compute(inputs([vault(entry("n"), base())], 8)), "n");
  const s = compute(inputs([vault(entry("n"), [...base(), ev("withdraw", T0 + 3 * DAY, { token: "near", amount: e18(2).toString(), to: "owner" })])], 8));
  const b = byId(s, "n");
  assert.equal(b.ranked, true, b.unranked_reason ?? "");
  assert.ok(!s.flags.some((f) => f.kind === "foreign_token" || f.kind === "negative_holding"));
  assert.equal(b.twr, a.twr, "native NEAR is not a league holding");
  // Another unknown token withdrawn is still foreign.
  const f = compute(inputs([vault(entry("n"), [...base(), ev("withdraw", T0 + 3 * DAY, { token: FAKE, amount: "1", to: "owner" })])], 8));
  assert.ok(f.flags.some((x) => x.kind === "foreign_token"));
});
