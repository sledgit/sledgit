// Trades chart markers and the decision log's hold runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { barAt, closeBars, holdRuns, HOUR, marksOf } from "../src/lib/trades";
import type { LeagueDecision } from "../src/lib/feed/league-data";

const d = (seq: number, event: LeagueDecision["event"], t: number, extra: Partial<LeagueDecision> = {}): LeagueDecision =>
  ({ seq, event, tx: `tx${seq}`, block_time_ms: t, receipt_hash: "h", in_season: true, on_schedule: null, ...extra });

test("marks: trades and refusals only, oldest first, stacked per hour and side", () => {
  const H = 10 * HOUR;
  const m = marksOf([
    d(5, "trade", H + 50, { side: "sell" }), d(4, "refuse", H + 40, { code: "rate_limit" }), d(3, "skip", H + 30, { note: "hold" }),
    d(2, "request", H + 20, { side: "buy" }), d(1, "trade", H + 10, { side: "buy" }), d(0, "trade", 0, { side: "buy" }),
  ], HOUR, 20 * HOUR);
  assert.deepEqual(m.map(x => [x.d.seq, x.kind, x.stack]), [[1, "buy", 0], [4, "refuse", 0], [5, "sell", 1]]);
});

test("marks: a skip noted as refused counts as a refusal", () => {
  assert.equal(marksOf([d(1, "skip", HOUR, { note: "refused: cap" })], 0, 2 * HOUR)[0].kind, "refuse");
});

test("barAt: the containing bar, else the nearest", () => {
  const bars = closeBars([[2 * HOUR, 4], [3 * HOUR, 5]]);
  assert.equal(barAt(bars, HOUR + 5)?.c, 4);
  assert.equal(barAt(bars, 2 * HOUR)?.c, 5);
  assert.equal(barAt(bars, 9 * HOUR)?.c, 5);
  assert.equal(barAt([], 0), undefined);
});

test("holdRuns: identical holds collapse from 3 in a row; trades never do", () => {
  const key = (x: string) => (x.startsWith("h") ? x : null);
  const r = holdRuns(["t", "h", "h", "h", "h", "r", "h", "h", "t", "t", "t"], key);
  assert.deepEqual(r, [{ one: "t" }, { run: ["h", "h", "h", "h"] }, { one: "r" }, { one: "h" }, { one: "h" }, { one: "t" }, { one: "t" }, { one: "t" }]);
  assert.deepEqual(holdRuns(["ha", "ha", "hb"], key, 2), [{ run: ["ha", "ha"] }, { one: "hb" }]);
});
