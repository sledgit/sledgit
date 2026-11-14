import type { Bot } from "./feed/types";
import { entryName, leagueFor, TESTNET_LEAGUE, TN_BENCH, type LeagueSnapshot } from "./feed/league-data";

// Per-network contracts. Simulated needs none; testnet and mainnet read real vaults into committed snapshots.
export type NetworkId = "sim" | "testnet" | "mainnet";
export const NETWORK_IDS: NetworkId[] = ["sim", "testnet", "mainnet"];
export const isNetwork = (x: unknown): x is NetworkId => NETWORK_IDS.includes(x as NetworkId);

/** The network the site leads with: default tab, home board, ticker, season copy. Set to "mainnet" to go live. */
export const LIVE_NETWORK = "mainnet" as Exclude<NetworkId, "sim">;
export const LIVE_LEAGUE = leagueFor(LIVE_NETWORK);

export interface Token { id: string; symbol: string; decimals: number }
export interface VaultConfig { id: string; name: string; account: string; note: string }
export interface NetworkConfig {
  id: Exclude<NetworkId, "sim">;
  label: string;
  rpc: string;
  explorer: string;
  txApi?: string;       // FastNEAR transactions API: lists an account's transactions, CORS-enabled
  rhea: string;         // Rhea (Ref Finance) exchange contract
  intents?: string;     // NEAR Intents contract (on testnet: our own copy)
  mpc: string;          // chain signatures signer
  factory?: string;     // the locked vault factory
  tokens: Token[];      // first is the traded asset, second the quote (USDC)
  pool?: number;        // Rhea pool used for the reference price
  vaults: VaultConfig[];
}

