// Model output -> a validated decision, and decimal <-> smallest-unit amounts. Pure; no I/O.

export type Action = "buy" | "sell" | "hold";

export interface Decision {
  action: Action;
  /** Decimal string in token_in units: quote for "buy", base for "sell", "0" for "hold". */
  amount_in: string;
  reason: string;
}

/** On failure, `code` is a fixed identifier safe to record anywhere; `error` is detail for local logs only. */
export type Parsed = { ok: true; decision: Decision } | { ok: false; code: ParseCode; error: string };
export type ParseCode = "no_json" | "invalid_json" | "not_object" | "unexpected_fields" | "bad_action" | "bad_reason"
  | "hold_nonzero" | "bad_amount" | "zero_amount" | "imprecise_number";

const fail = (code: ParseCode, error: string): Parsed => ({ ok: false, code, error });

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
const MAX_REASON = 200;

/** Strip reasoning blocks and code fences, then take the one JSON object in the text. */
export function extractJson(text: string): string | null {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").trim();
  // A top-level array is returned whole (and rejected), never unwrapped to its first element.
  const arr = t.indexOf("[");
  const obj = t.indexOf("{");
  const isArr = arr >= 0 && (obj < 0 || arr < obj);
  const start = isArr ? arr : obj;
  const end = t.lastIndexOf(isArr ? "]" : "}");
  if (start < 0 || end <= start) return null;
  return t.slice(start, end + 1);
}

export function parseDecision(text: string): Parsed {
  const raw = extractJson(text);
  if (raw === null) return fail("no_json", "no JSON object in model output");
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return fail("invalid_json", `invalid JSON: ${(e as Error).message}`);
  }
  return validateDecision(v);
}

export function validateDecision(v: unknown): Parsed {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("not_object", "decision is not an object");
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["action", "amount_in", "reason"].includes(k));
  if (extra.length) return fail("unexpected_fields", `unexpected fields: ${extra.join(",")}`);
  if (o.action !== "buy" && o.action !== "sell" && o.action !== "hold") {
    return fail("bad_action", `action must be buy|sell|hold, got ${JSON.stringify(o.action)}`);
  }
  if (typeof o.reason !== "string" || !o.reason.trim()) return fail("bad_reason", "reason must be a non-empty string");
  if (typeof o.amount_in === "number" && !exactNumber(o.amount_in)) {
    return fail("imprecise_number", `amount_in ${o.amount_in} has more than ${MAX_NUMBER_DIGITS} significant digits; send it as a string`);
  }
  const amount = typeof o.amount_in === "number" ? numberToDecimal(o.amount_in) : o.amount_in;
  if (o.action === "hold") {
    if (amount !== undefined && amount !== null && !(typeof amount === "string" && DECIMAL.test(amount) && Number(amount) === 0)) {
      return fail("hold_nonzero", "hold must have amount_in 0");
    }
    return { ok: true, decision: { action: "hold", amount_in: "0", reason: clip(o.reason) } };
  }
  if (typeof amount !== "string" || !DECIMAL.test(amount)) {
    return fail("bad_amount", `amount_in must be a positive decimal string, got ${JSON.stringify(o.amount_in)}`);
  }
  if (!/[1-9]/.test(amount)) return fail("zero_amount", "amount_in must be above 0 for buy/sell");
  return { ok: true, decision: { action: o.action, amount_in: amount, reason: clip(o.reason) } };
}

/** Doubles hold 15 significant decimal digits exactly; beyond that the parsed value may differ from the text. */
const MAX_NUMBER_DIGITS = 15;

function exactNumber(n: number): boolean {
  if (!Number.isFinite(n)) return true; // rejected below as not a decimal
  const digits = String(Math.abs(n)).split(/e/i)[0].replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  return digits.length <= MAX_NUMBER_DIGITS;
}

function numberToDecimal(n: number): string | null {
  if (!Number.isFinite(n) || n < 0) return null;
  // Plain notation only; 1e-7 style is rejected rather than guessed.
  const s = String(n);
  return /e/i.test(s) ? null : s;
}

const clip = (s: string): string => (s.length > MAX_REASON ? s.slice(0, MAX_REASON) : s).trim();

/** "1.5" with 24 decimals -> 1500000000000000000000000n. Rejects more fractional digits than the token has. */
/** Token decimals are 0–38 (u128 has 39 digits); anything else is a hostile or broken ft_metadata. */
export function checkDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error(`token decimals ${String(decimals).slice(0, 20)} out of range 0-38`);
  return decimals;
}

export function toUnits(amount: string, decimals: number): bigint {
  checkDecimals(decimals);
  if (!DECIMAL.test(amount)) throw new Error(`not a decimal amount: ${amount}`);
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new Error(`${amount} has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 1500000000000000000000000n with 24 decimals -> "1.5". */
export function fromUnits(units: bigint | string, decimals: number): string {
  checkDecimals(decimals);
  const u = BigInt(units);
  if (u < 0n) throw new Error("negative amount");
  const base = 10n ** BigInt(decimals);
  const frac = (u % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${u / base}.${frac}` : `${u / base}`;
}

/** Truncate to at most `max` UTF-8 bytes without splitting a character (the vault caps notes at 280 bytes). */
export function clipBytes(s: string, max = 280): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}
