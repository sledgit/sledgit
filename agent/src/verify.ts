// Receipt verification against the chain. `lint` only checks canonical form; `verify` also requires every receipt's
// sha256 to appear as receipt_hash in a request/refuse/skip event emitted by the vault itself, in the transaction the
// outcomes file names, and the event to match the receipt's decision (direction, token_in, amount_in). Only a genuine
// Sledgit vault (provenance.ts) can make a receipt "ok": any contract can log a vault-shaped event.
import { readFileSync, existsSync } from "node:fs";
import { canonical, sha256Hex, type Receipt } from "./receipt.js";
import { toUnits } from "./decision.js";
import type { Network } from "./config.js";
import type { VaultEvent } from "./vault.js";
import type { Provenance } from "./provenance.js";
import { expectedDecision } from "./attest/pill.js";
import { legs, pinnedPair, type Leg } from "./pairs.js";

export interface EventSource {
  /** Events emitted by `vault` itself in transaction `tx` sent by `sender`. */
  txEvents(vault: string, tx: string, sender: string): Promise<VaultEvent[]>;
  decimals(token: string): Promise<number>;
  /** Whether `vault` is a genuine Sledgit vault (provenance.ts); checked before anything else is read from it. */
  provenance(vault: string): Promise<Provenance>;
}

export type VerifyStatus = "ok" | "mismatch" | "not_found" | "no_tx" | "dry_run" | "unparseable" | "unverified_vault" | "legacy_vault" | "error";

export interface VerifyRow {
  line: number;
  hash: string;
  ts?: string;
  canonical: boolean;
  status: VerifyStatus;
  onchain: boolean;
  tx?: string;
  seq?: unknown;
  event?: string;
  sledgit_vault?: boolean;
  /** The vault is genuine but from a superseded factory: the receipt verifies as history, not as a ranked record. */
  retired?: string;
  vault_reason?: string;
  problems: string[];
}

/** The only passing status: the receipt's own vault emitted its event on chain. */
export const PASSING: VerifyStatus[] = ["ok"];

/**
 * Does a row pass? A dry run never went on chain, so it fails unless the caller explicitly allows dry runs; even then
 * a row with any problem (e.g. the wrong network) fails. Both files come from whoever is being verified.
 */
export function rowPasses(r: VerifyRow, allowDryRun = false): boolean {
  if (!r.canonical || r.problems.length) return false;
  return r.status === "ok" || (allowDryRun && r.status === "dry_run");
}

const RECORD_EVENTS = ["request", "refuse", "skip"];

function parseLines(text: string): { n: number; line: string; value?: unknown }[] {
  return text.split("\n").map((line, i) => ({ n: i + 1, line })).filter((x) => x.line.trim()).map((x) => {
    try {
      return { ...x, value: JSON.parse(x.line) as unknown };
    } catch {
      return x;
    }
  });
}

/** Find the outcome rows for each receipt hash. Unparseable outcome lines are ignored. */
function outcomesByHash(text: string): Map<string, Record<string, unknown>[]> {
  const m = new Map<string, Record<string, unknown>[]>();
  for (const { value } of parseLines(text)) {
    const o = value as Record<string, unknown> | undefined;
    if (!o || typeof o.receipt_hash !== "string") continue;
    m.set(o.receipt_hash, [...(m.get(o.receipt_hash) ?? []), o]);
  }
  return m;
}

