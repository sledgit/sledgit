"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";
import { BENCH, BENCH_ORDER } from "@/lib/bots";
import type { Bot, Decision, Standing } from "@/lib/feed/types";
import { ago, dir, pct, usd } from "@/lib/format";
import type { LeagueState } from "@/lib/league";
import { entryName, entryOf, leagueFor, sectionOf, type LeagueModelGroup, type LeagueSnapshot } from "@/lib/feed/league-data";
import { relSeries } from "@/lib/board";
import { NETWORKS, explorerTx, formatToken } from "@/lib/networks";
import { Disclaimer } from "./board";
import { VsBar, VsSpark } from "./charts";
import { BotPill, Pill } from "./ui";
import { holdRuns } from "@/lib/trades";

export const botOf = (s: LeagueState, id: string) => s.feed.bots.find(b => b.id === id) as Bot;
export const agentHref = (id: string) => `/agents/${id}/`;
export const receiptHref = (s: LeagueState, id: string) => `/receipt/?id=${encodeURIComponent(id)}${s.network === "sim" ? "" : `&net=${s.network}`}`;

// Entries in the snapshot's own order on a network with one (ranked first, by vs hold after gas); by result
// otherwise; then the benchmarks (the bars to beat).
export function ranked(s: LeagueState) {
  const L = leagueFor(s.network), pos = (id: string) => L?.entries.findIndex(e => e.id === id) ?? -1;
  const entries = s.standings.filter(r => !BENCH.has(r.botId))
    .sort((a, b) => (L ? pos(a.botId) - pos(b.botId) : b.vsHold - a.vsHold));
  const bench = s.standings.filter(r => BENCH.has(r.botId)).sort((a, b) => BENCH_ORDER.indexOf(a.botId) - BENCH_ORDER.indexOf(b.botId));
  return { entries, bench };
}

export function ShareRecord({ name }: { name: string }) {
  const [done, setDone] = useState(false);
  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: `${name} · record on Sledgit`, url });
      else { await navigator.clipboard.writeText(url); setDone(true); setTimeout(() => setDone(false), 1500); }
    } catch { /* share sheet dismissed or clipboard blocked: nothing to do */ }
  }
  return <button className="btn" onClick={share}>{done ? "Link copied" : "Share record"}</button>;
}

// Filters by what is proven, never by who runs an entry.
type Filter = "all" | "attested" | "rules" | "self";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" }, { id: "attested", label: "Attested" }, { id: "rules", label: "Open rules" }, { id: "self", label: "Self-reported" }];

const unranked = (id: string) => entryOf(id)?.unranked_reason ?? null;
// One word for why an entry isn't ranked; the full reason is the cell's title and on the agent page.
function statusOf(b: Bot): string {
  const sec = sectionOf(b.id);
  if (sec) return sec === "unregistered" ? "unlisted" : sec;
  const why = unranked(b.id) ?? "";
  return /day 7/.test(why) ? "day 7" : /^inactive/.test(why) ? "inactive" : /needs 7/.test(why) ? "too few" : /incomplete/.test(why) ? "incomplete" : /:/.test(why) ? "flagged" : "unranked";
}

