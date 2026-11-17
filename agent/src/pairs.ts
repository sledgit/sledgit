// The arena pair per network and its tokens' decimals, pinned. Key-free (no near-api-js), so verifiers and the MCP
// server can use it; receipts never supply these values.
export type PairNetwork = "testnet" | "mainnet";

export interface Pair {
  base: string;
  quote: string;
  decimals: Record<string, number>;
  /** Liquid-staking token for staked vaults, and the view that gives its redemption rate (yocto base per token). */
  stake?: { token: string; rate_method: string };
}

export const PAIRS: Record<PairNetwork, Pair> = {
  testnet: { base: "wrap.testnet", quote: "usdc.itachicara.testnet", decimals: { "wrap.testnet": 24, "usdc.itachicara.testnet": 24 } },
  // Native USDC (Circle, implicit account), the token in Rhea pool 4512 (wNEAR/USDC), the Season 1 pool.
  mainnet: { base: "wrap.near", quote: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: { "wrap.near": 24, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": 6, "meta-pool.near": 24 },
    // stNEAR (Meta Pool), traded against wNEAR in Rhea rated pool 3514.
    stake: { token: "meta-pool.near", rate_method: "get_st_near_price" } },
};

/** The pinned pair for a receipt's network, or undefined for anything else. */
export function pinnedPair(network: unknown): Pair | undefined {
  return Object.hasOwn(PAIRS, String(network)) ? PAIRS[network as PairNetwork] : undefined;
}

export type Leg = "buy" | "sell" | "stake" | "unstake";

/** Token in and out for an action: buy spends quote for base, sell the reverse; stake swaps base for the staking token,
 * unstake the reverse. Undefined when the pair has no staking token. */
export function legs(pair: Pair, action: Leg): [string, string] | undefined {
  if (action === "buy") return [pair.quote, pair.base];
  if (action === "sell") return [pair.base, pair.quote];
  if (!pair.stake) return undefined;
  return action === "stake" ? [pair.base, pair.stake.token] : [pair.stake.token, pair.base];
}
