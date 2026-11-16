// Verify a TEE evidence bundle, following NEAR AI Cloud's published flow (cloud/verification in nearai/docs):
// Intel TDX quote (dcap-qvl) -> debug bit -> report_data binds signer + nonce -> MRCONFIGID -> RTMR3 replay -> GPU
// evidence (NVIDIA NRAS) -> EIP-191 response signature over `<model>:<sha256(req)>:<sha256(resp)>` by exactly one
// verified model report -> the pinned policy. On top of NEAR's flow: the request must be the published template, and
// (format v2) carry the vault, salt and a chain anchor block the reply must postdate. Fail-closed: any check that is
// missing, failing or not run here means no pill; a failure is recorded as a check, never thrown.
import { createHash } from "node:crypto";
import * as dcap from "@phala/dcap-qvl";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { canonical } from "../receipt.js";
import { deriveNonce, bundleRequest, bundleResponse, templateRequest, BINDING_KEY, type TeeBundle, type TeeBinding, type NearReport,
  type ResponseSignature } from "./evidence.js";
import { nearAiPolicy, policyChecks, validatePolicy, PROVES, type MeasurementPolicy } from "./policy.js";

/** TCB statuses accepted for a pill. Anything else (OutOfDate, debug, revoked...) is not attested. */
export const ACCEPTED_TCB = ["UpToDate"];
/** More model reports than this is not a NEAR AI bundle; refused before any network call. */
export const MAX_MODEL_REPORTS = 8;
/** Deadline for each Intel collateral fetch + verify, and for NVIDIA NRAS. */
export const NETWORK_TIMEOUT_MS = 30_000;
/** Largest NRAS response read. */
const MAX_NRAS_BYTES = 256 * 1024;

/** dcap-qvl fetches with the global fetch and no deadline, so the wait is bounded here. */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface QuoteFacts {
  status: string;
  advisory_ids: string[];
  tdAttributes: Uint8Array;
  reportData: Uint8Array;
  mrConfigId: Uint8Array;
  rtMr3: Uint8Array;
  /** Boot measurements, pinned per VM shape by the policy. */
  mrTd: Uint8Array;
  rtMr0: Uint8Array;
  rtMr1: Uint8Array;
  rtMr2: Uint8Array;
}

/** A block of the bundle's chain: its hash and timestamp (seconds). */
export interface ChainBlock { hash: string; time_secs: number }

export interface VerifyDeps {
  /** Verify an Intel quote. Default: dcap-qvl with collateral from Phala's PCCS (network). */
  verifyQuote?: (quote: Buffer) => Promise<QuoteFacts>;
  /** NVIDIA NRAS verdict for a decoded GPU payload; undefined = not checked here (no pill). Default: none. */
  nras?: (payload: unknown) => Promise<boolean | undefined>;
  /** Accepted NEAR AI Cloud software. Default: the pinned policy shipped in nearai-policy.json (see POLICY.md). */
  policy?: MeasurementPolicy;
  /** The block at `height` on `network`, for the anchor check; undefined = not checked here (no pill). */
  block?: (network: TeeBinding["network"], height: number) => Promise<ChainBlock>;
}

/** NEAR block time and the enclave's clock may differ this much. */
export const CLOCK_SKEW_SECS = 30;

/** ok: true passed, false failed, null not verified here (still no pill). */
export interface Check { name: string; ok: boolean | null; detail?: string }

export interface BundleResult {
  pill: boolean;
  model: string;
  signer?: string;
  /** The enclave-signed reply time, when readable. */
  created?: number;
  checks: Check[];
  proves: typeof PROVES;
}

/** Strict hex: only hex digits (optional 0x), even length, and `bytes` long when given; anything else is null. */
export function parseHex(v: unknown, bytes?: number): Buffer | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) return null;
  const b = Buffer.from(s, "hex");
  return bytes === undefined || b.length === bytes ? b : null;
}
const hex = (v: string): Buffer => {
  const b = parseHex(v);
  if (!b) throw new Error("not hex");
  return b;
};
const sameHex = (a: unknown, b: unknown, bytes: number): boolean => {
  const x = parseHex(a, bytes);
  const y = parseHex(b, bytes);
  return !!x && !!y && x.equals(y);
};
const sha = (alg: string, ...parts: (string | Uint8Array)[]): Buffer => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return h.digest();
};
const parse = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

