// The wider board's other venues: Polymarket and dYdX normalisers (fixtures trimmed from real replies), dollar scoring, the venue filter
// behind ?src=, cross-venue sorting, and the append-only history writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseSrc, scoreRecord, srcParam, type HistoryPoint, type SourceRecord, type WiderVault } from "../src/lib/wider";
import { dydxCandles, dydxRecord, pmFlows, pmLeader, pmPnlDays, pmPopulation, pmRecord, type PmLeader } from "../src/lib/wider-sources";
import { sorter } from "../src/components/wider";
import { appendSnapshot, snapshotRows } from "../scripts/wider-history";

const fx = (f: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", f), "utf8"));
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// ---------------------------------------------------------------- Polymarket

test("polymarket: leaderboard rows checked; a default profile name is not a name", () => {
  const rows = (fx("polymarket-leaderboard.json") as { data: unknown[] }).data;
  const list = rows.map(pmLeader).filter((x): x is PmLeader => x !== null);
  assert.equal(list.length, 4);
  assert.equal(list[0].name, "swisstony");
  assert.match(list[0].address, /^0x[0-9a-f]{40}$/);
  assert.equal(list[2].name, "", "0x…-timestamp is the default name");
  assert.equal(list[3].name, "ClaudeAI");
  assert.equal(pmLeader({ user_id: "0x12", pnl: 1, volume: 1 }), null);
  assert.equal(pmLeader({ user_id: "0x" + "a".repeat(40), pnl: "lots", volume: 1 }), null);
  assert.equal(pmLeader({ user_id: "0x" + "a".repeat(40), pnl: 1, volume: 1, user_name: "<img src=x onerror=alert(1)>Bob‮" })!.name, "Bob");
  const pop = pmPopulation(list);
  assert.equal(pop.listed, 4);
  assert.equal(pop.negative + pop.positive + pop.zero, 4);
});

test("polymarket: account value rebuilt from deposits plus cumulative economic PnL", () => {
  const item = pmLeader((fx("polymarket-leaderboard.json") as { data: unknown[] }).data[0])!;
  const pnl = fx("polymarket-user-pnl.json"), f = pmFlows((fx("polymarket-activity.json") as { data: unknown[] }).data);
  assert.equal(f.dropped, 0);
  assert.ok(f.flows.length > 0 && f.flows.every(([t, a], i) => Number.isFinite(t) && Number.isFinite(a) && (i === 0 || t >= f.flows[i - 1][0])));
  const rec = pmRecord(item, pnl, f, 0);
  const pts = (pnl as { data: { points: { timestamp: number; economic_pnl: number }[] } }).data.points;
  assert.equal(rec.history.length, pts.length);
  for (const [i, h] of rec.history.entries()) {
    const net = f.flows.filter(([t]) => t <= h.t).reduce((s, [, a]) => s + a, 0);
    assert.equal(h.t, pts[i].timestamp * 1000);
    close(h.pnl, pts[i].economic_pnl);
    close(h.value, net + pts[i].economic_pnl);
  }
  assert.equal(rec.kind, "trader");
  assert.equal(rec.btcBaseline, false);
  assert.equal(rec.source, "polymarket");
  assert.equal(rec.explorer, `https://polygonscan.com/address/${item.address}`);
  assert.ok(pmPnlDays(pnl) > 30);
  assert.equal(rec.basis, "usd");
  const v = scoreRecord(rec, [])!;
  assert.equal(v.vsBtc, null, "prediction markets: vs BTC is n/a");
  assert.equal(v.ret, null, "scored in dollars");
  close(v.pnlUsd, Math.round(pts[pts.length - 1].economic_pnl - pts[0].economic_pnl), 1);
});

test("polymarket: no name falls back to the pseudonym; bio is plain text and capped", () => {
  const item: PmLeader = { address: "0x" + "b".repeat(40), name: "", pnlAllTime: 0, volume: 1 };
  const pnl = { data: { points: [{ timestamp: 1, economic_pnl: 0 }, { timestamp: 86401, economic_pnl: null }, { timestamp: 172801, economic_pnl: 50 }] } };
  const f = pmFlows([{ type: "DEPOSIT", usdc_size: 5000, timestamp: 0, pseudonym: "Frail-Possible", bio: "<b>AI</b> agent " + "x".repeat(900) },
    { type: "TRADE", usdc_size: 1, timestamp: 2 }, { type: "DEPOSIT", usdc_size: -4, timestamp: 3 }]);
  assert.equal(f.dropped, 2, "non-flow rows and negative sizes dropped");
  const rec = pmRecord(item, pnl, f, null);
  assert.equal(rec.name, "Frail-Possible");
  assert.ok(rec.description.startsWith("AI agent") && rec.description.length <= 600);
  assert.equal(rec.history.length, 2, "a null PnL point is dropped, never zeroed");
  assert.equal(rec.ai.claim, true);
});

test("polymarket: account value estimate never below the open positions or zero", () => {
  const item: PmLeader = { address: "0x" + "c".repeat(40), name: "x", pnlAllTime: 0, volume: 1 };
  const pnl = { data: { points: [{ timestamp: 1, economic_pnl: 0 }, { timestamp: 2, economic_pnl: -50_000 }] } };
  // Lost 50k having deposited 10k on record: funds arrived outside the deposit feed. Scored all the same, in dollars.
  const rec = pmRecord(item, pnl, pmFlows([{ type: "DEPOSIT", usdc_size: 10_000, timestamp: 0 }]), 2_500);
  assert.equal(rec.tvl, 2_500);
  assert.equal(pmRecord(item, pnl, pmFlows([]), null).tvl, 0);
  assert.throws(() => pmRecord(item, { data: { points: [] } }, pmFlows([]), null), /fewer than 2/);
});

// ---------------------------------------------------------------- dYdX

test("dydx: MegaVault history and BTC candles normalised", () => {
  const rec = dydxRecord(fx("dydx-megavault-pnl.json"));
  assert.equal(rec.id, "dydx:megavault");
  assert.equal(rec.btcBaseline, true);
  assert.equal(rec.history.length, 7);
  assert.equal(rec.history[0].value, 1699691);
  assert.equal(rec.history[0].pnl, 4663078);
  assert.ok(rec.history.every((p, i) => i === 0 || p.t > rec.history[i - 1].t));
  assert.equal(rec.tvl, rec.history[rec.history.length - 1].value);
  assert.match(rec.explorer, /^https:\/\/www\.mintscan\.io\/dydx\/address\/dydx1[0-9a-z]+$/);
  const c = dydxCandles(fx("dydx-candles.json"));
  assert.equal(c.length, 3);
  assert.ok(c.every((k, i) => k.T - k.t === 86_400_000 && k.o > 0 && (i === 0 || k.t > c[i - 1].t)));
  assert.throws(() => dydxRecord({}), /megavaultPnl/);
  assert.deepEqual(dydxCandles({ candles: [{ startedAt: "nope", open: "1", close: "1" }] }), []);
});

// ---------------------------------------------------------------- venue filter and sorting

const VENUES = [{ id: "hyperliquid", short: "hl" }, { id: "polymarket", short: "pm" }, { id: "dydx", short: "dydx" }];

test("venue filter: ?src= parsed and written back", () => {
  assert.deepEqual(parseSrc(null, VENUES), ["hyperliquid", "polymarket", "dydx"], "absent: every venue");
  assert.deepEqual(parseSrc("hl,pm", VENUES), ["hyperliquid", "polymarket"]);
  assert.deepEqual(parseSrc("PM, dydx", VENUES), ["polymarket", "dydx"]);
  assert.deepEqual(parseSrc("polymarket", VENUES), ["polymarket"], "ids work too");
  assert.deepEqual(parseSrc("nope", VENUES), ["hyperliquid", "polymarket", "dydx"], "nothing known: every venue");
  assert.deepEqual(parseSrc("none", VENUES), []);
  assert.equal(srcParam(["hyperliquid", "polymarket", "dydx"], VENUES), null, "all on: no parameter");
  assert.equal(srcParam(["polymarket", "hyperliquid"], VENUES), "hl,pm", "venue order, short codes");
  assert.equal(srcParam([], VENUES), "none");
  for (const on of [["dydx"], ["hyperliquid", "dydx"], []]) assert.deepEqual(parseSrc(srcParam(on, VENUES), VENUES), on, "round trip");
});

test("sorting across venues: n/a vs BTC goes last both ways", () => {
  const h: HistoryPoint[] = Array.from({ length: 5 }, (_, d) => ({ t: d * 86_400_000, value: 10_000 + d * 100, pnl: d * 100 }));
  const rec = (id: string, btcBaseline: boolean, scale: number): SourceRecord => ({ id, source: id, kind: "vault", btcBaseline, basis: btcBaseline ? "return" : "usd", name: id, address: id, leader: null, description: "",
    tvl: scale, createdMs: null, commission: null, followers: null, volumeUsd: null, nTrades: null, ai: { claim: false, words: [], where: [] }, explorer: "",
    history: h.map(p => ({ ...p, pnl: p.pnl * scale, value: 10_000 + p.pnl * scale })) });
  const btc = Array.from({ length: 6 }, (_, d) => ({ t: d * 86_400_000, T: (d + 1) * 86_400_000, o: 100, c: 100 }));
  const vs = [rec("a", true, 1), rec("pm", false, 3), rec("b", true, 2)].map(r => scoreRecord(r, btc)!) as WiderVault[];
  const ids = (key: "btc" | "ret" | "pnl" | "tvl", desc: boolean) => [...vs].sort(sorter({ key, desc })).map(v => v.id);
  assert.deepEqual(ids("btc", true), ["b", "a", "pm"]);
  assert.deepEqual(ids("btc", false), ["a", "b", "pm"], "n/a last both ways");
  assert.deepEqual(ids("ret", true), ["b", "a", "pm"], "a record scored in dollars has no return: last");
  assert.deepEqual(ids("pnl", true), ["pm", "b", "a"], "PnL $ sorts every venue together");
  assert.deepEqual(ids("pnl", false), ["a", "b", "pm"]);
  assert.deepEqual(ids("tvl", false), ["a", "b", "pm"]);
});

// ---------------------------------------------------------------- history writer

test("history: one gzipped snapshot per source and day; an existing day is never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "wider-history-"));
  try {
    const recs = [dydxRecord(fx("dydx-megavault-pnl.json"))];
    const rows = snapshotRows("2026-11-04", "dydx", recs);
    assert.deepEqual(Object.keys(rows[0]), ["date", "source", "id", "value", "pnl", "tvl"]);
    assert.equal(rows[0].value, 1940209);
    const logs: string[] = [];
    const a = appendSnapshot(dir, "dydx", "2026-11-04", rows, s => logs.push(s));
    assert.equal(a.written, true);
    const back = gunzipSync(readFileSync(a.path)).toString().trim().split("\n").map(l => JSON.parse(l));
    assert.deepEqual(back, rows);
    // Second fetch the same day: skipped and logged, the first file untouched.
    const before = readFileSync(a.path);
    const b = appendSnapshot(dir, "dydx", "2026-11-04", [{ ...rows[0], value: 1 }], s => logs.push(s));
    assert.equal(b.written, false);
    assert.ok(readFileSync(a.path).equals(before));
    assert.match(logs[logs.length - 1], /already exists, not overwritten/);
    // A past day, even if its file is changed by hand, stays as it is; a new day gets its own file.
    writeFileSync(a.path, "kept");
    appendSnapshot(dir, "dydx", "2026-11-04", rows, () => {});
    assert.equal(readFileSync(a.path, "utf8"), "kept");
    assert.equal(appendSnapshot(dir, "dydx", "2026-11-05", rows, () => {}).written, true);
    assert.deepEqual(readdirSync(join(dir, "dydx")).sort(), ["2026-11-04.jsonl.gz", "2026-11-05.jsonl.gz"]);
    assert.throws(() => appendSnapshot(dir, "../x", "2026-11-04", rows, () => {}), /bad source/);
    assert.throws(() => appendSnapshot(dir, "dydx", "2026-11-04/../../x", rows, () => {}), /bad date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
