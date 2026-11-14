// Every transaction the owner app can ask a wallet to sign, built in one place. The preview shows these objects
// exactly, and the wallet receives exactly these objects, so what you read is what you sign.
import { AGENT_METHODS, EXCHANGE_STORAGE, GAS, ONE_YOCTO, TOKEN_STORAGE } from "./config";
import type { PolicyArgs } from "./policy";
import { validAccount } from "./policy";
import { formatUnits } from "./units";

export interface PlannedTx {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gasTgas: number;
  depositYocto: bigint;
  title: string;      // what this does, in a sentence
}

/** The factory's name rule (contracts/factory valid_name): 2-32 chars of a-z, 0-9 and inner '-'. */
export const validVaultName = (n: string) => n.length >= 2 && n.length <= 32 && /^[a-z0-9-]+$/.test(n) && !n.startsWith("-") && !n.endsWith("-");

const need = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg); };
const amountStr = (v: bigint, what: string) => { need(v > 0n && v < 1n << 128n, `${what}: must be above zero`); return v.toString(); };
const tx = (receiverId: string, methodName: string, args: Record<string, unknown>, depositYocto: bigint, title: string): PlannedTx =>
  ({ receiverId, methodName, args, gasTgas: GAS[methodName as keyof typeof GAS], depositYocto, title });

export function createVault(o: { factory: string; name: string; owner: string; agent: string; policy: PolicyArgs; deposit: bigint;
  minDeposit: bigint; maxDeposit: bigint }): PlannedTx {
  need(validVaultName(o.name), "vault name: 2-32 characters of a-z, 0-9 and inner '-'");
  need(validAccount(o.owner) && validAccount(o.agent), "owner and agent must be valid NEAR account ids");
  need(o.agent !== o.owner, "the agent must be a different account from the owner");
  need(o.agent !== `${o.name}.${o.factory}` && o.agent !== o.factory, "the agent can't be the vault itself or the factory");
  need(o.deposit >= o.minDeposit && o.deposit <= o.maxDeposit,
    `deposit: between ${formatUnits(o.minDeposit, 24)} and ${formatUnits(o.maxDeposit, 24)} NEAR (the factory's season limits)`);
  return tx(o.factory, "create_vault", { name: o.name, owner_id: o.owner, agent_id: o.agent, policy: o.policy }, o.deposit,
    `Create ${o.name}.${o.factory}, owned by ${o.owner}, with ${formatUnits(o.deposit, 24)} NEAR (0.01 NEAR stays with the factory as its listing fee)`);
}

export const claimRefund = (factory: string, account: string) =>
  tx(factory, "claim_refund", { account_id: account }, 0n, "Claim a refund the factory recorded for a failed vault creation");

/** Funding, in order: register the vault with both tokens and with Rhea, wrap NEAR, send wNEAR to the vault. */
export function fundSteps(o: { vault: string; owner: string; wrap: string; quote: string; amount: bigint;
  vaultRegistered: { wrap: boolean; quote: boolean }; ownerRegisteredWrap: boolean; exchangeStorage: boolean; exchangeTokens: boolean }): PlannedTx[] {
  const steps: PlannedTx[] = [];
  if (!o.vaultRegistered.wrap) steps.push(tx(o.wrap, "storage_deposit", { account_id: o.vault }, TOKEN_STORAGE, `Register the vault with ${o.wrap} so it can hold wNEAR`));
  if (!o.vaultRegistered.quote) steps.push(tx(o.quote, "storage_deposit", { account_id: o.vault }, TOKEN_STORAGE, `Register the vault with ${o.quote} so it can hold USDC`));
  if (!o.exchangeStorage) steps.push(tx(o.vault, "exchange_storage_deposit", {}, EXCHANGE_STORAGE, "Pay Rhea's storage for the vault (the vault forwards it)"));
  if (!o.exchangeTokens) steps.push(tx(o.vault, "exchange_register_tokens", {}, ONE_YOCTO, "Register the policy's tokens on Rhea for the vault"));
  if (!o.ownerRegisteredWrap) steps.push(tx(o.wrap, "storage_deposit", { account_id: o.owner }, TOKEN_STORAGE, "Register your account with wNEAR"));
  steps.push(tx(o.wrap, "near_deposit", {}, o.amount, `Wrap ${formatUnits(o.amount, 24)} NEAR into wNEAR`));
  steps.push(tx(o.wrap, "ft_transfer_call", { receiver_id: o.vault, amount: amountStr(o.amount, "amount"), msg: "" }, ONE_YOCTO,
    `Send ${formatUnits(o.amount, 24)} wNEAR to the vault (it accepts deposits only from its owner)`));
  return steps;
}

