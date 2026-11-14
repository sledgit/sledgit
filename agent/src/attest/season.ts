// The season pill, checked against the chain rather than the receipts file: the vault must be a genuine Sledgit
// vault; every decision it recorded from the season's first seq on (request/refuse/skip, contiguous seq) must have a
// receipt in the file; each receipt that needs one must be attested (pill.ts) against its own on-chain event; and no
// evidence may back more than one receipt. Dropping a receipt, reusing a reply or replaying one onto another vault
// all lose the pill.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, type Receipt } from "../receipt.js";
import { cachedProvenance, type Provenance } from "../provenance.js";
import type { NetworkId } from "../config.js";
import { sealBundle, bundleResponse, type TeeBundle } from "./evidence.js";
import { verifyBundle, nrasOnline, type VerifyDeps, type Check } from "./verify.js";
import { attestDecision, requiresAttestation } from "./pill.js";
import { vaultDecisions, blockAt, tokenDecimals, rpcReader, vaultSeq, type ChainDecision } from "./chain.js";

export interface SeasonChain {
  provenance(vault: string): Promise<Provenance>;
  decisions(vault: string): Promise<ChainDecision[]>;
  decimals(token: string): Promise<number>;
  /** The vault's own decision counter (get_config.seq); the indexer's list must reach it. Missing = not checkable = no pill. */
  seq?(vault: string): Promise<number>;
}

export interface SeasonRow { seq: number; receipt_hash: string; attested: boolean; exempt?: true; failed: Check[] }

export interface SeasonResult {
  vault?: string;
  network?: string;
  provenance?: Provenance;
  from_seq: number;
  to_seq?: number;
  receipts: number;
  decisions: SeasonRow[];
  problems: string[];
  tee_pill: boolean;
}

