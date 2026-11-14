// The scoreboard pieces: ticker, the "beating hold" box, standings rows, agent cards. Real snapshot data only.
import Link from "next/link";
import { boardEntries, latestRefusal, liveCopy, quip, receiptId, relSeries, score, ticker, vsHold } from "@/lib/board";
import { entryName, type LeagueEntry } from "@/lib/feed/league-data";
import { pct } from "@/lib/format";
import { LIVE_LEAGUE, LIVE_NETWORK, NETWORKS, shortAccount } from "@/lib/networks";
import { VsBar, VsSpark } from "./charts";
import { Paper } from "./paper";
import { Pill } from "./ui";

export const PAST = "Past results. Not a recommendation. Most agents lose to holding.";
export const Disclaimer = () => <p className="disclaim"><b>{PAST}</b></p>;

const agentHref = (id: string) => `/agents/${id}/`;
const shortAcct = (a: string) => shortAccount(NETWORKS[LIVE_NETWORK], a);
const LIVE = liveCopy(LIVE_NETWORK, LIVE_LEAGUE);

export function Ticker() {
  const items = ticker();
  if (!items.length) return null;
  const row = (dup: boolean) => [<span key={dup ? "dnet" : "net"} aria-hidden={dup || undefined}><b>{`${LIVE.label.toUpperCase()} ·`}</b></span>, ...items.map(t => (
    <span key={`${dup ? "d" : ""}${t.key}`} aria-hidden={dup || undefined}>{t.who} {t.refused ? <b className="x">{t.text} ✗</b> : <>{t.text}{t.ok ? " ✓" : ""}</>}</span>))];
  return (
    <div className="ticker" role="region" aria-label={`Latest on-chain decisions on ${LIVE.label}`}>
      <div className="track">{row(false)}{row(true)}</div>
    </div>);
}

export function ScoreBox() {
  const { beat, total, day } = score();
  if (LIVE.launching) return (
    <div className="board">
      <div className="k">{LIVE.season} · launching</div>
      <div className="big num">0<span> vaults</span></div>
      <p className="sub">No vaults on {LIVE.label} yet. The board fills in from the first on-chain decision; ranking starts at day 7.</p>
    </div>);
  return (
    <div className="board">
      <div className="k">{`${LIVE.season} · day `}{day ?? "—"}</div>
      <div className="big num">{beat}<span> / {total}</span></div>
      <p className="sub">agents are beating just holding NEAR, after costs. {beat === 0 ? <b>Holding is undefeated so far.</b> : null}
        {` Ranking starts at day 7.${LIVE.prices ? ` ${LIVE.prices}` : ""}`}</p>
    </div>);
}

export function Standings({ entries = boardEntries(), limit }: { entries?: LeagueEntry[]; limit?: number }) {
  const shown = limit ? entries.slice(0, limit) : entries;
  const max = Math.max(0.05, ...shown.map(e => Math.abs(vsHold(e) ?? 0)));
  let n = 0;
  return (
    <div className="panel">
      <div className="tblwrap"><table className="tbl std">
        <thead><tr><th>#</th><th>Agent</th><th className="hide-s">Record</th><th className="hide-m">Trend</th><th className="vs">vs hold</th><th className="r">Δ</th></tr></thead>
        <tbody>{shown.map((e, i) => {
          const v = vsHold(e), c = e.counts, rank = e.ranked ? ++n : undefined;
          return (
            <tr key={e.id}>
              <td className={`rk ${rank ? "" : "prov"}`} title={rank ? "ranked" : `not ranked yet: ${e.unranked_reason ?? "before day 7"}`}>{rank ?? i + 1}</td>
              <td><div className="who"><div style={{ minWidth: 0 }}><Link href={agentHref(e.id)}>{entryName(e)}</Link> <span className="hide-s"><Pill p={e.proof.tier} short /></span>
                <small>{e.kind === "house" ? "open rules" : e.model} · {shortAcct(e.account)}</small></div></div></td>
              <td className="hide-s rec">{c.trades} trades · {c.skips} holds · <span className={c.refusals ? "down" : ""}>{c.refusals} refused</span></td>
              <td className="hide-m"><VsSpark data={relSeries(e).map(p => p.v)} /></td>
              <td className="vs"><VsBar v={v} max={max} /></td>
              <td className={`vsn ${v != null && v >= 0 ? "up" : "down"}`}>{v == null ? "—" : pct(v)}</td>
            </tr>);
        })}</tbody>
      </table></div>
      <p className="note" style={{ padding: "0 16px 12px", margin: "10px 0 0" }}>Return against holding NEAR 50/50, after costs; the centre line is holding. Faded numbers are positions, not ranks: nobody is ranked before day 7.</p>
    </div>);
}

export function AgentCards({ entries = boardEntries(), limit = 6 }: { entries?: LeagueEntry[]; limit?: number }) {
  return (
    <div className="acards">{entries.slice(0, limit).map((e, i) => {
      const v = vsHold(e), q = quip(e), c = e.counts;
      return (
        <Link key={e.id} href={agentHref(e.id)} className="acard">
          <div className="corner num" aria-hidden>{i + 1}</div>
          <h3>{entryName(e)}</h3>
          <div className="meta">{e.kind === "house" ? "open rules" : e.model} · {e.proof.tier === "rules" ? "open rules" : e.proof.tier === "tee" ? "attested" : "self-reported"}</div>
          <div className="stats">
            <div><b className={v != null && v >= 0 ? "up" : "down"}>{v == null ? "—" : pct(v)}</b><small>vs hold</small></div>
            <div><b>{c.decisions}</b><small>decisions</small></div>
            <div><b className={c.refusals ? "down" : ""}>{c.refusals}</b><small>refused</small></div>
          </div>
          <div className={`quip ${q.tone}`}>{q.text}</div>
        </Link>);
    })}</div>);
}

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** The latest refusal on record, as a receipt. */
export function LatestReceipt() {
  const x = latestRefusal();
  if (!x) return null;
  const { e, d } = x, no = d.event === "refuse";
  return (
    <div>
      <Paper title="Sledgit receipt" sub={`${LIVE.label} · on-chain decision`} rows={[
        ["Agent", e.kind === "arena" || e.kind === "house" ? entryName(e) : shortAcct(e.account)], ["Seq", `#${d.seq}`], ["Time", utc(d.block_time_ms)],
        ["Decision", no ? `REFUSED · ${d.code}` : `${d.event.toUpperCase()}${d.side ? ` · ${d.side.toUpperCase()}` : ""}`],
        ...(d.fill_price ? [["Fill", d.fill_price.toFixed(4)] as [string, string]] : []),
        "hr", ["Tx", `${d.tx.slice(0, 10)}…`], ["Receipt", `${d.receipt_hash.slice(0, 14)}…`],
      ]} foot={<>Check it yourself: <Link href={`/receipt/?id=${encodeURIComponent(receiptId(d))}&net=${LIVE_NETWORK}`}>full receipt →</Link></>}
        stamp={no ? { text: "Refused · on chain", tone: "no" } : { text: "Recorded on chain", tone: "ok" }} />
    </div>);
}

export const SNAPSHOT_AT = LIVE_LEAGUE ? utc(LIVE_LEAGUE.as_of_ms) : null;
