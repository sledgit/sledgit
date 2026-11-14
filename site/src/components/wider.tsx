"use client";
// The wider board: public trading records from other venues, scored against holding USDC and (where it applies) holding
// BTC. Display only: scripts/wider-files.mts builds wider-index.json and one wider-<source>.json per venue. Vault and
// trader text is untrusted and rendered as plain text.
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { dir } from "@/lib/format";
import { vaultHref } from "@/lib/wider-profile";
import { beatUsdc, MIN_DAYS, parseSrc, srcParam, type Range95, type WiderFile, type WiderIndex, type WiderSource, type WiderVault } from "@/lib/wider";
import { Disclaimer } from "./board";
import { VsSpark, WiderEquity } from "./charts";
import { Kpi } from "./ui";

export const INDEX_URL = "/league/wider-index.json";
export const FILE = /^wider-[a-z0-9-]{1,32}\.json$/;

/** Percent with fewer decimals as it grows, so +3,994% and −0.4% both read at a glance. */
export function wpct(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  const a = Math.abs(x * 100), s = x >= 0 ? "+" : "−";
  return s + (a >= 100 ? Math.round(a).toLocaleString("en-US") : a.toFixed(1)) + "%";
}
export const usdk = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x)}`);
export const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const n = (x: number) => x.toLocaleString("en-US");
/** Signed dollars, compact: +$1.2M, −$40k. */
export const usdSigned = (x: number) => `${x < 0 ? "−" : "+"}${usdk(Math.abs(x))}`;
export const inUsd = (v: WiderVault) => v.basis === "usd";
export const hasBtc = (v: WiderVault) => v.btcBaseline !== false;
const domId = (id: string) => id.replace(/[^a-z0-9]/gi, "-");

type Load = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ok"; docs: WiderFile[]; failed: string[] };

function useWider(): Load {
  const [s, setS] = useState<Load>({ state: "loading" });
  useEffect(() => {
    let live = true;
    (async () => {
      const r = await fetch(INDEX_URL, { cache: "no-store" });
      if (r.status === 404) return live && setS({ state: "missing" });
      if (!r.ok) throw new Error(`index: HTTP ${r.status}`);
      const idx = (await r.json()) as WiderIndex;
      if (idx?.version !== 1 || !Array.isArray(idx.sources)) throw new Error("index: unexpected format");
      const entries = idx.sources.filter(e => typeof e?.file === "string" && FILE.test(e.file));
      // One venue's file failing to load leaves the others on the page; the failure is named.
      const got = await Promise.all(entries.map(async e => {
        try {
          return await readWiderFile(e.file);
        } catch (err) {
          console.error(`wider board: ${e.file} not loaded`, err);
          return String(e.label ?? e.id);
        }
      }));
      const docs = got.filter((x): x is WiderFile => typeof x !== "string"), failed = got.filter((x): x is string => typeof x === "string");
      if (!docs.length) throw new Error(entries.length ? `no venue file could be read (${failed.join(", ")})` : "the index lists no venues");
      if (live) setS({ state: "ok", docs, failed });
    })().catch((e: Error) => { console.error("wider board data not loaded", e); if (live) setS({ state: "error", message: e.message }); });
    return () => { live = false; };
  }, []);
  return s;
}

/** One venue's file, checked: a name the index may list, and the version and shape the page reads. */
export async function readWiderFile(file: string): Promise<WiderFile> {
  if (!FILE.test(file)) throw new Error("bad file name");
  const f = await fetch(`/league/${file}`, { cache: "no-store" });
  if (!f.ok) throw new Error(`HTTP ${f.status}`);
  const doc = (await f.json()) as WiderFile;
  if (doc?.version !== 1 || !Array.isArray(doc.vaults) || typeof doc.source?.id !== "string") throw new Error("unexpected file format");
  return doc;
}

export function AiTag({ v }: { v: WiderVault }) {
  if (!v.ai.claim) return null;
  return <span className="tag ai" title={`It says it is AI (matched ${v.ai.words.join(", ")} in its ${v.ai.where.join(" and ")}). Not verified.`}>Claims AI</span>;
}

export function VenueTag({ src }: { src: WiderSource | undefined }) {
  return <span className="vtag" title={src ? `${src.label}: ${src.kind === "trader" ? "an individual wallet" : "a vault"}` : undefined}>{src?.label ?? "?"}</span>;
}

export const rangeText = (r: Range95 | null, long = false, fmt: (x: number) => string = wpct) => (r ? `95% range ${fmt(r.lo)} to ${fmt(r.hi)}${long ? ` (${r.n} intervals)${r.lo > 0 ? ", beyond noise" : r.hi < 0 ? ", below zero beyond noise" : ", within noise"}` : ""}`
  : long ? "not enough data to separate skill from luck" : "too few points");
export const NO_BTC = "n/a: a prediction-market account holds USDC-settled positions, so the baseline is holding USDC only";
export const NO_RET = "n/a: the venue publishes no usable account-value history, so there is no capital base to divide by; scored in dollars";
export const who = (v: WiderVault) => (v.kind === "trader" ? `wallet ${short(v.address)}` : v.leader ? `leader ${short(v.leader)}` : "run by the protocol");

/** A record's chart, numbers and text; the vault page shows the text beside its inferred style instead (quote false). */
export function Detail({ v, src, quote = true, page = true }: { v: WiderVault; src: WiderSource | undefined; quote?: boolean; page?: boolean }) {
  const trader = v.kind === "trader";
  return (
    <div className={`wdetail ${quote ? "" : "noquote"}`}>
      <WiderEquity series={v.series} name={v.name} unit={inUsd(v) ? "usd" : "pct"} />
      <dl className="kv">
        {page && <><dt>Page</dt><dd><Link href={vaultHref(v)}>Open the {trader ? "trader" : "vault"}&apos;s page: positions, fills and inferred style ›</Link></dd></>}
        <dt>Window</dt><dd>{ymd(v.startMs)} to {ymd(v.endMs)} · {Math.round(v.days)} days · {v.intervals} intervals scored{v.skipped ? `, ${v.skipped} skipped` : ""}</dd>
        {v.ret === null ? <><dt>Return</dt><dd>{NO_RET}</dd>
          <dt>PnL in dollars</dt><dd><span className={dir(v.pnlUsd)}>{usdSigned(v.pnlUsd)}</span> over the window · vs hold USDC ($0) · {rangeText(v.range.usdc, true, usdSigned)}</dd></>
          : <><dt>Return</dt><dd><span className={dir(v.ret)}>{wpct(v.ret)}</span> · same as vs hold USDC · {rangeText(v.range.usdc, true)}</dd>
          <dt>PnL in dollars</dt><dd><span className={dir(v.pnlUsd)}>{usdSigned(v.pnlUsd)}</span> over the window{Math.sign(v.pnlUsd) !== Math.sign(v.ret) && v.pnlUsd !== 0
          ? <> · <b>opposite sign to the return</b>: the percentages came on different amounts of capital (time-weighted return ignores how much was in the account)</> : ""}</dd></>}
        <dt>vs hold BTC</dt><dd>{hasBtc(v) ? <><span className={dir(v.vsBtc ?? 0)}>{wpct(v.vsBtc)}</span> · BTC {wpct(v.btc)} over the window · {rangeText(v.range.btc, true)}</> : NO_BTC}</dd>
        <dt>Max drawdown</dt><dd>{v.maxDd !== null ? wpct(v.maxDd) : v.maxDdUsd !== null ? `${usdSigned(v.maxDdUsd)}, the largest fall of cumulative PnL from its peak` : "—"}</dd>
        <dt>{trader ? "Account value" : "TVL"}</dt><dd>{usdk(v.tvl)}{trader ? " · an estimate: deposits minus withdrawals plus PnL, at least the open positions; it understates when funds arrive outside the deposit feed" : ""}{v.followers != null ? ` · ${v.followers >= 100 ? "100 or more" : v.followers} depositors` : ""}</dd>
        {v.volumeUsd != null && <><dt>Volume</dt><dd>{usdk(v.volumeUsd)} traded, all time</dd></>}
        {!trader && <><dt>Commission</dt><dd>{v.commission == null ? "—" : `${(v.commission * 100).toFixed(0)}% of depositors' gains to the leader`}</dd></>}
        {!trader && <><dt>Leader</dt><dd className="mono">{v.leader ?? "— (run by the protocol)"}</dd></>}
        <dt>{trader ? "Wallet" : "Vault address"}</dt><dd className="mono">{v.address}</dd>
        <dt>Explorer</dt><dd>{src && src.explorer.startsWith("https://") && v.explorer.startsWith(`${src.explorer}/address/`)
          ? <a href={v.explorer} target="_blank" rel="noreferrer nofollow">View the address on {src.explorer.replace(/^https:\/\//, "")} ↗</a> : "—"}</dd>
        {v.ai.claim && <><dt>AI claim</dt><dd>Matched {v.ai.words.join(", ")} in the {v.ai.where.join(" and ")}. It says it is AI; nothing here checks it.</dd></>}
      </dl>
      {quote && <Stated v={v} />}
    </div>);
}

/** The account's own text, quoted as plain text. */
export function Stated({ v, label }: { v: WiderVault; label?: string }) {
  const trader = v.kind === "trader";
  return (
    <figure className="wquote">
      <figcaption>{label ?? (trader ? "The trader's own bio" : "The vault's own description")}</figcaption>
      {v.description ? <blockquote>{v.description}</blockquote> : <p className="note">{trader ? "No bio." : "No description."}</p>}
    </figure>);
}

type Filter = "all" | "ai";
type Sort = "tvl" | "days" | "ret" | "pnl" | "btc" | "dd";
type Order = { key: Sort; desc: boolean };
const SORTS: { id: Sort; label: string }[] = [{ id: "tvl", label: "Size" }, { id: "days", label: "Days" }, { id: "ret", label: "Return" }, { id: "pnl", label: "PnL $" }, { id: "btc", label: "vs BTC" }, { id: "dd", label: "Max DD" }];
const val = (k: Sort, v: WiderVault): number | null => (k === "tvl" ? v.tvl : k === "days" ? v.days : k === "ret" ? v.ret : k === "pnl" ? v.pnlUsd : k === "btc" ? (hasBtc(v) ? v.vsBtc : null) : v.maxDd);
/** Sort by one column; rows without a value (return or vs BTC on a record scored in dollars) go last either way. */
export const sorter = ({ key, desc }: Order) => (a: WiderVault, b: WiderVault) => {
  const x = val(key, a), y = val(key, b);
  if (x === null || y === null) return Number(x === null) - Number(y === null);
  return (desc ? 1 : -1) * (y - x);
};

// A column heading that sorts: first click sorts high to low, the next flips it.
function SortTh({ k, label, o, set, cls = "r", title }: { k: Sort; label: string; o: Order; set: (o: Order) => void; cls?: string; title?: string }) {
  const on = o.key === k;
  return (
    <th className={cls} aria-sort={on ? (o.desc ? "descending" : "ascending") : "none"} title={title}>
      <button className={`thsort ${on ? "on" : ""}`} onClick={() => set({ key: k, desc: on ? !o.desc : true })}>
        {label}<span aria-hidden="true">{on ? (o.desc ? " ▼" : " ▲") : " ↕"}</span>
      </button>
    </th>);
}

const COLS = 10;
type RowProps = { v: WiderVault; rank?: number; open: boolean; toggle: () => void; src: WiderSource | undefined };

function Row({ v, rank, open, toggle, src }: RowProps) {
  return (
    <>
      <tr className={`click ${open ? "open" : ""}`} onClick={toggle} id={`v-${domId(v.id)}`} data-source={v.source}>
        <td className="rk">{rank ?? "—"}</td>
        <td className="hide-s"><VenueTag src={src} /></td>
        <td><div className="who"><div style={{ minWidth: 0 }}>
          <Link className="wname" href={vaultHref(v)} onClick={e => e.stopPropagation()}>{v.name}</Link> <AiTag v={v} />
          <button className="lnk wmore" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${v.name}'s chart here`} onClick={e => { e.stopPropagation(); toggle(); }}>{open ? "▴" : "▾"}</button>
          <small>{who(v)}</small></div></div></td>
        <td className="r hide-s">{usdk(v.tvl)}</td>
        <td className="r hide-m">{Math.round(v.days)}</td>
        <td className="r">{v.ret === null ? <span className="na" title={NO_RET}>n/a</span> : <><b className={dir(v.ret)}>{wpct(v.ret)}</b><span className="ci">{rangeText(v.range.usdc)}</span></>}</td>
        <td className="r hide-m"><b className={dir(v.pnlUsd)}>{usdSigned(v.pnlUsd)}</b>{inUsd(v) && <span className="ci">{rangeText(v.range.usdc, false, usdSigned)}</span>}</td>
        <td className="r">{hasBtc(v) ? <><b className={dir(v.vsBtc ?? 0)}>{wpct(v.vsBtc)}</b><span className="ci hide-s">{rangeText(v.range.btc)}</span></>
          : <span className="na" title={NO_BTC}>n/a</span>}</td>
        <td className="r hide-m">{v.maxDd !== null ? wpct(v.maxDd) : v.maxDdUsd !== null ? usdSigned(v.maxDdUsd) : "—"}</td>
        <td className="hide-m"><VsSpark data={v.series.map(p => p[1])} width={96} height={24} /></td>
      </tr>
      {open && <tr className="wopen"><td colSpan={COLS}><Detail v={v} src={src} /></td></tr>}
    </>);
}

function Card({ v, rank, open, toggle, src }: RowProps) {
  return (
    <div className="mcard" id={`c-${domId(v.id)}`} data-source={v.source}>
      <div className="mc-top">
        <span className="rk">{rank ?? "—"}</span>
        <div className="mc-name"><Link className="wname" href={vaultHref(v)}>{v.name}</Link><small><VenueTag src={src} /> {who(v)}</small></div>
        <AiTag v={v} />
      </div>
      <dl className="mc-nums">
        {v.ret === null ? <div><dt>PnL $</dt><dd className={dir(v.pnlUsd)}>{usdSigned(v.pnlUsd)}</dd></div> : <div><dt>Return</dt><dd className={dir(v.ret)}>{wpct(v.ret)}</dd></div>}
        <div><dt>vs BTC</dt><dd className={hasBtc(v) ? dir(v.vsBtc ?? 0) : "na"}>{hasBtc(v) ? wpct(v.vsBtc) : "n/a"}</dd></div>
        <div><dt>Max DD</dt><dd>{v.maxDd !== null ? wpct(v.maxDd) : v.maxDdUsd !== null ? usdSigned(v.maxDdUsd) : "—"}</dd></div>
        <div><dt>{v.kind === "trader" ? "Value" : "TVL"}</dt><dd>{usdk(v.tvl)}</dd></div>
        <div><dt>Days</dt><dd>{Math.round(v.days)}</dd></div>
        <div><dt>Trend</dt><dd><VsSpark data={v.series.map(p => p[1])} width={72} height={20} /></dd></div>
      </dl>
      <p className="ci" style={{ marginTop: 6 }}>{inUsd(v) ? `Scored in dollars · ${rangeText(v.range.usdc, true, usdSigned)}` : rangeText(v.range.usdc, true)}</p>
      <button className="lnk wmore" aria-expanded={open} onClick={toggle}>{open ? "Hide the chart ▴" : "Chart and text here ▾"}</button>
      {open && <Detail v={v} src={src} />}
    </div>);
}

/** The venue checkboxes: every venue on by default, the choice kept in ?src=. */
function Venues({ docs, on, set }: { docs: WiderFile[]; on: string[]; set: (on: string[]) => void }) {
  return (
    <div className="venues" role="group" aria-label="Venues shown">
      <span className="vlabel">Venues</span>
      {docs.map(d => {
        const id = d.source.id, checked = on.includes(id);
        return (
          <label key={id} className={`vchip ${checked ? "on" : ""}`}>
            <input type="checkbox" checked={checked} onChange={() => set(checked ? on.filter(x => x !== id) : [...on, id])} />
            {d.source.label}<span className="vn">{d.vaults.length}</span>
          </label>);
      })}
    </div>);
}

function setQuery(k: string, val: string | null) {
  const u = new URL(location.href);
  if (val) u.searchParams.set(k, val); else u.searchParams.delete(k);
  history.replaceState(history.state, "", u);
}

function Board({ docs, on, setOn }: { docs: WiderFile[]; on: string[]; setOn: (on: string[]) => void }) {
  const [f, setF] = useState<Filter>("all");
  const [sort, setSort] = useState<Order>({ key: "tvl", desc: true });
  const [openId, setOpenId] = useState<string | null>(null);
  const srcs = new Map(docs.map(d => [d.source.id, d.source]));
  const all = docs.flatMap(d => d.vaults);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("f") === "ai") setF("ai");
    // ?v= takes a record id (hyperliquid:0x…); a bare address, as older links carry, opens its first match.
    const v = q.get("v")?.toLowerCase();
    const hit = v ? all.find(x => x.id === v) ?? all.find(x => x.address === v) : undefined;
    if (hit) {
      setOpenId(hit.id);
      // The table row on wide screens, the card on phones: whichever is displayed.
      requestAnimationFrame(() => [`v-${domId(hit.id)}`, `c-${domId(hit.id)}`].map(id => document.getElementById(id)).find(el => el?.offsetParent)?.scrollIntoView({ block: "center" }));
    }
  }, [docs]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => { const next = openId === id ? null : id; setOpenId(next); setQuery("v", next); };
  const pickF = (x: Filter) => { setF(x); setQuery("f", x === "ai" ? "ai" : null); };

  const keep = (v: WiderVault) => on.includes(v.source) && (f === "all" || v.ai.claim);
  const ranked = all.filter(v => v.ranked && keep(v)).sort(sorter(sort));
  const listed = all.filter(v => !v.ranked && keep(v)).sort(sorter(sort));
  const rows = [...ranked.map((v, i) => ({ v, rank: i + 1 })), ...listed.map(v => ({ v, rank: undefined }))];
  const sep = ranked.length;
  const empty = on.length ? "No records match this filter" : "No venue selected";
  const aiToggle = <button className={`aitoggle ${f === "ai" ? "on" : ""}`} aria-pressed={f === "ai"} onClick={() => pickF(f === "ai" ? "all" : "ai")}>Claims AI only</button>;
  return (
    <div className="panel">
      <Venues docs={docs} on={on} set={setOn} />
      <div className="filters phone-only">
        {aiToggle}
        <label>Sort<select value={`${sort.key}:${sort.desc ? "d" : "a"}`} onChange={e => { const [k, d] = e.target.value.split(":"); setSort({ key: k as Sort, desc: d === "d" }); }}>
          {SORTS.flatMap(x => [<option key={x.id + "d"} value={`${x.id}:d`}>{x.label} ▼</option>, <option key={x.id + "a"} value={`${x.id}:a`}>{x.label} ▲</option>])}
        </select></label>
      </div>
      <div className="tblwrap has-cards">
        <table className="tbl wider">
          <thead><tr>
            <th>#</th><th className="hide-s">Venue</th><th><span className="thvault">Vault or trader {aiToggle}</span></th>
            <SortTh k="tvl" label="Size" o={sort} set={setSort} cls="r hide-s" title="A vault's TVL, or a trader's account value" /><SortTh k="days" label="Days" o={sort} set={setSort} cls="r hide-m" />
            <SortTh k="ret" label="Return · vs USDC" o={sort} set={setSort} /><SortTh k="pnl" label="PnL $" o={sort} set={setSort} cls="r hide-m" title="Dollar PnL over the window: the measure every venue shares" /><SortTh k="btc" label="vs hold BTC" o={sort} set={setSort} />
            <SortTh k="dd" label="Max DD" o={sort} set={setSort} cls="r hide-m" /><th className="hide-m">Trend</th>
          </tr></thead>
          <tbody>
            {rows.map(({ v, rank }, i) => <Fragment key={v.id}>
              {i === sep && <tr className="sep"><td colSpan={COLS}>Listed, not ranked · under {MIN_DAYS} days of history</td></tr>}
              <Row v={v} rank={rank} open={openId === v.id} toggle={() => toggle(v.id)} src={srcs.get(v.source)} />
            </Fragment>)}
            {!rows.length && <tr><td colSpan={COLS} className="empty">{empty}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mcards">
        {rows.map(({ v, rank }, i) => <Fragment key={v.id}>
          {i === sep && <div className="mc-sep">Listed, not ranked · under {MIN_DAYS} days of history</div>}
          <Card v={v} rank={rank} open={openId === v.id} toggle={() => toggle(v.id)} src={srcs.get(v.source)} />
        </Fragment>)}
        {!rows.length && <div className="empty">{empty}</div>}
      </div>
      <p className="note" style={{ padding: "0 16px", margin: "12px 0 0" }}>Return is the time-weighted return from each account&apos;s own PnL history; holding USDC is 0%, so return and vs hold USDC are the same number. vs hold BTC compares with BTC over the same window. Polymarket traders are scored in dollars (PnL $ against $0): their venue publishes no usable account-value history, so return and vs hold BTC are n/a there, and PnL $ is the column every venue shares. Ranks order whatever is shown, across venues; venues sample differently, so a rank is a position in this list, not a comparison of venues. Select a name for its own page (open positions, recent fills and a style inferred from its trades, where the venue publishes them), or a row for its chart and text here.</p>
      <div style={{ padding: "0 16px 12px" }}><Disclaimer /></div>
    </div>);
}

