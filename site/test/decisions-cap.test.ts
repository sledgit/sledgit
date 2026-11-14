// The live decision list keeps trades and refusals when it is full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushDecision } from "../src/lib/league";
import type { Decision } from "../src/lib/feed/types";

const dec = (i: number, kind: Decision["kind"]): Decision =>
  ({ type: "decision", id: `d${i}`, kind, botId: "b", at: i, reason: "" }) as Decision;

test("old refusals survive many newer holds", () => {
  const list: Decision[] = [];
  pushDecision(list, dec(0, "refuse"), 5);
  pushDecision(list, dec(1, "trade"), 5);
  for (let i = 2; i < 50; i++) pushDecision(list, dec(i, "skip"), 5);
  assert.equal(list.length, 5);
  assert.deepEqual(list.filter(d => d.kind !== "skip").map(d => d.id).sort(), ["d0", "d1"]);
  assert.equal(list[0].id, "d49", "newest first");
});

test("with no holds left, the oldest decision goes", () => {
  const list: Decision[] = [];
  for (let i = 0; i < 4; i++) pushDecision(list, dec(i, "refuse"), 3);
  assert.deepEqual(list.map(d => d.id), ["d3", "d2", "d1"]);
});
