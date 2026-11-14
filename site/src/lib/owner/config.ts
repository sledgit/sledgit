// What the owner app needs per network. Contract ids, tokens and factories come from networks.ts; the season
// defaults are listed here. Mainnet stays disabled until it is the live network.
import { LIVE_NETWORK, NETWORKS, type NetworkConfig, type Token } from "../networks";

export interface OwnerNet {
  id: "testnet" | "mainnet";
  net: NetworkConfig;
  factory: string | null;   // null: no factory yet, so creating vaults is disabled
  wrap: Token;              // wNEAR, the traded asset
  quote: Token;             // USDC
  pool: number;             // the canonical Rhea pool the league counts
  defaults: {
    tradeBase: string; dayBase: string; tradeQuote: string; dayQuote: string;
    sellFloor: string;      // lowest USDC per wNEAR a sale may fill at
    buyFloor: string;       // lowest wNEAR per USDC a purchase may fill at
    tradesPerHour: number; slippageBps: number; deposit: string; fund: string;
  };
}

export const OWNER_NETS: Record<"testnet" | "mainnet", OwnerNet> = {
  testnet: {
    id: "testnet", net: NETWORKS.testnet,
    factory: NETWORKS.testnet.factory ?? null,
    wrap: NETWORKS.testnet.tokens[0], quote: NETWORKS.testnet.tokens[1], pool: NETWORKS.testnet.pool ?? 1103,
    defaults: { tradeBase: "0.5", dayBase: "3", tradeQuote: "1", dayQuote: "5", sellFloor: "1.4", buyFloor: "0.33",
      tradesPerHour: 12, slippageBps: 100, deposit: "0.2", fund: "0.5" },
  },
  mainnet: {
    id: "mainnet", net: NETWORKS.mainnet, factory: LIVE_NETWORK === "mainnet" ? NETWORKS.mainnet.factory ?? null : null,
    wrap: NETWORKS.mainnet.tokens[0], quote: NETWORKS.mainnet.tokens[1], pool: NETWORKS.mainnet.pool ?? 4512,
    defaults: { tradeBase: "1.2", dayBase: "2.4", tradeQuote: "5", dayQuote: "10", sellFloor: "3.0", buyFloor: "0.17",
      tradesPerHour: 2, slippageBps: 100, deposit: "0.2", fund: "1" },
  },
};

/** Gas per owner call, in Tgas. Each is at or above the contract's own minimum (a test reads the contract's
 *  TG_ constants and checks this), with room for the cross-contract steps. */
export const GAS = {
  create_vault: 150, claim_refund: 30,
  storage_deposit: 30, near_deposit: 30, ft_transfer_call: 100,
  exchange_storage_deposit: 50, exchange_register_tokens: 50, exchange_withdraw: 150, exchange_claim_lostfound: 150,
  intents_setup: 150, intents_deposit: 100, intents_withdraw: 100, intents_cancel: 300, intents_settle: 100, intents_abandon: 30,
  withdraw: 50, withdraw_near: 30, freeze: 30, unfreeze: 30, propose_policy: 30, apply_policy: 30, cancel_policy: 30,
  set_agent: 30, propose_owner: 30, accept_owner: 30, clear_stuck: 30,
} as const;

/** Methods an agent's function-call key may call: exactly the vault's agent methods. */
export const AGENT_METHODS = ["request_swap", "request_intent_swap", "log_skip", "intents_cancel", "intents_settle", "freeze"] as const;

export const ONE_YOCTO = 1n;
export const NEAR_DECIMALS = 24;
export const TOKEN_STORAGE = 10n ** 22n;          // 0.01 NEAR, the storage_deposit the setup scripts attach
export const EXCHANGE_STORAGE = 10n ** 23n;       // 0.1 NEAR for Rhea's per-account storage
