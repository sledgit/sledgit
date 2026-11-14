"use client";
// One wider-board record on its own page, like an explorer: the board's numbers and chart, the account's own text, and a
// style inferred from its public trades. Hyperliquid's positions and fills are read live in the browser on load and on
// Refresh (never polled); Polymarket's profile comes from the daily pull; dYdX's MegaVault has its numbers only. All
// venue data is untrusted: the id is checked before any fetch, lists are capped, text is rendered as plain text.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { dir } from "@/lib/format";
import { HL, type WiderFile, type WiderIndex, type WiderSource, type WiderVault } from "@/lib/wider";
import { hlFills, hlState, parseVaultQuery, tradeStyle, MAX_FILLS, type HlFill, type HlState, type PmProfile, type TradeStyle } from "@/lib/wider-profile";
import { Disclaimer } from "./board";
import { PageHead, Kpi } from "./ui";
import { AiTag, Detail, hasBtc, INDEX_URL, popLine, readWiderFile, Stated, usdk, usdSigned, VenueTag, who, wpct, ymd } from "./wider";

const TIMEOUT_MS = 15_000;
const SHOWN_FILLS = 50;
const SHOWN_COINS = 12;

// ---------------------------------------------------------------- formatting (missing or NaN reads as —)

const fin = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
const pct0 = (x: number | null | undefined) => (fin(x) ? `${Math.round(x * 100)}%` : "—");
const qty = (x: number | null | undefined) => (fin(x) ? Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: Math.abs(x) >= 100 ? 2 : 5 }) : "—");
const price = (x: number | null | undefined) => (!fin(x) ? "—" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 1 }) : x >= 1 ? x.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(Number(x.toPrecision(4))));
const usd = (x: number | null | undefined) => (fin(x) ? usdk(Math.abs(x)) : "—");
const signed = (x: number | null | undefined) => (fin(x) ? usdSigned(x) : "—");
const lev = (x: number | null | undefined) => (fin(x) ? `${x < 10 ? x.toFixed(1).replace(/\.0$/, "") : Math.round(x)}x` : "—");
const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
function dur(ms: number | null): string {
  if (!fin(ms)) return "—";
  const m = ms / 60_000;
  return m < 1 ? "under a minute" : m < 90 ? `${Math.round(m)} min` : m < 48 * 60 ? `${(m / 60).toFixed(1)} hours` : `${(m / 1440).toFixed(1)} days`;
}

// ---------------------------------------------------------------- loading the board's record

type Rec = { state: "loading" } | { state: "error"; message: string } | { state: "missing"; label: string } | { state: "ok"; doc: WiderFile; v: WiderVault };

function useRecord(source: string, id: string): Rec {
  const [s, setS] = useState<Rec>({ state: "loading" });
  useEffect(() => {
    let live = true;
    (async () => {
      const r = await fetch(INDEX_URL, { cache: "no-store" });
      if (r.status === 404) throw new Error("no wider-board data in this build");
      if (!r.ok) throw new Error(`index: HTTP ${r.status}`);
      const idx = (await r.json()) as WiderIndex;
      if (idx?.version !== 1 || !Array.isArray(idx.sources)) throw new Error("index: unexpected format");
      const e = idx.sources.find(x => x?.id === source);
      if (!e || typeof e.file !== "string") throw new Error(`the index lists no ${source} file`);
      const doc = await readWiderFile(e.file);
      const v = doc.vaults.find(x => x.id === `${source}:${id}`);
      if (live) setS(v ? { state: "ok", doc, v } : { state: "missing", label: doc.source.label });
    })().catch((e: Error) => { console.error("wider vault page: record not loaded", e); if (live) setS({ state: "error", message: e.message }); });
    return () => { live = false; };
  }, [source, id]);
  return s;
}

// ---------------------------------------------------------------- Hyperliquid, live

type Live<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T; at: number };

/** POST to Hyperliquid's public info API with a timeout. Every failure carries its reason. */
async function info(body: object): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(HL.infoUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(name === "TimeoutError" || name === "AbortError" ? `no reply within ${TIMEOUT_MS / 1000} s` : `network error: ${(e as Error).message}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 429 ? ", rate limited: try again in a minute" : ""}`);
  try { return await r.json(); } catch (e) { throw new Error(`the reply was not JSON (${(e as Error).message})`); }
}

