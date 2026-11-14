// Exact conversion between what a person types ("0.5") and a token's smallest unit, with bigint only. No floats:
// a vault cap is an integer on chain, and a rounding error here would sign a different cap than the one shown.

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** "1.25" at 24 decimals → 1250000000000000000000000n. Rejects signs, exponents, separators and excess precision. */
export function parseUnits(text: string, decimals: number): bigint {
  const s = text.trim();
  if (!DECIMAL.test(s)) throw new Error(`"${text}" is not a plain decimal number`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** 1250000000000000000000000n at 24 decimals → "1.25". Exact; trailing zeros dropped. */
export function formatUnits(v: bigint, decimals: number): string {
  if (v < 0n) return "-" + formatUnits(-v, decimals);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/** A price "out per in" in human units → the contract's band ratio in smallest units, reduced. The band check is
 *  amount_out_smallest ≥ amount_in_smallest × num / den. */
export function priceRatio(price: string, decIn: number, decOut: number): { num: bigint; den: bigint } {
  const s = price.trim();
  if (!DECIMAL.test(s)) throw new Error(`"${price}" is not a plain decimal number`);
  const [whole, frac = ""] = s.split(".");
  let num = BigInt(whole + frac);
  let den = 10n ** BigInt(frac.length);
  if (num === 0n) throw new Error("the price floor must be above zero");
  if (decOut >= decIn) num *= 10n ** BigInt(decOut - decIn); else den *= 10n ** BigInt(decIn - decOut);
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** The inverse of priceRatio, for display: the band as a human price. */
export function ratioPrice(num: bigint, den: bigint, decIn: number, decOut: number, places = 6): string {
  // price = num/den × 10^(decIn − decOut)
  let n = num, d = den;
  if (decIn >= decOut) n *= 10n ** BigInt(decIn - decOut); else d *= 10n ** BigInt(decOut - decIn);
  const scaled = (n * 10n ** BigInt(places)) / d;
  return formatUnits(scaled, places);
}
