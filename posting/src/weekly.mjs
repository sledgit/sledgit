// Weekly race data for a JSON-driven video composition (beats + race frames). Pure: snapshot in, JSON out.
import { stampFor, refusalCards } from "./cards.mjs";

export const WEEKLY_SCHEMA = "sledgit-weekly/1";
const WEEK_MS = 7 * 86_400_000;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function weekly(snap, { tokens, agentEvents, handle = "@sledgit_com" } = {}) {
  const stamp = stampFor(snap);
  const end = snap.as_of_ms, start = Math.max(snap.season.start_ms, end - WEEK_MS);
  const week = Math.floor((end - snap.season.start_ms) / WEEK_MS) + 1;
  const es = snap.entries.filter((e) => (e.kind === "arena" || e.kind === "house") && !e.id.startsWith("u-"));
  const times = [...new Set(es.flatMap((e) => e.series.map((p) => p.t)))].filter((t) => t >= start && t <= end).sort((a, b) => a - b);
  const frames = times.map((t) => ({
    t,
    rows: es.flatMap((e) => {
      const p = e.series.find((x) => x.t === t);
      return p && p.hold > 0 ? [{ id: e.id, value_vs_hold: r6(p.value / p.hold - 1) }] : [];
    }).sort((a, b) => b.value_vs_hold - a.value_vs_hold || (a.id < b.id ? -1 : 1)),
  }));
  const ranked = es.filter((e) => e.ranked);
  const ahead = ranked.filter((e) => e.vs_hold_after_gas > 0).length;
  const hook = ranked.length
    ? `Week ${week}: ${ahead} of ${ranked.length} ranked agents are ahead of just holding NEAR.`
    : `Week ${week}: no agent is ranked yet. Ranking starts on day 7.`;
  const ref = tokens && agentEvents ? refusalCards(snap, { tokens, agentEvents, max: 1, seenCodes: [] })[0] ?? null : null;
  const beats = [];
  let t0 = 0.4;
  const beat = (id, dur, text, viz) => { beats.push({ id, t0: r6(t0), dur, text, viz, shot: null, focus: null }); t0 += dur + 0.2; };
  beat("hook", 2.6, `${stamp} · ${hook}`, "title");
  beat("race", 18, "Every agent against the hold line, after costs.", "race");
  if (ref) beat("refusal", 6, ref.text, "refusal");
  beat("end", 3, `Receipts on chain. ${handle}`, "end");
  return {
    schema: WEEKLY_SCHEMA, network: snap.network, stamp, season: snap.season.id, week: { n: week, start_ms: start, end_ms: end },
    as_of_ms: end, derived_sha256: snap.derived_sha256, caveat: snap.caveat ?? null,
    fps: 30, duration: r6(t0 + 0.2), formats: ["1080x1080", "1920x1080"], beats,
    race: {
      metric: "value_vs_hold", baseline: { label: "Hold 50/50", value_vs_hold: 0 },
      entries: es.map((e) => ({ id: e.id, name: e.name, kind: e.kind, proof: e.proof.tier, ranked: e.ranked, final_vs_hold_after_gas: e.vs_hold_after_gas })),
      frames,
    },
    refusal_of_week: ref ? { id: ref.id, text: ref.text, link: ref.link } : null,
    end_card: { handle, line: "Receipts on chain" },
  };
}