function td(report: { type: string; data: unknown }): Record<string, Uint8Array> {
  // TDX 1.0 reports carry the fields directly; 1.5 nests them under `base` (once or twice).
  let d = report.data as Record<string, unknown>;
  while (d && !("rtMr3" in d) && "base" in d) d = d.base as Record<string, unknown>;
  if (!d || !("rtMr3" in d)) throw new Error(`not a TDX report (${report.type})`);
  return d as Record<string, Uint8Array>;
}

/** Default quote check: dcap-qvl against Intel's root CA, collateral from Phala's PCCS. */
export async function dcapVerifyQuote(quote: Buffer): Promise<QuoteFacts> {
  const v = await withDeadline(dcap.getCollateralAndVerify(quote), NETWORK_TIMEOUT_MS, "Intel collateral (PCCS)");
  return facts(v);
}

/** Offline quote check with saved collateral and a fixed clock (tests, archived bundles). */
export function dcapVerifyQuoteWith(collateral: unknown, nowSecs: number): (quote: Buffer) => Promise<QuoteFacts> {
  return async (quote) => facts(dcap.verify(quote, collateral as Parameters<typeof dcap.verify>[1], nowSecs));
}

function facts(v: { status: string; advisory_ids: string[]; report: unknown }): QuoteFacts {
  const d = td(v.report as { type: string; data: unknown });
  return { status: v.status, advisory_ids: v.advisory_ids, tdAttributes: d.tdAttributes, reportData: d.reportData,
    mrConfigId: d.mrConfigId, rtMr3: d.rtMr3, mrTd: d.mrTd, rtMr0: d.rtMr0, rtMr1: d.rtMr1, rtMr2: d.rtMr2 };
}

export function replayRtmr3(eventLog: unknown): Buffer {
  let rtmr3: Buffer = Buffer.alloc(48);
  for (const e of parse(eventLog) as { imr: number; event_type: number; event: string; event_payload?: string; digest?: string }[]) {
    if (e.imr !== 3) continue;
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type);
    const digest = sha("sha384", type, ":", Buffer.from(e.event, "utf8"), ":", hex(e.event_payload ?? ""));
    if (e.digest && !hex(e.digest).equals(digest)) throw new Error(`digest mismatch for event ${e.event}`);
    rtmr3 = sha("sha384", rtmr3, digest);
  }
  return rtmr3;
}

/**
 * Checks on one report (gateway or model candidate). `gpu`: GPU evidence is required (model candidates). `sink` gets
 * the verified quote's facts (boot measurements for the policy). Never throws: a malformed report fails its checks.
 */
export async function checkReport(name: string, r: NearReport, nonce: string, deps: Required<Pick<VerifyDeps, "verifyQuote" | "nras">>, gpu: boolean,
  sink?: { facts?: QuoteFacts }): Promise<Check[]> {
  const out: Check[] = [];
  const add = (check: string, ok: boolean | null, detail?: string) => out.push({ name: `${name}: ${check}`, ok, ...(detail ? { detail } : {}) });
  if (typeof r !== "object" || r === null) {
    add("report present", false);
    return out;
  }
  let q: QuoteFacts;
  try {
    q = await deps.verifyQuote(hex(r.intel_quote));
  } catch (e) {
    add("tdx quote", false, (e as Error).message);
    return out;
  }
  if (sink) sink.facts = q;
  add("tdx quote", ACCEPTED_TCB.includes(q.status), `TCB ${q.status}${q.advisory_ids.length ? ` (${q.advisory_ids.join(",")})` : ""}`);
  add("debug mode off", (q.tdAttributes[0] & 1) === 0);
  const identity = parseHex(r.signing_address, 20);
  const idOk = r.signing_algo === "ecdsa" && !!identity;
  add("signer is a 20-byte ecdsa address", idOk);
  const n = parseHex(nonce, 32);
  add("report_data binds signer + nonce", idOk && !!n && same(q.reportData, Buffer.concat([identity!, Buffer.alloc(12), n])));
  add("echoed nonce", typeof r.request_nonce === "string" && r.request_nonce.toLowerCase() === nonce);
  try {
    const compose = (parse((r.info as { tcb_info: unknown }).tcb_info) as { app_compose: string }).app_compose;
    const expected = Buffer.concat([Buffer.from([1]), sha("sha256", Buffer.from(compose, "utf8")), Buffer.alloc(15)]);
    add("MRCONFIGID = app_compose", same(q.mrConfigId, expected), `compose sha256 ${sha("sha256", Buffer.from(compose, "utf8")).toString("hex")}`);
  } catch (e) {
    add("MRCONFIGID = app_compose", false, (e as Error).message);
  }
  try {
    add("RTMR3 event-log replay", same(replayRtmr3(r.event_log), q.rtMr3));
  } catch (e) {
    add("RTMR3 event-log replay", false, (e as Error).message);
  }
  if (gpu) {
    if (!r.nvidia_payload) {
      add("gpu evidence", false, "no nvidia_payload");
    } else {
      let payload: { nonce?: unknown } | undefined;
      try {
        payload = parse(r.nvidia_payload) as { nonce?: unknown };
      } catch {
        add("gpu nonce", false, "nvidia_payload is not JSON");
      }
      if (payload) {
        const nonceOk = typeof payload.nonce === "string" && payload.nonce.toLowerCase() === nonce;
        add("gpu nonce", nonceOk);
        let verdict: boolean | undefined = false;
        let why: string | undefined;
        try {
          verdict = nonceOk ? await deps.nras(payload) : false;
        } catch (e) {
          verdict = false;
          why = `NVIDIA NRAS: ${(e as Error).message} ${String((e as { cause?: unknown }).cause ?? "")}`.slice(0, 160);
        }
        add("gpu verdict (NVIDIA NRAS)", verdict ?? null, why ?? (verdict === undefined ? "not checked here (offline)" : undefined));
      }
    }
  }
  return out;
}

