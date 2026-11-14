// Model providers. Every provider gets the same system prompt and the same user message, and returns raw text;
// parsing and validation happen once, in decision.ts, so no provider gets a softer check than another.
import Anthropic from "@anthropic-ai/sdk";
import { registerSecret, registerUrlSecrets, checkEndpointUrl, envOf } from "./config.js";

/** `endpoint` is set only when the Anthropic SDK was pointed somewhere other than the official API by env vars. */
export interface ModelRef { provider: "anthropic" | "openai-compatible" | "echo" | "nearai-tee" | "rules" | "iron-trader"; id: string; endpoint?: "custom" }
/** `ctx.vault` lets an attested provider bind its evidence to the vault the decision is for. */
export interface Model { ref: ModelRef; complete(system: string, user: string, ctx?: { vault: string }): Promise<string> }

/** Largest model reply read, in bytes. A decision is under 1 KB; reasoning models need more, but not megabytes. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * A provider failure. `code` is a fixed identifier ([a-z0-9_]+) that is safe to put in receipts, outcomes and on
 * chain. `detail` may hold server text and stays in local output only (after redaction).
 */
export class ModelError extends Error {
  constructor(readonly code: string, readonly detail = code) {
    super(detail);
  }
}

/** Map any thrown value to a fixed error code; never returns free text. */
export function modelErrorCode(e: unknown): string {
  if (e instanceof ModelError) return e.code;
  const err = e as { name?: string; status?: unknown };
  if (typeof err?.status === "number") return `http_${err.status}`;
  const name = String(err?.name ?? "");
  if (/timeout/i.test(name) || name === "AbortError") return "timeout";
  if (/connection/i.test(name) || e instanceof TypeError) return "network";
  return "other";
}

/** JSON schema for the decision; used by providers that can enforce it. Validation still runs on the result. */
export const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["buy", "sell", "hold"] },
    amount_in: { type: "string" },
    reason: { type: "string" },
  },
  required: ["action", "amount_in", "reason"],
  additionalProperties: false,
} as const;

export function makeModel(provider: string, id: string, env: NodeJS.ProcessEnv = process.env): Model {
  switch (provider) {
    case "anthropic": return anthropic(id, env);
    case "openai-compatible": return openaiCompatible(id, env);
    case "echo": return echo(id);
    case "nearai-tee": throw new Error("the nearai-tee provider is selected with --attest tee");
    default: throw new Error(`unknown provider ${provider} (anthropic | openai-compatible | echo)`);
  }
}

const ANTHROPIC_API = "https://api.anthropic.com";

/**
 * The SDK honours ANTHROPIC_BASE_URL and ANTHROPIC_CUSTOM_HEADERS. The runner passes the base URL explicitly from the
 * given env (so tests and the receipt see the same value) and marks the receipt's model `endpoint: "custom"` when
 * either is set: the named model is then whatever that endpoint says it is.
 */
function anthropic(id: string, env: NodeJS.ProcessEnv): Model {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  registerSecret(env.ANTHROPIC_API_KEY);
  const custom = !!(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_CUSTOM_HEADERS);
  const baseURL = env.ANTHROPIC_BASE_URL || ANTHROPIC_API;
  if (env.ANTHROPIC_BASE_URL) {
    registerUrlSecrets(baseURL);
    checkEndpointUrl(baseURL, "ANTHROPIC_BASE_URL", env);
  }
  // One request per tick: SDK retries would make several model calls under one receipt.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL, maxRetries: 0, timeout: 180_000 });
  return {
    ref: { provider: "anthropic", id, ...(custom ? { endpoint: "custom" as const } : {}) },
    async complete(system, user) {
      // No server-side fallbacks: a fallback model would answer under this model's name and spoil the comparison.
      const r = await client.messages.create({
        model: id,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: DECISION_SCHEMA } },
      });
      if (r.stop_reason === "refusal") throw new ModelError("refused", `model refused (${r.stop_details?.category ?? "no category"})`);
      if (r.stop_reason === "max_tokens") throw new ModelError("max_tokens", "model hit max_tokens before finishing");
      const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new ModelError("oversize", "model reply above the size cap");
      return text;
    },
  };
}

/** Read a response body, stopping at `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
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
  return Buffer.concat(chunks).toString("utf8");
}

/** Model call timeout for local servers: SLEDGIT_MODEL_TIMEOUT_S, 30–900 s, default 180 (big local models are slow). */
export function modelTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = envOf(env, "MODEL_TIMEOUT_S");
  if (raw === undefined || raw === "") return 180_000;
  const s = Number(raw);
  if (!Number.isInteger(s) || s < 30 || s > 900) throw new Error("SLEDGIT_MODEL_TIMEOUT_S must be a whole number of seconds, 30 to 900");
  return s * 1000;
}

/** Any /v1/chat/completions server (a home server, llama-swap, vLLM, ...). No JSON mode: some local servers return {}. */
function openaiCompatible(id: string, env: NodeJS.ProcessEnv): Model {
  const base = envOf(env, "OPENAI_BASE_URL");
  if (!base) throw new Error("SLEDGIT_OPENAI_BASE_URL is not set (e.g. https://host/v1)");
  registerUrlSecrets(base); // internal hosts (LAN, mesh) must never reach a receipt or the chain
  checkEndpointUrl(base, "SLEDGIT_OPENAI_BASE_URL", env);
  const key = envOf(env, "OPENAI_API_KEY");
  registerSecret(key);
  const timeoutMs = modelTimeoutMs(env);
  return {
    ref: { provider: "openai-compatible", id },
    async complete(system, user) {
      const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: id, max_tokens: 4000, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!res.ok) {
        const body = await readCapped(res, 4096).catch(() => "");
        throw new ModelError(`http_${res.status}`, `endpoint answered HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const body = await readCapped(res, MAX_RESPONSE_BYTES);
      let parsed: { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        throw new ModelError("bad_response", "endpoint returned a body that is not JSON");
      }
      const msg = parsed.choices?.[0]?.message;
      // Qwen3-style servers sometimes put the whole answer in reasoning_content.
      const text = msg?.content || msg?.reasoning_content;
      if (!text) throw new ModelError("no_content", "endpoint returned no message content");
      return text;
    },
  };
}

/** Offline stub: id is "hold", "buy <amount>" or "sell <amount>". Used for tests and dry runs; no network. */
function echo(id: string): Model {
  const [action, amount = "0"] = id.trim().split(/\s+/);
  return {
    ref: { provider: "echo", id },
    complete: async () => JSON.stringify({ action, amount_in: amount, reason: `echo provider: ${id}` }),
  };
}
