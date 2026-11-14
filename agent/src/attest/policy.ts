// Measurement policy for the TEE pill: which NEAR AI Cloud software we accept, not just "some TDX VM with a GPU".
// NEAR leaves the accepted measurements to each verifier (nearai/docs, cloud/verification/reference/verification-policy),
// so Sledgit pins its own, from NEAR-served reports that verified, in nearai-policy.json (sources + refresh: POLICY.md).
// Boot code is pinned through the quote itself (MRTD, RTMR0-2, each set tied to one OS image hash); app-id, compose-hash,
// os-image-hash and key-provider come from the RTMR3 event log (replayed against the verified quote by checkReport),
// each exactly once and before system-ready; images come from app_compose, whose hash is the verified MRCONFIGID.
// A value not on the list means no pill (fail closed).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { NearReport } from "./evidence.js";
import type { Check } from "./verify.js";

/** One accepted VM shape: boot measurements from the verified quote, and the OS image they belong to. */
export interface VmPin {
  os_image_hash: string;
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
}

export interface RolePolicy {
  app_ids: string[];
  compose_hashes: string[];
  os_image_hashes: string[];
  key_providers: string[];
  /** Exact `repo@sha256:<digest>` references every image in the compose must be one of. */
  images: string[];
  vms: VmPin[];
}

export interface ModelPolicy extends RolePolicy {
  /** NEAR AI gives every instance of a model one signing key; the reply's signer must be one of these. */
  signers: string[];
}

export interface MeasurementPolicy {
  version: number;
  /** The gateway URL the bundle names (self-declared by the bundle; see PROVES). */
  api: string;
  /** Largest gap allowed between the anchor block and the enclave-signed reply, and between the reply and the
   *  block that recorded the decision. */
  max_evidence_age_secs: number;
  gateway: RolePolicy;
  models: Record<string, ModelPolicy>;
}

/** Boot measurements of a verified quote (verify.ts QuoteFacts carries them). */
export interface BootFacts { mrTd: Uint8Array; rtMr0: Uint8Array; rtMr1: Uint8Array; rtMr2: Uint8Array }

/** The dstack events a policy pins. Each must appear exactly once in RTMR3, before system-ready. */
export const PINNED_EVENTS = ["app-id", "compose-hash", "os-image-hash", "key-provider"] as const;

export interface Measured {
  app_id?: string;
  compose_hash?: string;
  os_image_hash?: string;
  key_provider?: string;
  /** Image references, with `${VAR:-default}` resolved to its default (overridable: true). */
  images: { ref: string; overridable: boolean }[];
  /** Why the measured values can't be trusted as read: duplicated or late events, unreadable or unpinnable compose. */
  problems: string[];
}

const parse = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

/** Every service must name exactly one image; `build:` (an image built inside the CVM) can't be pinned. */
export function composeImages(composeFile: string): { images: Measured["images"]; problems: string[] } {
  const images: Measured["images"] = [];
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(composeFile);
  } catch (e) {
    return { images, problems: [`compose is not YAML: ${(e as Error).message.slice(0, 80)}`] };
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return { images, problems: ["compose has no services map"] };
  for (const [name, svc] of Object.entries(services as Record<string, unknown>)) {
    const s = svc as { image?: unknown; build?: unknown } | null;
    if (s && "build" in s) problems.push(`service ${name} builds its own image`);
    if (typeof s?.image !== "string" || !s.image) {
      problems.push(`service ${name} names no image`);
      continue;
    }
    const env = /^\$\{[A-Z0-9_]+:-(.+)\}$/.exec(s.image);
    images.push({ ref: env ? env[1] : s.image, overridable: !!env || s.image.includes("${") });
  }
  if (!images.length) problems.push("compose names no images");
  return { images, problems };
}

