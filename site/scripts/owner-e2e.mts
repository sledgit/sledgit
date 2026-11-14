// Testnet end-to-end for the owner app: the SAME transaction builders the site uses (src/lib/owner), signed here by a
// throwaway owner instead of a browser wallet. Creates a vault, funds it, freezes it, withdraws.
//   cd site && node --import tsx scripts/owner-e2e.mts            (testnet only; keys from ~/.config/sledgit)
// The throwaway owner's key is written 0600 next to the others and never printed.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OWNER_NETS } from "../src/lib/owner/config";
import { buildPolicy } from "../src/lib/owner/policy";
import * as T from "../src/lib/owner/tx";
import { parseUnits } from "../src/lib/owner/units";

// near-api-js is ESM-only and installed for the agent; load its entry directly.
const { Account, JsonRpcProvider, KeyPair, actions, teraToGas } =
  await import(new URL("../../agent/node_modules/near-api-js/lib/index.js", import.meta.url).href) as typeof import("near-api-js");

const on = OWNER_NETS.testnet;
const TREASURY = "it1793205219-owner.testnet";
const NEW_KEYS = join(homedir(), ".config/sledgit"), OLD_KEYS = join(homedir(), ".config/iron-trades"); // legacy: remove after the server redeploy
const KEYS = !existsSync(NEW_KEYS) && existsSync(OLD_KEYS) ? OLD_KEYS : NEW_KEYS;
const provider = new JsonRpcProvider({ url: on.net.rpc });
if (!on.factory || !on.net.rpc.includes("testnet")) throw new Error("testnet only");

function keyFor(account: string): string {
  for (const f of readdirSync(KEYS).filter(f => f.startsWith("testnet-") && f.endsWith(".json"))) {
    const d = JSON.parse(readFileSync(join(KEYS, f), "utf8"));
    if (Array.isArray(d.accounts) && d.accounts.includes(account) && typeof d.secret_key === "string") return d.secret_key;
  }
  throw new Error(`no key for ${account}`);
}
const view = <R>(contractId: string, method: string, args: object = {}) => provider.callFunction({ contractId, method, args }) as Promise<R>;

type Outcome = { status: Record<string, unknown>; transaction: { hash: string }; receipts_outcome: { outcome: { status: Record<string, unknown>; logs: string[] } }[] };
async function send(acct: InstanceType<typeof Account>, p: T.PlannedTx): Promise<{ hash: string; ok: boolean; value?: string }> {
  const r = await acct.signAndSendTransaction({ receiverId: p.receiverId, waitUntil: "FINAL", throwOnFailure: false,
    actions: [actions.functionCall(p.methodName, p.args, teraToGas(p.gasTgas), p.depositYocto)] }) as unknown as Outcome;
  const failed = "Failure" in r.status || r.receipts_outcome.some(o => "Failure" in o.outcome.status);
  const v = r.status.SuccessValue as string | undefined;
  return { hash: r.transaction.hash, ok: !failed, value: v ? Buffer.from(v, "base64").toString() : undefined };
}

const ts = Math.floor(Date.now() / 1000);
const owner = `owner-e2e-${ts}.${TREASURY}`;
const agent = `agent-e2e-${ts}.${TREASURY}`;
const name = `e2e-${ts}`;
const vault = `${name}.${on.factory}`;
const log: { step: string; tx: string; ok: boolean; note?: string }[] = [];
const step = async (label: string, acct: InstanceType<typeof Account>, p: T.PlannedTx) => {
  const r = await send(acct, p);
  log.push({ step: label, tx: r.hash, ok: r.ok, note: r.value });
  console.log(`${r.ok ? "ok  " : "FAIL"} ${label}  ${r.hash}${r.value ? `  -> ${r.value}` : ""}`);
  if (!r.ok) throw new Error(`${label} failed (${r.hash})`);
};

