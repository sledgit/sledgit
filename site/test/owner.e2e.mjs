// Owner app in a real browser, with a mocked wallet and mocked chain: nothing is signed or sent.
// Build the site with NEXT_PUBLIC_OWNER_MOCK_WALLET=1 (the only build that honours the mock), then:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node test/owner.e2e.mjs <path to that build's out/>
// Checks: what the wallet receives equals the preview on screen; validation blocks bad input; owner-only actions
// are disabled for other accounts; nothing scrolls sideways at 390 px.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const OUT = process.argv[2];
if (!OUT) { console.error("usage: node test/owner.e2e.mjs <out dir>"); process.exit(2); }

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".txt": "text/plain", ".woff2": "font/woff2", ".ico": "image/x-icon", ".md": "text/markdown" };
const server = createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let f = join(OUT, p);
  const isDir = await stat(f).then(s => s.isDirectory(), () => null);
  if (isDir) f = join(f, "index.html");
  else if (isDir === null && !f.endsWith(".html")) f = `${f}.html`;
  const body = await readFile(f).catch(e => { if (e.code !== "ENOENT") console.error(`serve ${f}: ${e.message}`); return null; });
  if (!body) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" }); res.end(body);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const FACTORY = "arena2.irontrade.testnet", VAULT = `e2e-vault.${FACTORY}`, E24 = 10n ** 24n;
const POLICY = { tokens: [
  { token: "wrap.testnet", max_per_trade: (E24 / 2n).toString(), max_per_day: (3n * E24).toString() },
  { token: "usdc.itachicara.testnet", max_per_trade: E24.toString(), max_per_day: (5n * E24).toString() }],
  pairs: [{ token_in: "wrap.testnet", token_out: "usdc.itachicara.testnet", pool_id: 1103, min_price_num: "7", min_price_den: "5" },
    { token_in: "usdc.itachicara.testnet", token_out: "wrap.testnet", pool_id: 1103, min_price_num: "33", min_price_den: "100" }],
  max_trades_per_hour: 12, max_slippage_bps: 100 };
const VIEWS = {
  [`${FACTORY}.get_config`]: { code_hash: "2ZP4H1ENzFKyN4nVSZf9vKf3pEpgoup9DVU6NbjbE2Gg", min_deposit: (E24 / 10n).toString(), max_deposit: (10n * E24).toString(), vaults: 1 },
  [`${FACTORY}.get_vaults`]: [VAULT],
  [`${VAULT}.get_config`]: { owner_id: "owner.testnet", proposed_owner: null, agent_id: "bot.testnet", exchange_id: "ref-finance-101.testnet", frozen: false, seq: 3 },
  [`${VAULT}.get_policy`]: POLICY, [`${VAULT}.get_pending_policy`]: null, [`${VAULT}.get_in_flight`]: null,
  [`${VAULT}.get_intents`]: { public_key: null, open_intent: null },
  "wrap.testnet.ft_balance_of": (E24 / 2n).toString(), "usdc.itachicara.testnet.ft_balance_of": "0",
  "wrap.testnet.storage_balance_of": null, "usdc.itachicara.testnet.storage_balance_of": { total: "1", available: "0" },
  "ref-finance-101.testnet.storage_balance_of": null,
};
const enc = v => [...new TextEncoder().encode(JSON.stringify(v))];

