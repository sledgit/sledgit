// The "Attested model (TEE)" pill. Per decision: the receipt commits to a bundle, the bundle verifies, the bundle's
// request/reply are the receipt's own prompt, inputs and model output, the receipt's decision is exactly what that
// reply says, and the vault recorded that decision on chain within the evidence window after the signed reply. Per
// season (season.ts): every on-chain decision has such a receipt; one unattested decision drops the pill.
import { canonical, sha256Hex, type Receipt } from "../receipt.js";
import { parseDecision, toUnits } from "../decision.js";
import { sealBundle, bundleRequest, bundleResponse, completionText, boundUserMessage, type TeeBundle } from "./evidence.js";
import { verifyBundle, CLOCK_SKEW_SECS, type VerifyDeps, type Check } from "./verify.js";
import { nearAiPolicy } from "./policy.js";
import type { ChainDecision } from "./chain.js";
import { pinnedPair } from "../pairs.js";

export interface DecisionAttestation { receipt_hash: string; attested: boolean; checks: Check[] }

/** What the chain says about this decision: its event, and token decimals to compare amounts. */
export interface DecisionContext {
  event?: ChainDecision;
  decimals?: (token: string) => Promise<number>;
}

type Inputs = { vault?: { base?: string; quote?: string } } & Record<string, unknown>;

/**
 * The decision the arena records for `model_output` (arena.ts tick): parsed, or a fixed invalid_output code. The token
 * and its decimals come from the network's pinned pair, so editing the receipt's inputs can't change the answer.
 */
export function expectedDecision(r: Pick<Receipt, "model_output" | "network">): Record<string, string> {
  const p = parseDecision(r.model_output);
  const hold = (code: string) => ({ action: "hold", amount_in: "0", reason: code, error: code });
  if (!p.ok) return hold(`invalid_output:${p.code}`);
  const d = p.decision;
  if (d.action !== "hold") {
    const pair = pinnedPair(r.network);
    if (!pair) return hold("unknown_network");
    try {
      toUnits(d.amount_in, pair.decimals[d.action === "buy" ? pair.quote : pair.base]);
    } catch {
      return hold("invalid_output:amount_precision");
    }
  }
  return { action: d.action, amount_in: d.amount_in, reason: d.reason };
}

/** The receipt's recorded pair must be the network's pinned pair (the operator writes the inputs). */
export function pairCheck(r: Pick<Receipt, "network" | "inputs">): Check {
  const pair = pinnedPair(r.network);
  const v = ((r.inputs ?? {}) as Inputs).vault;
  return { name: "receipt pair = the network's pinned pair", ok: !!pair && v?.base === pair.base && v?.quote === pair.quote,
    detail: `${String(v?.base)}/${String(v?.quote)}` };
}

/** Checks that tie a receipt to its bundle; the bundle's own cryptography is verifyBundle's job. */
export function bindingChecks(r: Receipt, b: TeeBundle | undefined): Check[] {
  const a = r.attestation;
  if (!a) return [{ name: "receipt has an attestation", ok: false, detail: "self-reported" }];
  if (!b) return [{ name: "bundle file present", ok: false, detail: `attestations/${a.bundle_sha256}.json missing` }];
  const out: Check[] = [];
  out.push({ name: "bundle sha256 = receipt.attestation.bundle_sha256", ok: sealBundle(b).sha256 === a.bundle_sha256 });
  out.push({ name: "bundle vault/model/chat = receipt's", ok: b.vault === r.vault && b.model === r.model.id && r.model.provider === "nearai-tee" && b.chat_id === a.chat_id });
  try {
    const req = JSON.parse(bundleRequest(b).toString("utf8")) as { messages?: { role: string; content: string }[] };
    const [sys, user] = req.messages ?? [];
    const { raw: _raw, ...inputs } = (r.inputs ?? {}) as Record<string, unknown>;
    // v2: the user message is the receipt's inputs plus the binding (vault, salt, chain anchor), canonical.
    const expected = b.v === 2 && b.binding ? boundUserMessage(canonical(inputs), b.binding) : canonical(inputs);
    out.push({ name: "request system prompt = receipt.prompt_sha256", ok: sys?.role === "system" && sha256Hex(sys.content) === r.prompt_sha256 });
    out.push({ name: "request user message = receipt inputs", ok: user?.role === "user" && user.content === expected && req.messages?.length === 2 });
  } catch {
    out.push({ name: "request is JSON and the receipt inputs an object", ok: false });
  }
  try {
    out.push({ name: "reply text = receipt.model_output", ok: completionText(bundleResponse(b).toString("utf8")) === r.model_output });
  } catch {
    out.push({ name: "reply is JSON", ok: false });
  }
  out.push(pairCheck(r));
  // The decision must be what the attested reply says, not anything the operator chose to send.
  out.push({ name: "decision = what the reply says", ok: canonical(expectedDecision(r)) === canonical(r.decision),
    detail: `reply says ${canonical(expectedDecision(r)).slice(0, 120)}` });
  return out;
}

