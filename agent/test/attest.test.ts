// TEE pill tests. Offline: real NEAR AI Cloud reports captured once (test/fixtures/nearai, refreshed by capture.ts)
// are verified against saved Intel collateral at a fixed clock; signatures use a key generated in the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { deriveNonce, sealBundle, type TeeBundle, type NearReport, type ResponseSignature } from "../src/attest/evidence.js";
import { verifyBundle, checkSignature, checkReport, recoverSigner, expectedSignedText, replayRtmr3, dcapVerifyQuoteWith,
  MAX_MODEL_REPORTS, V1_NOTE, type QuoteFacts, type VerifyDeps } from "../src/attest/verify.js";
import { measured, nearAiPolicy, validatePolicy, composeImages, type MeasurementPolicy } from "../src/attest/policy.js";
import { nearAiModel, SIGNATURE_RETRIES } from "../src/attest/nearai.js";
import { attestDecision, bindingChecks, requiresAttestation, seasonPill } from "../src/attest/pill.js";
import { chainAsOf, verifySeason, type SeasonChain } from "../src/attest/season.js";
import type { ChainDecision } from "../src/attest/chain.js";
import { sealReceipt } from "../src/receipt.js";
import { tick, attestationsDir } from "../src/arena.js";
import { classify, eventsFromLogs, type Vault, type TxResult } from "../src/vault.js";
import { NETWORKS } from "../src/config.js";
import { sha256Hex, type Receipt } from "../src/receipt.js";
import { FIXTURE } from "./fixtures/nearai/fixture.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "nearai");
const captured = JSON.parse(readFileSync(join(FIX, "report.json"), "utf8")) as { nonce: string; report: TeeBundle["report"] };
const saved = JSON.parse(readFileSync(join(FIX, "collateral.json"), "utf8")) as { verified_at: number; collateral: Record<string, unknown> };

