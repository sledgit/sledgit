// Is an account a genuine Sledgit vault? Only then do its events mean "the vault's policy enforced this decision".
// A genuine vault is a direct sub-account of a known factory (only the factory can create those) running exactly the
// global code it pins, with no access keys, initialised with the pinned exchange/intents/MPC ids.
// Any contract can log a vault-shaped event, so receipts and records from anything else are reported as unverified.
// No imports with side effects: the MCP server uses this module and must not load key-handling code.

export interface KnownFactory {
  id: string;
  /** The global vault code this factory was locked with. Pinned here, never read from the factory's live answer. */
  vault_code_hash: string;
  /** false: the factory account still holds a key; its children are reported as legacy, never as genuine. */
  locked: boolean;
  /** Set when the factory was superseded: its children are still genuine history (locked, pinned code), never ranked. */
  retired?: string;
  /** The exchange, intents and MPC contracts this factory gives every vault. Pinned here, never read from the factory:
   *  a look-alike factory on the same code could hand its vaults another exchange (final-review-2 F2-01). */
  bound: { exchange_id: string; intents_id: string; mpc_id: string };
}

const TESTNET_BOUND = { exchange_id: "ref-finance-101.testnet", intents_id: "it1793205011-intents.testnet", mpc_id: "v1.signer-prod.testnet" };

/** Known factories per network. Configured here, never taken from tool input. */
export const FACTORIES: Record<"testnet" | "mainnet", KnownFactory[]> = {
  testnet: [
    { id: "arena2.irontrade.testnet", vault_code_hash: "2ZP4H1ENzFKyN4nVSZf9vKf3pEpgoup9DVU6NbjbE2Gg", locked: true, bound: TESTNET_BOUND },
    { id: "arena.irontrade.testnet", vault_code_hash: "5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ", locked: true,
      retired: "legacy factory (pre-round-3 code)", bound: TESTNET_BOUND },
    // Legacy: pre-round-2 code, and the account still holds a full-access key (audits/phase-2-review.md P2-3).
    { id: "irontrade.testnet", vault_code_hash: "zSZ8hT8PinALB1cd95KBrmZQDmpWnamFqfFTYemZfyk", locked: false, bound: TESTNET_BOUND },
  ],
  mainnet: [
    // The public factory, launching 1 Nov. Until then provenance fails closed: the account doesn't exist, and the
    // placeholder hash matches no code. Replace it with the reproducible-build hash at the 1 Nov tag.
    { id: "arena.sledgit.near", vault_code_hash: "REPLACE-WITH-THE-REPRODUCIBLE-BUILD-HASH-AT-THE-1-NOV-TAG", locked: true,
      bound: { exchange_id: "v2.ref-finance.near", intents_id: "intents.near", mpc_id: "v1.signer" } },
  ],
};

export interface ChainReader {
  viewAccount(id: string): Promise<{ global_contract_hash?: string | null; code_hash?: string }>;
  accessKeyCount(id: string): Promise<number>;
  view<T>(id: string, method: string): Promise<T>;
}

export interface Provenance {
  sledgit_vault: boolean;
  /** genuine: counts as a Sledgit vault. legacy: child of a factory that still holds a key (history only). */
  status: "genuine" | "legacy" | "unverified";
  reason: string;
  factory?: string;
  factory_locked?: boolean;
  /** Genuine, but from a superseded factory: history, not ranked. */
  retired?: string;
  code_hash?: string | null;
  access_keys?: number;
}

/** Contract ids the factory hands every vault at creation; a vault initialised with others isn't the factory's. */
const BOUND = ["exchange_id", "intents_id", "mpc_id"] as const;

export async function vaultProvenance(vault: string, network: "testnet" | "mainnet", r: ChainReader): Promise<Provenance> {
  const known = FACTORIES[network];
  const dot = vault.indexOf(".");
  const parent = dot > 0 ? vault.slice(dot + 1) : "";
  const f = known.find((k) => k.id === parent);
  if (!f) {
    return { sledgit_vault: false, status: "unverified",
      reason: `${vault} is not a direct sub-account of a known Sledgit factory on ${network} (${known.map((k) => k.id).join(", ") || "none yet"})` };
  }
  let acct: Awaited<ReturnType<ChainReader["viewAccount"]>>, keys: number, factoryKeys: number, fcfg: Record<string, unknown>, vcfg: Record<string, unknown>;
  try {
    [acct, keys, factoryKeys, fcfg, vcfg] = await Promise.all([
      r.viewAccount(vault), r.accessKeyCount(vault), r.accessKeyCount(f.id),
      r.view<Record<string, unknown>>(f.id, "get_config"), r.view<Record<string, unknown>>(vault, "get_config"),
    ]);
  } catch (e) {
    return { sledgit_vault: false, status: "unverified", factory: f.id, reason: `could not read ${vault} or ${f.id}: ${(e as Error).message.slice(0, 160)}` };
  }
  const base = { factory: f.id, factory_locked: f.locked && factoryKeys === 0, code_hash: acct.global_contract_hash ?? null, access_keys: keys };
  const no = (reason: string): Provenance => ({ ...base, sledgit_vault: false, status: "unverified", reason });
  if (acct.global_contract_hash !== f.vault_code_hash) {
    return no(`${vault} does not run the code ${f.id} was locked with (${String(acct.global_contract_hash ?? acct.code_hash)} vs ${f.vault_code_hash})`);
  }
  if (keys !== 0) return no(`${vault} has ${keys} access key(s); Sledgit vaults have none`);
  const off = BOUND.filter((k) => vcfg[k] !== f.bound[k]);
  if (off.length) return no(`${vault} was initialised with ${off.join(", ")} other than the pinned ${off.map((k) => f.bound[k]).join(", ")}`);
  const foff = BOUND.filter((k) => fcfg[k] !== f.bound[k]);
  if (foff.length) return no(`${f.id} reports ${foff.join(", ")} other than the pinned values; not the expected factory`);
  // A factory with any key can be redeployed by its holder, who could then create a look-alike child: history only.
  if (!f.locked || factoryKeys !== 0) {
    return { ...base, sledgit_vault: false, status: "legacy",
      reason: `legacy: child of ${f.id}, which holds ${factoryKeys} access key(s), so its children can't be trusted as genuine` };
  }
  return { ...base, sledgit_vault: true, status: "genuine", ...(f.retired ? { retired: f.retired } : {}),
    reason: `direct child of ${f.id} (factory keyless), runs its pinned code ${f.vault_code_hash}, 0 access keys`
      + (f.retired ? `; ${f.retired}: history, not ranked` : "") };
}

/** One lookup per vault per run. */
export function cachedProvenance(network: "testnet" | "mainnet", r: ChainReader): (vault: string) => Promise<Provenance> {
  const seen = new Map<string, Promise<Provenance>>();
  return (vault) => {
    let p = seen.get(vault);
    if (!p) { p = vaultProvenance(vault, network, r); seen.set(vault, p); }
    return p;
  };
}
