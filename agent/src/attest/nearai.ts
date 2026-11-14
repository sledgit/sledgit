// Attested model calls through NEAR AI Cloud (`--attest tee`). Per tick: a recent final block of the vault's chain ->
// request bytes from the published template, whose user message carries the vault, a fresh salt and that block ->
// fresh preflight attestation bound to those bytes -> non-streamed completion -> the TEE's signature over the request
// and response hashes. The evidence is kept for the tick to seal into a bundle; verify-attestation checks it.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerSecret, NETWORKS, type NetworkId } from "../config.js";
import { ModelError, MAX_RESPONSE_BYTES, type Model } from "../models.js";
import { deriveNonce, completionText, templateRequest, boundUserMessage, type TeeBundle, type TeeBinding, type NearReport,
  type ResponseSignature } from "./evidence.js";

export const NEARAI_API = "https://cloud-api.near.ai/v1";
/** Reports are ~250 KB (quotes, event logs, GPU evidence); anything far larger is not a report. */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
/** Signatures can lag the completion; retry briefly, then record the decision as unattested. */
export const SIGNATURE_RETRIES = 5;

export interface NearAiDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  salt?: () => string;
  /** A recent final block of the network (default: the network's RPC). */
  anchor?: (network: NetworkId) => Promise<{ block_height: number; block_hash: string }>;
}

/** Named accounts carry their network's suffix (config.ts), so the vault id says which chain anchors the call. */
export const networkOf = (vault: string): NetworkId => (vault.endsWith(".testnet") ? "testnet" : "mainnet");

/** The latest final block from the network's RPC. */
export async function rpcAnchor(network: NetworkId, f: typeof fetch = fetch): Promise<{ block_height: number; block_hash: string }> {
  const res = await f(NETWORKS[network].rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "anchor", method: "block", params: { finality: "final" } }),
    signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!res.ok) throw new ModelError("anchor_unavailable", `block RPC HTTP ${res.status}`);
  const h = (JSON.parse((await readBytes(res, 1024 * 1024)).toString("utf8")) as { result?: { header?: { height?: unknown; hash?: unknown } } }).result?.header;
  if (!Number.isSafeInteger(h?.height) || typeof h?.hash !== "string") throw new ModelError("anchor_unavailable", "block RPC returned no header");
  return { block_height: h!.height as number, block_hash: h!.hash as string };
}

export interface AttestedModel extends Model {
  /** The evidence from the last complete() call, once; undefined if that call failed before a reply. */
  takeEvidence(): TeeBundle | undefined;
}

