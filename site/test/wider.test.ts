// The wider board: returns from PnL (flows never count), skipped intervals, baselines, the 95% range and the AI-claim rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aiClaim, chainReturns, DAY, thin, hlListItem, hlRecord, maxDrawdown, plainText, population, priceAt, range95, scoreRecord, type Candle, type HistoryPoint } from "../src/lib/wider";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const pt = (d: number, value: number, pnl: number): HistoryPoint => ({ t: d * DAY, value, pnl });
const last = (h: HistoryPoint[]) => { const p = chainReturns(h).points; return p[p.length - 1][1]; };

test("returns: +10% then +10% chains to +21%", () => {
  close(last([pt(0, 10000, 0), pt(1, 11000, 1000), pt(2, 12100, 2100)]), 0.21);
});

test("returns: a deposit is not return", () => {
  // +10% on 1000, then 5000 deposited with no trading gain: still +10%.
  const r = chainReturns([pt(0, 10000, 0), pt(1, 11000, 1000), pt(2, 61000, 1000), pt(3, 61000, 1000)]);
  close(r.points[r.points.length - 1][1], 0.1);
  assert.equal(r.skipped, 0);
});

test("returns: a withdrawal is not a loss", () => {
  close(last([pt(0, 20000, 0), pt(1, 5000, 0), pt(2, 5500, 500)]), 0.1);
});

test("returns: a deposit inside an interval enlarges the base (Modified Dietz), not the return", () => {
  // 2000 at the start, 100000 deposited, 5050 gained: base 2000 + 100000/2 = 52000, r = 5050/52000.
  close(last([pt(0, 2000, 0), pt(1, 107050, 5050)]), 5050 / 52000);
  // ΔPnL / V_prev alone would say +252%.
});

test("returns: zero-capital intervals are skipped and counted; leading empty points are not part of the record", () => {
  const r = chainReturns([pt(0, 0, 0), pt(1, 10000, 0), pt(2, 11000, 1000), pt(3, 0, 1000), pt(4, 0, 1000), pt(5, 20000, 1000), pt(6, 22000, 3000)]);
  assert.equal(r.points[0][0], DAY, "starts at the first funded point");
  // 1→2: +10%. 2→3: 1100 withdrawn, fine (r=0). 3→4 and 4→5 start at 0: skipped. 5→6: +10%.
  assert.equal(r.skipped, 2);
  close(r.points[r.points.length - 1][1], 0.21);
  assert.equal(r.steps.length, 3);
});

test("returns: never funded means no record; bad numbers are dropped", () => {
  assert.equal(chainReturns([pt(0, 0, 0), pt(1, 500, 1)]).points.length, 0);
  close(last([pt(0, 10000, 0), { t: DAY, value: NaN, pnl: 5 }, pt(2, 11000, 1000)]), 0.1);
});

test("returns: a loss larger than the base is a hidden flow: skipped and counted, not a wipeout", () => {
  const r = chainReturns([pt(0, 10000, 0), pt(1, 10, -50000), pt(2, 10000, -50000), pt(3, 11000, -49000)]);
  assert.equal(r.skipped, 2);
  close(r.points[r.points.length - 1][1], 0.1);
  close(last([pt(0, 10000, 0), pt(1, 0, -10000)]), -1, 1e-9);
});

test("maxDrawdown: from the running peak", () => {
  close(maxDrawdown([0, 0.2, -0.04, 0.1]), 0.96 / 1.2 - 1);
  assert.equal(maxDrawdown([0, 0.1, 0.2]), 0);
});

test("priceAt: inside a candle, after the last, before the first", () => {
  const c: Candle[] = [{ t: 0, T: DAY, o: 100, c: 110 }, { t: DAY, T: 2 * DAY, o: 110, c: 90 }];
  assert.equal(priceAt(c, DAY / 2), 105);
  assert.equal(priceAt(c, DAY), 110);
  assert.equal(priceAt(c, 5 * DAY), 90);
  assert.equal(priceAt(c, -1), null);
});

test("range95: null below 24 steps; brackets the total otherwise", () => {
  assert.equal(range95(Array(23).fill(0.01), 0.25), null);
  const ex = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.02 : -0.01));
  const r = range95(ex, Math.exp(ex.reduce((a, b) => a + b, 0)) - 1)!;
  assert.equal(r.n, 40);
  assert.ok(r.lo < 0.2 && r.hi > 0.2 && r.lo > -1);
});