// 1. A throwaway owner with its own full-access key (the role a browser wallet plays on the site).
const keyFile = join(KEYS, `testnet-owner-e2e-${ts}.json`);
if (existsSync(keyFile)) throw new Error("key file exists");
const ownerKey = KeyPair.fromRandom("ed25519");
writeFileSync(keyFile, JSON.stringify({ accounts: [owner], secret_key: ownerKey.toString() }), { mode: 0o600, flag: "wx" });
const treasury = new Account(TREASURY, provider, keyFor(TREASURY) as `ed25519:${string}`);
const created = await treasury.signAndSendTransaction({ receiverId: owner, waitUntil: "FINAL", throwOnFailure: false,
  actions: [actions.createAccount(), actions.transfer(parseUnits("1.5", 24)), actions.addFullAccessKey(ownerKey.getPublicKey())] }) as unknown as Outcome;
log.push({ step: "create throwaway owner", tx: created.transaction.hash, ok: !("Failure" in created.status) });
console.log(`ok   create throwaway owner ${owner}  ${created.transaction.hash}`);
const me = new Account(owner, provider, ownerKey.toString() as `ed25519:${string}`);

// 2. Create the vault exactly as the site's form would.
const cfg = await view<{ min_deposit: string; max_deposit: string }>(on.factory, "get_config");
const d = on.defaults;
const { policy, errors } = buildPolicy({ tradeBase: d.tradeBase, dayBase: d.dayBase, tradeQuote: d.tradeQuote, dayQuote: d.dayQuote,
  sellFloor: d.sellFloor, buyFloor: d.buyFloor, tradesPerHour: String(d.tradesPerHour), slippageBps: String(d.slippageBps) }, { base: on.wrap, quote: on.quote, pool: on.pool });
if (!policy) throw new Error(errors.join("; "));
await step("create_vault", me, T.createVault({ factory: on.factory, name, owner, agent, policy, deposit: parseUnits(d.deposit, 24),
  minDeposit: BigInt(cfg.min_deposit), maxDeposit: BigInt(cfg.max_deposit) }));
const vc = await view<{ owner_id: string; frozen: boolean }>(vault, "get_config");
if (vc.owner_id !== owner) throw new Error("vault owner mismatch");

// 3. Fund: the steps the manage page computes from on-chain registrations.
const reg = async (token: string, a: string) => (await view<unknown>(token, "storage_balance_of", { account_id: a })) !== null;
const fund = T.fundSteps({ vault, owner, wrap: on.wrap.id, quote: on.quote.id, amount: parseUnits(d.fund, 24),
  vaultRegistered: { wrap: await reg(on.wrap.id, vault), quote: await reg(on.quote.id, vault) }, ownerRegisteredWrap: await reg(on.wrap.id, owner),
  exchangeStorage: await reg(on.net.rhea, vault), exchangeTokens: false });
for (const p of fund) await step(`fund: ${p.receiverId}.${p.methodName}`, me, p);
const bal = BigInt(await view<string>(on.wrap.id, "ft_balance_of", { account_id: vault }));
if (bal !== parseUnits(d.fund, 24)) throw new Error(`vault wNEAR ${bal}, expected ${parseUnits(d.fund, 24)}`);

// 4. Freeze, then withdraw (withdrawal works while frozen: the owner's way out).
await step("freeze", me, T.freeze(vault));
if (!(await view<{ frozen: boolean }>(vault, "get_config")).frozen) throw new Error("not frozen");
const out = parseUnits("0.2", 24);
await step("withdraw wNEAR", me, T.withdraw(vault, on.wrap.id, out, on.wrap.symbol, on.wrap.decimals));
const after = BigInt(await view<string>(on.wrap.id, "ft_balance_of", { account_id: vault }));
if (after !== bal - out) throw new Error(`vault wNEAR after withdraw ${after}, expected ${bal - out}`);

const result = { network: "testnet", factory: on.factory, vault, owner, agent, wnear_in_vault: after.toString(), steps: log, at: new Date().toISOString() };
writeFileSync(new URL(`../../deploy/testnet/owner-e2e-${ts}.json`, import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(`all ok: ${vault} (owner ${owner}); result deploy/testnet/owner-e2e-${ts}.json`);