function useHlLive(address: string) {
  const [state, setState] = useState<Live<HlState>>({ state: "loading" });
  const [fills, setFills] = useState<Live<{ fills: HlFill[]; dropped: number }>>({ state: "loading" });
  const load = useCallback(() => {
    setState({ state: "loading" });
    setFills({ state: "loading" });
    const fail = (what: string, set: (x: Live<never>) => void) => (e: Error) => { console.error(`hyperliquid ${what} not read`, e); set({ state: "error", message: e.message }); };
    info({ type: "clearinghouseState", user: address }).then(hlState).then(data => setState({ state: "ok", data, at: Date.now() }), fail("clearinghouseState", setState));
    info({ type: "userFills", user: address }).then(x => hlFills(x)).then(data => setFills({ state: "ok", data, at: Date.now() }), fail("userFills", setFills));
  }, [address]);
  useEffect(load, [load]);
  return { state, fills, load, busy: state.state === "loading" || fills.state === "loading" };
}

function LiveBar({ at, busy, load, errors }: { at: number | null; busy: boolean; load: () => void; errors: string[] }) {
  return (
    <div className="wlive">
      <p className="note" aria-live="polite">
        {busy ? "Reading Hyperliquid's public API…" : at ? <>As of {utc(at)}, read from Hyperliquid&apos;s public API. Not refreshed automatically.</> : "Nothing read yet."}
        {errors.map(e => <span key={e} className="err" role="alert"><br />{e}</span>)}
      </p>
      <button className="btn sm" onClick={load} disabled={busy} aria-disabled={busy || undefined}>{busy ? "Reading…" : "Refresh"}</button>
    </div>);
}

function Positions({ s }: { s: Live<HlState> }) {
  if (s.state === "loading") return <div className="empty">Reading positions…</div>;
  if (s.state === "error") return <div className="empty">Positions could not be read: {s.message}.</div>;
  const P = s.data.positions;
  return (
    <>
      <p className="note" style={{ margin: "0 0 8px" }}>Account value {usd(s.data.accountValue)} · open notional {usd(s.data.notional)}{fin(s.data.time) ? ` · state at ${utc(s.data.time)}` : ""}</p>
      {!P.length ? <div className="empty">No open positions.</div> : (
        <div className="tblwrap"><table className="tbl wfills">
          <thead><tr><th>Coin</th><th>Side</th><th className="r">Size</th><th className="r">Value</th><th className="r">Entry</th><th className="r">Leverage</th><th className="r">Unrealised PnL</th><th className="r">Liq. price</th></tr></thead>
          <tbody>{P.map((p, i) => (
            <tr key={`${p.coin}-${i}`}>
              <td className="mono">{p.coin}</td><td className={p.size > 0 ? "up" : "down"}>{p.size > 0 ? "Long" : "Short"}</td>
              <td className="r">{qty(p.size)}</td><td className="r">{usd(p.value)}</td><td className="r">{price(p.entry)}</td>
              <td className="r">{lev(p.leverage)}{p.levType ? ` ${p.levType}` : ""}</td>
              <td className={`r ${fin(p.upnl) ? dir(p.upnl) : ""}`}>{signed(p.upnl)}</td><td className="r">{price(p.liq)}</td>
            </tr>))}</tbody>
        </table></div>)}
    </>);
}

function Fills({ s }: { s: Live<{ fills: HlFill[]; dropped: number }> }) {
  if (s.state === "loading") return <div className="empty">Reading fills…</div>;
  if (s.state === "error") return <div className="empty">Fills could not be read: {s.message}.</div>;
  const F = s.data.fills.slice(0, SHOWN_FILLS);
  if (!F.length) return <div className="empty">No fills returned.</div>;
  return (
    <div className="tblwrap"><table className="tbl wfills">
      <thead><tr><th>Time (UTC)</th><th>Coin</th><th>Action</th><th className="r">Size</th><th className="r">Price</th><th className="r">Value</th><th>Taker or maker</th><th className="r">Closed PnL</th></tr></thead>
      <tbody>{F.map((f, i) => (
        <tr key={`${f.time}-${i}`}>
          <td className="mono">{utc(f.time).slice(5, 19)}</td><td className="mono">{f.coin}</td><td>{f.dir || (f.side === "B" ? "Buy" : "Sell")}</td>
          <td className="r">{qty(f.sz)}</td><td className="r">{price(f.px)}</td><td className="r">{usd(f.px * f.sz)}</td>
          <td>{f.crossed ? "taker" : "maker"}</td><td className={`r ${fin(f.closedPnl) && f.closedPnl !== 0 ? dir(f.closedPnl) : ""}`}>{f.closedPnl ? signed(f.closedPnl) : "—"}</td>
        </tr>))}</tbody>
    </table></div>);
}