function Row({ s, r, rank, b, max }: { s: LeagueState; r: Standing; rank?: number; b: Bot; max: number }) {
  const router = useRouter();
  const base = b.id === "baseline" || b.id === "tn-bench-hold", sim = s.feed.simulated;
  return (
    <tr className={`click ${BENCH.has(b.id) ? "bench" : ""} ${b.id === "random" ? "luck" : ""}`} onClick={() => router.push(agentHref(b.id))}>
      <td className={`rk ${rank === 1 ? "top" : ""}`}>{rank ? (r.ranked ? rank : "—") : ""}</td>
      <td><div className="who"><span className="dot" style={{ background: b.color }} />
        <div style={{ minWidth: 0 }}><Link href={agentHref(b.id)} onClick={e => e.stopPropagation()}>{b.name}</Link>
          <small>{b.kind === "arena" ? `${b.harness} · ${b.strategy}` : b.strategy}</small></div></div></td>
      <td className="hide-s"><BotPill bot={b} /></td>
      <td className="vs hide-s"><VsBar v={base ? 0 : r.vsHold} max={max} /></td>
      <td className="r"><b className={base ? "flat" : dir(r.vsHold)}>{base ? "0.00%" : pct(r.vsHold)}</b>
        <span className="ci">{base ? "benchmark" : b.proof === "computed" ? "computed" : sim ? `±${(r.ci * 100).toFixed(2)}%` : s.network === "testnet" ? "testnet · not performance" : "after costs"}</span></td>
      <td className={`r hide-m ${dir(r.vsStake)}`}>{pct(r.vsStake)}</td>
      <td className="r hide-s">{sim || b.proof === "computed" ? usd(r.equity) : r.equity.toFixed(4)}</td>
      <td className="r hide-m">{r.trades}</td>
      <td className={`r hide-m ${r.refused ? "guard" : ""}`}>{r.refused}</td>
      <td className="r hide-m">{r.trades ? `${r.execPct.toFixed(2)}%` : "—"}</td>
      <td className="hide-m"><VsSpark data={s.race[b.id] ?? []} width={96} height={24} /></td>
      <td className="r hide-s">{BENCH.has(b.id) ? <span className="unr">bar</span> : r.ranked ? <span className="unr">ranked</span> : <span className="unr" title={unranked(b.id) ?? undefined}>{sim ? "day 7" : statusOf(b)}</span>}</td>
    </tr>);
}

// One row as a stacked card for phones: name, proof, vs-hold bar and the key numbers, nothing truncated.
function EntryCard({ s, r, rank, b, max }: { s: LeagueState; r: Standing; rank?: number; b: Bot; max: number }) {
  const base = b.id === "baseline" || b.id === "tn-bench-hold", sim = s.feed.simulated;
  const status = BENCH.has(b.id) ? "bar" : r.ranked ? "ranked" : sim ? "day 7" : statusOf(b);
  return (
    <div className={`mcard ${BENCH.has(b.id) ? "bench" : ""}`}>
      <div className="mc-top">
        {rank !== undefined && <span className={`rk ${rank === 1 ? "top" : ""}`}>{rank > 0 && r.ranked ? rank : "—"}</span>}
        <div className="mc-name"><Link href={agentHref(b.id)}><span className="dot" style={{ background: b.color }} />{b.name}</Link>
          <small>{b.kind === "arena" ? `${b.harness} · ${b.strategy}` : b.strategy}</small></div>
        <BotPill bot={b} short />
      </div>
      <div className="mc-vs"><VsBar v={base ? 0 : r.vsHold} max={max} /><b className={base ? "flat" : dir(r.vsHold)}>{base ? "0.00%" : pct(r.vsHold)}</b></div>
      <dl className="mc-nums">
        <div><dt>vs stake</dt><dd className={dir(r.vsStake)}>{pct(r.vsStake)}</dd></div>
        <div><dt>Value</dt><dd>{sim || b.proof === "computed" ? usd(r.equity) : r.equity.toFixed(4)}</dd></div>
        <div><dt>Trades</dt><dd>{r.trades}</dd></div>
        <div><dt>Refused</dt><dd className={r.refused ? "guard" : ""}>{r.refused}</dd></div>
        <div><dt>Status</dt><dd title={unranked(b.id) ?? undefined}>{status}</dd></div>
        <div><dt>Trend</dt><dd><VsSpark data={s.race[b.id] ?? []} width={72} height={20} /></dd></div>
      </dl>
    </div>);
}