/** Offline quote check: pick the saved collateral whose quote matches. */
const realReports = [captured.report.gateway_attestation, ...(captured.report.model_attestations ?? [])];
const offlineQuote = async (quote: Buffer): Promise<QuoteFacts> => {
  const i = realReports.findIndex((r) => Buffer.from(r.intel_quote, "hex").equals(quote));
  const col = saved.collateral[i === 0 ? "gateway" : `model${i - 1}`];
  if (!col) throw new Error("no collateral for this quote");
  return dcapVerifyQuoteWith(col, saved.verified_at)(quote);
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function realBundle(over: Partial<TeeBundle> = {}): TeeBundle {
  return { v: 1, kind: "tee-nearai", api: "https://cloud-api.near.ai/v1", vault: FIXTURE.vault, model: FIXTURE.model,
    salt: FIXTURE.salt, nonce: captured.nonce, report: clone(captured.report),
    request_b64: Buffer.from(FIXTURE.request).toString("base64"), response_b64: Buffer.from("{}").toString("base64"),
    chat_id: "chatcmpl-fixture", signature: null, ...over };
}
const failing = (r: { checks: { name: string; ok: boolean | null }[] }) => r.checks.filter((c) => c.ok !== true).map((c) => c.name);

/** The report checks verifyBundle runs once a bundle passes its local checks (the captured fixture has no signature). */
async function reportChecks(b: TeeBundle, deps: VerifyDeps) {
  const d = { verifyQuote: deps.verifyQuote!, nras: deps.nras ?? (async () => undefined) };
  const checks = await checkReport("gateway", b.report.gateway_attestation, b.nonce, d, false);
  const models = b.report.model_attestations ?? [];
  if (!models.length) checks.push({ name: "model evidence present", ok: false });
  for (const [i, m] of models.entries()) {
    checks.push(...(await checkReport(`model[${i}]`, m, b.nonce, d, true)), { name: `model[${i}]: model_name`, ok: m.model_name === b.model });
  }
  return { checks };
}

// ------------------------------------------------------------- real NEAR AI Cloud evidence (offline)

test("tee: the captured nonce is deriveNonce(vault, salt, request), so the fixture binds our own request bytes", () => {
  assert.equal(deriveNonce(FIXTURE.vault, FIXTURE.salt, Buffer.from(FIXTURE.request)), captured.nonce);
});

test("tee: real gateway + Qwen3.6 model reports pass quote, debug, report_data, nonce, MRCONFIGID, RTMR3 and GPU-nonce checks", async () => {
  const r = await reportChecks(realBundle(), { verifyQuote: offlineQuote });
  // Offline, the only gap is the GPU verdict (needs NVIDIA NRAS).
  assert.deepEqual(failing(r), ["model[0]: gpu verdict (NVIDIA NRAS)"]);
  assert.equal(r.checks.find((c) => c.name === "model[0]: gpu verdict (NVIDIA NRAS)")!.ok, null, "not run is null, not true");
  assert.match(r.checks.find((c) => c.name === "model[0]: tdx quote")!.detail!, /TCB UpToDate/);
});

test("tee: with no response signature there is no pill, and no Intel or NVIDIA call is made (review F3)", async () => {
  let calls = 0;
  const r = await verifyBundle(realBundle(), { verifyQuote: async (q) => { calls++; return offlineQuote(q); }, nras: async () => { calls++; return true; } });
  assert.deepEqual(failing(r), ["response signature", "network checks (Intel, NVIDIA, chain)"]);
  assert.equal(r.pill, false);
  assert.equal(calls, 0);
});

test("tee: a changed request byte breaks the nonce binding even though the reports still verify", async () => {
  const req = FIXTURE.request.replace("fixture system prompt", "fixture system prompT");
  const r = await verifyBundle(realBundle({ request_b64: Buffer.from(req).toString("base64") }), { verifyQuote: offlineQuote, nras: async () => true });
  assert.ok(failing(r).includes("nonce = H(vault, salt, request)"));
});

test("tee: a bundle claiming another vault or salt fails the nonce binding", async () => {
  for (const over of [{ vault: "other.testnet" }, { salt: "ff".repeat(16) }]) {
    const r = await verifyBundle(realBundle(over), { verifyQuote: offlineQuote, nras: async () => true });
    assert.ok(failing(r).includes("nonce = H(vault, salt, request)"), JSON.stringify(over));
  }
});

test("tee: a stale report (different nonce) fails report_data, echo and GPU-nonce checks", async () => {
  const other = "ab".repeat(32);
  const r = await reportChecks(realBundle({ nonce: other }), { verifyQuote: offlineQuote, nras: async () => true });
  const f = failing(r);
  for (const n of ["gateway: report_data binds signer + nonce", "gateway: echoed nonce", "model[0]: report_data binds signer + nonce", "model[0]: gpu nonce"]) {
    assert.ok(f.includes(n), n);
  }
});

test("tee: a tampered event log or app_compose fails RTMR3 or MRCONFIGID", async () => {
  const b = realBundle();
  const m = b.report.model_attestations![0] as NearReport & { event_log: { imr: number; event: string; event_payload: string; digest?: string }[] };
  const log = (typeof m.event_log === "string" ? JSON.parse(m.event_log) : m.event_log) as { imr: number; event_payload: string; digest?: string }[];
  const e = log.find((x) => x.imr === 3 && x.event_payload)!;
  e.event_payload = e.event_payload.slice(0, -2) + (e.event_payload.endsWith("00") ? "01" : "00");
  m.event_log = log as never;
  const tcb = typeof m.info === "object" ? (m.info as { tcb_info: unknown }) : undefined;
  const info = typeof tcb!.tcb_info === "string" ? JSON.parse(tcb!.tcb_info) : tcb!.tcb_info;
  info.app_compose += " ";
  tcb!.tcb_info = typeof tcb!.tcb_info === "string" ? JSON.stringify(info) : info;
  const f = failing(await reportChecks(b, { verifyQuote: offlineQuote, nras: async () => true }));
  assert.ok(f.includes("model[0]: RTMR3 event-log replay"));
  assert.ok(f.includes("model[0]: MRCONFIGID = app_compose"));
});

test("tee: a corrupted quote fails the TDX check", async () => {
  const b = realBundle();
  const q = b.report.model_attestations![0].intel_quote;
  b.report.model_attestations![0].intel_quote = q.slice(0, 2000) + (q[2000] === "0" ? "1" : "0") + q.slice(2001);
  const f = failing(await reportChecks(b, { verifyQuote: (qb) => dcapVerifyQuoteWith(saved.collateral.model0, saved.verified_at)(qb), nras: async () => true }));
  assert.ok(f.includes("model[0]: tdx quote"));
});

test("tee: a report for another model fails model_name; a missing model report list fails", async () => {
  const f1 = failing(await reportChecks(realBundle({ model: "z-ai/glm-5.3-flash" }), { verifyQuote: offlineQuote, nras: async () => true }));
  assert.ok(f1.includes("model[0]: model_name"));
  const b = realBundle();
  delete b.report.model_attestations;
  assert.ok(failing(await reportChecks(b, { verifyQuote: offlineQuote, nras: async () => true })).includes("model evidence present"));
});

// ------------------------------------------------------------- a real signed call (2026-10-29, Qwen3.6, a few tokens)

const realSigned = readFileSync(join(FIX, "real-bundle.json"), "utf8");
const realSignedCol = JSON.parse(readFileSync(join(FIX, "real-collateral.json"), "utf8")) as typeof saved;
const realSignedQuote = (b: TeeBundle) => async (quote: Buffer): Promise<QuoteFacts> => {
  const key = Buffer.from(b.report.gateway_attestation.intel_quote, "hex").equals(quote) ? "gateway" : "model0";
  return dcapVerifyQuoteWith(realSignedCol.collateral[key], realSignedCol.verified_at)(quote);
};
// NRAS needs the network; its live verdict for this bundle was true. Offline the test supplies that verdict.
const nrasRecorded = async () => true;

const V1_FORMAT = "bundle format v2 (vault, salt and chain anchor inside the signed request)";

test("real: a recorded pre-binding (v1) NEAR AI Cloud call passes every evidence check, but policy v2 awards no pill", async () => {
  const b = JSON.parse(realSigned) as TeeBundle;
  assert.equal(sealBundle(b).text, realSigned, "the fixture is the sealed bundle, byte for byte");
  assert.equal(b.signature!.signature_kind, "provider_tee");
  const r = await verifyBundle(b, { verifyQuote: realSignedQuote(b), nras: nrasRecorded });
  // TDX quotes, boot measurements, events, template, signature: all pass. Only the binding format is missing.
  assert.deepEqual(failing(r), [V1_FORMAT]);
  assert.equal(r.checks.find((c) => c.name === V1_FORMAT)!.detail, V1_NOTE);
  assert.equal(r.pill, false);
});

test("real: the same recorded call fails if one reply byte, the model id or the vault is changed", async () => {
  const b = JSON.parse(realSigned) as TeeBundle;
  const resp = Buffer.from(b.response_b64, "base64");
  resp[resp.length - 2] ^= 1;
  const cases: [string, TeeBundle][] = [
    ["reply byte", { ...b, response_b64: resp.toString("base64") }],
    ["model id", { ...b, model: "Qwen/Qwen3.8-27B" }],
    ["vault", { ...b, vault: "someone-else.testnet" }],
  ];
  for (const [what, t] of cases) {
    const r = await verifyBundle(t, { verifyQuote: realSignedQuote(b), nras: nrasRecorded });
    assert.equal(r.pill, false, what);
    assert.ok(failing(r).some((n) => n !== V1_FORMAT), `${what} fails an evidence check, not only the format`);
  }
});

test("real: a bundle failing a local check makes no Intel or NVIDIA call; more than 8 model reports are refused unread (review F3)", async () => {
  const b = JSON.parse(realSigned) as TeeBundle;
  let calls = 0;
  const counting = { verifyQuote: async (q: Buffer) => { calls++; return realSignedQuote(b)(q); }, nras: async () => { calls++; return true; } };
  for (const t of [{ ...b, vault: "someone-else.testnet" }, { ...b, nonce: "ab".repeat(32) }]) {
    const r = await verifyBundle(t, counting);
    assert.equal(r.pill, false);
    assert.ok(failing(r).includes("network checks (Intel, NVIDIA, chain)"));
  }
  const flood = clone(b);
  flood.report.model_attestations = Array.from({ length: 203 }, () => clone(b.report.model_attestations![0]));
  const r = await verifyBundle(flood, counting);
  assert.equal(r.pill, false);
  assert.ok(failing(r).includes(`at most ${MAX_MODEL_REPORTS} model reports`));
  assert.equal(calls, 0, "no network call for a bundle that fails locally");
  // Only the report whose address signed the reply is checked: an extra report from another signer costs nothing.
  const extra = clone(b);
  extra.report.model_attestations!.push({ ...clone(b.report.model_attestations![0]), signing_address: "0x" + "11".repeat(20) });
  calls = 0;
  const ok = await verifyBundle(extra, counting);
  assert.deepEqual(failing(ok), [V1_FORMAT]);
  assert.equal(calls, 3, "gateway quote + the signer's quote + its GPU verdict");
});

// ------------------------------------------------------------- response signatures (synthetic keys)

function wallet() {
  const sk = secp256k1.utils.randomSecretKey();
  const address = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(sk, false).subarray(1))).subarray(12).toString("hex");
  const sign = (text: string): string => {
    const msg = Buffer.from(text, "utf8");
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
    const rec = secp256k1.sign(digest, sk, { prehash: false, format: "recovered" }); // [recovery, r, s]
    return "0x" + Buffer.concat([rec.subarray(1), Buffer.from([rec[0] + 27])]).toString("hex"); // Ethereum r||s||v
  };
  return { address, sign };
}

