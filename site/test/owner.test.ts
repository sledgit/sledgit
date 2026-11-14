// Owner app: exact unit conversion, the policy form ↔ contract args, transaction builders, and gas against the
// contract's own minimums. Run: npm test (node --test with tsx).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LIVE_NETWORK } from "../src/lib/networks";
import { AGENT_METHODS, GAS, OWNER_NETS } from "../src/lib/owner/config";
import { buildPolicy, describePolicy, diffPolicy, formFromPolicy, validatePolicy, type PolicyForm } from "../src/lib/owner/policy";
import * as T from "../src/lib/owner/tx";
import { formatUnits, parseUnits, priceRatio, ratioPrice } from "../src/lib/owner/units";
import { walletReturn } from "../src/lib/owner/wallet";

const tn = OWNER_NETS.testnet, mn = OWNER_NETS.mainnet;
const spec = { base: tn.wrap, quote: tn.quote, pool: tn.pool };
const form = (o: Partial<PolicyForm> = {}): PolicyForm => ({ tradeBase: "0.5", dayBase: "3", tradeQuote: "1", dayQuote: "5",
  sellFloor: "1.4", buyFloor: "0.33", tradesPerHour: "12", slippageBps: "100", ...o });

test("parseUnits is exact and strict", () => {
  assert.equal(parseUnits("1", 24), 10n ** 24n);
  assert.equal(parseUnits("0.5", 24), 5n * 10n ** 23n);
  assert.equal(parseUnits("0.000000000000000000000001", 24), 1n);
  assert.equal(parseUnits("123456789.123456", 6), 123456789123456n);
  for (const bad of ["", "-1", "1e3", "1,000", ".5", "01", "1.", " 1 2", "0x10", "Infinity", "NaN"]) assert.throws(() => parseUnits(bad, 24), bad);
  assert.throws(() => parseUnits("0.0000001", 6), /more than 6 decimal places/);
  // Round trip without floats, including values a double can't hold exactly.
  for (const v of [0n, 1n, 10n ** 24n, 123456789012345678901234567n, (1n << 128n) - 1n]) assert.equal(parseUnits(formatUnits(v, 24), 24), v);
});

test("price bands match the setup scripts' ratios and survive different decimals", () => {
  // testnet: both tokens 24 decimals → 1.4 USDC/wNEAR is 14/10 reduced to 7/5; 0.33 is 33/100 (as arena_setup.rs).
  assert.deepEqual(priceRatio("1.4", 24, 24), { num: 7n, den: 5n });
  assert.deepEqual(priceRatio("0.33", 24, 24), { num: 33n, den: 100n });
  // mainnet: wNEAR 24 → USDC 6: 3.0 USDC per wNEAR = 3e6 per 1e24 → 3 / 10^18.
  assert.deepEqual(priceRatio("3.0", 24, 6), { num: 3n, den: 10n ** 18n });
  assert.deepEqual(priceRatio("0.17", 6, 24), { num: 17n * 10n ** 16n, den: 1n });
  assert.equal(ratioPrice(3n, 10n ** 18n, 24, 6), "3");
  assert.equal(ratioPrice(17n * 10n ** 16n, 1n, 6, 24), "0.17");
  assert.throws(() => priceRatio("0", 24, 6), /above zero/);
  // The band check the contract runs: amount_out ≥ amount_in × num / den, for 1 wNEAR at 3 USDC.
  const r = priceRatio("3", 24, 6);
  assert.equal((10n ** 24n * r.num + r.den - 1n) / r.den, 3_000_000n);
});

test("the form builds the exact policy the contract expects", () => {
  const { policy, errors } = buildPolicy(form(), spec);
  assert.deepEqual(errors, []);
  assert.deepEqual(policy, {
    tokens: [
      { token: "wrap.testnet", max_per_trade: (5n * 10n ** 23n).toString(), max_per_day: (3n * 10n ** 24n).toString() },
      { token: tn.quote.id, max_per_trade: (10n ** 24n).toString(), max_per_day: (5n * 10n ** 24n).toString() },
    ],
    pairs: [
      { token_in: "wrap.testnet", token_out: tn.quote.id, pool_id: tn.pool, min_price_num: "7", min_price_den: "5" },
      { token_in: tn.quote.id, token_out: "wrap.testnet", pool_id: tn.pool, min_price_num: "33", min_price_den: "100" },
    ],
    max_trades_per_hour: 12, max_slippage_bps: 100,
  });
  // and back again for display / prefill
  assert.deepEqual(formFromPolicy(policy!, spec), form({ sellFloor: "1.4", buyFloor: "0.33" }));
  assert.deepEqual(describePolicy(policy!, [tn.wrap, tn.quote]).caps[0], { symbol: "wNEAR", trade: "0.5", day: "3" });
});