// The leaderboard. Filters by proof and entry type, plus harness and model.
export function LeaderTable({ s, limit, filters = false }: { s: LeagueState; limit?: number; filters?: boolean }) {
  const [f, setF] = useState<Filter>("all");
  const [harness, setHarness] = useState("");
  const [model, setModel] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("f");
    if (filters && FILTERS.some(x => x.id === q)) setF(q as Filter);
  }, [filters]);
  const { entries, bench } = ranked(s);
  const opts = useMemo(() => {
    const bots = s.feed.bots.filter(b => !BENCH.has(b.id));
    return { h: [...new Set(bots.map(b => b.harness))].filter(x => x !== "—").sort(), m: [...new Set(bots.map(b => b.model))].filter(x => x !== "—").sort() };
  }, [s.feed.bots]);
  const keep = (b: Bot) => (f === "all" || (f === "attested" ? b.proof === "tee" || b.proof === "tpm" : b.proof === f))
    && (!harness || b.harness === harness) && (!model || b.model === model);
  // Fixtures, retired entries and unregistered vaults are listed apart from the entries, never ranked. Rank numbers
  // count ranked rows only.
  const snap = !!leagueFor(s.network), section = (id: string) => (snap ? sectionOf(id) : null);
  let n = 0;
  const rows = entries.map(r => ({ r, b: botOf(s, r.botId) })).filter(x => x.b && x.b.kind !== "vault" && !section(x.b.id) && keep(x.b))
    .map(x => ({ ...x, rank: x.r.ranked ? ++n : undefined }));
  const apart = (k: "fixture" | "retired" | "unregistered") => entries.map(r => ({ r, b: botOf(s, r.botId) }))
    .filter(x => x.b && (section(x.b.id) === k || (k === "fixture" && !snap && x.b.kind === "vault")));
  const GROUPS = [["fixture", "Test fixtures · scripted vaults, not entries"], ["retired", "Retired entries · record kept, not ranked"],
    ["unregistered", "Unregistered vaults · names chosen by their creators, not league entries"]] as const;
  const shown = limit ? rows.slice(0, limit) : rows;
  const max = Math.max(0.05, ...shown.map(x => Math.abs(Number.isFinite(x.r.vsHold) ? x.r.vsHold : 0)));
  return (
    <div className="panel">
      {filters && (
        <div className="filters">
          <div className="seg" role="group" aria-label="Proof">
            {FILTERS.map(x => <button key={x.id} className={f === x.id ? "on" : ""} aria-pressed={f === x.id} onClick={() => setF(x.id)}>{x.label}</button>)}
          </div>
          <label>Harness<select value={harness} onChange={e => setHarness(e.target.value)}><option value="">Any</option>{opts.h.map(x => <option key={x}>{x}</option>)}</select></label>
          <label>Model<select value={model} onChange={e => setModel(e.target.value)}><option value="">Any</option>{opts.m.map(x => <option key={x}>{x}</option>)}</select></label>
        </div>)}
      <div className="tblwrap has-cards">
        <table className="tbl">
          <thead><tr>
            <th>#</th><th>Entry</th><th className="hide-s">Proof</th><th className="vs hide-s">vs hold</th><th className="r">Δ</th><th className="r hide-m">vs stake</th>
            <th className="r hide-s">Value</th><th className="r hide-m">Trades</th><th className="r hide-m">Refused</th><th className="r hide-m">Cost</th>
            <th className="hide-m">Trend</th><th className="r hide-s">Status</th>
          </tr></thead>
          <tbody>
            {shown.map(x => <Row key={x.b.id} s={s} r={x.r} rank={x.rank ?? -1} b={x.b} max={max} />)}
            {!shown.length && <tr><td colSpan={12} className="empty">{s.standings.length ? "No entries match these filters" : "No results yet"}</td></tr>}
            {!limit && bench.length > 0 && <>
              <tr className="sep"><td colSpan={12}>Benchmarks · the bars every entry must clear</td></tr>
              {bench.map(r => <Row key={r.botId} s={s} r={r} b={botOf(s, r.botId)} max={max} />)}
            </>}
            {!limit && f === "all" && GROUPS.map(([k, label]) => apart(k).length > 0 && <Fragment key={k}>
              <tr className="sep"><td colSpan={12}>{label}</td></tr>
              {apart(k).map(x => <Row key={x.b.id} s={s} r={x.r} b={x.b} max={max} />)}
            </Fragment>)}
          </tbody>
        </table>
      </div>
      <div className="mcards">
        {shown.map(x => <EntryCard key={x.b.id} s={s} r={x.r} rank={x.rank ?? -1} b={x.b} max={max} />)}
        {!shown.length && <div className="empty">{s.standings.length ? "No entries match these filters" : "No results yet"}</div>}
        {!limit && bench.length > 0 && <>
          <div className="mc-sep">Benchmarks · the bars every entry must clear</div>
          {bench.map(r => <EntryCard key={r.botId} s={s} r={r} b={botOf(s, r.botId)} max={max} />)}
        </>}
        {!limit && f === "all" && GROUPS.map(([k, label]) => apart(k).length > 0 && <Fragment key={k}>
          <div className="mc-sep">{label}</div>
          {apart(k).map(x => <EntryCard key={x.b.id} s={s} r={x.r} b={x.b} max={max} />)}
        </Fragment>)}
      </div>
      <div style={{ padding: "0 16px 12px" }}><Disclaimer /></div>
    </div>);
}