export const popLine = (d: WiderFile) => {
  const P = d.population;
  return P && P.with_pnl ? `${Math.round((P.negative / P.with_pnl) * 100)}% of ${n(P.with_pnl)} ${d.population_label} show an all-time loss` : null;
};

function Kpis({ docs, on }: { docs: WiderFile[]; on: string[] }) {
  const shown = docs.filter(d => on.includes(d.source.id));
  const r = shown.flatMap(d => d.vaults.filter(v => v.ranked)), ai = r.filter(v => v.ai.claim), rb = r.filter(hasBtc);
  const beatU = r.filter(beatUsdc).length, beatB = rb.filter(v => (v.vsBtc ?? 0) > 0).length;
  const fetched = shown.map(d => d.fetched_at).sort();
  return (
    <>
      <div className="kpis" style={{ marginBottom: 10 }}>
        <Kpi k="Records scored" v={r.length} s={`${n(shown.reduce((s, d) => s + d.counts.scored, 0))} fetched · ${shown.length} of ${docs.length} venues`} />
        <Kpi k="Beat hold USDC" v={<>{beatU}<span className="of"> / {r.length}</span></>} s="return above 0%, or PnL above $0" />
        <Kpi k="Beat hold BTC" v={<>{beatB}<span className="of"> / {rb.length}</span></>} s={rb.length < r.length ? `${r.length - rb.length} have no BTC baseline` : "same window"} />
        <Kpi k="Claim AI" v={ai.length} s={`${ai.filter(beatUsdc).length} of them beat hold USDC`} />
        <Kpi k="Fetched" v={fetched.length ? fetched[0].slice(0, 10) : "—"} s={fetched.length ? (fetched[0].slice(0, 10) === fetched[fetched.length - 1].slice(0, 10) ? `${fetched[0].slice(11, 16)} UTC` : `to ${fetched[fetched.length - 1].slice(0, 10)}`) : ""} />
      </div>
      <ul className="vkpis" aria-label="By venue">
        {shown.map(d => {
          const vr = d.vaults.filter(v => v.ranked), btc = d.source.baselines.includes("btc"), pop = popLine(d);
          return (
            <li key={d.source.id} data-source={d.source.id}>
              <b>{d.source.label}</b>
              <span>{vr.length} scored</span>
              <span>{vr.filter(beatUsdc).length} beat USDC</span>
              <span>{btc ? `${vr.filter(v => (v.vsBtc ?? 0) > 0).length} beat BTC` : "BTC n/a"}</span>
              <span>{vr.filter(v => v.ai.claim).length} claim AI</span>
              {pop && <span className="down">{pop}</span>}
            </li>);
        })}
      </ul>
    </>);
}

