// Receipts: canonical JSON (RFC 8785 / JCS for the values receipts hold) -> sha256 -> receipt_hash. The .jsonl line IS the hashed bytes,
// so anyone can verify a receipt with `sha256(line)` and match it to the on-chain event's receipt_hash.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`non-finite number in receipt: ${v}`);
    return JSON.stringify(v);
  }
  if (typeof v === "bigint") throw new Error("bigint in receipt: store amounts as decimal strings");
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error(`unsupported value in receipt: ${typeof v}`);
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export const isReceiptHash = (h: string): boolean => /^[0-9a-f]{64}$/.test(h);

/** Commitment to a TEE evidence bundle stored next to the receipts (attestations/<bundle_sha256>.json). */
export interface AttestationRef { kind: "tee-nearai"; bundle_sha256: string; chat_id: string; signing_address: string | null }

/** v2 adds `harness` (always on arena receipts) and `attestation` (only with --attest tee). */
export interface Receipt {
  v: 1 | 2;
  vault: string;
  network: string;
  agent: string;
  /** Self-reported agent software, e.g. "sledgit-runner/0.1.0". Only the attestation proves the model. */
  harness?: string;
  model: { provider: string; id: string };
  prompt_sha256: string;
  inputs: Json;
  decision: Json;
  model_output: string;
  attestation?: AttestationRef;
  ts: string;
}

/** Returns the exact line written and its hash. */
export function sealReceipt(r: Receipt): { line: string; hash: string } {
  const line = canonical(r);
  return { line, hash: sha256Hex(line) };
}

export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n", { mode: 0o600 });
}

/**
 * Offline lint (the `lint` command): re-hash every line and flag lines whose re-canonicalised form differs (edited by
 * hand, or written by a serializer that is not RFC 8785). It does NOT prove a receipt is unaltered: a rewritten line
 * can be canonical too. Use `verify`, which matches each hash to the vault's on-chain event.
 */
export function verifyFile(path: string): { hash: string; canonical: boolean; ts: string }[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => {
    let parsed: Receipt | undefined;
    try {
      parsed = JSON.parse(line) as Receipt;
    } catch {
      return { hash: sha256Hex(line), canonical: false, ts: "" };
    }
    return { hash: sha256Hex(line), canonical: canonical(parsed) === line, ts: parsed.ts };
  });
}