// The by-model view: the crowd of entries per model (or published strategy) at each proof tier, averaged by the league
// reader (snapshot.by_model). Benchmarks are reference lines. The site only displays it.
const nameOf = (id: string) => { const e = entryOf(id); return e ? entryName(e) : id; };
// The bar shows the scored average; before anything is scored, the provisional figure, faded.
const barOf = (g: LeagueModelGroup) => g.avg_vs_hold_after_gas ?? g.provisional_vs_hold_after_gas;
const sparksOf = (g: LeagueModelGroup) => g.entries.map(entryOf).filter(e => !!e).map(e => relSeries(e).map(p => p.v));
const ScoreCell = ({ g }: { g: LeagueModelGroup }) => {
  const scored = g.avg_vs_hold_after_gas;
  return <>{scored === null ? <span className="unr" title="No entry of this model is ranked yet (day 7, minimum value, 7 decisions)">not enough data</span>
    : <b className={dir(scored)}>{pct(scored)}</b>}
    <span className="ci">{g.spread ? `${pct(g.spread.lo)} to ${pct(g.spread.hi)}` : scored === null ? "" : "one source"}</span></>;
};
const Entries = ({ g }: { g: LeagueModelGroup }) => <>{g.entries.map((id, k) => <Fragment key={id}>{k ? ", " : ""}<Link href={agentHref(id)}>{nameOf(id)}</Link></Fragment>)}</>;

function ModelRow({ g, max }: { g: LeagueModelGroup; max: number }) {
  const [first, ...more] = sparksOf(g);
  return (
    <tr>
      <td><div className="who"><div style={{ minWidth: 0 }}><b>{g.family}</b><small><Entries g={g} /></small></div></div></td>
      <td className="hide-s"><Pill p={g.tier} /></td>
      <td className="vs hide-s"><VsBar v={barOf(g)} max={max} faded={g.avg_vs_hold_after_gas === null} /></td>
      <td className="r"><ScoreCell g={g} /></td>
      <td className="r hide-s">{g.provisional_vs_hold_after_gas === null ? "—" : <span className={dir(g.provisional_vs_hold_after_gas)}>{pct(g.provisional_vs_hold_after_gas)}</span>}
        <span className="ci">provisional · not scored</span></td>
      <td className="r">{g.entries.length}<span className="ci">{g.sources} source{g.sources === 1 ? "" : "s"}</span></td>
      <td className="r hide-m">{g.decisions}</td>
      <td className="r hide-m">{g.trades}</td>
      <td className={`r hide-m ${g.refusals ? "guard" : ""}`}>{g.refusals}</td>
      <td className="hide-m"><VsSpark data={first ?? []} more={more} width={80} height={24} /></td>
    </tr>);
}

function ModelCard({ g, max }: { g: LeagueModelGroup; max: number }) {
  const [first, ...more] = sparksOf(g), prov = g.provisional_vs_hold_after_gas;
  return (
    <div className="mcard">
      <div className="mc-top">
        <div className="mc-name"><b>{g.family}</b><small><Entries g={g} /></small></div>
        <Pill p={g.tier} short />
      </div>
      <div className="mc-vs"><VsBar v={barOf(g)} max={max} faded={g.avg_vs_hold_after_gas === null} /><span className="r"><ScoreCell g={g} /></span></div>
      <dl className="mc-nums">
        <div><dt>So far</dt><dd>{prov === null ? "—" : <span className={dir(prov)}>{pct(prov)}</span>}<span className="ci">provisional · not scored</span></dd></div>
        <div><dt>Entries</dt><dd>{g.entries.length}<span className="ci">{g.sources} source{g.sources === 1 ? "" : "s"}</span></dd></div>
        <div><dt>Trend</dt><dd><VsSpark data={first ?? []} more={more} width={72} height={20} /></dd></div>
        <div><dt>Decisions</dt><dd>{g.decisions}</dd></div>
        <div><dt>Trades</dt><dd>{g.trades}</dd></div>
        <div><dt>Refused</dt><dd className={g.refusals ? "guard" : ""}>{g.refusals}</dd></div>
      </dl>
    </div>);
}