test("the form rejects what the contract would reject", () => {
  const bad = (o: Partial<PolicyForm>, re: RegExp) => { const r = buildPolicy(form(o), spec); assert.equal(r.policy, undefined); assert.match(r.errors.join("|"), re); };
  bad({ tradeBase: "4" }, /per-trade cap above daily cap/);
  bad({ tradeBase: "0" }, /zero per-trade cap/);
  bad({ tradesPerHour: "0" }, /between 1 and 60/);
  bad({ tradesPerHour: "61" }, /between 1 and 60/);
  bad({ tradesPerHour: "1.5" }, /whole number/);
  bad({ slippageBps: "501" }, /between 0 and 500/);
  bad({ sellFloor: "0" }, /above zero/);
  bad({ dayQuote: "-5" }, /plain decimal/);
  // validatePolicy mirrors Policy::validate on hand-built args too
  const { policy } = buildPolicy(form(), spec);
  assert.match(validatePolicy({ ...policy!, tokens: [policy!.tokens[0], policy!.tokens[0]] }).join("|"), /duplicate token/);
  assert.match(validatePolicy({ ...policy!, pairs: [] }).join("|"), /1-16 pairs/);
  assert.match(validatePolicy({ ...policy!, pairs: [{ ...policy!.pairs[0], token_out: "wrap.testnet" }] }).join("|"), /itself/);
  assert.match(validatePolicy({ ...policy!, tokens: [{ ...policy!.tokens[0], max_per_day: ((1n << 128n)).toString() }, policy!.tokens[1]] }).join("|"), /above u128/);
});

test("create_vault: owner is the signer, deposit inside the factory's limits, 150 Tgas", () => {
  const { policy } = buildPolicy(form(), spec);
  const base = { factory: "arena2.irontrade.testnet", name: "my-vault", owner: "alice.testnet", agent: "bot.testnet", policy: policy!,
    deposit: parseUnits("0.2", 24), minDeposit: parseUnits("0.1", 24), maxDeposit: parseUnits("10", 24) };
  const p = T.createVault(base);
  assert.equal(p.receiverId, "arena2.irontrade.testnet");
  assert.equal(p.methodName, "create_vault");
  assert.deepEqual(p.args, { name: "my-vault", owner_id: "alice.testnet", agent_id: "bot.testnet", policy });
  assert.equal(p.depositYocto, 2n * 10n ** 23n);
  assert.equal(p.gasTgas, 150);
  assert.throws(() => T.createVault({ ...base, deposit: parseUnits("0.05", 24) }), /between 0.1 and 10/);
  assert.throws(() => T.createVault({ ...base, deposit: parseUnits("10.000000000000000000000001", 24) }), /between/);
  assert.throws(() => T.createVault({ ...base, agent: "alice.testnet" }), /different account/);
  for (const n of ["a", "-ab", "ab-", "Ab", "a.b", "a_b", "x".repeat(33)]) assert.throws(() => T.createVault({ ...base, name: n }), /vault name/);
  assert.throws(() => T.createVault({ ...base, agent: "Bad..id" }), /valid NEAR account/);
});

test("funding skips registrations already on chain and ends with the deposit", () => {
  const all = T.fundSteps({ vault: "v.f.testnet", owner: "alice.testnet", wrap: "wrap.testnet", quote: "usdc.testnet", amount: parseUnits("0.5", 24),
    vaultRegistered: { wrap: false, quote: false }, ownerRegisteredWrap: false, exchangeStorage: false, exchangeTokens: false });
  assert.deepEqual(all.map(s => `${s.receiverId}.${s.methodName}`), [
    "wrap.testnet.storage_deposit", "usdc.testnet.storage_deposit", "v.f.testnet.exchange_storage_deposit", "v.f.testnet.exchange_register_tokens",
    "wrap.testnet.storage_deposit", "wrap.testnet.near_deposit", "wrap.testnet.ft_transfer_call"]);
  const last = all.at(-1)!;
  assert.deepEqual(last.args, { receiver_id: "v.f.testnet", amount: (5n * 10n ** 23n).toString(), msg: "" });
  assert.equal(last.depositYocto, 1n);
  assert.equal(all[5].depositYocto, 5n * 10n ** 23n);
  const some = T.fundSteps({ vault: "v.f.testnet", owner: "alice.testnet", wrap: "wrap.testnet", quote: "usdc.testnet", amount: 1n,
    vaultRegistered: { wrap: true, quote: true }, ownerRegisteredWrap: true, exchangeStorage: true, exchangeTokens: true });
  assert.deepEqual(some.map(s => s.methodName), ["near_deposit", "ft_transfer_call"]);
  assert.throws(() => T.fundSteps({ vault: "v.f.testnet", owner: "a.testnet", wrap: "w", quote: "q", amount: 0n,
    vaultRegistered: { wrap: true, quote: true }, ownerRegisteredWrap: true, exchangeStorage: true, exchangeTokens: true }), /above zero/);
});

