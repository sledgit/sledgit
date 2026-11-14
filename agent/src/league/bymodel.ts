// The by-model view: the crowd of entries per model (or per published strategy), averaged. Part of the snapshot, so it is
// deterministic and covered by derived_sha256. No operator labels: an entry is its model, harness and proof tier.
import type { EntryResult, ModelGroup, ProofTier, RawEvent, VaultInput } from "./types.js";

const RANKABLE = new Set(["arena", "house"]);
const STRATEGY_NAMES: Record<string, string> = {
  rebalancer: "Rebalancer", trend: "Trend 50-day", luck: "Luck baseline", breakout: "Breakout 55/20", hold: "Hold-once",
};
const TIER_LABEL: Record<ProofTier, string> = { tee: "attested", rules: "open rules", self: "self-reported" };
/** Code-point order: the same on every machine, whatever the locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const r8 = (x: number): number => {
  if (!Number.isFinite(x)) throw new Error(`non-finite number in the by-model view: ${x}`);
  const v = Math.round(x * 1e8) / 1e8;
  return v === 0 ? 0 : v; // never -0
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A model id as one family name, whatever the serving stack calls it ("qwen3.6:35b-a3b" and
 * "Qwen/Qwen3.6-35B-A3B-FP8" are both "Qwen3.6 35B"). Unknown ids pass through unchanged. */
export function modelFamily(model: string): string {
  const m = model.trim().replace(/^[^/]+\//, "").toLowerCase();
  if (m.startsWith("rules:")) return STRATEGY_NAMES[m.slice(6)] ?? model.slice(6);
  let x = m.match(/^qwen(\d+(?:\.\d+)?)[-:_ ]?(\d+(?:\.\d+)?)b\b/);
  if (x) return `Qwen${x[1]} ${x[2]}B`;
  x = m.match(/^llama[-_ ]?(\d+(?:\.\d+)?)[-:_ ]?(\d+(?:\.\d+)?)b\b/);
  if (x) return `Llama ${x[1]} ${x[2]}B`;
  x = m.match(/^claude[-_ ](haiku|sonnet|opus|fable)[-_ ](\d+)(?:[-_.](\d+))?/);
  if (x) return `Claude ${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? `.${x[3]}` : ""}`;
  x = m.match(/^gpt[-_ ]?(\d+(?:\.\d+)?)/);
  if (x) return `GPT-${x[1]}`;
  return model;
}

/** Owner and agent at the cutoff, from the vault's own events (init, then owner_set / agent_set in block order). */
export function controlAt(events: RawEvent[]): { owner: string | null; agent: string | null } {
  let owner: string | null = null, agent: string | null = null;
  const sorted = [...events].sort((a, b) => a.block_height - b.block_height || cmp(a.receipt_id, b.receipt_id));
  for (const e of sorted) {
    if (e.event === "init") { owner = String(e.data.owner_id ?? "") || null; agent = String(e.data.agent_id ?? "") || null; }
    else if (e.event === "owner_set" && e.data.new) owner = String(e.data.new);
    else if (e.event === "agent_set" && e.data.new) agent = String(e.data.new);
  }
  return { owner, agent };
}

/** Entries sharing an owner OR an agent are one source (union-find); each source counts once in a model's average. */
function sources(members: { id: string; owner: string | null; agent: string | null }[]): string[][] {
  const parent = new Map(members.map((m) => [m.id, m.id]));
  const find = (x: string): string => { while (parent.get(x) !== x) x = parent.get(x)!; return x; };
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(cmp(ra, rb) <= 0 ? rb : ra, cmp(ra, rb) <= 0 ? ra : rb); };
  const by = new Map<string, string>();
  for (const m of members) for (const k of [m.owner && `o:${m.owner}`, m.agent && `a:${m.agent}`]) if (k) {
    const seen = by.get(k);
    if (seen) join(seen, m.id); else by.set(k, m.id);
  }
  const groups = new Map<string, string[]>();
  for (const m of members) groups.set(find(m.id), [...(groups.get(find(m.id)) ?? []), m.id]);
  return [...groups.values()].map((g) => g.sort(cmp)).sort((a, b) => cmp(a[0], b[0]));
}

/** Per (model family, proof tier): entries, sources, the average of vs hold after gas over RANKED entries (each source
 * averaged first), its spread, and a provisional figure over every entry with a result (shown, never scored). */
export function byModel(results: EntryResult[], vaults: VaultInput[]): ModelGroup[] {
  const ev = new Map(vaults.map((v) => [v.entry.id, v.events]));
  const pool = results.filter((r) => RANKABLE.has(r.kind) && r.provenance.status === "genuine");
  // Proven tiers group by what the proof binds, never the registry text (final review 2 F2-02).
  const modelOf = (r: EntryResult) => (r.proof.tier !== "self" && r.proof.verified_model) ? r.proof.verified_model : r.model;
  const keyOf = (r: EntryResult) => `${modelFamily(modelOf(r))}\u0000${r.proof.tier}`;
  const groups = new Map<string, EntryResult[]>();
  for (const r of pool) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  const out: ModelGroup[] = [];
  for (const [key, rs] of groups) {
    const [family, tier] = key.split("\u0000") as [string, ProofTier];
    const members = rs.map((r) => ({ id: r.id, ...controlAt(ev.get(r.id) ?? []) }));
    const avgOver = (keep: (r: EntryResult) => boolean) => {
      const ok = new Set(rs.filter((r) => keep(r) && r.vs_hold_after_gas !== null).map((r) => r.id));
      const per = sources(members.filter((m) => ok.has(m.id)))
        .map((g) => mean(g.map((id) => rs.find((r) => r.id === id)!.vs_hold_after_gas!)));
      return per.length ? { avg: r8(mean(per)), lo: r8(Math.min(...per)), hi: r8(Math.max(...per)), n: per.length } : null;
    };
    const scored = avgOver((r) => r.ranked);
    out.push({
      family, tier, label: `${family} · ${TIER_LABEL[tier]}`,
      strategy: modelOf(rs[0]).startsWith("rules:") ? modelOf(rs[0]).slice(6) : null,
      entries: rs.map((r) => r.id).sort(cmp),
      sources: sources(members).length,
      ranked_entries: rs.filter((r) => r.ranked).length,
      avg_vs_hold_after_gas: scored?.avg ?? null,
      spread: scored && scored.n >= 2 ? { lo: scored.lo, hi: scored.hi } : null,
      scored_sources: scored?.n ?? 0,
      provisional_vs_hold_after_gas: avgOver(() => true)?.avg ?? null,
      decisions: rs.reduce((a, r) => a + r.counts.decisions, 0),
      trades: rs.reduce((a, r) => a + r.counts.trades, 0),
      refusals: rs.reduce((a, r) => a + r.counts.refusals, 0),
      status: !scored ? "not enough data" : scored.n < 2 ? "one source" : "averaged",
    });
  }
  // Scored groups first by average, then the rest by decisions; ties by label (code points).
  return out.sort((a, b) => (a.avg_vs_hold_after_gas === null ? 1 : 0) - (b.avg_vs_hold_after_gas === null ? 1 : 0)
    || (b.avg_vs_hold_after_gas ?? 0) - (a.avg_vs_hold_after_gas ?? 0) || b.decisions - a.decisions || cmp(a.label, b.label));
}