export async function verifyReceipts(receiptsText: string, outcomesText: string, net: Network, src: EventSource): Promise<VerifyRow[]> {
  const outcomes = outcomesByHash(outcomesText);
  const rows: VerifyRow[] = [];
  for (const { n, line, value } of parseLines(receiptsText)) {
    const hash = sha256Hex(line);
    const row: VerifyRow = { line: n, hash, canonical: false, status: "error", onchain: false, problems: [] };
    rows.push(row);
    if (value === undefined || typeof value !== "object" || value === null) { row.status = "unparseable"; continue; }
    const r = value as Receipt;
    row.ts = r.ts;
    row.canonical = canonical(r) === line;
    if (!row.canonical) row.problems.push("line is not in canonical form");
    if (r.network !== net.id) row.problems.push(`receipt network ${r.network} is not ${net.id}`);
    // A model's or rule's receipt must record exactly what its output says (the arena's own rule); a human CLI receipt
    // has no output to compare. Otherwise the on-chain trade wasn't the decision the receipt credits to the model.
    if (r.model?.provider !== "human" && typeof r.model_output === "string" && r.model_output !== "" && canonical(expectedDecision(r)) !== canonical(r.decision)) {
      row.problems.push("the receipt's decision is not what its model/rule output says");
    }
    const outs = outcomes.get(hash) ?? [];
    const withTx = outs.find((o) => typeof o.tx === "string");
    if (!withTx) {
      const dry = outs.some((o) => (o.outcome as { status?: string } | undefined)?.status === "dry_run");
      row.status = dry ? "dry_run" : outs.length ? "no_tx" : "not_found";
      if (!dry) row.problems.push(outs.length ? "outcome has no transaction" : "no outcome line names this receipt hash");
      continue;
    }
    row.tx = withTx.tx as string;
    try {
      const prov = await src.provenance(r.vault);
      row.sledgit_vault = prov.sledgit_vault;
      row.vault_reason = prov.reason;
      if (prov.retired) row.retired = prov.retired;
      if (!prov.sledgit_vault) {
        row.status = prov.status === "legacy" ? "legacy_vault" : "unverified_vault";
        row.problems.push(`${prov.status === "legacy" ? "legacy vault" : "not a Sledgit vault"}: ${prov.reason}`);
        continue;
      }
      const events = await src.txEvents(r.vault, row.tx, r.agent);
      const ev = events.find((e) => RECORD_EVENTS.includes(e.event) && e.data.receipt_hash === hash);
      if (!ev) {
        row.status = "mismatch";
        row.problems.push("the vault emitted no request/refuse/skip event with this receipt_hash in that transaction");
        continue;
      }
      row.onchain = true;
      row.event = ev.event;
      row.seq = ev.data.seq;
      row.problems.push(...(await decisionMatches(r, ev, net, src)));
      row.status = row.problems.length ? "mismatch" : "ok";
    } catch (e) {
      row.status = "error";
      row.problems.push(`could not read the transaction: ${(e as Error).message}`);
    }
  }
  return rows;
}

async function decisionMatches(r: Receipt, ev: VaultEvent, net: Network, src: EventSource): Promise<string[]> {
  const d = r.decision as { action?: string; amount_in?: string } | null;
  const action = d?.action;
  if (action === "hold") return ev.event === "skip" ? [] : [`decision is hold but the vault recorded ${ev.event}`];
  const pair = pinnedPair(net.id);
  const leg = pair && ["buy", "sell", "stake", "unstake"].includes(String(action)) ? legs({ ...pair, base: net.base, quote: net.quote }, action as Leg) : undefined;
  if (!leg) return [`decision has no valid action`];
  if (ev.event === "skip") {
    // The arena logs a local refusal (insufficient balance) as a skip with the decision's action and amount.
    const note = String(ev.data.note ?? "");
    return note.startsWith("refused:") && note.endsWith(` ${action} ${d?.amount_in}`) ? [] : [`decision is ${action} but the vault recorded a skip`];
  }
  const [tokenIn, tokenOut] = leg;
  // A wrong token ends it: its metadata is never fetched, so a hostile token's decimals can't cost anything.
  if (ev.data.token_in !== tokenIn) return [`token_in on chain ${clip(ev.data.token_in)}, decision implies ${tokenIn}`];
  if (ev.data.token_out !== undefined && ev.data.token_out !== tokenOut) return [`token_out on chain ${clip(ev.data.token_out)}, decision implies ${tokenOut}`];
  try {
    const units = toUnits(String(d?.amount_in), await src.decimals(tokenIn));
    if (String(ev.data.amount_in) !== units.toString()) return [`amount_in on chain ${clip(ev.data.amount_in)}, decision ${clip(d?.amount_in)} = ${clip(units)}`];
  } catch (e) {
    return [`decision amount_in unusable: ${clip((e as Error).message, 200)}`];
  }
  return [];
}

/** Chain or receipt values in messages are clipped, so no input can make a result large. */
const clip = (v: unknown, max = 80): string => {
  const s = String(v);
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
};

export const readIfExists = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