test("owner calls attach exactly 1 yocto where the contract asserts it", () => {
  const v = "v.f.testnet";
  const oneYocto = [T.freeze(v), T.unfreeze(v), T.cancelPolicy(v), T.withdraw(v, "wrap.testnet", 5n, "wNEAR", 24), T.withdrawNear(v, 5n),
    T.setAgent(v, "bot2.testnet", "alice.testnet"), T.proposeOwner(v, "bob.testnet", "bot.testnet"), T.acceptOwner(v),
    T.exchangeWithdraw(v, "wrap.testnet", 5n, "wNEAR", 24), T.claimLostfound(v, "wrap.testnet", "wNEAR"), T.intentsAbandon(v),
    T.intentsCancel(v), T.intentsSetup(v), T.clearStuck(v)];
  for (const p of oneYocto) assert.equal(p.depositYocto, 1n, p.methodName);
  assert.equal(T.applyPolicy(v).depositYocto, 0n);
  assert.equal(T.intentsSettle(v).depositYocto, 0n);
  assert.throws(() => T.setAgent(v, "alice.testnet", "alice.testnet"), /not the owner/);
  assert.throws(() => T.setAgent(v, v, "alice.testnet"), /not the vault/);
  assert.throws(() => T.proposeOwner(v, "bot.testnet", "bot.testnet"), /not the agent/);
  assert.throws(() => T.withdraw(v, "wrap.testnet", 0n, "wNEAR", 24), /above zero/);
});

test("gas is at least each contract minimum (read from the contract source)", () => {
  const src = readFileSync(new URL("../../contracts/vault/src/lib.rs", import.meta.url), "utf8")
    + readFileSync(new URL("../../contracts/vault/src/intents.rs", import.meta.url), "utf8");
  const defs = new Map<string, string>();
  for (const m of src.matchAll(/const (TG_[A-Z_]+): u64 = ([^;]+);/g)) defs.set(m[1], m[2]);
  const val = (name: string): number => {
    const e = defs.get(name); assert.ok(e, `${name} not found in the contract`);
    // + and 2 * NAME only, as the contract writes them
    return e!.split("+").map(t => t.trim()).reduce((s, t) => {
      const mul = t.match(/^(\d+)\s*\*\s*(TG_[A-Z_]+)$/);
      return s + (mul ? Number(mul[1]) * val(mul[2]) : /^\d+$/.test(t) ? Number(t) : val(t));
    }, 0);
  };
  assert.ok(GAS.exchange_withdraw >= val("TG_MIN_EXCHANGE_WITHDRAW"));
  assert.ok(GAS.exchange_claim_lostfound >= val("TG_MIN_CLAIM_LOSTFOUND"));
  assert.ok(GAS.intents_cancel >= val("TG_MIN_CANCEL"));
  assert.ok(GAS.intents_settle >= val("TG_MIN_SETTLE"));
  // withdraw's own transfer plus its callback
  assert.ok(GAS.withdraw >= val("TG_FT_TRANSFER") + val("TG_ON_MOVED") + 10);
});

test("the agent key command grants exactly the agent methods, with no allowance cap", () => {
  const c = T.agentKeyCommand("bot.testnet", "v.f.testnet", "testnet");
  assert.match(c, /--allowance unlimited --contract-account-id v\.f\.testnet/);
  assert.match(c, new RegExp(`--function-names '${AGENT_METHODS.join(", ")}'`));
  assert.deepEqual([...AGENT_METHODS].sort(), ["freeze", "intents_cancel", "intents_settle", "log_skip", "request_intent_swap", "request_swap"]);
});

test("mainnet stays disabled until it is the live network", () => {
  assert.equal(mn.factory, LIVE_NETWORK === "mainnet" ? "arena.sledgit.near" : null);
  assert.equal(tn.factory, "arena2.irontrade.testnet");
});

test("redirect-wallet returns accept only well-formed hashes", () => {
  assert.deepEqual(walletReturn("?transactionHashes=8RhTCrzynmsx9mMhrJVGe2wkD9pkU6ZBPGx1TXQfUqZC,<script>").hashes, ["8RhTCrzynmsx9mMhrJVGe2wkD9pkU6ZBPGx1TXQfUqZC"]);
  assert.equal(walletReturn("?errorCode=userRejected").error, "the wallet didn't send the transaction (code: userRejected)");
});