/** Does the vault's on-chain event record this receipt's decision (direction, token, amount)? */
export async function eventMatches(r: Receipt, ev: ChainDecision, decimals?: (token: string) => Promise<number>): Promise<Check> {
  const name = "the vault's on-chain event records this decision";
  const d = r.decision as { action?: string; amount_in?: string } | null;
  const pair = pinnedPair(r.network);
  if (d?.action === "hold") return { name, ok: ev.event === "skip", detail: `${ev.event} #${ev.seq}` };
  if (d?.action !== "buy" && d?.action !== "sell") return { name, ok: false, detail: "no valid action" };
  if (ev.event === "skip") {
    return { name, ok: !!ev.note?.startsWith("refused:") && ev.note.endsWith(` ${d.action} ${d.amount_in}`), detail: `skip #${ev.seq}` };
  }
  const token = !pair ? undefined : d.action === "buy" ? pair.quote : pair.base;
  if (!token || ev.token_in !== token) return { name, ok: false, detail: `token_in ${String(ev.token_in).slice(0, 80)} vs ${String(token)}` };
  if (!decimals) return { name, ok: null, detail: "amount not checked here (no chain access)" };
  try {
    const units = toUnits(String(d.amount_in), await decimals(token));
    return { name, ok: ev.amount_in === units.toString(), detail: `${ev.event} #${ev.seq}` };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message.slice(0, 120) };
  }
}

/** Never throws: a malformed receipt or bundle, or a network failure, fails a check. */
export async function attestDecision(receiptLine: string, loadBundle: (sha: string) => TeeBundle | undefined, deps: VerifyDeps = {},
  ctx: DecisionContext = {}): Promise<DecisionAttestation> {
  const receipt_hash = sha256Hex(receiptLine);
  const checks: Check[] = [];
  try {
    const r = JSON.parse(receiptLine) as Receipt;
    const b = r.attestation ? loadBundle(r.attestation.bundle_sha256) : undefined;
    checks.push(...bindingChecks(r, b));
    if (!b || !checks.every((c) => c.ok === true)) return { receipt_hash, attested: false, checks };
    const res = await verifyBundle(b, deps);
    checks.push(...res.checks);
    if (!ctx.event) {
      checks.push({ name: "decision recorded on chain within the evidence window", ok: null,
        detail: "not checked here: needs the vault's on-chain event (verify-attestation <receipts.jsonl>)" });
    } else {
      const ev = ctx.event;
      const maxAge = (deps.policy ?? nearAiPolicy()).max_evidence_age_secs;
      checks.push({ name: "on-chain event names this receipt", ok: ev.receipt_hash === receipt_hash, detail: `#${ev.seq} ${ev.tx}` });
      checks.push(await eventMatches(r, ev, ctx.decimals));
      const gap = res.created === undefined ? NaN : ev.block_time_secs - res.created;
      checks.push({ name: `decision recorded within ${maxAge} s after the signed reply`,
        ok: Number.isFinite(gap) && gap >= -CLOCK_SKEW_SECS && gap <= maxAge, detail: Number.isFinite(gap) ? `${Math.round(gap)} s` : "no signed reply time" });
    }
  } catch (e) {
    checks.push({ name: "decision readable and verifiable", ok: false, detail: (e as Error).message.slice(0, 160) });
  }
  return { receipt_hash, attested: checks.length > 0 && checks.every((c) => c.ok === true), checks };
}

/**
 * A receipt needs an attestation when a model produced output or a trade was decided. Ticks where no model was reached
 * (price or network error) have no output, always hold, and cannot trade, so they neither need nor break the pill.
 */
export function requiresAttestation(r: Receipt): boolean {
  return r.model_output !== "" || (r.decision as { action?: string } | null)?.action !== "hold";
}

/** The season rule: a pill only if at least one decision needed attesting and every such decision is attested. */
export function seasonPill(decisions: Pick<DecisionAttestation, "attested">[]): boolean {
  return decisions.length > 0 && decisions.every((d) => d.attested);
}