/** The measured values in one report. Meaningful only when its RTMR3 replay and MRCONFIGID checks pass. */
export function measured(r: NearReport): Measured {
  const out: Measured = { images: [], problems: [] };
  const events = (parse(r.event_log) as { imr: number; event: string; event_payload?: string }[]).filter((e) => e.imr === 3);
  const ready = events.findIndex((e) => e.event === "system-ready");
  if (ready < 0) out.problems.push("no system-ready event");
  for (const name of PINNED_EVENTS) {
    const at = events.map((e, i) => (e.event === name ? i : -1)).filter((i) => i >= 0);
    if (at.length !== 1) out.problems.push(`${name} appears ${at.length} times`);
    else if (ready >= 0 && at[0] > ready) out.problems.push(`${name} comes after system-ready`);
    if (!at.length) continue;
    // A duplicate is reported above; the first (boot) occurrence is the one read, never a later append.
    const p = events[at[0]].event_payload ?? "";
    if (name === "app-id") out.app_id = p.toLowerCase();
    else if (name === "compose-hash") out.compose_hash = p.toLowerCase();
    else if (name === "os-image-hash") out.os_image_hash = p.toLowerCase();
    else {
      try {
        out.key_provider = String((JSON.parse(Buffer.from(p, "hex").toString("utf8")) as { id?: unknown }).id ?? "").toLowerCase();
      } catch {
        out.key_provider = "";
      }
    }
  }
  const compose = (parse((r.info as { tcb_info: unknown }).tcb_info) as { app_compose: string }).app_compose;
  const file = String((JSON.parse(compose) as { docker_compose_file?: unknown }).docker_compose_file ?? "");
  const c = composeImages(file);
  out.images = c.images;
  out.problems.push(...c.problems);
  return out;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const hexOf = (u: Uint8Array | undefined): string => (u ? Buffer.from(u).toString("hex") : "");

/** Policy checks for one report that already passed checkReport. `signer` is checked for model reports. */
export function policyChecks(name: string, r: NearReport, p: RolePolicy | undefined, signer?: { address: string; allowed?: string[] }, boot?: BootFacts): Check[] {
  const add = (check: string, ok: boolean, detail?: string): Check => ({ name: `${name}: ${check}`, ok, ...(detail ? { detail } : {}) });
  if (!p) return [add("software on the measured list", false, "no policy for this role or model")];
  let m: Measured;
  try {
    m = measured(r);
  } catch (e) {
    return [add("measured values readable", false, (e as Error).message.slice(0, 120))];
  }
  const on = (v: string | undefined, list: string[]) => !!v && list.includes(v);
  const compose = (parse((r.info as { tcb_info: unknown }).tcb_info) as { app_compose: string }).app_compose;
  const eventProblems = m.problems.filter((x) => PINNED_EVENTS.some((e) => x.startsWith(e)) || x === "no system-ready event");
  const out = [
    add("pinned events once, before system-ready", eventProblems.length === 0, eventProblems.join("; ") || undefined),
    add("app-id pinned", on(m.app_id, p.app_ids), m.app_id),
    add("compose pinned", on(m.compose_hash, p.compose_hashes) && m.compose_hash === sha256(compose), m.compose_hash),
    add("OS image pinned", on(m.os_image_hash, p.os_image_hashes), m.os_image_hash),
    add("KMS pinned", on(m.key_provider, p.key_providers), m.key_provider),
  ];
  const vm = boot && p.vms.find((v) => v.os_image_hash === m.os_image_hash && v.mrtd === hexOf(boot.mrTd)
    && v.rtmr0 === hexOf(boot.rtMr0) && v.rtmr1 === hexOf(boot.rtMr1) && v.rtmr2 === hexOf(boot.rtMr2));
  out.push(add("boot measurements (MRTD, RTMR0-2) pinned for that OS image", !!vm,
    boot ? `mrtd ${hexOf(boot.mrTd).slice(0, 16)}…` : "no verified quote measurements"));
  const imageProblems = m.problems.filter((x) => !eventProblems.includes(x));
  const off = m.images.filter((i) => !p.images.includes(i.ref)).map((i) => i.ref);
  const over = m.images.filter((i) => i.overridable).map((i) => i.ref);
  out.push(add("images pinned", m.images.length > 0 && off.length === 0 && imageProblems.length === 0,
    imageProblems.length ? imageProblems.join("; ") : off.length ? `not on the list: ${off.join(", ")}`
      : over.length ? `pinned boot defaults; a launcher can replace them at runtime (see PROVES): ${over.join(", ")}` : undefined));
  if (signer) {
    out.push(add("signer pinned for this model", !!signer.allowed?.includes(signer.address.toLowerCase()), signer.address));
  }
  return out;
}

const HEX = (n?: number) => (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]*$/.test(v) && v.length > 0 && v.length % 2 === 0 && (n === undefined || v.length === n);
const IMAGE = (v: unknown): boolean => typeof v === "string" && /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/.test(v);
const SIGNER = (v: unknown): boolean => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v);
export const POLICY_API = "https://cloud-api.near.ai/v1";