export const NETWORKS: Record<NetworkConfig["id"], NetworkConfig> = {
  testnet: {
    id: "testnet", label: "NEAR testnet",
    rpc: "https://rpc.testnet.fastnear.com",
    explorer: "https://testnet.nearblocks.io",
    txApi: "https://tx.test.fastnear.com",
    rhea: "ref-finance-101.testnet",
    intents: "it1793205011-intents.testnet",
    mpc: "v1.signer-prod.testnet",
    factory: "arena2.irontrade.testnet",
    tokens: [
      { id: "wrap.testnet", symbol: "wNEAR", decimals: 24 },
      { id: "usdc.itachicara.testnet", symbol: "USDC", decimals: 24 },
    ],
    pool: 1103,
    // Every vault the locked factory created, as read from the chain into the committed snapshot.
    vaults: vaultsOf(TESTNET_LEAGUE),
  },
  mainnet: {
    id: "mainnet", label: "NEAR mainnet",
    rpc: "https://rpc.mainnet.fastnear.com",
    explorer: "https://nearblocks.io",
    txApi: "https://tx.main.fastnear.com",
    rhea: "v2.ref-finance.near",
    intents: "intents.near",
    mpc: "v1.signer",
    factory: "arena.sledgit.near",
    tokens: [
      { id: "wrap.near", symbol: "wNEAR", decimals: 24 },
      { id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC", decimals: 6 },
    ],
    pool: 4512,
    // Empty until deploy/mainnet/league/snapshot.json exists.
    vaults: vaultsOf(leagueFor("mainnet")),
  },
};

function vaultsOf(L: LeagueSnapshot | null): VaultConfig[] {
  return (L?.entries ?? []).map(e => ({ id: e.id, name: entryName(e), account: e.account, note: e.description }));
}

/** An account without the factory suffix: "qwen36-tee", not "qwen36-tee.arena2.irontrade.testnet". */
export const shortAccount = (n: NetworkConfig, a: string) => (n.factory && a.endsWith(`.${n.factory}`) ? a.slice(0, -n.factory.length - 1) : a);

export const explorerTx = (n: NetworkConfig, hash: string) => `${n.explorer}/txns/${hash}`;
export const explorerAccount = (n: NetworkConfig, account: string) => `${n.explorer}/address/${account}`;

const VAULT_COLORS = ["#D4FF3A", "#7FD1FF", "#FFB547", "#C792FF", "#5EF2C1", "#FF7AB6", "#B0B8B2", "#FFE36E", "#8FA2FF", "#9CE37D", "#FF9466", "#6EE7E7"];
const KIND: Record<string, Bot["kind"]> = { arena: "arena", house: "house", fixture: "vault", retired: "vault", unregistered: "vault" };
export function vaultBots(n: NetworkConfig): Bot[] {
  const league = leagueFor(n.id);
  return n.vaults.map((v, i) => {
    const e = league?.entries.find(x => x.id === v.id);
    if (!e) return { id: v.id, name: v.name, strategy: "Rhea and NEAR Intents", description: v.note,
      color: VAULT_COLORS[i % VAULT_COLORS.length], tag: "TEST", kind: "vault", proof: "self", harness: "test scripts and CLI", model: "—",
      owner: "test accounts", account: v.account, strategyHash: "none: driven by test commands" };
    // Proof and strategy hash are what the snapshot proved, not what the entry claims.
    return { id: e.id, name: entryName(e), description: e.description, color: VAULT_COLORS[i % VAULT_COLORS.length],
      strategy: e.kind === "house" ? "open rules" : e.kind === "fixture" ? "test fixture" : e.model,
      tag: e.kind === "fixture" ? "TEST" : e.kind === "house" ? "HOUSE" : "ARENA", kind: KIND[e.kind], proof: e.proof.tier,
      harness: e.harness, model: e.model, owner: n.id === "testnet" ? "test accounts" : "vault owner", account: e.account,
      strategyHash: e.strategy_sha256 ?? (e.kind === "house" ? "none: house-rerun did not confirm a strategy hash" : "none") };
  });
}

/** Testnet benchmarks: computed from reference prices, no vault. */
export function benchBots(n: NetworkConfig): Bot[] {
  if (n.id !== "testnet") return [];
  const apr = TESTNET_LEAGUE.benchmarks.stake_apr;
  return [
    { id: TN_BENCH.hold, name: "Hold 50/50", strategy: "computed: 50/50 from each entry's start, never trades", tag: "HOLD", color: "#7d8a99", kind: "benchmark",
      proof: "computed", harness: "—", model: "—", owner: "computed", account: "none (computed benchmark)", strategyHash: "none: computed",
      description: "Computed from reference prices, not a vault. Each entry's vs-hold uses its own start value, time and price, and pays the entry's own cost rate on the one rebalance to 50/50." },
    { id: TN_BENCH.stake, name: "Stake & hold", strategy: `computed: 50/50, NEAR half at ${(apr.value * 100).toFixed(1)}% APR (assumed)`, tag: "STAKE", color: "#56616e", kind: "benchmark",
      proof: "computed", harness: "—", model: "—", owner: "computed", account: "none (computed benchmark)", strategyHash: "none: computed",
      description: `Computed, not a vault: Hold 50/50 with the NEAR half compounding at ${(apr.value * 100).toFixed(1)}% a year. The APR is an assumption: ${apr.source}.` },
  ];
}

// The network a vault bot belongs to, if it is one.
export function networkOfBot(id: string): NetworkConfig | undefined {
  return Object.values(NETWORKS).find(n => n.vaults.some(v => v.id === id));
}

// Raw on-chain integer string to a display number. Float precision is fine for display.
export function tokenAmount(n: NetworkConfig, token: string, raw: string): number {
  const t = n.tokens.find(x => x.id === token);
  return Number(raw) / 10 ** (t?.decimals ?? 0);
}

export function formatToken(n: NetworkConfig, token: string, raw: string): string {
  const t = n.tokens.find(x => x.id === token);
  if (!t) return `${raw} ${token} (unknown decimals)`;
  const v = tokenAmount(n, token, raw);
  return `${v.toLocaleString("en-US", { maximumFractionDigits: v !== 0 && Math.abs(v) < 0.01 ? 8 : 4 })} ${t.symbol}`;
}
