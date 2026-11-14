// Per-vault deposit caps (set by the factory at creation). Pure helpers; the chain read is in chain.ts.
export interface DepositCap { token: string; max: string; net_deposited: string }

/** How much more of `token` the vault accepts: null = no cap (or code without caps); 0n = none. Mirrors the contract. */
export function capRoom(caps: DepositCap[] | null, token: string): bigint | null {
  if (!caps || caps.length === 0) return null;
  const c = caps.find(x => x.token === token);
  if (!c) return 0n;
  const room = BigInt(c.max) - BigInt(c.net_deposited);
  return room > 0n ? room : 0n;
}