function signedBundle(w = wallet(), response = '{"id":"chatcmpl-1","choices":[{"message":{"content":"{}"}}]}') {
  const b = realBundle({ response_b64: Buffer.from(response).toString("base64") });
  const text = expectedSignedText(b.model, Buffer.from(FIXTURE.request), Buffer.from(response));
  const sig: ResponseSignature = { text, signature: w.sign(text), signing_address: w.address, signing_algo: "ecdsa", signature_kind: "provider_tee" };
  return { b: { ...b, signature: sig }, w };
}

test("sig: EIP-191 recovery returns the signer's address", () => {
  const w = wallet();
  assert.equal("0x" + recoverSigner("hello", w.sign("hello"))!.toString("hex"), w.address);
  assert.notEqual("0x" + recoverSigner("hellO", w.sign("hello"))!.toString("hex"), w.address);
  assert.equal(recoverSigner("x", "0x1234"), null);
});

test("sig: a correct provider_tee signature by the one verified model signer passes", () => {
  const { b, w } = signedBundle();
  assert.deepEqual(checkSignature(b.signature, b, [w.address]).filter((c) => !c.ok), []);
});

test("sig: a changed response byte, another model id, a forged signer or the wrong kind each fail", () => {
  const { b, w } = signedBundle();
  const resp = Buffer.from(b.response_b64, "base64").toString();
  const changed = { ...b, response_b64: Buffer.from(resp.replace("chatcmpl-1", "chatcmpl-2")).toString("base64") };
  assert.ok(checkSignature(changed.signature, changed, [w.address]).some((c) => c.name.startsWith("signed text") && !c.ok));
  const otherModel = { ...b, model: "z-ai/glm-5.3-flash" };
  assert.ok(checkSignature(otherModel.signature, otherModel, [w.address]).some((c) => c.name.startsWith("signed text") && !c.ok));
  const mallory = wallet();
  const forged = { ...b.signature!, signature: mallory.sign(b.signature!.text) }; // claims w's address
  assert.ok(checkSignature(forged, b, [w.address]).some((c) => c.name.startsWith("EIP-191") && !c.ok));
  const gw = { ...b.signature!, signature_kind: "gateway" };
  assert.ok(checkSignature(gw, b, [w.address]).some((c) => c.name.startsWith("signature kind") && !c.ok));
  assert.equal(checkSignature(null, b, [w.address])[0].ok, false);
});

test("sig: the signer must match exactly one verified model report (none or two = reject)", () => {
  const { b, w } = signedBundle();
  const one = (s: string[]) => checkSignature(b.signature, b, s).find((c) => c.name.startsWith("signer matches"))!.ok;
  assert.equal(one([w.address]), true);
  assert.equal(one([]), false, "signer not among verified reports");
  assert.equal(one([w.address, w.address.toUpperCase().replace("0X", "0x")]), false, "ambiguous: two matching reports");
});

// ------------------------------------------------------------- full flow with a synthetic enclave

/** A synthetic report whose "quote" is the nonce, checked by a stub verifier: exercises every check end to end. */
// A synthetic enclave's measured software: a JSON compose with one pinned-style image, and the dstack RTMR3 events.
const SYNTH_COMPOSE = JSON.stringify({ docker_compose_file: `services:\n  model:\n    image: example/model@sha256:${"ab".repeat(32)}\n` });
const SYNTH_LOG = [
  { imr: 3, event_type: 134217729, event: "app-id", event_payload: "aa".repeat(20) },
  { imr: 3, event_type: 134217729, event: "compose-hash", event_payload: createHash("sha256").update(SYNTH_COMPOSE).digest("hex") },
  { imr: 3, event_type: 134217729, event: "os-image-hash", event_payload: "bb".repeat(32) },
  { imr: 3, event_type: 134217729, event: "key-provider", event_payload: Buffer.from(JSON.stringify({ name: "kms", id: "cc" })).toString("hex") },
  { imr: 3, event_type: 134217729, event: "system-ready", event_payload: "" },
];
/** The synthetic VM's boot measurements (the stub quote reports these). */
const SYNTH_VM = { os_image_hash: "bb".repeat(32), mrtd: "d1".repeat(48), rtmr0: "d2".repeat(48), rtmr1: "d3".repeat(48), rtmr2: "d4".repeat(48) };
/** A policy accepting exactly the synthetic enclave, for `model` with these signers. */
function synthPolicy(model: string, signers: string[]): MeasurementPolicy {
  const role = { app_ids: ["aa".repeat(20)], compose_hashes: [createHash("sha256").update(SYNTH_COMPOSE).digest("hex")],
    os_image_hashes: ["bb".repeat(32)], key_providers: ["cc"], images: [`example/model@sha256:${"ab".repeat(32)}`], vms: [SYNTH_VM] };
  return { version: 2, api: "https://cloud-api.near.ai/v1", max_evidence_age_secs: 900, gateway: role,
    models: { [model]: { ...role, signers: signers.map((x) => x.toLowerCase()) } } };
}

/** The stub "quote": the nonce for a model report, GW_QUOTE ‖ nonce for the gateway (so the two differ). */
const GW_QUOTE = "ee".repeat(32);
function synthReport(addr: string, nonce: string, model?: string, log: unknown[] = SYNTH_LOG): NearReport {
  return { signing_address: addr, signing_algo: "ecdsa", intel_quote: model ? nonce : GW_QUOTE + nonce, event_log: log, request_nonce: nonce,
    info: { tcb_info: JSON.stringify({ app_compose: SYNTH_COMPOSE }) }, ...(model ? { model_name: model, nvidia_payload: JSON.stringify({ nonce }) } : {}) };
}
const stubDeps = (addrs: Record<string, string>, log: unknown[] = SYNTH_LOG): VerifyDeps => ({
  // The stub stands in for Intel: it "attests" whichever address the test enclave holds for this quote.
  verifyQuote: async (quote) => ({ status: "UpToDate", advisory_ids: [], tdAttributes: new Uint8Array(8),
    reportData: Buffer.concat([Buffer.from(addrs[quote.toString("hex")].slice(2), "hex"), Buffer.alloc(12), quote]),
    mrConfigId: Buffer.concat([Buffer.from([1]), createHash("sha256").update(SYNTH_COMPOSE).digest(), Buffer.alloc(15)]), rtMr3: replayRtmr3(log),
    mrTd: Buffer.from(SYNTH_VM.mrtd, "hex"), rtMr0: Buffer.from(SYNTH_VM.rtmr0, "hex"), rtMr1: Buffer.from(SYNTH_VM.rtmr1, "hex"), rtMr2: Buffer.from(SYNTH_VM.rtmr2, "hex") }),
  nras: async () => true,
});