// final-review-1 A5: a crafted link can't put its own sentence on the signing page.
test("wallet errors never echo the URL's free text", () => {
  const e = walletReturn("?errorCode=Wallet&errorMessage=Your%20vault%20is%20locked.%20Send%20NEAR%20to%20recover.near").error!;
  assert.ok(!/locked|recover|Send/.test(e), e);
  assert.match(walletReturn("?errorCode=%3Cb%3Ehi%20there").error!, /code: unknown/);
});

// final-review-1 A1: every field of a proposal is shown against the current policy, weakened ones flagged.
test("diffPolicy shows floors, pools, rate and slippage, and flags weaker ones", () => {
  const cur = buildPolicy(form(), spec).policy!;
  assert.deepEqual(diffPolicy(cur, cur, [tn.wrap, tn.quote]), []);
  // The review's PoC: same caps, sell floor dropped to ~0.
  const sneaky = structuredClone(cur);
  sneaky.pairs[0] = { ...sneaky.pairs[0], min_price_num: "1", min_price_den: (10n ** 30n).toString() };
  const d = diffPolicy(cur, sneaky, [tn.wrap, tn.quote]);
  assert.equal(d.length, 1); assert.match(d[0].field, /price floor/); assert.ok(d[0].weaker && d[0].loud);
  const more = buildPolicy(form({ slippageBps: "300", tradesPerHour: "40", dayBase: "30" }), spec).policy!;
  const m = diffPolicy(cur, more, [tn.wrap, tn.quote]);
  for (const f of ["max slippage", "trades per hour", "wNEAR per 24 h"]) assert.ok(m.find(c => c.field === f)?.weaker, f);
  assert.ok(m.find(c => c.field === "wNEAR per 24 h")!.loud, "a cap raised 10x is loud");
  const pool = structuredClone(cur); pool.pairs[1].pool_id = 9999;
  assert.ok(diffPolicy(cur, pool, [tn.wrap, tn.quote]).some(c => /pool/.test(c.field) && c.loud));
  const stricter = buildPolicy(form({ tradeBase: "0.2", sellFloor: "2" }), spec).policy!;
  assert.ok(diffPolicy(cur, stricter, [tn.wrap, tn.quote]).every(c => !c.weaker));
});

// final-review-1 A3: the form never silently rewrites a policy it can't represent, nor lowers a floor by rounding.
test("formFromPolicy refuses other pools or extra tokens; untouched floors stay exact", () => {
  const p = buildPolicy(form(), spec).policy!;
  const otherPool = structuredClone(p); otherPool.pairs.forEach(q => { q.pool_id = 1234; });
  assert.equal(formFromPolicy(otherPool, spec), null);
  const extra = structuredClone(p); extra.tokens.push({ token: "other.testnet", max_per_trade: "1", max_per_day: "2" });
  assert.equal(formFromPolicy(extra, spec), null);
  const precise = structuredClone(p); precise.pairs[0] = { ...precise.pairs[0], min_price_num: "1400000001", min_price_den: "1000000000" };
  const f = formFromPolicy(precise, spec)!;
  assert.deepEqual(diffPolicy(precise, buildPolicy(f, spec, precise).policy!, [tn.wrap, tn.quote]), [], "re-proposing an untouched form changes nothing");
});

// final-review-1 A2: the agent can't be the vault being created or the factory.
test("create_vault refuses the vault or the factory as its own agent", () => {
  const base = { factory: tn.factory!, name: "my-vault", owner: "me.testnet", policy: buildPolicy(form(), spec).policy!,
    deposit: 10n ** 23n, minDeposit: 10n ** 23n, maxDeposit: 10n ** 25n };
  assert.throws(() => T.createVault({ ...base, agent: `my-vault.${tn.factory}` }), /vault itself or the factory/);
  assert.throws(() => T.createVault({ ...base, agent: tn.factory! }), /vault itself or the factory/);
  assert.doesNotThrow(() => T.createVault({ ...base, agent: "my-bot.testnet" }));
});

test("deposit cap room mirrors the contract", async () => {
  const { capRoom } = await import("../src/lib/owner/caps");
  const caps = [{ token: "wrap.near", max: "5", net_deposited: "2" }];
  assert.equal(capRoom(null, "wrap.near"), null, "code without caps");
  assert.equal(capRoom([], "wrap.near"), null, "empty = uncapped");
  assert.equal(capRoom(caps, "wrap.near"), 3n);
  assert.equal(capRoom(caps, "usdc.near"), 0n, "a capped vault takes no uncapped token");
  assert.equal(capRoom([{ token: "wrap.near", max: "5", net_deposited: "9" }], "wrap.near"), 0n, "never negative");
});