// Owner actions. Every owner method asserts exactly 1 yoctoNEAR, which proves a full-access key signed.
export const freeze = (v: string) => tx(v, "freeze", {}, ONE_YOCTO, "Freeze: stop all trading now");
export const unfreeze = (v: string) => tx(v, "unfreeze", {}, ONE_YOCTO, "Unfreeze: allow trading again");
export const proposePolicy = (v: string, policy: PolicyArgs) =>
  tx(v, "propose_policy", { policy }, ONE_YOCTO, "Propose new limits: they apply only after the 24-hour timelock, so the record shows them in advance");
export const applyPolicy = (v: string) => tx(v, "apply_policy", {}, 0n, "Apply the proposed limits (allowed once the 24-hour timelock is over)");
export const cancelPolicy = (v: string) => tx(v, "cancel_policy", {}, ONE_YOCTO, "Cancel the proposed limits");
export const withdraw = (v: string, token: string, amount: bigint, symbol: string, decimals: number) =>
  tx(v, "withdraw", { token, amount: amountStr(amount, "amount") }, ONE_YOCTO, `Withdraw ${formatUnits(amount, decimals)} ${symbol} to the owner`);
export const withdrawNear = (v: string, amount: bigint) =>
  tx(v, "withdraw_near", { amount: amountStr(amount, "amount") }, ONE_YOCTO, `Withdraw ${formatUnits(amount, 24)} NEAR to the owner (the vault keeps its storage and a 0.5 NEAR gas reserve)`);
export function setAgent(v: string, agent: string, owner: string): PlannedTx {
  need(validAccount(agent) && agent !== owner && agent !== v, "the agent must be a valid account, not the owner and not the vault");
  return tx(v, "set_agent", { agent_id: agent }, ONE_YOCTO, `Replace the agent with ${agent} (the old agent's key stops working on this vault)`);
}
export function proposeOwner(v: string, newOwner: string, agent: string): PlannedTx {
  need(validAccount(newOwner) && newOwner !== agent && newOwner !== v, "the new owner must be a valid account, not the agent and not the vault");
  return tx(v, "propose_owner", { owner_id: newOwner }, ONE_YOCTO, `Propose ${newOwner} as the new owner (they must accept)`);
}
export const acceptOwner = (v: string) => tx(v, "accept_owner", {}, ONE_YOCTO, "Accept ownership of this vault");
export const exchangeWithdraw = (v: string, token: string, amount: bigint, symbol: string, decimals: number) =>
  tx(v, "exchange_withdraw", { token, amount: amountStr(amount, "amount") }, ONE_YOCTO, `Bring ${formatUnits(amount, decimals)} ${symbol} back from Rhea into the vault`);
export const claimLostfound = (v: string, token: string, symbol: string) =>
  tx(v, "exchange_claim_lostfound", { token }, ONE_YOCTO, `Claim ${symbol} that Rhea parked in the vault's lost-and-found`);
export const intentsSetup = (v: string) =>
  tx(v, "intents_setup", {}, ONE_YOCTO, "Derive the vault's Chain Signatures key and register it with NEAR Intents (once)");
export const intentsAbandon = (v: string) =>
  tx(v, "intents_abandon", {}, ONE_YOCTO, "Abandon an intent settlement can't resolve (an hour after its deadline; the cap stays reserved)");
export const intentsCancel = (v: string) => tx(v, "intents_cancel", {}, ONE_YOCTO, "Cancel the open intent by burning its nonce");
export const intentsSettle = (v: string) => tx(v, "intents_settle", {}, 0n, "Settle the open intent (anyone may call this)");
export const clearStuck = (v: string) => tx(v, "clear_stuck", {}, ONE_YOCTO, "Release a swap whose callbacks never came back (after 15 minutes; moves no funds)");

/** The command an agent's operator runs to give the agent a key that can only call this vault. No allowance cap on
 *  a lightly funded agent account: a small cap blocks the agent at its first call (see skill.md). */
export function agentKeyCommand(agent: string, vault: string, network: "testnet" | "mainnet"): string {
  return [
    `near account add-key ${agent} grant-function-call-access \\`,
    `  --allowance unlimited --contract-account-id ${vault} \\`,
    `  --function-names '${AGENT_METHODS.join(", ")}' \\`,
    `  autogenerate-new-keypair save-to-keychain network-config ${network} sign-with-keychain send`,
  ].join("\n");
}
