// The by-model view: family names, proof tiers kept apart, ranked-only averages, one vote per source (shared owner or
// agent), and an honest "not enough data" for tiny or unranked groups.
import { test } from "node:test";
import assert from "node:assert/strict";
import { byModel, controlAt, modelFamily } from "../src/league/bymodel.js";
import type { EntryResult, ProofTier, RawEvent, VaultInput } from "../src/league/types.js";

let h = 0;
const ev = (event: string, data: Record<string, unknown>): RawEvent =>
  ({ event, data, tx: `tx${++h}`, receipt_id: `r${h}`, block_height: h, block_time_ms: h });

function entry(id: string, model: string, tier: ProofTier, vs: number | null, ranked: boolean, kind: EntryResult["kind"] = "arena"): EntryResult {
  return {
    id, account: `${id}.arena2.irontrade.testnet`, name: id, kind, harness: "h", model, description: "", strategy_sha256: null,
    proof: { tier, detail: "", claimed: tier }, provenance: { status: "genuine", reason: "" }, season_seqs: null, events_sha256: "",
    start: null, end: null, twr: null, hold_twr: null, stake_twr: null, funded_twr: null, vs_hold: vs, vs_stake: null, vs_funded: null,
    vs_hold_after_gas: vs, range95: null, beyond_noise: null,
    costs: { traded_ref_usd: 0, fill_vs_reference_usd: 0, fill_vs_reference_pct: null, gas_near: 0, gas_usd: 0, neutralised_usd: 0,
      benchmark_rebalance_usd: 0, benchmark_cost_rate: 0, benchmark_cost_rate_source: "" },
    counts: { decisions: 3, trades: 1, skips: 2, refusals: 0, failed: 0, off_schedule: 0, missed_slots: 0 },
    inactive: false, refusals_by_code: {}, days: 8, ranked, unranked_reason: ranked ? null : "day 7", series: [], decisions: [],
  };
}
const vault = (id: string, owner: string, agent: string, extra: RawEvent[] = []): VaultInput =>
  ({ entry: { id }, events: [ev("init", { owner_id: owner, agent_id: agent }), ...extra] } as unknown as VaultInput);

test("model ids from different stacks are one family; strategies by name; unknown ids pass through", () => {
  assert.equal(modelFamily("qwen3.6:35b-a3b"), "Qwen3.6 35B");
  assert.equal(modelFamily("Qwen/Qwen3.6-35B-A3B-FP8"), "Qwen3.6 35B");
  assert.equal(modelFamily("qwen2.5:14b"), "Qwen2.5 14B");
  assert.equal(modelFamily("llama3.2:3b"), "Llama 3.2 3B");
  assert.equal(modelFamily("anthropic/claude-haiku-5-5"), "Claude Haiku 5.5");
  assert.equal(modelFamily("rules:breakout"), "Breakout 55/20");
  assert.equal(modelFamily("mystery-model"), "mystery-model");
});

test("control at the cutoff follows init, then owner_set / agent_set in block order", () => {
  const c = controlAt([ev("init", { owner_id: "o1", agent_id: "a1" }), ev("agent_set", { old: "a1", new: "a2" }), ev("owner_set", { old: "o1", new: "o2" })]);
  assert.deepEqual(c, { owner: "o2", agent: "a2" });
});

test("proof tiers are separate rows within a model", () => {
  const g = byModel([entry("a", "qwen3.6:35b-a3b", "self", 0.1, true), entry("b", "Qwen/Qwen3.6-35B-A3B-FP8", "tee", 0.2, true)],
    [vault("a", "o1", "x1"), vault("b", "o2", "x2")]);
  assert.deepEqual(g.map((x) => x.label).sort(), ["Qwen3.6 35B · attested", "Qwen3.6 35B · self-reported"]);
});