function Label({ trader }: { trader: boolean }) {
  return <div className="wlabel"><b>Inferred from public trades.</b> Not the {trader ? "trader" : "vault"}&apos;s stated strategy.</div>;
}

function HlStyle({ s, dropped }: { s: TradeStyle; dropped: number }) {
  const more = s.coins.length > SHOWN_COINS ? s.coins.slice(SHOWN_COINS).reduce((a, c) => a + c.share, 0) : 0;
  return (
    <div className="wstyle">
      <Label trader={false} />
      <p className="line">{s.summary}</p>
      <dl className="kv">
        <dt>Sample</dt><dd>{s.fills ? <>The latest {s.fills.toLocaleString("en-US")} fills ({s.orders.toLocaleString("en-US")} orders), {ymd(s.fromMs!)} to {ymd(s.toMs!)}. Hyperliquid returns at most {MAX_FILLS.toLocaleString("en-US")}.</> : "No fills returned."}{dropped ? ` ${dropped} malformed fill(s) left out.` : ""}</dd>
        <dt>Long or short</dt><dd>{s.longShare === null ? "—" : `${pct0(s.longShare)} long, ${pct0(1 - s.longShare)} short, by traded value`}</dd>
        <dt>Taker or maker</dt><dd>{s.takerShare === null ? "—" : `${pct0(s.takerShare)} taker (crossed the book), ${pct0(1 - s.takerShare)} maker, by traded value`}</dd>
        <dt>Leverage</dt><dd>{s.avgLev === null ? (s.openPositions ? "Not published for the open positions." : "No open positions, so none to read.")
          : <>{lev(s.avgLev)} average set leverage (weighted by position value), {lev(s.maxLev)} highest, over {s.openPositions} open position{s.openPositions === 1 ? "" : "s"}{s.grossLev !== null ? ` · open notional is ${lev(s.grossLev)} account value` : ""}</>}</dd>
        <dt>Coins</dt><dd>{s.nCoins ? <><ul className="wcoins">{s.coins.slice(0, SHOWN_COINS).map(c => <li key={c.coin}>{c.coin}<span>{pct0(c.share)}</span></li>)}</ul>
          {more > 0 && <span className="note">and {s.nCoins - SHOWN_COINS} more ({pct0(more)})</span>}</> : "—"}</dd>
        <dt>Orders per day</dt><dd>{s.perDay === null ? "The sample covers under a day." : `${s.perDay < 10 ? s.perDay.toFixed(1) : Math.round(s.perDay).toLocaleString("en-US")} over the sample`}</dd>
        <dt>Median holding time</dt><dd>{s.medianHoldMs === null ? "Not derivable: no position was both opened and closed inside the sample." : `${dur(s.medianHoldMs)}, over ${s.roundTrips} position${s.roundTrips === 1 ? "" : "s"} opened and closed in the sample`}</dd>
        <dt>Direction flips</dt><dd>{s.flipRate === null ? "Not derivable: no coin was reopened inside the sample." : `${pct0(s.flipRate)} of ${s.reopens} reopened position${s.reopens === 1 ? "" : "s"} took the opposite side to the coin's previous one`}</dd>
      </dl>
    </div>);
}