export async function verifySeason(receiptsText: string, load: (sha: string) => TeeBundle | undefined, chain: SeasonChain,
  deps: VerifyDeps, fromSeq = 1): Promise<SeasonResult> {
  const lines = receiptsText.split("\n").filter((l) => l.trim());
  const res: SeasonResult = { from_seq: fromSeq, receipts: lines.length, decisions: [], problems: [], tee_pill: false };
  const byHash = new Map<string, { line: string; r: Receipt }>();
  for (const line of lines) {
    try {
      byHash.set(sha256Hex(line), { line, r: JSON.parse(line) as Receipt });
    } catch {
      res.problems.push(`unreadable receipt line ${sha256Hex(line).slice(0, 12)}`);
    }
  }
  const vaults = [...new Set([...byHash.values()].map((x) => x.r.vault))];
  const networks = [...new Set([...byHash.values()].map((x) => x.r.network))];
  if (vaults.length !== 1 || networks.length !== 1) {
    res.problems.push(`a season is one vault on one network; the file has ${vaults.length} vault(s), ${networks.length} network(s)`);
    return res;
  }
  res.vault = vaults[0];
  res.network = networks[0];
  res.provenance = await chain.provenance(res.vault);
  if (!res.provenance.sledgit_vault) res.problems.push(`not a genuine Sledgit vault: ${res.provenance.reason}`);

  // Evidence reuse: a chat id, bundle or reply may back one receipt only.
  const uses = new Map<string, number>();
  const keysOf = (r: Receipt): string[] => {
    if (!r.attestation) return [];
    const b = load(r.attestation.bundle_sha256);
    return [`bundle:${r.attestation.bundle_sha256}`, `chat:${r.attestation.chat_id}`,
      ...(b ? [`reply:${sha256Hex(bundleResponse(b))}`, `bundle:${sealBundle(b).sha256}`] : [])];
  };
  for (const { r } of byHash.values()) for (const k of new Set(keysOf(r))) uses.set(k, (uses.get(k) ?? 0) + 1);

  let events: ChainDecision[];
  try {
    events = (await chain.decisions(res.vault)).filter((e) => e.seq >= fromSeq);
  } catch (e) {
    res.problems.push(`could not read the vault's decisions: ${(e as Error).message.slice(0, 160)}`);
    return res;
  }
  if (!events.length) {
    res.problems.push(`no decisions on chain from seq ${fromSeq}`);
    return res;
  }
  res.to_seq = events[events.length - 1].seq;
  // The tail: decisions the indexer hasn't returned (lag or omission) must not be invisible. The vault's own counter
  // says how many decisions exist; every one up to it must be read and backed.
  if (!chain.seq) {
    res.problems.push("the vault's on-chain seq was not read, so the season's last decisions can't be checked");
  } else {
    try {
      const onchain = await chain.seq(res.vault);
      if (onchain > res.to_seq) {
        res.problems.push(`the vault has recorded ${onchain} decisions but the indexer returned up to seq ${res.to_seq}`);
        for (let s = res.to_seq + 1; s <= onchain; s++) {
          res.decisions.push({ seq: s, receipt_hash: "", attested: false, failed: [{ name: "decision event read from chain", ok: false, detail: `seq ${s} not returned by the indexer` }] });
        }
        res.to_seq = onchain;
      } else if (onchain < res.to_seq) {
        res.problems.push(`the indexer returned seq ${res.to_seq} beyond the vault's own seq ${onchain}`);
      }
    } catch (e) {
      res.problems.push(`could not read the vault's seq: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  const seen = new Set(events.map((e) => e.seq));
  const lastRead = events[events.length - 1].seq;
  for (let s = fromSeq; s <= lastRead; s++) {
    if (!seen.has(s)) res.decisions.push({ seq: s, receipt_hash: "", attested: false, failed: [{ name: "decision event read from chain", ok: false, detail: `seq ${s} missing` }] });
  }
  for (const ev of events) {
    const hit = byHash.get(ev.receipt_hash);
    if (!hit) {
      res.decisions.push({ seq: ev.seq, receipt_hash: ev.receipt_hash, attested: false,
        failed: [{ name: "receipt present for this on-chain decision", ok: false, detail: `${ev.event} #${ev.seq} in ${ev.tx}` }] });
      continue;
    }
    if (!requiresAttestation(hit.r)) {
      // No model was reached: no output, hold. It must still be what the vault recorded.
      const ok = ev.event === "skip";
      res.decisions.push({ seq: ev.seq, receipt_hash: ev.receipt_hash, attested: ok, exempt: true,
        failed: ok ? [] : [{ name: "no-model tick recorded as a skip", ok: false, detail: ev.event }] });
      continue;
    }
    const a = await attestDecision(hit.line, load, deps, { event: ev, decimals: chain.decimals });
    const reused = keysOf(hit.r).filter((k) => (uses.get(k) ?? 0) > 1);
    const checks: Check[] = [...a.checks, { name: "evidence backs this receipt only", ok: reused.length === 0, ...(reused.length ? { detail: reused.join(", ") } : {}) }];
    res.decisions.push({ seq: ev.seq, receipt_hash: ev.receipt_hash, attested: checks.every((c) => c.ok === true), failed: checks.filter((c) => c.ok !== true) });
  }
  res.decisions.sort((x, y) => x.seq - y.seq);
  const needed = res.decisions.filter((d) => !d.exempt);
  res.tee_pill = res.problems.length === 0 && needed.length > 0 && res.decisions.every((d) => d.attested);
  return res;
}

/** A season chain as of a cutoff whose last decision is `toSeq`: decisions after it are dropped, and the vault's counter
 * is its live seq less the decisions the indexer returned after `toSeq`. Later decisions never change the result; a
 * decision the indexer missed (before the cutoff, or after it) still leaves the counter above what was read, which fails
 * closed (round 3 R3-06 within the snapshot's cutoff, P4-8). */
export function chainAsOf<C extends SeasonChain>(c: C, toSeq: number, cutoffMs?: number): C {
  const all = new Map<string, Promise<ChainDecision[]>>();
  const read = (v: string) => all.get(v) ?? (all.set(v, c.decisions(v)), all.get(v)!);
  // After the cutoff = a higher seq AND (when the cutoff time is known) a block after it. A decision the collector's
  // indexer read missed but which landed before the cutoff stays in, so the season fails closed (final review 2 F2-16).
  const after = (x: ChainDecision) => x.seq > toSeq && (cutoffMs === undefined || x.block_time_secs * 1000 > cutoffMs);
  return {
    ...c,
    decisions: async (v: string) => (await read(v)).filter((x) => !after(x)),
    ...(c.seq ? { seq: async (v: string) => (await c.seq!(v)) - (await read(v)).filter(after).length } : {}),
  };
}

/** The default chain for a network: FastNEAR transactions API + RPC, with provenance from provenance.ts. */
export function chainFor(net: NetworkId, f: typeof fetch = fetch): SeasonChain & { block: NonNullable<VerifyDeps["block"]> } {
  const prov = cachedProvenance(net, rpcReader(net, f));
  const dec = new Map<string, Promise<number>>();
  return {
    provenance: prov,
    decisions: (v) => vaultDecisions(net, v, f),
    seq: (v) => vaultSeq(net, v, f),
    decimals: (t) => dec.get(t) ?? (dec.set(t, tokenDecimals(net, t, f)), dec.get(t)!),
    block: (n, h) => blockAt(n, h, f),
  };
}

/** verify-attestation: one bundle (.json), or a season (.jsonl) checked against the chain. Exit 0 only with the pill. */
export async function runVerifyAttestation(path: string, text: string, attestationsDir: string, out: (v: unknown) => void,
  opts: { deps?: VerifyDeps; chain?: (net: NetworkId) => SeasonChain & { block: NonNullable<VerifyDeps["block"]> }; fromSeq?: number } = {}): Promise<number> {
  const deps: VerifyDeps = opts.deps ?? { nras: nrasOnline };
  const chainOf = opts.chain ?? ((n: NetworkId) => chainFor(n));
  if (!path.endsWith(".jsonl")) {
    let b: TeeBundle;
    try {
      b = JSON.parse(text) as TeeBundle;
    } catch (e) {
      out({ pill: false, checks: [{ name: "bundle is JSON", ok: false, detail: (e as Error).message.slice(0, 120) }] });
      return 1;
    }
    const net: NetworkId = String(b?.vault ?? "").endsWith(".testnet") ? "testnet" : "mainnet";
    const r = await verifyBundle(b, { ...deps, block: deps.block ?? chainOf(net).block });
    out(r);
    return r.pill ? 0 : 1;
  }
  const load = (sha: string): TeeBundle | undefined => {
    if (!/^[0-9a-f]{64}$/.test(sha)) return undefined;
    const f = join(attestationsDir, `${sha}.json`);
    try {
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as TeeBundle) : undefined;
    } catch {
      return undefined;
    }
  };
  const first = text.split("\n").find((l) => l.trim());
  let net: NetworkId = "testnet";
  try {
    net = (JSON.parse(first ?? "{}") as Receipt).network === "mainnet" ? "mainnet" : "testnet";
  } catch {
    /* reported by verifySeason */
  }
  const chain = chainOf(net);
  const r = await verifySeason(text, load, chain, { ...deps, block: deps.block ?? chain.block }, opts.fromSeq ?? 1);
  out(r);
  return r.tee_pill ? 0 : 1;
}