/** A fake NEAR AI Cloud: attestation report, chat completion and signature, signed by the test enclave's model key. */
function fakeCloud(model: { sign(t: string): string; address: string }, gateway: { address: string }, reply: string, opts: { sigMisses?: number; log?: unknown[] } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let request = Buffer.alloc(0);
  let response = "";
  let misses = opts.sigMisses ?? 0;
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname.endsWith("/attestation/report")) {
      const nonce = u.searchParams.get("nonce")!;
      return new Response(JSON.stringify({ gateway_attestation: synthReport(gateway.address, nonce),
        model_attestations: [synthReport(model.address, nonce, u.searchParams.get("model")!, opts.log)] }));
    }
    if (u.pathname.endsWith("/chat/completions")) {
      request = Buffer.from(init!.body as Uint8Array);
      response = JSON.stringify({ id: "chatcmpl-42", created: Math.floor(Date.now() / 1000), choices: [{ message: { content: reply } }] });
      return new Response(response);
    }
    if (u.pathname.includes("/signature/")) {
      if (misses-- > 0) return new Response("{}", { status: 404 });
      const id = JSON.parse(request.toString()).model as string;
      const text = expectedSignedText(id, request, Buffer.from(response));
      return new Response(JSON.stringify({ text, signature: model.sign(text), signing_address: model.address, signing_algo: "ecdsa", signature_kind: "provider_tee" }));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

function fakeVault() {
  const tx = (events: string[]) => async (): Promise<TxResult> => {
    const e = eventsFromLogs(events);
    return { tx: "tx-1", ok: true, events: e, outcome: classify(e) };
  };
  const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.1.0", event, data: [{}] })}`;
  return {
    id: "v1.owner.testnet", agentId: "agent.testnet", net: NETWORKS.testnet,
    config: async () => ({ agent_id: "agent.testnet", frozen: false, seq: 1 }),
    policy: async () => ({ tokens: [], pairs: [], max_trades_per_hour: 10, max_slippage_bps: 100 }),
    usage: async () => ({ hour: "1", trades: 0, spent: [] }),
    intents: async () => ({ open_intent: null }), inFlight: async () => null,
    decimals: async () => 24, balance: async () => 0n,
    preview: async () => ({ ok: true, pool_id: 1, band_floor: "1" }), logSkip: tx([ev("skip")]), requestSwap: tx([ev("request")]),
  } as unknown as Vault;
}

const MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
const HOLD = '{"action":"hold","amount_in":"0","reason":"flat market"}';
/** The chain anchor the fake chain serves: a block a few seconds before the reply. */
const ANCHOR = { block_height: 275000000, block_hash: "8Zq7nX4e1YbR3uV6tK2wQmPd9sLhJcAaB5fG7hNzE2xT" };
const anchorBlock = () => ({ hash: ANCHOR.block_hash, time_secs: Math.floor(Date.now() / 1000) - 5 });

async function attestedTick(reply = HOLD, opts: { sigMisses?: number; log?: unknown[] } = {}) {
  const enclave = wallet();
  const gw = wallet();
  const cloud = fakeCloud(enclave, gw, reply, opts);
  const model = nearAiModel(MODEL, { NEAR_AI_CLOUD_API_KEY: "test-key-not-real" }, { fetch: cloud.f, sleep: async () => undefined,
    anchor: async () => ANCHOR });
  const dir = mkdtempSync(join(tmpdir(), "it-tee-"));
  const d = { vault: fakeVault(), model, prompt: { text: "PROMPT", sha256: sha256Hex("PROMPT"), path: "p" },
    price: async () => ({ source: "test", symbol: "NEARUSDT", price: "2.50", fetched_at: "t" }),
    receiptsPath: join(dir, "receipts.jsonl"), outcomesPath: join(dir, "outcomes.jsonl") };
  const r = await tick(d);
  const line = readFileSync(d.receiptsPath, "utf8").trim();
  const receipt = JSON.parse(line) as Receipt;
  const load = (sha: string) => JSON.parse(readFileSync(join(attestationsDir(d.receiptsPath), `${sha}.json`), "utf8")) as TeeBundle;
  return { r, line, receipt, load, cloud, enclave, gw };
}

/** Stub quote verifier for a synthetic bundle: the gateway's quote is GW_QUOTE ‖ nonce, the model's is the nonce. */
function synthDeps(_b: TeeBundle, enclave: { address: string }, gw: { address: string }, log: unknown[] = SYNTH_LOG): VerifyDeps {
  return {
    nras: async () => true,
    policy: synthPolicy(MODEL, [enclave.address]),
    block: async (_n, h) => (h === ANCHOR.block_height ? anchorBlock() : { hash: "other", time_secs: 0 }),
    verifyQuote: async (q) => {
      const hexq = q.toString("hex");
      const isGw = hexq.length === 128 && hexq.startsWith(GW_QUOTE);
      const nonceQ = isGw ? q.subarray(32) : q;
      const f = await stubDeps({ [nonceQ.toString("hex")]: isGw ? gw.address : enclave.address }, isGw ? SYNTH_LOG : log).verifyQuote!(nonceQ);
      return f;
    },
  };
}

test("collector: report -> completion -> signature, with the nonce bound to the exact request bytes and identity encoding", async () => {
  const { receipt, load, cloud } = await attestedTick();
  assert.equal(receipt.v, 2);
  assert.equal(receipt.harness, "sledgit-runner/0.1.0");
  assert.deepEqual(receipt.model, { provider: "nearai-tee", id: MODEL });
  const b = load(receipt.attestation!.bundle_sha256);
  assert.equal(sealBundle(b).sha256, receipt.attestation!.bundle_sha256);
  const [rep, chat, sig] = cloud.calls;
  assert.match(rep.url, /\/attestation\/report\?/);
  assert.equal(new URL(rep.url).searchParams.get("provider"), "near");
  assert.equal(new URL(rep.url).searchParams.get("nonce"), deriveNonce("v1.owner.testnet", b.salt, Buffer.from(b.request_b64, "base64")));
  const h = chat.init!.headers as Record<string, string>;
  assert.equal(h["x-no-aliasing"], "true");
  assert.equal(h["accept-encoding"], "identity");
  assert.equal(Buffer.from(chat.init!.body as Uint8Array).toString("base64"), b.request_b64, "the bytes sent are the bytes kept");
  const sent = JSON.parse(Buffer.from(b.request_b64, "base64").toString());
  assert.equal(sent.stream, false);
  assert.equal(b.v, 2);
  assert.deepEqual(JSON.parse(sent.messages[1].content).tee_binding,
    { network: "testnet", vault: "v1.owner.testnet", salt: b.salt, ...ANCHOR }, "vault, salt and anchor ride inside the signed bytes");
  assert.match(sig.url, /\/signature\/chatcmpl-42\?signing_algo=ecdsa$/);
});

test("collector: the API key never reaches the bundle or the receipt", async () => {
  const { line, receipt, load } = await attestedTick();
  const text = sealBundle(load(receipt.attestation!.bundle_sha256)).text;
  assert.ok(!line.includes("test-key-not-real") && !text.includes("test-key-not-real"));
});

/** The vault's on-chain record of a receipt: a skip for a hold, `dt` seconds after the reply. */
function eventFor(line: string, b: TeeBundle, over: Partial<ChainDecision> = {}): ChainDecision {
  const created = JSON.parse(Buffer.from(b.response_b64, "base64").toString()).created as number;
  return { seq: 1, event: "skip", receipt_hash: sha256Hex(line), note: "hold", tx: "tx-1", block_time_secs: created + 3, ...over };
}
/** Bundles on disk are untouched; tests verify a copy whose gateway quote the stub knows. */
const stubbed = (load: (sha: string) => TeeBundle, enclave: { address: string }, gw: { address: string }) => {
  const cache = new Map<string, TeeBundle>();
  const get = (sha: string) => cache.get(sha) ?? cache.set(sha, load(sha)).get(sha)!;
  return { get, deps: (sha: string, log?: unknown[]) => synthDeps(get(sha), enclave, gw, log) };
};

test("pill: an attested tick verifies end to end (receipt binding, enclave reports, model signature, chain anchor, on-chain event)", async () => {
  const { line, receipt, load, enclave, gw } = await attestedTick();
  const sha = receipt.attestation!.bundle_sha256;
  assert.deepEqual(bindingChecks(receipt, load(sha)).filter((c) => !c.ok), []);
  const b = load(sha);
  const r = await verifyBundle(b, synthDeps(b, enclave, gw));
  assert.deepEqual(failing(r), []);
  assert.equal(r.pill, true);
  const st = stubbed(load, enclave, gw);
  const a = await attestDecision(line, st.get, st.deps(sha), { event: eventFor(line, st.get(sha)) });
  assert.deepEqual(failing(a), []);
  assert.equal(a.attested, true);
  // Without the on-chain event the decision isn't attested: its block time is part of the proof.
  const noChain = await attestDecision(line, st.get, st.deps(sha));
  assert.deepEqual(failing(noChain), ["decision recorded on chain within the evidence window"]);
});

test("policy (P1-4): an enclave that passes every hardware check but runs other software gets no pill under NEAR's pinned policy", async () => {
  const { receipt, load, enclave, gw } = await attestedTick();
  const b = load(receipt.attestation!.bundle_sha256);
  const deps = synthDeps(b, enclave, gw);
  const own = await verifyBundle(b, deps);
  assert.equal(own.pill, true, "it is a perfectly attested TDX + GPU enclave");
  const pinned = await verifyBundle(b, { ...deps, policy: nearAiPolicy() });
  assert.equal(pinned.pill, false);
  const f = failing(pinned);
  for (const n of ["gateway: app-id pinned", "gateway: compose pinned", "gateway: images pinned", "model[0]: compose pinned", "model[0]: signer pinned for this model",
    "model[0]: boot measurements (MRTD, RTMR0-2) pinned for that OS image"]) {
    assert.ok(f.includes(n), n);
  }
  assert.ok(pinned.proves.does_not_prove.some((s) => /weights/.test(s)), "the result states what stays unproven");
});

test("policy: each pinned value is enforced on its own (app-id, OS, KMS, image, signer, gateway URL, unlisted model)", async () => {
  const { receipt, load, enclave, gw } = await attestedTick();
  const b = load(receipt.attestation!.bundle_sha256);
  const base = synthPolicy(MODEL, [enclave.address]);
  const variants: [string, (p: MeasurementPolicy) => void][] = [
    ["model[0]: app-id pinned", (p) => { p.models[MODEL].app_ids = ["00".repeat(20)]; }],
    ["model[0]: OS image pinned", (p) => { p.models[MODEL].os_image_hashes = ["00".repeat(32)]; }],
    ["model[0]: KMS pinned", (p) => { p.models[MODEL].key_providers = ["00"]; }],
    ["model[0]: images pinned", (p) => { p.models[MODEL].images = [`example/other@sha256:${"cd".repeat(32)}`]; }],
    ["model[0]: signer pinned for this model", (p) => { p.models[MODEL].signers = ["0x" + "11".repeat(20)]; }],
    ["model[0]: boot measurements (MRTD, RTMR0-2) pinned for that OS image", (p) => { p.models[MODEL].vms = [{ ...SYNTH_VM, rtmr1: "00".repeat(48) }]; }],
    ["model is on the measured list", (p) => { p.models = { "other/model": p.models[MODEL] }; }],
    ["measurement policy valid", (p) => { p.api = "https://other.example/v1"; }],
  ];
  for (const [name, mutate] of variants) {
    const p = clone(base);
    mutate(p);
    const r = await verifyBundle(clone(b), { ...synthDeps(clone(b), enclave, gw), policy: p });
    assert.equal(r.pill, false, name);
    assert.ok(failing(r).includes(name), `${name}: ${failing(r).join(", ")}`);
  }
});

test("policy: the real recorded bundles' measured values are on the shipped list (real gateway, Qwen3.6 enclave)", () => {
  const p = nearAiPolicy();
  const b = JSON.parse(realSigned) as TeeBundle;
  const gwm = measured(b.report.gateway_attestation);
  const mm = measured(b.report.model_attestations![0]);
  assert.ok(p.gateway.app_ids.includes(gwm.app_id!) && p.gateway.compose_hashes.includes(gwm.compose_hash!));
  assert.ok(p.models[b.model].compose_hashes.includes(mm.compose_hash!));
  assert.ok(p.models[b.model].signers.includes(b.signature!.signing_address));
  assert.ok(mm.images.some((i) => i.overridable), "the env-overridable compose-manager image is detected (stated as a gap)");
});

test("evidence age (A2): the reply must postdate the anchor block, and the chain must record the decision soon after it", async () => {
  const { line, receipt, load, enclave, gw } = await attestedTick();
  const sha = receipt.attestation!.bundle_sha256;
  const st = stubbed(load, enclave, gw);
  const b = st.get(sha);
  // An anchor block an hour older than the reply: the evidence is stale (or was prepared ahead).
  const old = await verifyBundle(b, { ...st.deps(sha), block: async () => ({ hash: ANCHOR.block_hash, time_secs: Math.floor(Date.now() / 1000) - 3600 }) });
  assert.ok(failing(old).includes("reply signed within 900 s after the anchor block"));
  // An anchor that isn't the chain's block at that height.
  const fake = await verifyBundle(b, { ...st.deps(sha), block: async () => ({ hash: "11111111111111111111111111111111", time_secs: Math.floor(Date.now() / 1000) }) });
  assert.ok(failing(fake).includes("chain anchor block exists with this hash"));
  // The receipt's own `ts` no longer matters; the block that recorded the decision does (operator-written dates can't backdate).
  for (const dt of [3600, -600]) {
    const created = JSON.parse(Buffer.from(b.response_b64, "base64").toString()).created as number;
    const a = await attestDecision(line, st.get, st.deps(sha), { event: eventFor(line, b, { block_time_secs: created + dt }) });
    assert.ok(failing(a).includes("decision recorded within 900 s after the signed reply"), String(dt));
  }
});

test("pill: a receipt whose model_output or inputs were edited no longer binds to its bundle", async () => {
  const { receipt, load } = await attestedTick();
  const b = load(receipt.attestation!.bundle_sha256);
  const edited = { ...receipt, model_output: receipt.model_output.replace("flat", "bull") };
  assert.ok(bindingChecks(edited, b).some((c) => c.name.startsWith("reply text") && !c.ok));
  const inputs = { ...(receipt.inputs as Record<string, unknown>), reference_price: null };
  assert.ok(bindingChecks({ ...receipt, inputs: inputs as never }, b).some((c) => c.name.startsWith("request user message") && !c.ok));
  assert.ok(bindingChecks({ ...receipt, decision: { action: "buy", amount_in: "1000", reason: "x" } }, b).some((c) => c.name === "decision = what the reply says" && !c.ok));
  assert.ok(bindingChecks({ ...receipt, model: { provider: "nearai-tee", id: "z-ai/glm-5.3-flash" } }, b).some((c) => !c.ok));
  const { attestation: _a, ...selfReported } = receipt;
  assert.equal(bindingChecks(selfReported as Receipt, b)[0].detail, "self-reported");
});

test("collector: a signature still missing after the bounded retry leaves the decision unattested, not failed", async () => {
  const { r, receipt, load, cloud } = await attestedTick(HOLD, { sigMisses: SIGNATURE_RETRIES });
  assert.equal(r.decision.action, "hold");
  assert.equal(receipt.attestation!.signing_address, null);
  assert.equal(load(receipt.attestation!.bundle_sha256).signature, null);
  assert.equal(cloud.calls.filter((c) => c.url.includes("/signature/")).length, SIGNATURE_RETRIES);
});

test("collector: a missing API key or a report with the wrong nonce stops before any completion", async () => {
  assert.throws(() => nearAiModel(MODEL, {}), /NEAR_AI_CLOUD_API_KEY/);
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ gateway_attestation: {}, model_attestations: [{ request_nonce: "00" }] }));
  }) as typeof fetch;
  const m = nearAiModel(MODEL, { NEAR_AI_CLOUD_API_KEY: "test-key-not-real" }, { fetch: f, anchor: async () => ANCHOR });
  await assert.rejects(m.complete("s", "{}", { vault: "v.testnet" }), (e: { code?: string }) => e.code === "attestation_unavailable");
  await assert.rejects(m.complete("s", "{}", { vault: "" }), (e: { code?: string }) => e.code === "unbound", "an attested call is always bound to a vault");
  assert.ok(!calls.some((u) => u.includes("/chat/completions")));
  assert.equal(m.takeEvidence(), undefined);
});