/** EIP-191 personal-sign recovery: the 20-byte address that signed `text`, or null. */
export function recoverSigner(text: string, signatureHex: string): Buffer | null {
  const sig = hex(signatureHex);
  if (sig.length !== 65) return null;
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  if (v !== 0 && v !== 1) return null;
  const msg = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, "utf8"), msg]));
  try {
    const pub = secp256k1.recoverPublicKey(Buffer.concat([Buffer.from([v]), sig.subarray(0, 64)]), digest, { prehash: false });
    const full = secp256k1.Point.fromBytes(pub).toBytes(false);
    return Buffer.from(keccak_256(full.subarray(1))).subarray(12);
  } catch {
    return null;
  }
}

export const expectedSignedText = (model: string, request: Uint8Array, response: Uint8Array): string =>
  `${model}:${sha("sha256", request).toString("hex")}:${sha("sha256", response).toString("hex")}`;

/** Signature checks; `verifiedSigners` are the addresses of model reports that passed every report check. */
export function checkSignature(sig: ResponseSignature | null, b: TeeBundle, verifiedSigners: string[]): Check[] {
  if (!sig) return [{ name: "response signature", ok: false, detail: "unavailable (the gateway had none after the retry)" }];
  const out: Check[] = [];
  out.push({ name: "signature kind is provider_tee", ok: sig.signature_kind === "provider_tee",
    detail: sig.signature_kind === "gateway" ? "gateway-signed: binds the gateway, not a model TEE" : `kind ${String(sig.signature_kind)}` });
  out.push({ name: "signed text = model:sha256(request):sha256(response)",
    ok: sig.text === expectedSignedText(b.model, bundleRequest(b), bundleResponse(b)) });
  const recovered = sig.signing_algo === "ecdsa" && parseHex(sig.signature, 65) ? recoverSigner(sig.text, sig.signature) : null;
  const claimed = parseHex(sig.signing_address, 20);
  out.push({ name: "EIP-191 signer = signing_address", ok: !!recovered && !!claimed && recovered.equals(claimed) });
  const matches = claimed ? verifiedSigners.filter((a) => parseHex(a, 20)?.equals(claimed)).length : 0;
  out.push({ name: "signer matches exactly one verified model report", ok: matches === 1,
    detail: matches > 1 ? `ambiguous: ${matches} verified reports share this key (NEAR gives every instance of a model one key)` : `${matches} match(es)` });
  return out;
}

