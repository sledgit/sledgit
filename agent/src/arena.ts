// One arena tick: state + reference price -> model decision -> sealed receipt -> preview -> request_swap or log_skip.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseDecision, toUnits, fromUnits, clipBytes, type Decision } from "./decision.js";
import { sealReceipt, appendLine, canonical, type Json, type AttestationRef } from "./receipt.js";
import { sealBundle, type TeeBundle } from "./attest/evidence.js";
import { redact } from "./config.js";
import { modelErrorCode, type Model } from "./models.js";
import { PriceError, type RefPrice } from "./price.js";
import type { Vault, Outcome, Policy, Preview } from "./vault.js";

export interface Prompt { text: string; sha256: string; path: string }

export function loadPrompt(path: string): Prompt {
  const buf = readFileSync(path);
  return { text: buf.toString("utf8"), sha256: createHash("sha256").update(buf).digest("hex"), path };
}

export interface TickDeps {
  vault: Vault;
  model: Model;
  prompt: Prompt;
  price: () => Promise<RefPrice>;
  receiptsPath: string;
  outcomesPath: string;
  historySize?: number;
  /** Stop after sealing the receipt; send nothing on-chain. */
  dryRun?: boolean;
  /** Self-reported agent software recorded in the receipt. */
  harness?: string;
  /** Extra market data for rule-based agents (daily candles); recorded in the inputs as `market`. */
  market?: () => Promise<Json>;
  /** On-chain state for rule-based agents (decision history, slot block); recorded in the inputs as `chain`. */
  chain?: Json;
}

/** Default harness label: this runner. */
export const RUNNER_HARNESS = "sledgit-runner/0.1.0";

/** Bundles live next to the receipts: <dir>/attestations/<sha256>.json. */
export const attestationsDir = (receiptsPath: string): string => join(dirname(receiptsPath), "attestations");

