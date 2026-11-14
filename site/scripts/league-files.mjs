// Prebuild: bring the committed leaderboard snapshots (deploy/<network>/league/; mainnet optional, built from the chain by
// `node agent/bin/league.mjs build`) into the site. The site never computes standings itself. Missing files fail the build,
// and so does a snapshot whose body doesn't hash to its own derived_sha256, or an agent file that isn't exactly its entry.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Same canonical JSON as agent/src/receipt.ts: sorted keys (code-unit order), no whitespace, undefined keys dropped.
function canonical(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`non-finite number: ${v}`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  throw new Error(`unsupported value: ${typeof v}`);
}
const sha256 = s => createHash("sha256").update(s).digest("hex");

const site = join(dirname(fileURLToPath(import.meta.url)), "..");

// Verified { snapshot, agents } for one network, or null when it has no snapshot and isn't required.
function load(net, required) {
  const src = join(site, `../deploy/${net}/league`);
  const snapPath = join(src, "snapshot.json");
  if (!existsSync(snapPath)) {
    if (required) throw new Error(`${snapPath} missing: run node agent/bin/league.mjs build deploy/${net}/league/entries.json`);
    return null;
  }
  const snapshot = JSON.parse(readFileSync(snapPath, "utf8"));
  if (snapshot.network !== net) throw new Error(`${snapPath}: network is ${snapshot.network}, expected ${net}`);
  const { season, entries, benchmarks, flags, luck_entry, by_model } = snapshot;
  if (sha256(canonical({ season, entries, benchmarks, flags, luck_entry, by_model })) !== snapshot.derived_sha256)
    throw new Error(`${net} snapshot.json: the body does not hash to its derived_sha256 (edited after it was computed?)`);
  const agents = {};
  // An empty league has no agents/ folder.
  const dir = join(src, "agents");
  for (const f of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).sort() : []) {
    const a = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (a.derived_sha256 !== snapshot.derived_sha256) throw new Error(`${net} ${f} is from another snapshot`);
    const e = entries.find(x => x.id === a.entry.id);
    if (!e || canonical(e) !== canonical(a.entry)) throw new Error(`${net} ${f}: its entry differs from the snapshot's`);
    if (sha256(canonical(a.events)) !== e.events_sha256) throw new Error(`${net} ${f}: its events don't hash to the entry's events_sha256`);
    agents[a.entry.id] = { events: a.events, observed: a.observed };
  }
  for (const e of entries) if (!agents[e.id]) throw new Error(`${net}: no agent file for ${e.id}`);
  return { snapshot, agents };
}

mkdirSync(join(site, "src/data"), { recursive: true });
mkdirSync(join(site, "public/league"), { recursive: true });
for (const [net, required] of [["testnet", true], ["mainnet", false]]) {
  const d = load(net, required);
  // Mainnet without a snapshot is written as null, so the site builds and shows "no vaults yet".
  writeFileSync(join(site, `src/data/league-${net}.json`), JSON.stringify(d));
  const pub = join(site, `public/league/${net}.json`);
  if (d) writeFileSync(pub, JSON.stringify(d.snapshot));
  else rmSync(pub, { force: true });
  console.log(d ? `league: ${net} snapshot ${d.snapshot.derived_sha256.slice(0, 12)} (${d.snapshot.entries.length} entries), body and agent files verified`
    : `league: no ${net} snapshot (deploy/${net}/league/snapshot.json): ${net} league is empty`);
}