/** The published shape of a request: exactly a system and a user message, nothing else. */
function templateMessages(req: unknown): { system: string; user: string } | null {
  const m = (req as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(m) || m.length !== 2) return null;
  const [a, b] = m as { role?: unknown; content?: unknown }[];
  const plain = (x: object) => Object.keys(x).sort().join() === "content,role";
  if (!a || !b || !plain(a) || !plain(b) || a.role !== "system" || b.role !== "user" || typeof a.content !== "string" || typeof b.content !== "string") return null;
  return { system: a.content, user: b.content };
}

const NETWORKS_OK = ["testnet", "mainnet"];

/** The binding a v2 bundle claims, if well-formed and consistent with the bundle's own vault and salt. */
function bindingOk(b: TeeBundle): boolean {
  const x = b.binding as TeeBinding | undefined;
  return !!x && typeof x === "object" && Object.keys(x).sort().join() === "block_hash,block_height,network,salt,vault"
    && NETWORKS_OK.includes(x.network) && x.network === (b.vault.endsWith(".testnet") ? "testnet" : "mainnet")
    && x.vault === b.vault && x.salt === b.salt && /^[0-9a-f]{32}$/.test(x.salt)
    && Number.isSafeInteger(x.block_height) && x.block_height > 0 && typeof x.block_hash === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(x.block_hash);
}

export const V1_NOTE = "attested under policy v1 (pre-binding format): badge not awarded under policy v2";

