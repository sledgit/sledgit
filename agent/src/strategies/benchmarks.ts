// Benchmarks that never trade, so they need no vault: computed from the start value and the same daily closes.
// Stake & hold can't run on testnet (the vault has no staking method); it compounds the NEAR half at a stated APR,
// the post-2024 rate bt.py uses (4.5%). Both are labelled "computed" wherever they appear.

export const STAKE_APR = 0.045;
const DAY = 86_400_000;

export interface Point { t: number; value: number }

/** 50/50 at the first close, never trades. */
export function hold5050(start: number, closes: [number, number][]): Point[] {
  if (!closes.length) return [];
  const p0 = closes[0][1];
  const near = start / 2 / p0;
  return closes.map(([t, p]) => ({ t, value: start / 2 + near * p }));
}

/** 50/50 with the NEAR half staked: it grows by the APR, compounded daily, from the first close. */
export function stakeHold(start: number, closes: [number, number][], apr = STAKE_APR): Point[] {
  if (!closes.length) return [];
  const [t0, p0] = closes[0];
  const near = start / 2 / p0;
  return closes.map(([t, p]) => ({ t, value: start / 2 + near * (1 + apr / 365) ** ((t - t0) / DAY) * p }));
}
