// The arena pair per network and its tokens' decimals, pinned. Key-free (no near-api-js), so verifiers and the MCP
// server can use it; receipts never supply these values.
export type PairNetwork = "testnet" | "mainnet";

export interface Pair { base: string; quote: string; decimals: Record<string, number> }

export const PAIRS: Record<PairNetwork, Pair> = {
  testnet: { base: "wrap.testnet", quote: "usdc.itachicara.testnet", decimals: { "wrap.testnet": 24, "usdc.itachicara.testnet": 24 } },
  // Native USDC (Circle, implicit account), the token in Rhea pool 4512 (wNEAR/USDC), the Season 1 pool.
  mainnet: { base: "wrap.near", quote: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: { "wrap.near": 24, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": 6 } },
};

/** The pinned pair for a receipt's network, or undefined for anything else. */
export function pinnedPair(network: unknown): Pair | undefined {
  return Object.hasOwn(PAIRS, String(network)) ? PAIRS[network as PairNetwork] : undefined;
}
