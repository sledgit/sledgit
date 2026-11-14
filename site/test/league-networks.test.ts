// Per-network leagues and the live-network switch: testnet from its snapshot, mainnet empty until it has one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsFor, leagueFor, leagueOf, MAINNET_LEAGUE, TESTNET_AGENTS, TESTNET_LEAGUE, type LeagueSnapshot } from "../src/lib/feed/league-data";
import { benchBots, LIVE_LEAGUE, LIVE_NETWORK, NETWORKS, shortAccount, vaultBots } from "../src/lib/networks";
import { boardEntries, latestRefusal, liveCopy, score, ticker } from "../src/lib/board";

test("leagueFor: testnet snapshot, mainnet snapshot or null, nothing for the simulation", () => {
  assert.equal(leagueFor("testnet"), TESTNET_LEAGUE);
  assert.equal(leagueFor("mainnet"), MAINNET_LEAGUE);
  assert.equal(leagueFor("sim"), null);
  assert.equal(agentsFor("testnet"), TESTNET_AGENTS);
  assert.deepEqual(agentsFor("sim"), {});
  assert.equal(TESTNET_LEAGUE.network, "testnet");
  if (MAINNET_LEAGUE) assert.equal(MAINNET_LEAGUE.network, "mainnet");
  assert.equal(LIVE_LEAGUE, leagueFor(LIVE_NETWORK));
  const e = TESTNET_LEAGUE.entries[0];
  assert.equal(leagueOf(e.id), TESTNET_LEAGUE);
  assert.equal(leagueOf("no-such-entry"), null);
});

test("mainnet config: real contracts, vaults only from its snapshot", () => {
  const m = NETWORKS.mainnet;
  assert.deepEqual(m.tokens.map(t => [t.id, t.decimals]), [["wrap.near", 24], ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", 6]]);
  assert.equal(m.pool, 4512);
  assert.equal(m.rhea, "v2.ref-finance.near");
  assert.equal(m.intents, "intents.near");
  assert.equal(m.mpc, "v1.signer");
  assert.equal(m.factory, "arena.sledgit.near");
  assert.equal(m.vaults.length, MAINNET_LEAGUE?.entries.length ?? 0);
  assert.deepEqual(benchBots(m), []);
  assert.equal(vaultBots(m).length, m.vaults.length);
  assert.equal(shortAccount(m, "qwen36-tee.arena.sledgit.near"), "qwen36-tee");
  assert.equal(shortAccount(NETWORKS.testnet, "qwen36-tee.arena2.irontrade.testnet"), "qwen36-tee");
});

test("no mainnet snapshot: an empty board, no numbers", () => {
  assert.deepEqual(boardEntries(null), []);
  assert.deepEqual(score(null), { beat: 0, total: 0, day: null });
  assert.deepEqual(ticker(24, null), []);
  assert.equal(latestRefusal(null), undefined);
  const c = liveCopy("mainnet", null);
  assert.equal(c.launching, true);
  assert.equal(c.prices, null);
  assert.equal(c.tag, "Mainnet launching");
  for (const v of Object.values(c)) if (typeof v === "string") assert.doesNotMatch(v, /testnet/i, v);
});

test("an empty mainnet snapshot: launching, a finite season day, nothing else", () => {
  const empty: LeagueSnapshot = { ...TESTNET_LEAGUE, network: "mainnet", caveat: null, entries: [], flags: [], by_model: [], luck_entry: null,
    season: { ...TESTNET_LEAGUE.season, id: "mainnet-s1", start_ms: TESTNET_LEAGUE.as_of_ms - 86_400_000 } };
  assert.deepEqual(score(empty), { beat: 0, total: 0, day: 2 });
  assert.deepEqual(ticker(24, empty), []);
  assert.equal(liveCopy("mainnet", empty).launching, true);
  assert.equal(liveCopy("mainnet", empty).tag, "Mainnet season live");
});

test("testnet copy is today's wording", () => {
  const c = liveCopy("testnet", TESTNET_LEAGUE);
  assert.equal(c.eyebrow, "On NEAR · testnet now, mainnet later");
  assert.equal(c.season, "Testnet season");
  assert.equal(c.label.toUpperCase(), "NEAR TESTNET");
  assert.equal(c.prices, "Testnet pool prices are not real markets.");
  assert.equal(c.length, "testnet now, mainnet later");
  assert.equal(c.launching, false);
  const s = score(TESTNET_LEAGUE);
  assert.ok(s.total > 0 && Number.isInteger(s.day));
  assert.ok(ticker(24, TESTNET_LEAGUE).every(t => !/NaN/.test(t.text)));
});
