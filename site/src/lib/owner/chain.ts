// Read-only chain state the owner app shows. Everything here is a view call; nothing signs.
import { accountQuery, view } from "../feed/near";
import type { NetworkConfig } from "../networks";
import type { DepositCap } from "./caps";
import type { PolicyArgs } from "./policy";

export interface FactoryConfig { code_hash: string; min_deposit: string; max_deposit?: string; owed_refunds?: string; vaults: number;
  deposit_caps?: { token: string; max: string }[] }
export interface VaultConfig { owner_id: string; proposed_owner: string | null; agent_id: string; exchange_id: string; frozen: boolean; seq: number }
export interface Pending { value: PolicyArgs; applies_at: string }

export const factoryConfig = (n: NetworkConfig, factory: string) => view<FactoryConfig>(n, factory, "get_config");
export const vaultConfig = (n: NetworkConfig, vault: string) => view<VaultConfig>(n, vault, "get_config");
export const vaultPolicy = (n: NetworkConfig, vault: string) => view<PolicyArgs>(n, vault, "get_policy");
export const vaultPending = (n: NetworkConfig, vault: string) => view<Pending | null>(n, vault, "get_pending_policy");
export const vaultUsage = (n: NetworkConfig, vault: string) => view<unknown>(n, vault, "get_usage");
export const vaultInFlight = (n: NetworkConfig, vault: string) => view<unknown>(n, vault, "get_in_flight");
export const vaultIntents = (n: NetworkConfig, vault: string) => view<unknown>(n, vault, "get_intents");
/** The vault's deposit caps; null when its code predates caps (no such method). Any other error propagates. */
export async function vaultDepositCaps(n: NetworkConfig, vault: string): Promise<DepositCap[] | null> {
  try { return await view<DepositCap[]>(n, vault, "get_deposit_caps"); }
  catch (e) { if (/MethodNotFound/.test(String(e))) return null; throw e; }
}
export const refundOf = (n: NetworkConfig, factory: string, account: string) => view<string>(n, factory, "get_refund", { account_id: account });

export const ftBalance = (n: NetworkConfig, token: string, account: string) =>
  view<string>(n, token, "ft_balance_of", { account_id: account }).then(BigInt);
export const ftRegistered = (n: NetworkConfig, token: string, account: string) =>
  view<unknown>(n, token, "storage_balance_of", { account_id: account }).then(r => r !== null);
/** Rhea: the vault's storage registration and its per-token deposits on the exchange. */
export const exchangeStorage = (n: NetworkConfig, account: string) =>
  view<unknown>(n, n.rhea, "storage_balance_of", { account_id: account }).then(r => r !== null);
export const exchangeDeposits = (n: NetworkConfig, account: string) =>
  view<Record<string, string>>(n, n.rhea, "get_deposits", { account_id: account });

export interface AccountView { amount: string; locked: string; code_hash: string; storage_usage: number }
export const accountView = (n: NetworkConfig, account: string) => accountQuery<AccountView>(n, "view_account", account);
export const accessKeys = (n: NetworkConfig, account: string) =>
  accountQuery<{ keys: unknown[] }>(n, "view_access_key_list", account).then(r => r.keys.length);

/** Vaults this account owns, from the factory's list (newest first, at most `limit`), plus any that didn't answer. */
export async function ownedVaults(n: NetworkConfig, factory: string, owner: string, limit = 100): Promise<{ vaults: string[]; unreadable: string[] }> {
  const cfg = await factoryConfig(n, factory);
  const from = Math.max(0, cfg.vaults - limit);
  const list = await view<string[]>(n, factory, "get_vaults", { from_index: from, limit });
  const vaults: string[] = [], unreadable: string[] = [];
  for (const v of list.reverse()) {
    try { if ((await vaultConfig(n, v)).owner_id === owner) vaults.push(v); }
    catch (e) { console.warn(`owner app: ${v} get_config failed`, e); unreadable.push(v); }
  }
  return { vaults, unreadable };
}

const EMPTY_CODE = "11111111111111111111111111111111";
/** Before an account gets an agent's trade rights: it must exist and not be the owner, the vault or the factory.
 *  Warnings: no keys (nobody can sign as it yet), deployed code (a contract, not a bot), an unusual id. */
export async function checkAgent(n: NetworkConfig, agent: string, o: { owner: string; vault: string; factory: string }):
  Promise<{ problems: string[]; warnings: string[] }> {
  const problems: string[] = [], warnings: string[] = [];
  if (agent === o.owner || agent === o.vault || agent === o.factory) problems.push("the agent must be a separate account: not the owner, the vault or the factory");
  const suffix = n.id === "mainnet" ? ".near" : ".testnet";
  if (!agent.endsWith(suffix) && !/^[0-9a-f]{64}$/.test(agent)) warnings.push(`unusual account id for ${n.label} (expected …${suffix} or a 64-hex implicit account)`);
  let acct: AccountView | undefined;
  try { acct = await accountView(n, agent); }
  catch (e) { problems.push(`${agent} doesn't exist on ${n.label} (${e instanceof Error ? e.message.slice(0, 80) : "lookup failed"}): a typo would hand trade rights to whoever registers it`); }
  if (acct) {
    if (acct.code_hash !== EMPTY_CODE) warnings.push(`${agent} has a contract deployed: agents are normally plain accounts`);
    try { if ((await accessKeys(n, agent)) === 0) warnings.push(`${agent} has no access keys yet: nobody can sign as it until its operator adds one`); }
    catch (e) { console.warn("owner app: access key check failed", e); warnings.push("couldn't read the agent's keys"); }
  }
  return { problems, warnings };
}