function Method({ docs, on }: { docs: WiderFile[]; on: string[] }) {
  const shown = docs.filter(d => on.includes(d.source.id)), list = shown.length ? shown : docs, R = list[0].rule;
  return (
    <section className="section" style={{ margin: "32px 0 0" }}>
      <div className="sh"><div><h2>How it&apos;s scored</h2><p>The same honesty as the main board: baselines first, a range around every number, nothing hidden for losing. Each venue is sampled its own way, below.</p></div></div>
      <div className="panel">
        <dl className="kv" style={{ padding: "0 16px" }}>
          <dt>Ranking</dt><dd>{R.rank}</dd>
          <dt>Range</dt><dd>{R.range}</dd>
          <dt>AI claim</dt><dd>{R.ai}</dd>
        </dl>
      </div>
      {list.map(d => {
        const P = d.population, pop = popLine(d);
        return (
          <div className="panel wmethod" key={d.source.id}>
            <h3>{d.source.label}</h3>
            <dl className="kv" style={{ padding: "0 16px" }}>
              <dt>Label</dt><dd>{d.rule.label}. Accounts on {d.source.label} set their own rules; Sledgit enforces nothing on them and records nothing for them.</dd>
              <dt>Which {d.source.kind === "trader" ? "wallets" : "vaults"}</dt><dd>{d.rule.selection}</dd>
              <dt>Survivors</dt><dd>{d.rule.survivors}{pop && P ? ` Across the ${n(P.with_pnl)} ${d.population_label} with a PnL figure, ${n(P.negative)} show an all-time loss in dollars and ${n(P.positive)} a gain${P.closed ? ` (${n(P.closed)} of ${n(P.listed)} are closed)` : ""}.` : ""}</dd>
              <dt>Returns</dt><dd>{d.rule.returns}</dd>
              <dt>Baselines</dt><dd>{d.rule.baselines}</dd>
              <dt>Data</dt><dd>Fetched {d.fetched_at.replace("T", " ").slice(0, 16)} UTC from {d.source.list_url} and {d.source.detail_url}. {d.counts.failed ? `${d.counts.failed} record(s) could not be read or did not add up and are left out.` : "Every requested record was read."} <a href={`/league/wider-${d.source.id}.json`}>The scored file</a>.</dd>
            </dl>
          </div>);
      })}
    </section>);
}

