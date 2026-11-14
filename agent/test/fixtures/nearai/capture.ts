// Refresh the NEAR AI Cloud fixtures (network, no API key): a real preflight report for a nonce derived from fixed
// request bytes, plus the Intel collateral to verify its quotes offline at `verified_at`.
// Run: node --import tsx test/fixtures/nearai/capture.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as dcap from "@phala/dcap-qvl";
import { deriveNonce } from "../../../src/attest/evidence.js";
import { FIXTURE } from "./fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const nonce = deriveNonce(FIXTURE.vault, FIXTURE.salt, Buffer.from(FIXTURE.request, "utf8"));
const q = new URLSearchParams({ model: FIXTURE.model, provider: "near", include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce });
const res = await fetch(`https://cloud-api.near.ai/v1/attestation/report?${q}`, { headers: { accept: "application/json", "x-no-aliasing": "true" } });
if (!res.ok) throw new Error(`report HTTP ${res.status}`);
const full = (await res.json()) as { gateway_attestation: Record<string, unknown>; model_attestations: Record<string, unknown>[] };
// Only the fields verification reads; the OHTTP extras are dropped to keep the fixture small.
const drop = new Set(["ohttp_attestation", "ohttp_key_config", "compose_manager_attestation"]);
const report = {
  gateway_attestation: full.gateway_attestation,
  model_attestations: full.model_attestations.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !drop.has(k)))),
};
const now = Math.floor(Date.now() / 1000);
const collateral: Record<string, unknown> = {};
for (const [name, r] of [["gateway", report.gateway_attestation], ...report.model_attestations.map((m, i) => [`model${i}`, m] as const)] as const) {
  const quote = Buffer.from(String((r as { intel_quote: string }).intel_quote), "hex");
  const c = await dcap.getCollateral(dcap.PHALA_PCCS_URL, quote);
  console.log(name, dcap.verify(quote, c, now).status);
  collateral[name] = c;
}
writeFileSync(join(here, "report.json"), JSON.stringify({ nonce, report }));
writeFileSync(join(here, "collateral.json"), JSON.stringify({ verified_at: now, collateral }));
console.log("nonce", nonce);
