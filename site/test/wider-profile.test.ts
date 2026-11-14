// Strategy profiles for the wider board's vault pages: Hyperliquid fills and state (fixtures trimmed from a real vault's
// replies) to an inferred style, Polymarket trades and positions to a profile, and the page's query check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DAY } from "../src/lib/wider";
import { hlFills, hlState, parseVaultQuery, pmLine, pmProfile, styleLine, tradeStyle, vaultHref, type HlFill } from "../src/lib/wider-profile";

const fx = (f: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", f), "utf8"));
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const H = 3_600_000;
const fill = (coin: string, side: "B" | "A", sz: number, startPosition: number, time: number, o: Partial<HlFill> = {}): HlFill =>
  ({ coin, px: 100, sz, side, time, startPosition, dir: "", crossed: true, fee: 0, closedPnl: 0, oid: null, ...o });

test("hyperliquid: fills checked, malformed rows dropped and counted, text cleaned", () => {
  const raw = fx("hyperliquid-user-fills.json") as unknown[];
  const { fills, dropped } = hlFills(raw);
  assert.equal(fills.length, raw.length);
  assert.equal(dropped, 0);
  assert.ok(fills.every(f => f.px > 0 && f.sz > 0 && Number.isFinite(f.time) && Number.isFinite(f.startPosition)));
  const bad = hlFills([{ coin: "BTC", px: "NaN", sz: "1", side: "B", time: 1, startPosition: "0" }, { coin: "<b>ETH</b>‮", px: "2", sz: "1", side: "A", time: 1, startPosition: "0" }, { coin: "X", px: "1", sz: "1", side: "Z", time: 1, startPosition: "0" }, null]);
  assert.equal(bad.fills.length, 1);
  assert.equal(bad.fills[0].coin, "ETH");
  assert.equal(bad.dropped, 3);
  assert.equal(hlFills(raw, 10).dropped, raw.length - 10, "rows past the cap count as not read");
  assert.throws(() => hlFills({ error: "x" }), /not an array/);
});

test("hyperliquid: clearinghouse state checked; missing liquidation price stays null", () => {
  const s = hlState(fx("hyperliquid-clearinghouse.json"));
  assert.ok(s.accountValue! > 0 && s.notional! > 0);
  assert.ok(s.positions.length > 0 && s.positions.every(p => p.size !== 0 && p.coin));
  assert.ok(s.positions.some(p => p.liq === null), "BTC on this vault has no liquidation price");
  assert.ok(s.positions.some(p => p.size < 0) && s.positions.some(p => p.size > 0));
  assert.deepEqual(hlState({ assetPositions: [{ position: { coin: "BTC", szi: "abc" } }] }).positions, []);
  assert.throws(() => hlState([]), /not an object/);
});

test("hyperliquid: inferred style from a real vault's fills is consistent", () => {
  const { fills } = hlFills(fx("hyperliquid-user-fills.json"));
  const s = tradeStyle(fills, hlState(fx("hyperliquid-clearinghouse.json")));
  assert.equal(s.fills, fills.length);
  assert.ok(s.orders > 0 && s.orders <= s.fills);
  assert.ok(s.longShare! >= 0 && s.longShare! <= 1 && s.takerShare! >= 0 && s.takerShare! <= 1);
  close(s.coins.reduce((a, c) => a + c.share, 0), 1, 1e-9);
  assert.ok(s.coins.every((c, i) => i === 0 || c.share <= s.coins[i - 1].share));
  close(s.volumeUsd, fills.reduce((a, f) => a + f.px * f.sz, 0), 1e-6);
  assert.ok(s.fromMs! <= s.toMs!);
  assert.ok(s.avgLev! > 0 && s.maxLev! >= s.avgLev!);
  assert.match(s.summary, /coins?$/);
});

test("hyperliquid: long/short split at zero, taker share, coins", () => {
  // Long 2 opened by a taker; then a maker sell of 3 flips it to short 1: 2 of those 3 were long, 1 short.
  const s = tradeStyle([fill("BTC", "B", 2, 0, 0), fill("BTC", "A", 3, 2, H, { crossed: false }), fill("ETH", "A", 1, 0, 2 * H)]);
  close(s.volumeUsd, 600);
  close(s.longShare!, (200 + 200) / 600);
  close(s.takerShare!, 300 / 600);
  assert.deepEqual(s.coins.map(c => c.coin), ["BTC", "ETH"]);
  assert.equal(s.nCoins, 2);
  assert.equal(s.perDay, null, "a window under a day has no per-day rate");
});

test("hyperliquid: holding time and flips need positions seen whole", () => {
  const s = tradeStyle([
    fill("SOL", "B", 5, -5, 0),                 // closes a short opened before the sample: no holding time
    fill("SOL", "B", 2, 0, 1 * H),              // opens long (flip from short): 1 reopen, 1 flip
    fill("SOL", "A", 2, 2, 3 * H),              // closes: held 2 h
    fill("SOL", "B", 1, 0, 4 * H),              // opens long again: 1 reopen, no flip
    fill("SOL", "A", 3, 1, 8 * H),              // flips to short: held 4 h, 1 reopen, 1 flip
    fill("SOL", "B", 2, -2, 2 * DAY + 8 * H),   // closes: held 2 days
  ]);
  assert.equal(s.roundTrips, 3);
  assert.equal(s.medianHoldMs, 4 * H);
  assert.equal(s.reopens, 3);
  close(s.flipRate!, 2 / 3);
  assert.ok(s.perDay! > 0);
  // Float residue on a close is flat, not a tiny position.
  const r = tradeStyle([fill("X", "B", 0.3, 0, 0), fill("X", "A", 0.1, 0.3, H), fill("X", "A", 0.2, 0.19999999999999998, 2 * H)]);
  assert.equal(r.roundTrips, 1);
  assert.equal(r.medianHoldMs, 2 * H);
});

test("hyperliquid: unsorted input is read in time order; leverage is value-weighted", () => {
  const a = [fill("BTC", "B", 1, 0, 0, { oid: 1 }), fill("BTC", "A", 1, 1, H, { oid: 2 })];
  assert.deepEqual(tradeStyle([...a].reverse()), tradeStyle(a));
  const st = { accountValue: 1000, notional: 4000, time: 0, positions: [
    { coin: "A", size: 1, entry: 1, leverage: 10, levType: "cross", value: 3000, upnl: 0, liq: null },
    { coin: "B", size: -1, entry: 1, leverage: 2, levType: "isolated", value: 1000, upnl: null, liq: null }] };
  const s = tradeStyle(a, st);
  close(s.avgLev!, 8);
  assert.equal(s.maxLev, 10);
  close(s.grossLev!, 4);
  assert.equal(s.openPositions, 2);
});

test("style lines read plainly", () => {
  assert.equal(styleLine({ fills: 10, longShare: 0.2, takerShare: 1, avgLev: 4.6, nCoins: 12, openPositions: 3 }), "Mostly short, all taker, ~5x, 12 coins");
  assert.equal(styleLine({ fills: 10, longShare: 0.5, takerShare: 0.2, avgLev: null, nCoins: 1, openPositions: 0 }), "Long and short, mostly maker, no open positions, 1 coin");
  assert.equal(styleLine({ fills: 0, longShare: null, takerShare: null, avgLev: null, nCoins: 0, openPositions: 0 }), "No fills in the sample");
  const banned = /\b(earn|yield|profit|best|top picks|follow|copy)/i;
  for (const l of [styleLine({ fills: 1, longShare: 1, takerShare: 0, avgLev: 1, nCoins: 1, openPositions: 1 }), pmLine({ trades: 5, buyShare: 0.9, yesShare: 0.7, yesNoShare: 1, markets: 3, open: { count: 2, more: false, avgValueUsd: 1, valueUsd: 2 } })])
    assert.doesNotMatch(l, banned);
});

// ---------------------------------------------------------------- Polymarket

test("polymarket: profile from real trades and positions", () => {
  const T = fx("polymarket-trades.json") as { data: { size: number; price: number; side: string; outcome: string; condition_id: string }[] };
  const p = pmProfile(T, fx("polymarket-positions.json"), 1_000);
  assert.equal(p.trades, T.data.length);
  assert.equal(p.more, true);
  assert.equal(p.markets, new Set(T.data.map(t => t.condition_id)).size);
  const vol = T.data.reduce((a, t) => a + t.size * t.price, 0), buy = T.data.filter(t => t.side === "BUY").reduce((a, t) => a + t.size * t.price, 0);
  close(p.buyShare!, Math.round((buy / vol) * 1e4) / 1e4);
  assert.ok(p.largest.length <= 5 && p.largest.every((m, i) => m.title && (i === 0 || m.share <= p.largest[i - 1].share)));
  assert.equal(p.open.count, 20, "resolved (redeemable) positions are not open");
  assert.ok(p.open.avgValueUsd! > 0);
  assert.equal(p.asOf, 1_000);
  assert.ok(p.summary.length > 0 && p.summary.length < 120);
});

test("polymarket: untrusted rows dropped; Yes/No share only over Yes/No outcomes", () => {
  const cid = "0x" + "ab".repeat(32);
  const trades = { data: [
    { side: "BUY", size: 100, price: 0.5, timestamp: 10, condition_id: cid, title: "<b>Will it rain?</b>", outcome: "Yes" },
    { side: "SELL", size: 100, price: 0.5, timestamp: 20, condition_id: cid, title: "Will it rain?", outcome: "No" },
    { side: "BUY", size: 300, price: 0.5, timestamp: 30, condition_id: "0x" + "cd".repeat(32), title: "A vs B", outcome: "A" },
    { side: "BUY", size: 1, price: 7, timestamp: 40, condition_id: cid, outcome: "Yes" },
    { side: "BUY", size: 1, price: 0.5, timestamp: 40, condition_id: "0x12", outcome: "Yes" },
  ] };
  const p = pmProfile(trades, { data: [{ status: "OPEN", current_size: 0, current_value: 0 }] }, 0);
  assert.equal(p.trades, 3);
  assert.equal(p.markets, 2);
  close(p.buyShare!, 0.8);
  close(p.yesNoShare!, 0.4);
  close(p.yesShare!, 0.5);
  assert.equal(p.largest[0].title, "A vs B");
  assert.equal(p.largest[1].title, "Will it rain?", "tags stripped");
  assert.equal(p.open.count, 0, "a zero-size position is not open");
  assert.throws(() => pmProfile({}, { data: [] }, 0), /trades/);
});

// ---------------------------------------------------------------- the page's query

test("vault page query: checked before any fetch", () => {
  const a = "0x" + "AbC1".repeat(10);
  assert.deepEqual(parseVaultQuery("hyperliquid", a), { ok: true, source: "hyperliquid", id: a.toLowerCase() });
  assert.deepEqual(parseVaultQuery("pm", a), { ok: true, source: "polymarket", id: a.toLowerCase() });
  assert.deepEqual(parseVaultQuery("dydx", "megavault"), { ok: true, source: "dydx", id: "megavault" });
  for (const [s, i] of [["hyperliquid", "0x123"], ["hyperliquid", a + "0"], ["hl", "0x" + "g".repeat(40)], ["nope", a], [null, a], ["dydx", a], ["hl", "javascript:alert(1)"]] as const)
    assert.equal(parseVaultQuery(s, i).ok, false, `${s} ${i}`);
  assert.equal(vaultHref({ id: `hyperliquid:${a.toLowerCase()}`, source: "hyperliquid" }), `/wider/vault/?src=hyperliquid&id=${a.toLowerCase()}`);
  assert.equal(vaultHref({ id: "dydx:megavault", source: "dydx" }), "/wider/vault/?src=dydx&id=megavault");
});