async function readBytes(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new ModelError("oversize", `reply larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The key from NEAR_AI_CLOUD_API_KEY, or from the API_KEY line of the env file named by NEAR_AI_ENV. */
export function nearAiKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.NEAR_AI_CLOUD_API_KEY) return env.NEAR_AI_CLOUD_API_KEY;
  if (!env.NEAR_AI_ENV) return undefined;
  const line = readFileSync(env.NEAR_AI_ENV, "utf8").split("\n").find((l) => /^(export\s+)?(NEAR_AI_CLOUD_)?API_KEY=/.test(l.trim()));
  return line?.trim().replace(/^(export\s+)?(NEAR_AI_CLOUD_)?API_KEY=/, "").replace(/^["']|["']$/g, "") || undefined;
}

export function nearAiModel(id: string, env: NodeJS.ProcessEnv, deps: NearAiDeps = {}): AttestedModel {
  const key = nearAiKey(env);
  if (!key) throw new Error("NEAR_AI_CLOUD_API_KEY (or NEAR_AI_ENV=<env file with API_KEY>) is not set; create a key at cloud.near.ai");
  registerSecret(key);
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const salt = deps.salt ?? (() => randomBytes(16).toString("hex"));
  const anchor = deps.anchor ?? ((n: NetworkId) => rpcAnchor(n, f));
  const auth = { authorization: `Bearer ${key}`, accept: "application/json" };
  let evidence: TeeBundle | undefined;

  const get = async (url: string): Promise<Response> =>
    f(url, { headers: { ...auth, "x-no-aliasing": "true", "accept-encoding": "identity" }, signal: AbortSignal.timeout(60_000), redirect: "error" });

  async function signature(chatId: string): Promise<ResponseSignature | null> {
    const url = `${NEARAI_API}/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`;
    for (let i = 0; i < SIGNATURE_RETRIES; i++) {
      if (i > 0) await sleep(1000 * i);
      try {
        const res = await get(url);
        if (res.status === 404) continue;
        if (!res.ok) continue;
        const s = JSON.parse((await readBytes(res, 64 * 1024)).toString("utf8")) as ResponseSignature & { error_code?: string };
        // A 2xx carrying error_code is "unavailable", not a signature.
        if (s.error_code !== undefined || typeof s.signature !== "string") continue;
        return s;
      } catch {
        continue; // network blips count as unavailable; bounded by SIGNATURE_RETRIES
      }
    }
    return null;
  }

  return {
    ref: { provider: "nearai-tee", id },
    takeEvidence() {
      const e = evidence;
      evidence = undefined;
      return e;
    },
    async complete(system, user, ctx) {
      evidence = undefined;
      const vault = ctx?.vault ?? "";
      if (!vault) throw new ModelError("unbound", "an attested call needs the vault it decides for");
      const network = networkOf(vault);
      const s = salt();
      const binding: TeeBinding = { network, vault, salt: s, ...(await anchor(network)) };
      // Built once; these exact bytes are hashed into the nonce and signed by the TEE. The binding rides inside them.
      let request: Buffer;
      try {
        request = templateRequest(id, system, boundUserMessage(user, binding));
      } catch (e) {
        throw new ModelError("bad_input", (e as Error).message);
      }
      const nonce = deriveNonce(vault, s, request);

      const q = new URLSearchParams({ model: id, provider: "near", include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce });
      const rep = await get(`${NEARAI_API}/attestation/report?${q}`);
      if (!rep.ok) throw new ModelError("attestation_unavailable", `attestation report HTTP ${rep.status}`);
      const report = JSON.parse((await readBytes(rep, MAX_REPORT_BYTES)).toString("utf8")) as TeeBundle["report"];
      const models: NearReport[] = report.model_attestations ?? [];
      // Cheap fail-closed precheck; full verification (quotes, GPU, signature) is verify-attestation's job.
      if (!models.length) throw new ModelError("attestation_unavailable", `no NEAR model evidence for ${id}`);
      if (models.some((m) => m.request_nonce?.toLowerCase() !== nonce)) throw new ModelError("attestation_unavailable", "report nonce mismatch");

      const res = await f(`${NEARAI_API}/chat/completions`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "x-no-aliasing": "true", "accept-encoding": "identity" },
        body: new Uint8Array(request),
        signal: AbortSignal.timeout(180_000),
        redirect: "error",
      });
      if (!res.ok) {
        const body = (await readBytes(res, 4096).catch(() => Buffer.alloc(0))).toString("utf8");
        throw new ModelError(`http_${res.status}`, `NEAR AI Cloud answered HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const response = await readBytes(res, MAX_RESPONSE_BYTES);
      let chatId: string;
      let text: string | undefined;
      try {
        chatId = String((JSON.parse(response.toString("utf8")) as { id?: unknown }).id ?? "");
        text = completionText(response.toString("utf8"));
      } catch {
        throw new ModelError("bad_response", "NEAR AI Cloud returned a body that is not JSON");
      }
      if (!text) throw new ModelError("no_content", "NEAR AI Cloud returned no message content");
      evidence = {
        v: 2, kind: "tee-nearai", api: NEARAI_API, vault, model: id, salt: s, nonce, report, binding,
        request_b64: request.toString("base64"), response_b64: response.toString("base64"),
        chat_id: chatId, signature: chatId ? await signature(chatId) : null,
      };
      return text;
    },
  };
}
