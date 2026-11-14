// Network config, the agent key, endpoint checks and log redaction. Secrets come only from env-named files or env vars.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { KeyPair } from "near-api-js";
import { PAIRS } from "./pairs.js";

export type NetworkId = "testnet" | "mainnet";

export interface Network {
  id: NetworkId;
  rpc: string;
  /** Arena pair: base is what "buy"/"sell" refer to, quote is the dollar side. */
  base: string;
  quote: string;
  explorer: string;
}

export const NETWORKS: Record<NetworkId, Network> = {
  testnet: {
    id: "testnet",
    rpc: "https://rpc.testnet.fastnear.com",
    base: PAIRS.testnet.base,
    quote: PAIRS.testnet.quote,
    explorer: "https://testnet.nearblocks.io/txns/",
  },
  mainnet: {
    id: "mainnet",
    rpc: "https://free.rpc.fastnear.com",
    base: PAIRS.mainnet.base,
    quote: PAIRS.mainnet.quote,
    explorer: "https://nearblocks.io/txns/",
  },
};

/** Environment variable SLEDGIT_<name>, else the old IRON_TRADE_<name>. */
export function envOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`SLEDGIT_${name}`] ?? env[`IRON_TRADE_${name}`]; // legacy: remove after the server redeploy
}

export const MAINNET_CONFIRM_ENV = "SLEDGIT_MAINNET_CONFIRM";
export const MAINNET_CONFIRM_VALUE = "I-UNDERSTAND-REAL-FUNDS";

/**
 * Testnet unless --mainnet is passed AND the confirmation env var holds the exact phrase. A SLEDGIT_RPC override
 * is only a transport choice: callers must still check the node's chain_id (Vault.assertChain) before signing.
 */
export function selectNetwork(mainnetFlag: boolean, env: NodeJS.ProcessEnv = process.env): Network {
  const base = mainnetFlag ? NETWORKS.mainnet : NETWORKS.testnet;
  if (mainnetFlag && env[MAINNET_CONFIRM_ENV] !== MAINNET_CONFIRM_VALUE) { // no legacy name for this one
    throw new Error(`--mainnet needs ${MAINNET_CONFIRM_ENV}=${MAINNET_CONFIRM_VALUE}`);
  }
  const rpcEnv = envOf(env, "RPC");
  const rpc = rpcEnv || base.rpc;
  if (rpcEnv) {
    registerUrlSecrets(rpc); // an RPC URL can carry an API key, and near-api-js errors quote the URL
    checkEndpointUrl(rpc, "SLEDGIT_RPC", env);
  }
  const net: Network = { ...base, rpc, base: envOf(env, "BASE") || base.base, quote: envOf(env, "QUOTE") || base.quote };
  assertAccountsMatchNetwork(net, [net.base, net.quote]);
  return net;
}

const IMPLICIT = /^[0-9a-f]{64}$/;

/** Named accounts must carry the network's suffix, so a mainnet id can never be used on a testnet run or the reverse. */
export function assertAccountsMatchNetwork(net: Pick<Network, "id">, ids: string[]): void {
  for (const id of ids) {
    const ok = net.id === "testnet"
      ? id.endsWith(".testnet")
      : !id.endsWith(".testnet") && (id.endsWith(".near") || IMPLICIT.test(id));
    if (!ok) throw new Error(`${id} is not a ${net.id} account (${net.id === "testnet" ? ".testnet" : ".near"} expected)`);
  }
}

const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);
/** Yggdrasil overlay addresses (200::/7) are encrypted end to end by the overlay itself. */
const isYggdrasil = (host: string) => isIP(host) === 6 && /^0?[23][0-9a-f]{2}:/i.test(host);

/**
 * Endpoint rules: no userinfo; https, except loopback, Yggdrasil overlay addresses, or a host listed in
 * SLEDGIT_HTTP_HOSTS (comma-separated). Plain HTTP elsewhere exposes the bearer key and lets anyone on the path
 * answer for the model or the chain.
 */
