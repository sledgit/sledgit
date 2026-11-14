// sledgit-league: build the leaderboard snapshot from the chain, recompute it from saved inputs, or check a
// committed snapshot against a fresh read of the chain with the same cutoff. Read-only.
//   build   <entries.json> [--as-of <ISO>] [--out <dir>]   collect + compute; writes inputs.json, snapshot.json, agents/*.json
//   compute <inputs.json> [--out <dir>]                    recompute offline from saved inputs
//   check   <entries.json> <snapshot.json>                 the committed body must hash to its own derived_sha256, then
//                                                          re-collect at its cutoff: exit 0 only if every entry and flag matches
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { canonical } from "../receipt.js";
import { chainAsOf, chainFor, runVerifyAttestation } from "../attest/season.js";
import { nrasOnline } from "../attest/verify.js";
import { houseCheck } from "../strategies/rerun.js";
import type { NetworkId } from "../config.js";
import { collect, type CollectDeps } from "./collect.js";
import { compute, selfConsistent } from "./compute.js";
import type { LeagueInputs, Snapshot } from "./types.js";

const pretty = (v: unknown) => `${JSON.stringify(JSON.parse(canonical(v)), null, 2)}\n`;

/** Write every file to a temp name first, then rename: a failure never leaves a half-written snapshot. */
function writeAll(files: [string, string][]) {
  const tmp = files.map(([p, body]) => {
    mkdirSync(dirname(p), { recursive: true });
    const t = `${p}.tmp-${process.pid}`;
    writeFileSync(t, body);
    return [t, p] as const;
  });
  for (const [t, p] of tmp) renameSync(t, p);
  // Agent files from an earlier snapshot (e.g. an entry that left the registry) would fail the site's hash check.
  const keep = new Set(files.map(([p]) => p));
  for (const d of new Set(files.map(([p]) => dirname(p)).filter((d) => d.endsWith("agents")))) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".json") && !keep.has(join(d, f))) unlinkSync(join(d, f));
  }
}

export function outputs(inp: LeagueInputs, snap: Snapshot, dir: string): [string, string][] {
  const files: [string, string][] = [[join(dir, "inputs.json"), pretty(inp)], [join(dir, "snapshot.json"), pretty(snap)]];
  for (const e of snap.entries) {
    const v = inp.vaults.find((x) => x.entry.id === e.id)!;
    files.push([join(dir, "agents", `${e.id}.json`), pretty({ schema: snap.schema, network: snap.network, as_of_ms: snap.as_of_ms,
      derived_sha256: snap.derived_sha256, entry: e, events: v.events, observed: v.observed })]);
  }
  return files;
}

export function deps(): CollectDeps {
  return {
    fetch, log: (s) => console.error(s), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // The season check over exactly the receipts the league kept, with the vault's decisions cut off at the snapshot's
    // last in-season seq: a later decision never changes a snapshot's result.
    teeSeason: async (text, attestDir, fromSeq, toSeq, cutoffMs) => {
      let res: { tee_pill?: boolean; vault?: string; problems?: string[]; decisions?: { seq: number; attested: boolean }[] } = {};
      const chain = (net: NetworkId) => chainAsOf(chainFor(net), toSeq, cutoffMs);
      const code = await runVerifyAttestation("season.jsonl", text, attestDir, (v) => { res = v as typeof res; },
        { deps: { nras: nrasOnline }, fromSeq, chain });
      const n = res.decisions?.length ?? 0, ok = res.decisions?.filter((x) => x.attested).length ?? 0;
      return code === 0 && res.tee_pill
        ? { pill: true, vault: res.vault, detail: `season check: ${ok} of ${n} decision(s) attested under the pinned NEAR AI policy` }
        : { pill: false, vault: res.vault, detail: (res.problems?.join("; ") || `${ok} of ${n} decision(s) attested`).slice(0, 300) };
    },
    rulesCheck: (text, net, decisions) => houseCheck(text, net, { decisions: async (_n, v) => decisions(v) }),
  };
}

export async function run(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { "as-of": { type: "string" }, out: { type: "string" } } });
  const [cmd, a, b] = positionals;
  if (cmd === "build" && a) {
    const asOf = o["as-of"] ? Date.parse(o["as-of"]) : Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
    if (!Number.isFinite(asOf)) throw new Error("--as-of must be an ISO time");
    const inp = await collect(a, asOf, deps());
    // A vault whose balances differ from its replay is unranked by its own flag (compute.ts); the others still publish.
    for (const v of inp.vaults) {
      const st = (v.observed.reconciliation as { status?: string } | undefined)?.status;
      if (st !== "ok") console.error(`note: ${v.entry.id} reconciliation ${st ?? "missing"}`);
    }
    // Shared owners or agents among arena/house entries (sybil, best-of-N): reported, for the registry's admission review.
    const who = new Map<string, string[]>();
    for (const v of inp.vaults) if (v.entry.kind === "arena" || v.entry.kind === "house") {
      const c = (v.observed.config ?? {}) as { owner_id?: string; agent_id?: string };
      for (const k of [c.owner_id && `owner ${c.owner_id}`, c.agent_id && `agent ${c.agent_id}`]) if (k) who.set(k, [...(who.get(k) ?? []), v.entry.id]);
    }
    for (const [k, list] of who) if (list.length > 1) console.error(`note: ${k} is shared by ${list.join(", ")}`);
    const snap = compute(inp);
    writeAll(outputs(inp, snap, o.out ?? dirname(a)));
    console.log(JSON.stringify({ as_of: new Date(asOf).toISOString(), derived_sha256: snap.derived_sha256, entries: snap.entries.length, flags: snap.flags.length }));
    return 0;
  }
  if (cmd === "compute" && a) {
    const inp = JSON.parse(readFileSync(a, "utf8")) as LeagueInputs;
    const snap = compute(inp);
    writeAll(outputs(inp, snap, o.out ?? dirname(a)));
    console.log(JSON.stringify({ derived_sha256: snap.derived_sha256 }));
    return 0;
  }
  if (cmd === "check" && a && b) {
    const committed = JSON.parse(readFileSync(b, "utf8")) as Snapshot;
    // First: the committed body must hash to its own derived_sha256 (an edited body with the old hash field fails here).
    if (!selfConsistent(committed)) {
      console.log(JSON.stringify({ same: false, problem: "the committed snapshot's body does not hash to its derived_sha256" }, null, 2));
      return 1;
    }
    const fresh = compute(await collect(a, committed.as_of_ms, deps()));
    const same = fresh.derived_sha256 === committed.derived_sha256;
    const diff = [...new Set([...fresh.entries, ...committed.entries].map((e) => e.id))]
      .filter((id) => canonical(fresh.entries.find((e) => e.id === id) ?? null) !== canonical(committed.entries.find((e) => e.id === id) ?? null));
    const flags = canonical(fresh.flags) === canonical(committed.flags);
    console.log(JSON.stringify({ same, committed: committed.derived_sha256, fresh: fresh.derived_sha256, entries_differing: diff, flags_equal: flags }, null, 2));
    return same && !diff.length && flags ? 0 : 1;
  }
  console.log("sledgit-league build <entries.json> [--as-of ISO] [--out dir] | compute <inputs.json> [--out dir] | check <entries.json> <snapshot.json>");
  return 2;
}

if (process.argv[1]?.endsWith("league/cli.ts")) {
  run(process.argv.slice(2)).then((c) => process.exit(c), (e: Error) => { console.error(`error: ${e.message}`); process.exit(1); });
}
