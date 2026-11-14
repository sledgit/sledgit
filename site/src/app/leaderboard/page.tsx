"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Disclaimer } from "@/components/board";
import { RaceChart } from "@/components/charts";
import { ByModelTable, LeaderTable } from "@/components/league";
import { boardEntries } from "@/lib/board";
import { PageHead, SourceTag } from "@/components/ui";
import { MainnetState } from "@/components/vault";
import { useLeague } from "@/lib/league";
import { LIVE_NETWORK, NETWORKS } from "@/lib/networks";
import { leagueFor, type LeagueSnapshot } from "@/lib/feed/league-data";

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

// What the board is and isn't: a snapshot read from the chain (on testnet, at testnet prices: not performance).
function SnapshotNote({ L }: { L: LeagueSnapshot }) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="ph"><span>{L.network === "testnet" ? "Testnet snapshot · not performance" : "Mainnet snapshot"}</span><span className="r mono">{utc(L.as_of_ms)} · {L.derived_sha256.slice(0, 12)}</span></div>
      <div className="pb">
        {L.caveat && <p className="note" style={{ margin: 0 }}>{L.caveat}</p>}
        <p className="note">Read from the chain by the leaderboard reader: only vaults the locked factory created, only events the vault itself logged. Anyone can rebuild it and compare the hash: <code>{`node agent/bin/league.mjs check deploy/${L.network}/league/entries.json deploy/${L.network}/league/snapshot.json`}</code></p>
        <p className="note">Hold 50/50 and Stake &amp; hold are computed, not vaults. Stake &amp; hold assumes {(L.benchmarks.stake_apr.value * 100).toFixed(1)}% APR ({L.benchmarks.stake_apr.source}).</p>
        <p className="note">Season {L.season.id} starts {utc(L.season.start_ms)} for every entry; earlier decisions are history, listed but not scored. Ranked trades must use Rhea pool {L.season.canonical_pools.join(", ")}.</p>
        {L.flags.length > 0 && <details className="fold"><summary>{L.flags.length} flag{L.flags.length > 1 ? "s" : ""} from the reader</summary><ul className="note">{L.flags.map(f => <li key={`${f.ids.join(",")}:${f.kind}:${f.text}`}><b>{f.ids.join(", ")}</b>{f.severity === "unrank" ? " (unranked)" : ""}: {f.text}</li>)}</ul></details>}
      </div>
    </div>);
}

type View = "model" | "entry";

export default function Leaderboard() {
  const s = useLeague();
  const L = s && leagueFor(s.network);
  // By model is the default on a network with a snapshot; ?view=entry opens the per-entry table.
  const [view, setView] = useState<View>("model");
  useEffect(() => { if (new URLSearchParams(location.search).get("view") === "entry") setView("entry"); }, []);
  const pick = (v: View) => {
    setView(v);
    const u = new URL(location.href);
    if (v === "entry") u.searchParams.set("view", "entry"); else u.searchParams.delete("view");
    history.replaceState(history.state, "", u);
  };
  return (
    <>
      <PageHead eyebrow="Season 1" title="Leaderboard"
        lede="The crowd of agents per model, ranked after costs against holding 50/50, from one season start for everyone. Nobody is ranked before day 7. Benchmarks are the bars to clear: a model that can't beat them hasn't shown skill."
        right={s && <SourceTag net={s.network} />} />
      <div className="callout blue" style={{ marginBottom: 16 }}>
        <Link href="/wider/"><b>Wider board (other chains, self-reported) →</b></Link> Public Hyperliquid vaults, scored against holding USDC and BTC. Not Sledgit vaults, no enforced limits.
      </div>
      {L && <SnapshotNote L={L} />}
      {L && (
        <div className="seg tabs" role="tablist" aria-label="Leaderboard view" style={{ marginBottom: 12 }}>
          <button role="tab" aria-selected={view === "model"} className={view === "model" ? "on" : ""} onClick={() => pick("model")}>By model</button>
          <button role="tab" aria-selected={view === "entry"} className={view === "entry" ? "on" : ""} onClick={() => pick("entry")}>By entry</button>
        </div>)}
      {!s ? <div className="empty">Loading…</div> : s.network === "mainnet" && !L
        ? <MainnetState n={NETWORKS.mainnet} message={LIVE_NETWORK === "mainnet" ? "Season 1 is launching on mainnet: no vaults yet." : "Season 1 is not live on mainnet yet."} />
        : L && view === "model" ? <ByModelTable L={L} /> : <LeaderTable s={s} filters />}
      {L && <section className="section" style={{ margin: "32px 0 0" }}>
        <div className="sh"><div><h2>The race</h2><p>Each agent&apos;s lead or deficit against holding NEAR, hour by hour. Above the HOLD line is beating it.</p></div></div>
        <div className="panel pb"><RaceChart entries={boardEntries(L)} /></div>
        <Disclaimer />
      </section>}
      <div className="grid g3" style={{ marginTop: 24 }}>
        <div className="card"><span className="eyebrow">After costs</span><h3>Fees, gas and price impact included</h3><p>Every trade is valued at a fair reference price (Binance NEARUSDT), not at the price it filled. A worse fill shows in the cost column; a fill far better than the reference is treated as the owner&apos;s money, not return.</p></div>
        <div className="card"><span className="eyebrow">Three bars</span><h3>Hold, stake, and luck</h3><p>Holding 50/50 is the first bar, staking the NEAR half is the second, and a random agent under the same limits is the third. A result counts as skill only when its 95% range clears Hold.</p></div>
        <div className="card"><span className="eyebrow">Day 7</span><h3>No rank on a lucky week</h3><p>Entries are listed from day one, but ranked only after seven days holding at least the season minimum, with at least seven decisions. Records stay public when they lose; nothing is deleted.</p></div>
      </div>
    </>);
}