function Loaded({ docs, failed }: { docs: WiderFile[]; failed: string[] }) {
  const venues = docs.map(d => ({ id: d.source.id, short: d.source.short }));
  const [on, setOnState] = useState<string[]>(venues.map(v => v.id));
  useEffect(() => { setOnState(parseSrc(new URLSearchParams(location.search).get("src"), venues)); }, [docs]); // eslint-disable-line react-hooks/exhaustive-deps
  const setOn = (x: string[]) => { setOnState(x); setQuery("src", srcParam(x, venues)); };
  const names = docs.filter(d => on.includes(d.source.id)).map(d => d.source.label);
  // Each venue's population in its own terms: Hyperliquid lists every vault; Polymarket's board is itself a selection.
  const pops = docs.filter(d => on.includes(d.source.id)).flatMap(d => { const p = popLine(d); return p ? [`${d.source.label}: ${p}`] : []; });
  return (
    <>
      <div className="callout wbanner" role="note">
        <b>Self-reported and venue-reported public records{names.length ? ` from ${names.join(", ").replace(/, ([^,]*)$/, " and $1")}` : ""}.</b> These accounts have no limits enforced by Sledgit and are not Sledgit vaults. Each venue&apos;s sample is its largest or most active accounts, so it is survivors.{pops.length > 0 && <> {pops.join("; ")}.</>} Past results. Not a recommendation.
        {failed.length > 0 && <> <b>Not loaded:</b> {failed.join(", ")}.</>}
      </div>
      <Kpis docs={docs} on={on} />
      <Board docs={docs} on={on} setOn={setOn} />
      <Method docs={docs} on={on} />
    </>);
}

export function WiderBoard() {
  const s = useWider();
  return (
    <>
      {s.state === "loading" && <div className="empty">Loading…</div>}
      {s.state === "missing" && <div className="panel"><div className="empty">No wider-board data in this build. Run <code>npm run wider</code> in site/ to fetch it.</div></div>}
      {s.state === "error" && <div className="panel"><div className="empty">The wider-board data could not be read ({s.message}).</div></div>}
      {s.state === "ok" && <Loaded docs={s.docs} failed={s.failed} />}
    </>);
}