async function page(browser, account, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(acct => {
    window.__itSent = [];
    window.__itMockWallet = {
      accountId: acct, wallets: [{ id: "mock", name: "Mock wallet" }],
      async signIn() {}, async signOut() {}, subscribe() { return () => {}; },
      async send(plan) {
        window.__itSent.push({ ...plan, depositYocto: plan.depositYocto.toString() });
        return { ok: true, hash: "8RhTCrzynmsx9mMhrJVGe2wkD9pkU6ZBPGx1TXQfUqZC" };
      },
    };
  }, account);
  const p = await ctx.newPage();
  const problems = [];
  p.on("pageerror", e => problems.push(e.message));
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, async route => {
    const req = route.request();
    if (/rpc\.testnet\.fastnear\.com/.test(req.url()) && req.method() === "POST") {
      const b = JSON.parse(req.postData() ?? "{}"), q = b.params ?? {};
      let result;
      if (q.request_type === "call_function") {
        const key = `${q.account_id}.${q.method_name}`;
        if (!(key in VIEWS)) return route.fulfill({ json: { jsonrpc: "2.0", id: b.id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN" }, data: `no mock for ${key}` } } });
        result = { result: enc(VIEWS[key]), logs: [] };
      } else if (q.request_type === "view_account") result = { amount: (2n * E24).toString(), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 1000 };
      else if (q.request_type === "view_access_key_list") result = { keys: [] };
      else return route.fulfill({ json: { jsonrpc: "2.0", id: b.id, error: { name: "UNSUPPORTED" } } });
      return route.fulfill({ json: { jsonrpc: "2.0", id: b.id, result } });
    }
    return route.fulfill({ status: 503, body: "offline in tests" });
  });
  return { p, ctx, problems };
}

const browser = await chromium.launch();
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split("\n")[0]}`); } };

await check("create: the wallet receives exactly the previewed transaction", async () => {
  const { p, ctx } = await page(browser, "owner.testnet");
  await p.goto(`${BASE}/vault/?net=testnet`);
  await p.getByText("owner.testnet", { exact: true }).waitFor();
  await p.getByLabel("Vault name").fill("e2e-vault");
  await p.getByLabel("Agent account").fill("bot.testnet");
  const card = p.locator('[data-tx="create_vault"]');
  await card.waitFor();
  const shown = JSON.parse(await card.locator("pre[data-args]").innerText());
  assert.deepEqual(shown, { name: "e2e-vault", owner_id: "owner.testnet", agent_id: "bot.testnet", policy: POLICY });
  await card.getByRole("button", { name: "Create vault in wallet" }).click();
  await card.getByText("Done").waitFor();
  const sent = await p.evaluate(() => window.__itSent);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, shown);
  assert.equal(sent[0].receiverId, FACTORY);
  assert.equal(sent[0].methodName, "create_vault");
  assert.equal(sent[0].depositYocto, (2n * E24 / 10n).toString());
  assert.equal(sent[0].gasTgas, 150);
  await ctx.close();
});

await check("create: invalid input shows errors and offers nothing to sign", async () => {
  const { p, ctx } = await page(browser, "owner.testnet");
  await p.goto(`${BASE}/vault/?net=testnet`);
  await p.getByLabel("Vault name").fill("e2e-vault");
  await p.getByLabel("Agent account").fill("owner.testnet");
  await p.getByText("different account from the owner").waitFor();
  await p.getByLabel("wNEAR per trade").fill("5");
  await p.getByText("per-trade cap above daily cap").waitFor();
  assert.equal(await p.locator('[data-tx="create_vault"]').count(), 0);
  await p.getByLabel("Deposit").fill("50");
  await ctx.close();
});

await check("manage: freeze and funding steps carry the contract's deposits", async () => {
  const { p, ctx } = await page(browser, "owner.testnet");
  await p.goto(`${BASE}/vault/manage/?v=${VAULT}&net=testnet`);
  const freeze = p.locator('[data-tx="freeze"]');
  await freeze.waitFor();
  await freeze.getByRole("button", { name: "Freeze now" }).click();
  await freeze.getByText("Done").waitFor();
  const sent = await p.evaluate(() => window.__itSent);
  assert.deepEqual({ r: sent[0].receiverId, m: sent[0].methodName, d: sent[0].depositYocto, a: sent[0].args }, { r: VAULT, m: "freeze", d: "1", a: {} });
  // wNEAR not registered for the vault, USDC registered, Rhea storage missing → those steps, then wrap and deposit.
  const fund = await p.locator("ol [data-tx]").evaluateAll(n => n.map(x => x.getAttribute("data-tx")));
  assert.deepEqual(fund, ["storage_deposit", "exchange_storage_deposit", "exchange_register_tokens", "storage_deposit", "near_deposit", "ft_transfer_call"]);
  await p.getByText("near account add-key bot.testnet grant-function-call-access").waitFor();
  await ctx.close();
});

await check("manage: a non-owner can't sign owner actions", async () => {
  const { p, ctx } = await page(browser, "stranger.testnet");
  await p.goto(`${BASE}/vault/manage/?v=${VAULT}&net=testnet`);
  const freeze = p.locator('[data-tx="freeze"]');
  await freeze.waitFor();
  assert.equal(await freeze.getByRole("button", { name: "Freeze now" }).isDisabled(), true);
  await freeze.getByText("only the owner can sign this").waitFor();
  await ctx.close();
});

await check("manage: a vault from another factory is refused", async () => {
  const { p, ctx } = await page(browser, "owner.testnet");
  await p.goto(`${BASE}/vault/manage/?v=evil.attacker.testnet&net=testnet`);
  await p.getByText("isn't a vault from").waitFor();
  assert.equal(await p.locator("[data-tx]").count(), 0);
  await ctx.close();
});

await check("390 px: no sideways scroll on either page", async () => {
  const { p, ctx } = await page(browser, "owner.testnet", { width: 390, height: 844 });
  for (const [path, ready] of [[`/vault/?net=testnet`, "text=Create a vault"], [`/vault/manage/?v=${VAULT}&net=testnet`, "[data-tx]"]]) {
    await p.goto(`${BASE}${path}`);
    await p.locator(ready).first().waitFor();
    const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= iw, `${path}: scrollWidth ${sw} > ${iw}`);
  }
  await ctx.close();
});

await browser.close();
server.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