export function checkEndpointUrl(raw: string, name: string, env: NodeJS.ProcessEnv = process.env): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (u.username || u.password) throw new Error(`${name} must not contain credentials (user:pass@); use the API key variable`);
  if (u.protocol === "https:") return u;
  if (u.protocol !== "http:") throw new Error(`${name} must be https`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const allowed = (envOf(env, "HTTP_HOSTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (isLoopback(host) || isYggdrasil(host) || allowed.includes(host)) return u;
  throw new Error(`${name} must be https (http is allowed only for loopback, Yggdrasil, or SLEDGIT_HTTP_HOSTS)`);
}

/** Register a URL and its sensitive parts (userinfo, host, query, path) so no message can repeat them. */
export function registerUrlSecrets(raw: string | undefined): void {
  if (!raw) return;
  registerSecret(raw);
  registerSecret(raw.replace(/\/+$/, ""));
  try {
    const u = new URL(raw);
    registerSecret(u.origin);
    registerSecret(u.host);
    if (u.username) registerSecret(decodeURIComponent(u.username));
    if (u.password) registerSecret(decodeURIComponent(u.password));
    if (u.search) registerSecret(u.search.slice(1));
    if (u.pathname.length > 1) registerSecret(u.pathname);
  } catch {
    /* not a URL: the raw string is registered above */
  }
}

export interface AgentKey {
  accountId: string;
  secretKey: string;
}

/**
 * Key file path from SLEDGIT_KEY_FILE. Accepts {secret_key|private_key, account_id?, accounts?}.
 * The account is SLEDGIT_AGENT, else the file's account_id. The key is never printed: a parse error names only
 * the path, and every form of the key is registered with the redactor before anything else can fail.
 */
export function loadAgentKey(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = (m) => console.error(m)): AgentKey {
  const raw = envOf(env, "KEY_FILE");
  if (!raw) throw new Error("SLEDGIT_KEY_FILE is not set (path to a JSON key file)");
  const path = raw.replace(/^~(?=\/)/, homedir());
  const text = readFileSync(path, "utf8");
  for (const m of text.match(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g) ?? []) registerSecret(m);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`key file is not valid JSON: ${raw}`);
  }
  const secretKey = (data.secret_key ?? data.private_key) as string | undefined;
  if (typeof secretKey !== "string" || !secretKey.startsWith("ed25519:")) {
    throw new Error(`key file has no ed25519 secret_key/private_key: ${raw}`);
  }
  registerSecret(secretKey);
  try {
    // near-api-js keeps the 32-byte seed as a separate base58 string; register that form too.
    const kp = KeyPair.fromString(secretKey as `ed25519:${string}`) as unknown as { secretKey?: string; extendedSecretKey?: string };
    registerSecret(kp.secretKey);
    registerSecret(kp.extendedSecretKey);
  } catch {
    throw new Error(`key file holds a malformed ed25519 key: ${raw}`);
  }
  const mode = statSync(path).mode;
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    warn(`warning: key file ${raw} is readable by other users (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`);
  }
  const accountId = envOf(env, "AGENT") || (data.account_id as string | undefined);
  if (!accountId) throw new Error("set SLEDGIT_AGENT (the agent account) or add account_id to the key file");
  return { accountId, secretKey };
}

const secrets = new Set<string>();

export function registerSecret(s: string | undefined): void {
  if (s && s.length >= 8) secrets.add(s);
}

/** Replace every registered secret in a string, longest first. Used on everything the CLI prints or stores. */
export function redact(text: string): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("[REDACTED]");
  return out;
}

/** Integer option in [min, max]; anything else (5m, 1e9, Infinity, 2.5) is an error, never a coerced default. */
export function boundedInt(raw: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be from ${min} to ${max}, got ${n}`);
  return n;
}