function HlLive({ v }: { v: WiderVault }) {
  const { state, fills, load, busy } = useHlLive(v.address);
  const style = useMemo(() => (fills.state === "ok" ? tradeStyle(fills.data.fills, state.state === "ok" ? state.data : null) : null), [fills, state]);
  const at = [state, fills].map(x => (x.state === "ok" ? x.at : 0)).reduce((a, b) => Math.max(a, b), 0) || null;
  const errors = [state.state === "error" ? `Positions: ${state.message}` : "", fills.state === "error" ? `Fills: ${fills.message}` : ""].filter(Boolean);
  return (
    <>
      <section className="panel" aria-labelledby="h-style">
        <h2 id="h-style">Trading style</h2>
        <LiveBar at={at} busy={busy} load={load} errors={errors} />
        <div className="wsplit">
          {style && fills.state === "ok" ? <HlStyle s={style} dropped={fills.data.dropped} />
            : <div className="wstyle"><Label trader={false} /><div className="empty">{fills.state === "error" ? `No style: the fills could not be read (${fills.message}).` : "Reading fills…"}</div></div>}
          <Stated v={v} label="Stated by the vault" />
        </div>
      </section>
      <section className="panel" aria-labelledby="h-pos"><h2 id="h-pos">Open positions</h2><Positions s={state} /></section>
      <section className="panel" aria-labelledby="h-fills"><h2 id="h-fills">Recent fills</h2>
        <p className="note" style={{ margin: "0 0 8px" }}>The latest {SHOWN_FILLS}, newest first. The style above uses every fill returned.</p>
        <Fills s={fills} /></section>
    </>);
}

// ---------------------------------------------------------------- Polymarket, from the daily pull

function PmStyle({ v, fetched }: { v: WiderVault; fetched: string }) {
  const p = v.profile;
  const body = !p ? <div className="empty">No profile in this pull.</div>
    : "error" in p ? <div className="empty">The daily pull could not build a profile: {p.error}.</div>
    : <PmProfileView p={p} />;
  return (
    <section className="panel" aria-labelledby="h-style">
      <h2 id="h-style">Trading style</h2>
      <p className="note" style={{ margin: "0 0 10px" }}>From the daily pull of {fetched.replace("T", " ").slice(0, 16)} UTC, read from Polymarket&apos;s public data API. Not live.</p>
      <div className="wsplit">
        <div className="wstyle"><Label trader={v.kind === "trader"} />{body}</div>
        <Stated v={v} label={v.kind === "trader" ? "Stated by the trader" : "Stated by the vault"} />
      </div>
    </section>);
}

function PmProfileView({ p }: { p: PmProfile }) {
  return (
    <>
      <p className="line">{p.summary}</p>
      <dl className="kv">
        <dt>Sample</dt><dd>{p.trades ? <>The latest {p.trades.toLocaleString("en-US")} trades, {ymd(p.fromMs!)} to {ymd(p.toMs!)}{p.more ? "; older trades exist and are not read" : ""}.</> : "No trades returned."}</dd>
        <dt>Markets</dt><dd>{p.markets.toLocaleString("en-US")} distinct market{p.markets === 1 ? "" : "s"} in the sample</dd>
        {p.largest.length > 0 && <><dt>Largest by traded value</dt><dd><ol style={{ margin: 0, paddingLeft: 18 }}>{p.largest.slice(0, 5).map((m, i) => <li key={i}>{m.title} <span className="note">{pct0(m.share)}</span></li>)}</ol></dd></>}
        <dt>Buys or sells</dt><dd>{p.buyShare === null ? "—" : `${pct0(p.buyShare)} buys, ${pct0(1 - p.buyShare)} sells, by traded value`}</dd>
        <dt>Yes or No</dt><dd>{p.yesShare === null ? "No trades on Yes/No outcomes in the sample." : `${pct0(p.yesShare)} Yes, ${pct0(1 - p.yesShare)} No, of the ${pct0(p.yesNoShare)} traded on Yes/No outcomes (the rest on named outcomes such as a team)`}</dd>
        <dt>Average trade</dt><dd>{p.avgTradeUsd === null ? "—" : usd(p.avgTradeUsd)}</dd>
        <dt>Open positions</dt><dd>{p.open.count.toLocaleString("en-US")}{p.open.more ? " or more (only the first page is read)" : ""}{p.open.count ? ` · average current value ${usd(p.open.avgValueUsd)}, ${usd(p.open.valueUsd)} in all` : ""}</dd>
      </dl>
    </>);
}

// ---------------------------------------------------------------- the page

const VENUE_PAGE: Record<string, (v: WiderVault) => { href: string; label: string } | null> = {
  hyperliquid: v => ({ href: `https://app.hyperliquid.xyz/vaults/${v.address}`, label: "View on Hyperliquid ↗" }),
  polymarket: v => ({ href: `https://polymarket.com/profile/${v.address}`, label: "View on Polymarket ↗" }),
};