// ------------------------------------------------------------- season rule

test("season: the pill needs every decision attested; one self-reported decision drops it", () => {
  assert.equal(seasonPill([{ attested: true }, { attested: true }]), true);
  assert.equal(seasonPill([{ attested: true }, { attested: false }]), false);
  assert.equal(seasonPill([]), false, "no decisions, no pill");
});

test("season: ticks where no model was reached need no attestation; any model output or trade does", () => {
  const base = { v: 2, vault: "v", network: "testnet", agent: "a", model: { provider: "nearai-tee", id: MODEL }, prompt_sha256: "", inputs: {}, ts: "t" } as const;
  assert.equal(requiresAttestation({ ...base, decision: { action: "hold", amount_in: "0", reason: "model_error:timeout" }, model_output: "" }), false);
  assert.equal(requiresAttestation({ ...base, decision: { action: "hold", amount_in: "0", reason: "x" }, model_output: HOLD }), true);
  assert.equal(requiresAttestation({ ...base, decision: { action: "buy", amount_in: "1", reason: "x" }, model_output: "" }), true);
});

// ------------------------------------------------------------- attestation-pinning review regressions (A1-A12)

/** Re-sign a bundle's request with the test enclave: new request bytes, fresh nonce, reports and signature. */
function resign(b: TeeBundle, enclave: { sign(t: string): string; address: string }, request: Buffer, over: Partial<TeeBundle> = {}): TeeBundle {
  const nb = { ...clone(b), ...over, request_b64: request.toString("base64") };
  nb.nonce = deriveNonce(nb.vault, nb.salt, request);
  for (const r of [nb.report.gateway_attestation, ...(nb.report.model_attestations ?? [])]) {
    r.intel_quote = r === nb.report.gateway_attestation ? GW_QUOTE + nb.nonce : nb.nonce;
    r.request_nonce = nb.nonce;
    if (r.nvidia_payload) r.nvidia_payload = JSON.stringify({ nonce: nb.nonce });
  }
  const text = expectedSignedText(nb.model, request, Buffer.from(nb.response_b64, "base64"));
  nb.signature = { text, signature: enclave.sign(text), signing_address: enclave.address, signing_algo: "ecdsa", signature_kind: "provider_tee" };
  return nb;
}

