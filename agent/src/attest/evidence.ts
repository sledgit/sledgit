// TEE evidence bundles: what an attested tick keeps so anyone can later check that NEAR AI's pinned model enclave signed
// the exact reply the receipt records, for this vault and decision. Pure; no I/O.
import { createHash } from "node:crypto";
import { canonical } from "../receipt.js";

/** One NEAR AI Cloud attestation report (gateway or model), as returned by /v1/attestation/report. */
export interface NearReport {
  signing_address: string;
  signing_algo: string;
  intel_quote: string;
  event_log: unknown;
  request_nonce: string;
  info: unknown;
  model_name?: string;
  nvidia_payload?: string;
  report_data?: string;
  [k: string]: unknown;
}

/** GET /v1/signature/<chat_id> response. */
export interface ResponseSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
  [k: string]: unknown;
}

/**
 * What binds a reply to one decision (format v2): the vault, the tick's salt and a recent final block of the vault's
 * chain, all inside the signed user message. A reply can't be moved to another vault, and wasn't requested before
 * that block existed.
 */
export interface TeeBinding {
  network: "testnet" | "mainnet";
  vault: string;
  salt: string;
  block_height: number;
  block_hash: string;
}

export interface TeeBundle {
  /** 1: pre-binding format (policy v1 only). 2: the request carries `binding` inside the signed bytes. */
  v: 1 | 2;
  kind: "tee-nearai";
  api: string;
  vault: string;
  /** Canonical model id, as sent in the request with x-no-aliasing. */
  model: string;
  /** 16 random bytes (hex), fresh per tick. */
  salt: string;
  /** deriveNonce(vault, salt, request bytes): the attestation is bound to this exact request. */
  nonce: string;
  /** Preflight evidence, fetched before the completion with `nonce`. */
  report: { gateway_attestation: NearReport; model_attestations?: NearReport[] };
  /** Exact request and response bodies, base64, so no byte is lost to re-serialisation. */
  request_b64: string;
  response_b64: string;
  chat_id: string;
  /** null when the gateway had no signature after the bounded retry: the decision is then unattested. */
  signature: ResponseSignature | null;
  /** v2 only: the binding the signed user message carries under BINDING_KEY. */
  binding?: TeeBinding;
}

/** Key of the binding object inside the user message the model sees (and the TEE signs). */
export const BINDING_KEY = "tee_binding";
/** Completion length the published request template asks for. */
export const REQUEST_MAX_TOKENS = 4000;

/**
 * The published request template, byte for byte. The verifier rebuilds it from the request's own two messages and
 * requires equality, so no other parameter (guided decoding, logit_bias, chat_template, tools...) can ride along.
 */
export function templateRequest(model: string, system: string, user: string): Buffer {
  return Buffer.from(JSON.stringify({ model, max_tokens: REQUEST_MAX_TOKENS, stream: false,
    messages: [{ role: "system", content: system }, { role: "user", content: user }] }), "utf8");
}

/** The user message for a bound call: the tick's inputs (a JSON object) plus the binding, canonical. */
export function boundUserMessage(inputs: string, binding: TeeBinding): string {
  const o = JSON.parse(inputs) as unknown;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("tick inputs are not a JSON object");
  if (BINDING_KEY in o) throw new Error(`tick inputs already carry ${BINDING_KEY}`);
  return canonical({ ...(o as Record<string, unknown>), [BINDING_KEY]: binding });
}

export const NONCE_DOMAIN = "iron-trade/tee-nonce/v1";

const sha256 = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");

export function deriveNonce(vault: string, salt: string, request: Uint8Array): string {
  return sha256(`${NONCE_DOMAIN}\n${vault}\n${salt}\n${sha256(request)}`);
}

/** The bundle file's bytes; its sha256 is what the receipt (and so the chain) commits to. */
export function sealBundle(b: TeeBundle): { text: string; sha256: string } {
  const text = canonical(b);
  return { text, sha256: sha256(text) };
}

export const bundleRequest = (b: TeeBundle): Buffer => Buffer.from(b.request_b64, "base64");
export const bundleResponse = (b: TeeBundle): Buffer => Buffer.from(b.response_b64, "base64");

/** The model's text from an OpenAI-style chat completion body; undefined if there is none. */
export function completionText(body: string): string | undefined {
  const parsed = JSON.parse(body) as { choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[] };
  const msg = parsed.choices?.[0]?.message;
  // Qwen3-style servers sometimes put the whole answer in reasoning_content.
  return msg?.content || msg?.reasoning_content || undefined;
}