export async function verifyBundle(b: TeeBundle, deps: VerifyDeps = {}): Promise<BundleResult> {
  const checks: Check[] = [];
  let created: number | undefined;
  const done = (signer?: string): BundleResult => ({ pill: checks.length > 0 && checks.every((c) => c.ok === true), model: b?.model, signer, created, checks, proves: PROVES });
  let policy: MeasurementPolicy;
  try {
    policy = validatePolicy(deps.policy ?? nearAiPolicy());
  } catch (e) {
    checks.push({ name: "measurement policy valid", ok: false, detail: (e as Error).message.slice(0, 200) });
    return done();
  }
  const d: Required<Pick<VerifyDeps, "verifyQuote" | "nras">> = { verifyQuote: deps.verifyQuote ?? dcapVerifyQuote, nras: deps.nras ?? (async () => undefined) };
  if (typeof b !== "object" || b === null || (b.v !== 1 && b.v !== 2) || b.kind !== "tee-nearai" || typeof b.vault !== "string" || typeof b.model !== "string") {
    checks.push({ name: "bundle format", ok: false, detail: "not a tee-nearai v1/v2 bundle" });
    return done();
  }
  let request: Buffer;
  let msgs: { system: string; user: string } | null;
  try {
    request = bundleRequest(b);
    checks.push({ name: "nonce = H(vault, salt, request)", ok: deriveNonce(b.vault, b.salt, request) === b.nonce });
    msgs = templateMessages(JSON.parse(request.toString("utf8")));
    checks.push({ name: "request is the published template (no other parameters)",
      ok: !!msgs && templateRequest(b.model, msgs.system, msgs.user).equals(request) });
    created = (JSON.parse(bundleResponse(b).toString("utf8")) as { created?: unknown }).created as number | undefined;
    if (!Number.isSafeInteger(created)) created = undefined;
  } catch (e) {
    checks.push({ name: "request and reply are readable JSON", ok: false, detail: (e as Error).message.slice(0, 120) });
    return done();
  }
  if (b.v === 2) {
    let carried = false;
    try {
      const u = msgs ? (JSON.parse(msgs.user) as Record<string, unknown>) : undefined;
      carried = bindingOk(b) && !!u && typeof u === "object" && canonical(u) === msgs!.user && canonical(u[BINDING_KEY]) === canonical(b.binding);
    } catch {
      carried = false;
    }
    checks.push({ name: "signed request carries this vault, salt and chain anchor", ok: carried });
  }
  checks.push({ name: "bundle names the pinned gateway URL", ok: b.api === policy.api, detail: String(b.api) });
  const modelPolicy = Object.hasOwn(policy.models, b.model) ? policy.models[b.model] : undefined;
  checks.push({ name: "model is on the measured list", ok: !!modelPolicy, detail: b.model });
  const models = Array.isArray(b.report?.model_attestations) ? b.report.model_attestations : [];
  checks.push({ name: `at most ${MAX_MODEL_REPORTS} model reports`, ok: models.length <= MAX_MODEL_REPORTS, detail: `${models.length}` });
  checks.push({ name: "gateway report present", ok: typeof b.report?.gateway_attestation === "object" && b.report.gateway_attestation !== null });
  // Local signature checks first: only the report whose address signed the reply is worth a network check.
  const local = checkSignature(b.signature, b, []).filter((c) => c.name !== "signer matches exactly one verified model report");
  const signer = b.signature?.signing_address ?? "";
  if (!checks.every((c) => c.ok === true) || !local.every((c) => c.ok === true)) {
    checks.push(...local, { name: "network checks (Intel, NVIDIA, chain)", ok: false, detail: "skipped: the bundle fails its local checks" });
    return done(b.signature?.signing_address);
  }
  const gwSink: { facts?: QuoteFacts } = {};
  const gw = await checkReport("gateway", b.report.gateway_attestation, b.nonce, d, false, gwSink);
  checks.push(...gw);
  // Policy values come from the event log, compose and quote, so they only mean something once the report verified.
  if (gw.every((c) => c.ok === true)) checks.push(...policyChecks("gateway", b.report.gateway_attestation, policy.gateway, undefined, gwSink.facts));
  const mine = models.map((m, i) => ({ m, i })).filter(({ m }) => parseHex(m?.signing_address, 20)?.equals(parseHex(signer, 20) ?? Buffer.alloc(0)));
  if (!mine.length) checks.push({ name: "model evidence present for the signer", ok: false });
  const verified: string[] = [];
  for (const { m, i } of mine) {
    const sink: { facts?: QuoteFacts } = {};
    const c = await checkReport(`model[${i}]`, m, b.nonce, d, true, sink);
    c.push({ name: `model[${i}]: model_name`, ok: m.model_name === b.model, detail: String(m.model_name) });
    if (c.every((x) => x.ok === true)) c.push(...policyChecks(`model[${i}]`, m, modelPolicy, { address: m.signing_address, allowed: modelPolicy?.signers }, sink.facts));
    checks.push(...c);
    if (c.every((x) => x.ok === true)) verified.push(m.signing_address);
  }
  checks.push(...checkSignature(b.signature, b, verified));
  if (b.v === 2) {
    const x = b.binding!;
    if (!deps.block) {
      checks.push({ name: "chain anchor block", ok: null, detail: "not checked here (no chain access)" });
    } else {
      try {
        const blk = await deps.block(x.network, x.block_height);
        checks.push({ name: "chain anchor block exists with this hash", ok: blk.hash === x.block_hash, detail: `${x.network} #${x.block_height}` });
        const after = created === undefined ? NaN : created - blk.time_secs;
        checks.push({ name: `reply signed within ${policy.max_evidence_age_secs} s after the anchor block`,
          ok: Number.isFinite(after) && after >= -CLOCK_SKEW_SECS && after <= policy.max_evidence_age_secs,
          detail: Number.isFinite(after) ? `${Math.round(after)} s` : "no signed reply time" });
      } catch (e) {
        checks.push({ name: "chain anchor block exists with this hash", ok: false, detail: (e as Error).message.slice(0, 120) });
      }
    }
  } else {
    checks.push({ name: "bundle format v2 (vault, salt and chain anchor inside the signed request)", ok: false, detail: V1_NOTE });
  }
  return done(b.signature?.signing_address);
}

/** Default online GPU check: POST the payload to NVIDIA NRAS and read x-nvidia-overall-att-result from the JWT. */
export async function nrasOnline(payload: unknown): Promise<boolean> {
  // Retries transport errors and 429/5xx only.
  let res: Response | undefined;
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    try {
      res = await fetch("https://nras.attestation.nvidia.com/v3/attest/gpu", {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      if (i === 3) throw e;
    }
  }
  if (!res?.ok) return false;
  const arr = JSON.parse(await readCapped(res, MAX_NRAS_BYTES, "NVIDIA NRAS")) as unknown[];
  const first = arr?.[0] as [string, string] | undefined;
  if (!Array.isArray(first) || first[0] !== "JWT") return false;
  const claims = JSON.parse(Buffer.from(first[1].split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  return claims["x-nvidia-overall-att-result"] === true;
}

/** A response body, refused as soon as it passes `max` bytes (a declared length over the cap is refused unread). */
export async function readCapped(res: Response, max: number, what: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new Error(`${what}: response larger than ${max} bytes`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error(`${what}: response larger than ${max} bytes`); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}