function VaultRecord({ doc, v }: { doc: WiderFile; v: WiderVault }) {
  const src: WiderSource = doc.source, trader = v.kind === "trader", pop = popLine(doc);
  const venue = /^0x[0-9a-f]{40}$/.test(v.address) ? VENUE_PAGE[v.source]?.(v) ?? null : null;
  return (
    <>
      <PageHead eyebrow={`Wider board · ${src.label} ${trader ? "trader" : "vault"}`} title={v.name}
        lede={<>{who(v)} <AiTag v={v} /></>}
        right={<><VenueTag src={src} /><span className="tag" title={`Read from ${src.label}'s public API`}>Self-reported</span>
          {venue && <a className="btn sm" href={venue.href} target="_blank" rel="noreferrer nofollow">{venue.label}</a>}</>} />
      <div className="wpage">
        <div className="callout wbanner" role="note">
          <b>A public record read from {src.label}.</b> This account has no limits enforced by Sledgit and is not a Sledgit vault. It is on the board because it is among the venue&apos;s largest or most active accounts, so it is a survivor.{pop && <> {src.label}: {pop}.</>} Past results. Not a recommendation.
        </div>
        <div className="kpis">
          {v.ret === null ? <Kpi k="PnL $" v={<span className={dir(v.pnlUsd)}>{usdSigned(v.pnlUsd)}</span>} s="over the window, vs hold USDC $0" />
            : <Kpi k="Return" v={<span className={dir(v.ret)}>{wpct(v.ret)}</span>} s="same as vs hold USDC" />}
          <Kpi k="vs hold BTC" v={hasBtc(v) ? <span className={dir(v.vsBtc ?? 0)}>{wpct(v.vsBtc)}</span> : "n/a"} s={hasBtc(v) ? `BTC ${wpct(v.btc)}` : "no BTC baseline"} />
          <Kpi k="Max drawdown" v={v.maxDd !== null ? wpct(v.maxDd) : v.maxDdUsd !== null ? usdSigned(v.maxDdUsd) : "—"} />
          <Kpi k={trader ? "Account value" : "TVL"} v={usdk(v.tvl)} s={trader ? "an estimate" : undefined} />
          <Kpi k="Days" v={Math.round(v.days)} s={v.ranked ? "ranked" : `listed, not ranked: ${v.unranked_reason ?? ""}`} />
        </div>
        <section className="panel" aria-labelledby="h-rec"><h2 id="h-rec">Record</h2><Detail v={v} src={src} quote={false} page={false} /></section>
        {v.source === "hyperliquid" ? <HlLive v={v} />
          : v.source === "polymarket" ? <PmStyle v={v} fetched={doc.fetched_at} />
          : <section className="panel" aria-labelledby="h-style"><h2 id="h-style">Trading style</h2>
            <div className="wsplit">
              <div className="wstyle"><Label trader={false} /><p className="note">No public trade feed is read for {v.name}, so no style is inferred. The numbers above are all this page has.</p></div>
              <Stated v={v} label="Stated by the vault" />
            </div></section>}
        <Disclaimer />
      </div>
    </>);
}

export function WiderVaultPage() {
  const q = useSearchParams();
  const p = parseVaultQuery(q.get("src"), q.get("id"));
  if (!p.ok) return <Gone title="Not a wider-board record" why={`This link is not valid: ${p.error}.`} />;
  return <Loaded source={p.source} id={p.id} />;
}

function Loaded({ source, id }: { source: string; id: string }) {
  const s = useRecord(source, id);
  if (s.state === "loading") return <><Back /><div className="empty">Loading…</div></>;
  if (s.state === "error") return <Gone title="Record not loaded" why={`The wider-board data could not be read (${s.message}).`} />;
  if (s.state === "missing") return <Gone title="Not on the board" why={`${id} is not in this build's ${s.label} file.`} />;
  return <><Back /><VaultRecord doc={s.doc} v={s.v} /></>;
}

const Back = () => <Link className="back" href="/wider/" style={{ marginTop: 24 }}>‹ Wider board</Link>;

function Gone({ title, why }: { title: string; why: string }) {
  return <div className="prose" style={{ paddingTop: 24 }}><Back /><h2>{title}</h2><p>{why}</p><Disclaimer /></div>;
}