const ARENA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "testnet", "receipts-arena", "qwen36-tee");

test("A1: a real receipt re-sealed with another decision no longer binds; the decision must be what the reply says", () => {
  const line = readFileSync(join(ARENA, "receipts.jsonl"), "utf8").split("\n").filter((l) => l.trim())[0];
  const r = JSON.parse(line) as Receipt;
  const b = JSON.parse(readFileSync(join(ARENA, "attestations", `${r.attestation!.bundle_sha256}.json`), "utf8")) as TeeBundle;
  const own = bindingChecks(r, b).find((c) => c.name === "decision = what the reply says")!;
  assert.equal(own.ok, true, "the recorded decision is what the model said");
  const forged = JSON.parse(sealReceipt({ ...r, decision: { action: "buy", amount_in: "1000", reason: "the model told me to (it did not)" } }).line) as Receipt;
  assert.equal(bindingChecks(forged, b).find((c) => c.name === "decision = what the reply says")!.ok, false);
});

test("A2: a signed reply moved to another vault (fresh nonce and report) fails: the vault is inside the signed bytes", async () => {
  const { receipt, load, enclave, gw } = await attestedTick();
  const b = load(receipt.attestation!.bundle_sha256);
  const req = Buffer.from(b.request_b64, "base64");
  // Same signed request and reply, re-derived for mallory's vault with a new salt, binding claim rewritten too.
  for (const binding of [b.binding!, { ...b.binding!, vault: "mallory-copycat.testnet", salt: "22".repeat(16) }]) {
    const moved = resign(b, enclave, req, { vault: "mallory-copycat.testnet", salt: "22".repeat(16), binding });
    const r = await verifyBundle(moved, synthDeps(moved, enclave, gw));
    assert.ok(failing(r).includes("signed request carries this vault, salt and chain anchor"), JSON.stringify(binding.vault));
  }
});