export function ByModelTable({ L }: { L: LeagueSnapshot }) {
  const groups = L.by_model ?? [];
  const luckId = L.luck_entry;
  const crowd = groups.filter(g => !(luckId && g.entries.includes(luckId)));
  const luck = groups.find(g => luckId && g.entries.includes(luckId));
  const max = Math.max(0.05, ...groups.map(g => Math.abs(barOf(g) ?? 0)), Math.abs(L.benchmarks.stake_vs_hold ?? 0));
  const refs: [string, number | null, string][] = [["Hold 50/50", 0, "never trades"], ["Stake & hold", L.benchmarks.stake_vs_hold, "the NEAR half staked"]];
  const val = (v: number | null) => (v === null ? "—" : <b className={v === 0 ? "flat" : dir(v)}>{v === 0 ? "0.00%" : pct(v)}</b>);
  return (
    <div className="panel">
      <div className="tblwrap has-cards">
        <table className="tbl bymodel">
          <thead><tr>
            <th>Model</th><th className="hide-s">Proof</th><th className="vs hide-s">vs hold</th><th className="r">vs hold, after costs</th><th className="r hide-s">So far</th>
            <th className="r">Entries</th><th className="r hide-m">Decisions</th><th className="r hide-m">Trades</th><th className="r hide-m">Refused</th><th className="hide-m">Trend</th>
          </tr></thead>
          <tbody>
            {crowd.map(g => <ModelRow key={g.label} g={g} max={max} />)}
            {!crowd.length && <tr><td colSpan={10} className="empty">No entries yet</td></tr>}
            <tr className="sep"><td colSpan={10}>Reference lines · the bars every model must clear</td></tr>
            {refs.map(([name, v, note]) => <tr key={name} className="bench"><td><div className="who"><div><b>{name}</b><small>{note}</small></div></div></td><td className="hide-s"><Pill p="computed" /></td>
              <td className="vs hide-s"><VsBar v={v} max={max} /></td><td className="r">{val(v)}<span className="ci">benchmark</span></td>
              <td className="r hide-s" /><td className="r" /><td className="r hide-m" /><td className="r hide-m" /><td className="r hide-m" /><td className="hide-m" /></tr>)}
            {luck && <ModelRow g={{ ...luck, family: "Luck baseline" }} max={max} />}
          </tbody>
        </table>
      </div>
      <div className="mcards">
        {crowd.map(g => <ModelCard key={g.label} g={g} max={max} />)}
        {!crowd.length && <div className="empty">No entries yet</div>}
        <div className="mc-sep">Reference lines · the bars every model must clear</div>
        {refs.map(([name, v, note]) => <div key={name} className="mcard bench">
          <div className="mc-top"><div className="mc-name"><b>{name}</b><small>{note}</small></div><Pill p="computed" short /></div>
          <div className="mc-vs"><VsBar v={v} max={max} /><span className="r">{val(v)}<span className="ci">benchmark</span></span></div>
        </div>)}
        {luck && <ModelCard g={{ ...luck, family: "Luck baseline" }} max={max} />}
      </div>
      <p className="note" style={{ padding: "0 16px", margin: "12px 0 0" }}>{L.method.by_model}</p>
      <div style={{ padding: "0 16px 12px" }}><Disclaimer /></div>
    </div>);
}

// Compact board for testnet/mainnet views (kept for the vault pages).
export const Board = ({ s }: { s: LeagueState }) => <LeaderTable s={s} />;

const KIND = (d: Decision) => (d.kind === "trade" ? d.side ?? "sell" : d.kind);
const LABEL: Record<string, string> = { buy: "Buy", sell: "Sell", stake: "Stake", unstake: "Unstake", refuse: "Refused", skip: "Hold" };