test("scoreRecord: vs BTC over the same window, ranking needs 30 days", () => {
  const btc: Candle[] = Array.from({ length: 60 }, (_, d) => ({ t: d * DAY, T: (d + 1) * DAY, o: 100 + d, c: 101 + d }));
  const h = Array.from({ length: 41 }, (_, d) => pt(d, 10000 * 1.001 ** d, 10000 * 1.001 ** d - 10000));
  const base = { id: "x", source: "test", kind: "vault" as const, btcBaseline: true, basis: "return" as const, name: "x", address: "0x", leader: null, description: "", tvl: 1, createdMs: null, commission: null, followers: null,
    volumeUsd: null, nTrades: null, ai: aiClaim("x"), explorer: "" };
  const v = scoreRecord({ ...base, history: h }, btc)!;
  close(v.ret!, 1.001 ** 40 - 1, 1e-6);
  assert.equal(v.pnlUsd, Math.round(10000 * 1.001 ** 40 - 10000));
  close(v.btc!, 140 / 100 - 1, 1e-6);
  close(v.vsBtc!, (1 + v.ret!) / 1.4 - 1, 1e-5);
  assert.equal(v.ranked, true);
  assert.ok(v.range.usdc && v.range.usdc.lo > 0, "a steady gain is beyond noise");
  const short = scoreRecord({ ...base, history: h.slice(0, 20) }, btc)!;
  assert.equal(short.ranked, false);
  assert.match(short.unranked_reason!, /ranking needs 30/);
  assert.equal(short.range.usdc, null, "19 intervals: not enough data");
  const noBtc = scoreRecord({ ...base, btcBaseline: false, history: h }, btc)!;
  assert.equal(noBtc.vsBtc, null, "no BTC baseline: vs BTC is not computed");
  assert.equal(noBtc.range.btc, null);
  assert.ok(noBtc.series.every(p => p[2] === null));
  close(noBtc.ret!, v.ret!);
  // Scored in dollars: PnL against $0, drawdown and range in dollars, no return.
  const pnl = [0, 500, 200, 900, ...Array.from({ length: 36 }, (_, i) => 900 + 50 * (i + 1))];
  const usd = scoreRecord({ ...base, basis: "usd", btcBaseline: false, history: pnl.map((p, d) => pt(d, 1, p + 7)) }, btc)!;
  assert.equal(usd.ret, null);
  assert.equal(usd.maxDd, null);
  assert.equal(usd.pnlUsd, 900 + 50 * 36);
  assert.equal(usd.maxDdUsd, -300, "500 to 200");
  assert.equal(usd.series[0][1], 0, "PnL since the start of the window");
  assert.ok(usd.range.usdc && usd.range.usdc.lo < usd.pnlUsd && usd.range.usdc.hi > usd.pnlUsd && usd.range.usdc.n === 39);
  assert.equal(usd.ranked, true);
});

test("thin: long series cut evenly to the cap, first and last kept", () => {
  const xs = Array.from({ length: 1000 }, (_, i) => i);
  const t = thin(xs, 240);
  assert.equal(t.length, 240);
  assert.equal(t[0], 0);
  assert.equal(t[239], 999);
  assert.deepEqual(thin([1, 2, 3], 240), [1, 2, 3]);
});

test("AI claim: capitalised AI, camel-case AI, and the listed words", () => {
  for (const s of ["AI Trend", "AIQuantPulse", "FuturAI", "OpenAI fund", "AI-driven", "my bot", "Trading Bots", "AGENT 7", "GPT4 vault", "LLM quant", "claude", "Qwen alpha", "grok", "DeepSeek", "gemini"])
    assert.equal(aiClaim(s).claim, true, s);
});

test("AI claim: not again, Kairos, Daily, or capitals inside a word", () => {
  for (const s of ["again", "Kairos", "Daily", "MAIN", "FAIR", "CHAIN", "Ai", "ai", "robot", "Bottom", "agentic", "HLP"])
    assert.equal(aiClaim(s).claim, false, s);
  assert.equal(aiClaim("Kairos Daily", "We trade again and again").claim, false);
});

test("AI claim: reports the words and where they matched", () => {
  assert.deepEqual(aiClaim("Alpha Bot", "Run by an AI agent"), { claim: true, words: ["bot", "AI", "agent"], where: ["name", "description"] });
});

test("plainText: tags, control and bidi characters removed, length capped", () => {
  assert.equal(plainText("<b>hi</b>‮there\u0007", 50), "hi there");
  assert.equal(plainText("a\n\n\n\nb", 50), "a\n\nb");
  assert.equal(plainText("x".repeat(20), 10).length, 10);
  assert.equal(plainText(42, 10), "");
});

test("hyperliquid: list item and vaultDetails normalised, malformed input rejected", () => {
  const addr = "0x" + "ab".repeat(20), leader = "0x" + "cd".repeat(20);
  assert.equal(hlListItem({ summary: { vaultAddress: "0x123", tvl: "1" } }), null);
  assert.equal(hlListItem({ summary: { vaultAddress: addr, tvl: "lots" } }), null);
  const item = hlListItem({ summary: { name: "FuturAI", vaultAddress: addr.toUpperCase().replace("0X", "0x"), leader, tvl: "12000.5", isClosed: false, relationship: { type: "normal" }, createTimeMillis: 5 } })!;
  assert.equal(item.address, addr);
  const rec = hlRecord(item, { name: "FuturAI", leader, description: "<script>x</script> trades", leaderCommission: 0.1, followers: [{}, {}],
    portfolio: [["day", {}], ["allTime", { accountValueHistory: [[1, "0"], [2, "1000"], [3, "1100"]], pnlHistory: [[1, "0"], [2, "0"], [3, "100"], [4, "7"]], vlm: "55.5" }]] });
  assert.equal(rec.description, "x trades");
  assert.deepEqual(rec.history.map(p => p.t), [1, 2, 3], "points without an account value are dropped");
  assert.equal(rec.explorer, `https://hypurrscan.io/address/${addr}`);
  assert.equal(rec.ai.claim, true);
  assert.equal(rec.volumeUsd, 55.5);
  assert.throws(() => hlRecord(item, { portfolio: [] }), /allTime/);
  assert.equal(item.pnlAllTime, null);
  const lost = hlListItem({ pnls: [["day", ["1"]], ["allTime", ["0", "5", "-3.5"]]], summary: { vaultAddress: addr, tvl: "1", isClosed: true } })!;
  assert.equal(lost.pnlAllTime, -3.5);
  assert.deepEqual(population([item, lost]), { listed: 2, with_pnl: 1, negative: 1, positive: 0, zero: 0, closed: 1, closed_negative: 1 });
});