test("A3: extra request parameters (guided decoding, logit_bias, chat_template) fail the published-template check", async () => {
  const { receipt, load, enclave, gw } = await attestedTick();
  const b = load(receipt.attestation!.bundle_sha256);
  const req = JSON.parse(Buffer.from(b.request_b64, "base64").toString());
  const forced = '{"action":"buy","amount_in":"1000","reason":"forced"}';
  const steered = { ...req, guided_choice: [forced], structured_outputs: { choice: [forced] }, logit_bias: { "1234": 100 }, chat_template: "x", temperature: 0 };
  for (const body of [JSON.stringify(steered), JSON.stringify({ ...req, model: req.model }).replace('"stream":false', '"stream":false,"stream":false')]) {
    const t = resign(b, enclave, Buffer.from(body));
    const r = await verifyBundle(t, synthDeps(t, enclave, gw));
    assert.ok(failing(r).includes("request is the published template (no other parameters)"), body.slice(0, 60));
  }
});

test("A4: a pinned event appended after boot (duplicate, or after system-ready) fails, and the boot value is the one read", async () => {
  const appended = [...SYNTH_LOG, { imr: 3, event_type: 134217729, event: "app-id", event_payload: "aa".repeat(20) }];
  const late = [
    ...SYNTH_LOG.filter((e) => e.event !== "app-id" && e.event !== "system-ready"),
    { imr: 3, event_type: 134217729, event: "system-ready", event_payload: "" },
    { imr: 3, event_type: 134217729, event: "app-id", event_payload: "aa".repeat(20) },
  ];
  const real = [{ imr: 3, event_type: 134217729, event: "app-id", event_payload: "dd".repeat(20) }, ...SYNTH_LOG.slice(1)];
  const spoof = [...real.slice(0, -1), SYNTH_LOG[0], real[real.length - 1]];
  assert.equal(measured(synthReport("0x00", "00", undefined, spoof)).app_id, "dd".repeat(20), "first (boot) value, never a later append");
  for (const log of [appended, late, spoof]) {
    const { receipt, load, enclave, gw } = await attestedTick(HOLD, { log });
    const b = load(receipt.attestation!.bundle_sha256);
    const r = await verifyBundle(b, synthDeps(b, enclave, gw, log));
    assert.ok(failing(r).includes("model[0]: pinned events once, before system-ready"), JSON.stringify(log.map((e) => e.event)));
  }
});

test("A7: the season covers every on-chain decision: a missing receipt, a seq gap, reused evidence or a non-genuine vault drop the pill", async () => {
  const one = await attestedTick();
  const two = await attestedTick();
  const loadAll = (sha: string) => {
    for (const t of [one, two]) {
      try { return t.load(sha); } catch { /* not in this tick's dir */ }
    }
    throw new Error("no bundle");
  };
  const st = stubbed(loadAll, one.enclave, one.gw);
  // Each tick has its own enclave; the season deps must accept both signers and both gateways' quotes.
  const deps = (sha: string): VerifyDeps => {
    const t = [one, two].find((x) => { try { x.load(sha); return true; } catch { return false; } })!;
    return synthDeps(st.get(sha), t.enclave, t.gw);
  };
  const ev = (t: typeof one, seq: number): ChainDecision => eventFor(t.line, st.get(t.receipt.attestation!.bundle_sha256), { seq, tx: `tx-${seq}` });
  const chain = (events: ChainDecision[], genuine = true): SeasonChain => ({
    provenance: async () => ({ sledgit_vault: genuine, status: genuine ? "genuine" : "unverified", reason: "test" }),
    decisions: async () => events, decimals: async () => 24,
    seq: async () => (events.length ? Math.max(...events.map((e) => e.seq)) : 0),
  });
  const run = (text: string, events: ChainDecision[], genuine = true) =>
    verifySeason(text, st.get, chain(events, genuine), deps(one.receipt.attestation!.bundle_sha256));
  const good = await run(one.line + "\n", [ev(one, 1)]);
  assert.equal(good.tee_pill, true, JSON.stringify(good.decisions));
  assert.equal((await run(one.line + "\n", [ev(one, 1), ev(two, 2)])).tee_pill, false, "on-chain decision #2 has no receipt in the file");
  assert.equal((await run(one.line + "\n", [{ ...ev(one, 2) }], true)).tee_pill, false, "seq 1 missing");
  assert.equal((await run(one.line + "\n", [ev(one, 1)], false)).tee_pill, false, "not a genuine vault");
  // Two receipts backed by one bundle (the second re-dated): the evidence is reused.
  const again = sealReceipt({ ...one.receipt, ts: new Date(Date.parse(one.receipt.ts) + 60_000).toISOString() }).line;
  const reused = await run(`${one.line}\n${again}\n`, [ev(one, 1), { ...ev(one, 2), receipt_hash: sha256Hex(again) }]);
  assert.equal(reused.tee_pill, false);
  assert.ok(reused.decisions.every((d) => d.failed.some((c) => c.name === "evidence backs this receipt only")));
});