/** Schema check: exact keys, lowercase hex of the right length, exact image digests. Throws on the first problem. */
export function validatePolicy(v: unknown): MeasurementPolicy {
  const fail = (m: string): never => { throw new Error(`policy: ${m}`); };
  const obj = (x: unknown, where: string, keys: string[]): Record<string, unknown> => {
    if (typeof x !== "object" || x === null || Array.isArray(x)) fail(`${where} is not an object`);
    const o = x as Record<string, unknown>;
    const k = Object.keys(o).sort();
    if (k.join() !== [...keys].sort().join()) fail(`${where} keys ${k.join(",")} are not ${keys.join(",")}`);
    return o;
  };
  const list = (x: unknown, where: string, ok: (v: unknown) => boolean) => {
    if (!Array.isArray(x) || !x.length || !x.every(ok)) fail(`${where} must be a non-empty list of exact values`);
  };
  const ROLE = ["app_ids", "compose_hashes", "os_image_hashes", "key_providers", "images", "vms"];
  const role = (x: unknown, where: string, model: boolean) => {
    const o = obj(x, where, model ? [...ROLE, "signers"] : ROLE);
    list(o.app_ids, `${where}.app_ids`, HEX(40));
    list(o.compose_hashes, `${where}.compose_hashes`, HEX(64));
    list(o.os_image_hashes, `${where}.os_image_hashes`, HEX(64));
    list(o.key_providers, `${where}.key_providers`, HEX());
    list(o.images, `${where}.images`, IMAGE);
    list(o.vms, `${where}.vms`, (vm) => {
      const p = obj(vm, `${where}.vms[]`, ["os_image_hash", "mrtd", "rtmr0", "rtmr1", "rtmr2"]);
      return HEX(64)(p.os_image_hash) && ["mrtd", "rtmr0", "rtmr1", "rtmr2"].every((k) => HEX(96)(p[k]));
    });
    if (model) list(o.signers, `${where}.signers`, SIGNER);
  };
  const o = obj(v, "root", ["version", "api", "max_evidence_age_secs", "gateway", "models"]);
  if (!Number.isInteger(o.version) || (o.version as number) < 2) fail("version must be an integer >= 2");
  if (o.api !== POLICY_API) fail(`api must be ${POLICY_API}`);
  const age = o.max_evidence_age_secs;
  if (!Number.isInteger(age) || (age as number) < 60 || (age as number) > 3600) fail("max_evidence_age_secs must be an integer 60-3600");
  role(o.gateway, "gateway", false);
  const models = obj(o.models, "models", Object.keys((o.models ?? {}) as object));
  if (!Object.keys(models).length) fail("models is empty");
  for (const [id, m] of Object.entries(models)) role(m, `models[${id}]`, true);
  return v as MeasurementPolicy;
}

const POLICY_FILE = new URL("./nearai-policy.json", import.meta.url);

/** The pinned NEAR AI Cloud policy shipped with the runner (agent/src/attest/nearai-policy.json), schema-checked. */
export function nearAiPolicy(): MeasurementPolicy {
  return validatePolicy(JSON.parse(readFileSync(POLICY_FILE, "utf8")));
}

/** Plain-language scope of the pill, shown with every result so nobody reads more into it. */
export const PROVES = {
  proves: [
    "The reply bytes were signed with the key NEAR AI Cloud uses for this model (a pinned address). The Intel TDX quote that binds that key verified (UpToDate, debug off), and its boot measurements (MRTD, RTMR0-2), OS image, app-id, KMS, compose and image digests are on Sledgit's pinned list.",
    "The signed request is the published template with no other parameters, and carries this vault, the tick's salt and a final block of the vault's chain: the reply was produced for this vault after that block.",
    "With a receipt and its on-chain event: the decision the vault recorded is exactly what that reply says, recorded within the evidence window after the reply, and every decision in the season has such a receipt.",
  ],
  does_not_prove: [
    "Which model weights produced the reply. `model_name` and the reply's `model` are labels tied to the per-model key NEAR's KMS assigns, not measured weights.",
    "Which serving code ran at the time of the reply. The measured compose runs a launcher that installs any compose-manager release NEAR's CI signs (channel `latest`, no minimum age) and restores the last one from an unmeasured volume; the pinned digests are boot defaults only, and the enclave hosts many models. In effect the trust root for the serving code is NEAR's CI signing.",
    "That the request went through NEAR AI Cloud's attested gateway or TLS session: a model signature is not bound to the gateway's report (NEAR's docs say so). The gateway checks show only that NEAR's gateway software is what it claims.",
    "That the GPU NVIDIA attested is in the same VM: the GPU evidence shares the nonce, not the TD. NVIDIA's verdict is read from its HTTPS answer; the token's signature isn't checked here.",
    "That the agent didn't ask several times and keep the reply it liked (rerolls).",
    "That the evidence still verifies under Intel's collateral of the day it was produced: quotes are checked against today's collateral.",
  ],
};

/** Compare one report's measured values with the pinned list: each value marked "pinned" or "NEW" for human review. */
export function policyDiff(r: NearReport, p: RolePolicy | undefined, boot?: BootFacts): Record<string, { value: string; pinned: boolean }[]> {
  const m = measured(r);
  const mark = (v: string | undefined, list: string[] = []) => (v ? [{ value: v, pinned: list.includes(v) }] : []);
  const vm = boot ? { os_image_hash: m.os_image_hash ?? "", mrtd: hexOf(boot.mrTd), rtmr0: hexOf(boot.rtMr0), rtmr1: hexOf(boot.rtMr1), rtmr2: hexOf(boot.rtMr2) } : undefined;
  return {
    app_id: mark(m.app_id, p?.app_ids),
    compose_hash: mark(m.compose_hash, p?.compose_hashes),
    os_image_hash: mark(m.os_image_hash, p?.os_image_hashes),
    key_provider: mark(m.key_provider, p?.key_providers),
    images: [...new Set(m.images.map((i) => i.ref))].map((v) => ({ value: v, pinned: !!p?.images.includes(v) })),
    ...(vm ? { vm: [{ value: JSON.stringify(vm), pinned: !!p?.vms.some((x) => JSON.stringify(x) === JSON.stringify(vm)) }] } : {}),
    ...(m.problems.length ? { problems: m.problems.map((x) => ({ value: x, pinned: false })) } : {}),
  };
}