test("only ranked entries are averaged (day-7 gate first); unranked show as provisional, never scored", () => {
  const g = byModel([entry("a", "llama3.2:3b", "self", 0.1, false)], [vault("a", "o1", "x1")])[0];
  assert.equal(g.avg_vs_hold_after_gas, null);
  assert.equal(g.status, "not enough data");
  assert.equal(g.provisional_vs_hold_after_gas, 0.1);
});

test("entries sharing an owner OR an agent count once (averaged first); spread from two sources", () => {
  // a and b share an owner; c shares b's agent; d is independent. Sources: {a,b,c} and {d}.
  const rs = [entry("a", "qwen2.5:14b", "self", 0.3, true), entry("b", "qwen2.5:14b", "self", 0.0, true),
    entry("c", "qwen2.5:14b", "self", 0.3, true), entry("d", "qwen2.5:14b", "self", -0.2, true)];
  const vs = [vault("a", "o1", "x1"), vault("b", "o1", "x2"), vault("c", "o9", "x2"), vault("d", "o5", "x5")];
  const g = byModel(rs, vs)[0];
  assert.equal(g.sources, 2);
  assert.equal(g.scored_sources, 2);
  assert.equal(g.avg_vs_hold_after_gas, 0.0); // mean(mean(0.3, 0, 0.3) = 0.2, -0.2)
  assert.deepEqual(g.spread, { lo: -0.2, hi: 0.2 });
  assert.equal(g.status, "averaged");
});

test("one scored source: average shown, no spread", () => {
  const g = byModel([entry("a", "qwen3.8:27b", "self", 0.05, true)], [vault("a", "o1", "x1")])[0];
  assert.equal(g.avg_vs_hold_after_gas, 0.05);
  assert.equal(g.spread, null);
  assert.equal(g.status, "one source");
});

test("fixtures, retired and unregistered vaults are never in a model's crowd", () => {
  const g = byModel([entry("a", "llama3.2:3b", "self", 0.1, true), entry("f", "llama3.2:3b", "self", 0.9, false, "fixture"),
    entry("r", "llama3.2:3b", "self", 0.9, false, "retired")], [vault("a", "o1", "x1"), vault("f", "o2", "x2"), vault("r", "o3", "x3")]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].entries, ["a"]);
});

test("the view is deterministic: the same inputs in any order give the same rows", () => {
  const rs = [entry("a", "llama3.2:3b", "self", 0.1, true), entry("b", "qwen2.5:14b", "self", 0.2, true)];
  const vs = [vault("a", "o1", "x1"), vault("b", "o2", "x2")];
  assert.deepEqual(byModel(rs, vs), byModel([...rs].reverse(), [...vs].reverse()));
});

test("F2-02: proven tiers group by what the proof binds, not the registry text", () => {
  const tee = entry("t", "anthropic/claude-opus-5", "tee", 0.1, false);
  tee.proof.verified_model = "Qwen/Qwen3.6-35B-A3B-FP8";
  const luck = entry("l", "rules:trend", "rules", 0.1, false);
  luck.proof.verified_model = "rules:luck";
  const self = entry("s", "anthropic/claude-opus-5", "self", 0.1, false);
  self.proof.verified_model = "Qwen/Qwen3.6-35B-A3B-FP8"; // never trusted for self-reported entries
  const g = byModel([tee, luck, self], [vault("t", "o1", "a1"), vault("l", "o2", "a2"), vault("s", "o3", "a3")]);
  const labels = g.map((x) => x.label).sort();
  assert.ok(labels.includes("Qwen3.6 35B · attested"), labels.join(" | "));
  assert.ok(!labels.some((x) => x.startsWith("Claude Opus 5 · attested")), "the registry text can't name an attested group");
  assert.ok(labels.some((x) => x.includes("Luck")) && !labels.some((x) => x.startsWith("Trend")), labels.join(" | "));
  assert.ok(labels.some((x) => x.endsWith("· self-reported")), "self-reported keeps its own label, marked self-reported");
});
