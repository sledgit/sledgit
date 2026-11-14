// The mainnet Season 1 registry exists but has no start yet: a league build must refuse it rather than score nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PAIRS } from "../src/pairs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("mainnet-s1 registry: factory, pool 4512, native USDC, no entries and no start yet", () => {
  const r = JSON.parse(readFileSync(join(ROOT, "deploy", "mainnet", "league", "entries.json"), "utf8"));
  assert.equal(r.network, "mainnet");
  assert.equal(r.season.id, "mainnet-s1");
  assert.equal(r.season.start_ms, null);
  assert.deepEqual(r.season.canonical_pools, [4512]);
  assert.deepEqual(r.factories, ["arena.sledgit.near"]);
  assert.deepEqual(r.tokens, [PAIRS.mainnet.base, PAIRS.mainnet.quote]);
  assert.deepEqual(r.entries, []);
});

test("the mainnet pair is wNEAR / native USDC (the tokens of pool 4512)", () => {
  assert.equal(PAIRS.mainnet.base, "wrap.near");
  assert.equal(PAIRS.mainnet.quote, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  assert.equal(PAIRS.mainnet.decimals[PAIRS.mainnet.quote], 6);
});