function saveBundle(receiptsPath: string, b: TeeBundle): AttestationRef {
  const { text, sha256 } = sealBundle(b);
  const dir = attestationsDir(receiptsPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha256}.json`), text, { mode: 0o600 });
  return { kind: "tee-nearai", bundle_sha256: sha256, chat_id: b.chat_id, signing_address: b.signature?.signing_address ?? null };
}

/** Why a run must end: the owner froze the vault, or the vault no longer names this key's account as its agent. */
export type StopReason = "frozen" | "agent_replaced";

export interface TickResult {
  receipt_hash: string;
  decision: Decision;
  /** Fixed code (`model_error:<code>`, `invalid_output:<code>`, `price_error:<code>`); recorded in receipt and outcomes. */
  decision_error?: string;
  /** Redacted detail for the operator's terminal only; never stored or sent on chain. */
  decision_detail?: string;
  preview?: Preview;
  local_refusal?: string;
  tx?: string;
  /** Set when the tick did nothing (no model call, no receipt, no transaction) and the run must stop. */
  stopped?: StopReason;
  outcome: Outcome | { status: "dry_run" } | { status: "stopped"; reason: StopReason };
}

/** The only notes the arena ever puts on chain. */
export const SKIP_NOTES = ["hold", "model_error", "invalid_model_output", "price_error"] as const;

/** Policy amounts in token units, so the model never has to scale 10^24 by itself. */
function humanPolicy(p: Policy, dec: Record<string, number>): Json {
  const d = (t: string, v: string) => (t in dec ? fromUnits(v, dec[t]) : v);
  return {
    tokens: p.tokens.map((t) => ({ token: t.token, max_per_trade: d(t.token, t.max_per_trade), max_per_day: d(t.token, t.max_per_day) })),
    pairs: p.pairs.map((x) => ({ token_in: x.token_in, token_out: x.token_out,
      worst_price_out_per_in: Number(x.min_price_num) / Number(x.min_price_den) * 10 ** ((dec[x.token_in] ?? 0) - (dec[x.token_out] ?? 0)) })),
    max_trades_per_hour: p.max_trades_per_hour,
    max_slippage_bps: p.max_slippage_bps,
  };
}

/** The model's recent real decisions. Lines that do not parse (a crash mid-write) and dry runs are skipped. */
export function readHistory(path: string, vault: string, model: string, n: number): Json[] {
  if (!existsSync(path)) return [];
  const rows: Record<string, Json>[] = [];
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as unknown;
      if (r && typeof r === "object" && !Array.isArray(r)) rows.push(r as Record<string, Json>);
    } catch {
      /* partial line: ignored */
    }
  }
  return rows
    .filter((r) => r.vault === vault && r.model === model && (r.outcome as { status?: string } | null)?.status !== "dry_run")
    .slice(-n)
    .map((r) => ({ ts: r.ts, decision: r.decision, outcome: r.outcome }));
}

export async function tick(d: TickDeps): Promise<TickResult> {
  const { vault, model } = d;
  const { base, quote } = vault.net;
  const modelKey = `${model.ref.provider}:${model.ref.id}`;

  // The brake comes first: no model call and no transaction once the owner froze the vault or replaced the agent.
  const config = await vault.config();
  const stop: StopReason | undefined = config.frozen ? "frozen"
    : vault.agentId !== undefined && config.agent_id !== vault.agentId ? "agent_replaced" : undefined;
  if (stop) {
    return { receipt_hash: "", decision: { action: "hold", amount_in: "0", reason: stop }, stopped: stop,
      outcome: { status: "stopped", reason: stop } };
  }

  const [policy, usage, intents, inFlight, decBase, decQuote, balBase, balQuote] = await Promise.all([
    vault.policy(), vault.usage(), vault.intents(), vault.inFlight(),
    vault.decimals(base), vault.decimals(quote), vault.balance(base), vault.balance(quote),
  ]);
  let refPrice: RefPrice | null = null;
  let decisionError: string | undefined;
  let detail: string | undefined;
  try {
    refPrice = await d.price();
  } catch (e) {
    decisionError = `price_error:${e instanceof PriceError ? e.code : "unavailable"}`;
    detail = (e as Error).message;
  }
  let market: Json | undefined;
  if (!decisionError && d.market) {
    try {
      market = await d.market();
    } catch (e) {
      decisionError = `price_error:${e instanceof PriceError ? e.code : "unavailable"}`;
      detail = (e as Error).message;
    }
  }
  const dec: Record<string, number> = { [base]: decBase, [quote]: decQuote };
  const inputs = {
    reference_price: refPrice as unknown as Json,
    vault: {
      base, quote, frozen: config.frozen, busy: inFlight !== null || intents.open_intent !== null,
      balances: { [base]: fromUnits(balBase, decBase), [quote]: fromUnits(balQuote, decQuote) },
      policy: humanPolicy(policy, dec),
      usage: { trades_this_hour: usage.trades, spent_24h: Object.fromEntries(usage.spent.map(([t, v]) => [t, t in dec ? fromUnits(v, dec[t]) : v])) },
    },
    // historySize 0: no local history at all (house rules read their history from chain instead).
    history: d.historySize === 0 ? [] : readHistory(d.outcomesPath, vault.id, modelKey, d.historySize ?? 5),
    ...(market !== undefined ? { market } : {}),
    ...(d.chain !== undefined ? { chain: d.chain } : {}),
  };
  // Raw chain values too, so a verifier does not have to trust the conversion above.
  const raw = { config, policy, usage, balances: { [base]: balBase.toString(), [quote]: balQuote.toString() }, decimals: dec,
    chain_id: vault.chainId };

  let output = "";
  let decision: Decision = { action: "hold", amount_in: "0", reason: "" };
  if (!decisionError) {
    try {
      // Redacted before anything else sees it: the receipt is sealed over these bytes.
      output = redact(await model.complete(d.prompt.text, canonical(inputs), { vault: vault.id }));
    } catch (e) {
      decisionError = `model_error:${modelErrorCode(e)}`;
      detail = (e as Error)?.message;
    }
  }
  // An attested provider leaves evidence for the call it just made; the receipt commits to it by hash.
  const evidence = "takeEvidence" in model ? (model as { takeEvidence(): TeeBundle | undefined }).takeEvidence() : undefined;
  const attestation = evidence ? saveBundle(d.receiptsPath, evidence) : undefined;
  if (!decisionError) {
    const p = parseDecision(output);
    if (p.ok) decision = { ...p.decision, reason: redact(p.decision.reason) };
    else { decisionError = `invalid_output:${p.code}`; detail = p.error; }
  }
  const tokenIn = decision.action === "buy" ? quote : base;
  const tokenOut = decision.action === "buy" ? base : quote;
  let amountIn = 0n;
  if (!decisionError && decision.action !== "hold") {
    try {
      amountIn = toUnits(decision.amount_in, dec[tokenIn]);
    } catch (e) {
      decisionError = "invalid_output:amount_precision";
      detail = (e as Error).message;
    }
  }
  if (decisionError) decision = { action: "hold", amount_in: "0", reason: decisionError };

  const ts = new Date().toISOString();
  const { line, hash } = sealReceipt({
    v: 2, vault: vault.id, network: vault.net.id, agent: vault.agentId ?? "", harness: d.harness ?? RUNNER_HARNESS, model: model.ref,
    prompt_sha256: d.prompt.sha256, inputs: { ...inputs, raw } as unknown as Json,
    decision: { ...decision, ...(decisionError ? { error: decisionError } : {}) } as unknown as Json,
    model_output: output, ...(attestation ? { attestation } : {}), ts,
  });
  appendLine(d.receiptsPath, line);

  const result: TickResult = { receipt_hash: hash, decision, decision_error: decisionError, outcome: { status: "dry_run" },
    ...(detail ? { decision_detail: redact(detail).slice(0, 500) } : {}) };
  let sent: { method: string; venue?: string; min_amount_out?: string; note?: string } | undefined;
  if (!d.dryRun) {
    const skip = async (note: string) => {
      sent = { method: "log_skip", note: clipBytes(note) };
      const r = await vault.logSkip(hash, sent.note!);
      result.tx = r.tx;
      result.outcome = r.outcome;
    };
    if (decision.action === "hold") {
      // On chain only a fixed code; the model's own words stay in the off-chain receipt (bound by receipt_hash).
      await skip(!decisionError ? "hold" : decisionError.startsWith("model_error") ? "model_error"
        : decisionError.startsWith("price_error") ? "price_error" : "invalid_model_output");
    } else {
      const bal = tokenIn === base ? balBase : balQuote;
      if (amountIn > bal) {
        result.local_refusal = "insufficient_balance";
        await skip(`refused:insufficient_balance ${decision.action} ${decision.amount_in}`);
      } else {
        result.preview = await vault.preview(tokenIn, tokenOut, amountIn, 1n);
        if (!result.preview.ok) {
          await skip(`refused:${result.preview.code} ${decision.action} ${decision.amount_in}`);
        } else {
          sent = { method: "request_swap", venue: "rhea", min_amount_out: result.preview.band_floor };
          const r = await vault.requestSwap(tokenIn, tokenOut, amountIn, BigInt(result.preview.band_floor), hash);
          result.tx = r.tx;
          result.outcome = r.outcome;
        }
      }
    }
  }
  appendLine(d.outcomesPath, canonical({
    ts, vault: vault.id, network: vault.net.id, chain_id: vault.chainId, model: modelKey, receipt_hash: hash,
    decision, decision_error: decisionError, preview: result.preview, local_refusal: result.local_refusal,
    sent, tx: result.tx, outcome: result.outcome,
  }));
  return result;
}