// A decision read from NEAR: amounts in token units, never dollars.
function ChainRow({ s, d, named }: { s: LeagueState; d: Decision; named: boolean }) {
  const b = botOf(s, d.botId), c = d.chain!, n = NETWORKS[s.network as "testnet"];
  const amt = (t?: string, a?: string) => (t && a ? formatToken(n, t, a) : "?");
  const who = named && <><b><Link href={agentHref(d.botId)}>{b?.name ?? d.botId}</Link></b>{" "}</>;
  return (
    <div className={`dr ${KIND(d)}`}>
      <span className="k">{LABEL[KIND(d)]}</span>
      <span className="t">{who}
        {d.kind === "trade" ? <>swapped {amt(c.tokenIn, c.amountIn)} for {amt(c.tokenOut, c.amountOut)} on {d.venue}</>
          : d.kind === "refuse" ? <>was stopped by its vault <code>{c.code ?? "refused"}</code></> : <>held <span className="why">· {d.reason}</span></>}</span>
      <span className="m">{ago(d.at, s.at)} · <a href={explorerTx(n, c.txHash)} target="_blank" rel="noreferrer">tx ↗</a> · <Link href={receiptHref(s, d.id)}>receipt</Link></span>
    </div>);
}

export function DecisionRow({ s, d, named = true }: { s: LeagueState; d: Decision; named?: boolean }) {
  if (d.chain && s.network !== "sim") return <ChainRow s={s} d={d} named={named} />;
  const b = botOf(s, d.botId);
  const who = named && <><b><Link href={agentHref(d.botId)}>{b.name}</Link></b>{" "}</>;
  return (
    <div className={`dr ${KIND(d)}`}>
      <span className="k">{LABEL[KIND(d)]}</span>
      <span className="t">{who}
        {d.kind === "trade" ? <>{d.side === "buy" ? "bought" : "sold"} <span className={d.side === "buy" ? "up" : "down"}>{usd(d.usd ?? 0)}</span> of wNEAR at {d.price?.toFixed(4)} via {d.venue} <span className="why">· {d.reason}</span></>
          : d.kind === "refuse" ? <>was stopped <code>{d.code ?? "refused"}</code> <span className="why">· {d.reason}</span></>
          : <>held <span className="why">· {d.reason}</span></>}</span>
      <span className="m">{ago(d.at, s.at)} · <Link href={receiptHref(s, d.id)}>receipt</Link></span>
    </div>);
}

// A run of identical holds by one entry, folded into one row; trades and refusals are never folded.
function HoldRun({ s, ds, named }: { s: LeagueState; ds: Decision[]; named: boolean }) {
  const [open, setOpen] = useState(false);
  const b = botOf(s, ds[0].botId), newest = ago(ds[0].at, s.at).replace(" ago", ""), oldest = ago(ds[ds.length - 1].at, s.at);
  return (
    <>
      <div className="dr skip run">
        <span className="k">Held ×{ds.length}</span>
        <span className="t">{named && <><b><Link href={agentHref(ds[0].botId)}>{b?.name ?? ds[0].botId}</Link></b>{" "}</>}<span className="why">{ds[0].reason}</span></span>
        <span className="m">{newest === oldest.replace(" ago", "") ? oldest : `${newest}–${oldest}`} · <button className="lnk" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "hide" : "show"}</button></span>
      </div>
      {open && ds.map(d => <DecisionRow key={d.id} s={s} d={d} named={named} />)}
    </>);
}

export function DecisionFeed({ s, botId, kind, limit = 30 }: { s: LeagueState; botId?: string; kind?: Decision["kind"]; limit?: number }) {
  const list = s.decisions.filter(d => (!botId || d.botId === botId) && (!kind || d.kind === kind));
  const rows = holdRuns(list, d => (d.kind === "skip" ? `${d.botId}|${d.reason}` : null)).slice(0, limit);
  return <div className="feed">{rows.length ? rows.map(r => ("one" in r ? <DecisionRow key={r.one.id} s={s} d={r.one} named={!botId} />
    : <HoldRun key={`run-${r.run[0].id}`} s={s} ds={r.run} named={!botId} />))
    : <div className="empty">{kind === "refuse" ? "No refusals yet" : "No decisions yet"}</div>}</div>;
}