test("league cutoff: a later decision never changes the season check; a decision missed before the cutoff still fails", async () => {
  const one = await attestedTick();
  const two = await attestedTick();
  const loadAll = (sha: string) => {
    for (const t of [one, two]) {
      try { return t.load(sha); } catch { /* not in this tick's dir */ }
    }
    throw new Error("no bundle");
  };
  const st = stubbed(loadAll, one.enclave, one.gw);
  const deps = (sha: string): VerifyDeps => {
    const t = [one, two].find((x) => { try { x.load(sha); return true; } catch { return false; } })!;
    return synthDeps(st.get(sha), t.enclave, t.gw);
  };
  const ev = (t: typeof one, seq: number): ChainDecision => eventFor(t.line, st.get(t.receipt.attestation!.bundle_sha256), { seq, tx: `tx-${seq}` });
  // The indexer returns `events`; the vault's own live counter is `live`.
  const chain = (events: ChainDecision[], live: number): SeasonChain => ({
    provenance: async () => ({ sledgit_vault: true, status: "genuine", reason: "test" }),
    decisions: async () => events, decimals: async () => 24, seq: async () => live,
  });
  const run = (c: SeasonChain) => verifySeason(one.line + "\n", st.get, c, deps(one.receipt.attestation!.bundle_sha256));
  // Snapshot cut off after seq 1; a second decision lands later.
  assert.equal((await run(chainAsOf(chain([ev(one, 1)], 1), 1))).tee_pill, true);
  assert.equal((await run(chainAsOf(chain([ev(one, 1), ev(two, 2)], 2), 1))).tee_pill, true, "a decision after the cutoff changed the result");
  assert.equal((await run(chain([ev(one, 1), ev(two, 2)], 2))).tee_pill, false, "without the cutoff the live counter counts the later decision");
  // The indexer missed seq 2 (before the cutoff), so the league's last seq is 1; seq 3 came after. The counter as of the
  // cutoff is 3 - 1 = 2 > 1: still fails (R3-06).
  const missed = await run(chainAsOf(chain([ev(one, 1), ev(two, 3)], 3), 1));
  assert.equal(missed.tee_pill, false);
  assert.ok(missed.problems.some((p) => /indexer returned up to seq 1/.test(p)), JSON.stringify(missed.problems));
  // F2-16: the collector saw only seq 1, but seq 2 landed BEFORE the cutoff: with the cutoff time it stays in the season
  // (no receipt for it), so the pill fails instead of the decision being silently treated as later.
  const early = { ...ev(two, 2), block_time_secs: 100 };
  const lag = await run(chainAsOf(chain([ev(one, 1), early], 2), 1, 200_000));
  assert.equal(lag.tee_pill, false, "a pre-cutoff decision hidden from the collector must not vanish");
  const late = { ...ev(two, 2), block_time_secs: 300 };
  assert.equal((await run(chainAsOf(chain([ev(one, 1), late], 2), 1, 200_000))).tee_pill, true, "a truly later decision still doesn't count");
});

test("A8: compose images are parsed as YAML: comments, flow style, build: and image-less services can't hide", () => {
  const file = [
    "services:",
    `  ok:\n    image: example/model@sha256:${"ab".repeat(32)}`,
    "  evil1:\n    image: attacker/backdoor:latest # pinned by review",
    "  evil2:\n    build:\n      dockerfile_inline: |\n        FROM attacker/backdoor:latest",
    "  evil3: { image: attacker/backdoor:latest }",
  ].join("\n");
  const c = composeImages(file);
  assert.deepEqual(c.images.map((i) => i.ref), [`example/model@sha256:${"ab".repeat(32)}`, "attacker/backdoor:latest", "attacker/backdoor:latest"]);
  assert.ok(c.problems.some((p) => /evil2 builds its own image/.test(p)) && c.problems.some((p) => /evil2 names no image/.test(p)));
});

test("A9: the policy file is schema-checked: a string where a list belongs, bad hex or unknown keys are refused", async () => {
  assert.doesNotThrow(() => nearAiPolicy());
  const base = synthPolicy(MODEL, ["0x" + "12".repeat(20)]);
  const bad: [string, (p: Record<string, any>) => void][] = [
    ["images as a string", (p) => { p.gateway.images = "alpine@sha256:4b7c..., nearaidev/cloud-api@sha256:d38e..."; }],
    ["uppercase hex", (p) => { p.gateway.app_ids = ["AA".repeat(20)]; }],
    ["unknown key", (p) => { p.gateway.extra = []; }],
    ["evidence age out of range", (p) => { p.max_evidence_age_secs = 86_400; }],
    ["unpinned image tag", (p) => { p.models[MODEL].images = ["alpine:latest"]; }],
  ];
  for (const [what, mutate] of bad) {
    const p = clone(base) as Record<string, any>;
    mutate(p);
    assert.throws(() => validatePolicy(p), /policy:/, what);
  }
  const { receipt, load, enclave, gw } = await attestedTick();
  const b = load(receipt.attestation!.bundle_sha256);
  const p = clone(base) as Record<string, any>;
  p.gateway.images = "alpine";
  const r = await verifyBundle(b, { ...synthDeps(b, enclave, gw), policy: p as MeasurementPolicy });
  assert.deepEqual(failing(r), ["measurement policy valid"]);
});

test("A10: an NVIDIA outage or a bundle with no report fails a check instead of aborting the run", async () => {
  const { receipt, load, enclave, gw } = await attestedTick();
  const b = load(receipt.attestation!.bundle_sha256);
  const r = await verifyBundle(b, { ...synthDeps(b, enclave, gw), nras: async () => { throw new TypeError("fetch failed"); } });
  const c = r.checks.find((x) => x.name === "model[0]: gpu verdict (NVIDIA NRAS)")!;
  assert.equal(c.ok, false);
  assert.match(c.detail!, /fetch failed/);
  const nb = clone(b) as Partial<TeeBundle>;
  delete nb.report;
  const r2 = await verifyBundle(nb as TeeBundle, synthDeps(b, enclave, gw));
  assert.equal(r2.pill, false);
  assert.ok(failing(r2).includes("gateway report present"));
});

test("A12: a junk-suffixed hex address no longer compares equal to the real one", async () => {
  const { receipt, load, enclave, gw } = await attestedTick();
  const b = load(receipt.attestation!.bundle_sha256);
  const junk = { ...b, signature: { ...b.signature!, signing_address: b.signature!.signing_address + "zz-not-hex" } };
  const r = await verifyBundle(junk, synthDeps(junk, enclave, gw));
  assert.equal(r.pill, false);
  assert.ok(failing(r).includes("EIP-191 signer = signing_address"));
});
