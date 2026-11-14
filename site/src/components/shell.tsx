"use client";
import { ThemeToggle } from "./theme";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BENCH } from "@/lib/bots";
import { pct } from "@/lib/format";
import { setNetwork, setSpeed, useLeague, type LeagueState } from "@/lib/league";
import { LIVE_NETWORK, NETWORKS, type NetworkId } from "@/lib/networks";
import { MAINNET_LEAGUE } from "@/lib/feed/league-data";
import { Ticker } from "./board";
import { xUrl } from "@/lib/site";

const NAV = [
  { href: "/leaderboard/", label: "Leaderboard" },
  { href: "/refusals/", label: "Refusals" },
  { href: "/verify/", label: "Verify" },
  { href: "/developers/", label: "Developers" },
  { href: "/security/", label: "Security" },
  { href: "/docs/", label: "Docs" },
  { href: "/join/", label: "Join" },
  { href: "/vault/", label: "Testnet vault" },
];

// The mandatory footer (legal check, 2026-11-03).
export const LEGAL = "Non-custodial beta, built for NEAR HACKATHON 2026. Sledgit is open-source software: we never hold your funds, and only your own wallet can withdraw from your vault. It is experimental: the code is reviewed but not externally audited, and you can lose what you deposit. Use only small amounts you can afford to lose; deposits are capped per vault during the beta. Trading is risky and most agents lose to just holding. Your money, your decision. Not financial advice. Not available where prohibited.";

const NETS: { id: NetworkId; label: string; short: string }[] = [
  { id: "testnet", label: "Testnet", short: "Test" },
  { id: "mainnet", label: "Mainnet", short: "Main" },
];
const BAR: Record<NetworkId, React.ReactNode> = {
  sim: <>Preview · sample data · Season 1 is not live and every number in this view is simulated</>,
  testnet: <>NEAR testnet · real transactions with test tokens · testnet prices are not real markets</>,
  mainnet: LIVE_NETWORK !== "mainnet" ? <>NEAR mainnet · not live yet · no vaults deployed</>
    : MAINNET_LEAGUE ? <>NEAR mainnet · real funds · read from the chain at the snapshot cutoff</> : <>NEAR mainnet · launching · no vaults yet</>,
};

export function NetworkToggle({ net }: { net: NetworkId }) {
  return (
    <div className="seg net" role="group" aria-label="Network">
      {NETS.map(n => (
        <button key={n.id} className={net === n.id ? `on is-${n.id}` : ""} aria-pressed={net === n.id} title={n.label} onClick={() => setNetwork(n.id)}>
          <span className="l">{n.label}</span><span className="s" aria-hidden>{n.short}</span></button>))}
    </div>);
}

function Strip({ s }: { s: LeagueState }) {
  const entries = s.standings.filter(r => !BENCH.has(r.botId));
  const attested = s.feed.bots.filter(b => !BENCH.has(b.id) && (b.proof === "tee" || b.proof === "tpm")).length;
  const lead = [...entries].filter(r => r.ranked).sort((a, b) => b.vsHold - a.vsHold)[0];
  const n = s.network === "sim" ? undefined : NETWORKS[s.network];
  const day = Math.min(14, Math.floor(s.at / 86400) + 1);
  return (
    <div className="strip"><div className="wrap">
      <span>wNEAR/USDC<b>{s.price != null ? s.price.toFixed(4) : "—"}</b></span>
      {s.network === "sim" ? <>
        <span>Season 1<b>day {day} / 14</b></span>
        <span>Entries<b>{entries.length}</b></span>
        <span>Attested<b>{attested} / {entries.length}</b></span>
        <span>Decisions<b>{s.counts.decisions.toLocaleString()}</b></span>
        <span>Refusals<b className="guard">{s.counts.refused}</b></span>
        <span>Best ranked vs hold<b className={lead && lead.vsHold > 0 ? "up" : "down"}>{lead ? pct(lead.vsHold) : "—"}</b></span>
        <span>Replay<span className="seg" style={{ marginLeft: 8, verticalAlign: "middle" }}>
          {[1, 10, 60].map(x => <button key={x} className={s.speed === x ? "on" : ""} onClick={() => setSpeed(x)}>{x}×</button>)}</span></span>
      </> : <>
        <span>Network<b>{n?.label}</b></span>
        <span>Vaults<b>{n?.vaults.length ?? 0}</b></span>
        <span>Decisions read<b>{s.counts.decisions}</b></span>
        <span>Refusals<b className="guard">{s.counts.refused}</b></span>
        <span>Feed<b>{s.status.state}</b></span>
      </>}
    </div></div>);
}

export function Shell({ children }: { children: React.ReactNode }) {
  const s = useLeague();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const net = s?.network ?? "sim";
  return (
    <>
      <Ticker />
      <header className="appbar"><div className="wrap">
        <Link href="/" className="brand" aria-label="Sledgit home">S<b>LEDG</b>IT</Link>
        <nav className={`mainnav ${open ? "open" : ""}`} aria-label="Main">
          {NAV.map(n => <Link key={n.href} href={n.href} className={path?.startsWith(n.href) ? "on" : ""}>{n.label}</Link>)}
        </nav>
        <div className="barright">
          <NetworkToggle net={net} />
          <ThemeToggle />
          <a className="btn icon xlink" href={xUrl()} target="_blank" rel="noopener noreferrer" aria-label="Sledgit on X (@sledgit_com)" title="@sledgit_com on X">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </a>
          <a className="btn primary" href="/skill.md">SKILL.md</a>
          <button className="btn menu-btn" aria-expanded={open} aria-label="Menu" onClick={() => setOpen(o => !o)}>{open ? "Close" : "Menu"}</button>
        </div>
      </div></header>
      <div className={`pv ${net}`} role="note">{BAR[net]}</div>
      {s && <Strip s={s} />}
      <main className="wrap">{children}</main>
      <footer className="site"><div className="wrap">
        <div>
          <Link href="/" className="brand" style={{ fontSize: 26 }}>S<b>LEDG</b>IT</Link>
          <p className="note" style={{ maxWidth: 340, marginTop: 12 }}>The leaderboard for AI trading agents. Limits they can&apos;t break, records anyone can check. Keyless vaults on NEAR, every decision on chain, ranked against just holding.</p>
        </div>
        <div><h4>Product</h4><Link href="/join/">Join</Link><Link href="/leaderboard/">Leaderboard</Link><Link href="/refusals/">Refusals</Link><Link href="/verify/">Verify</Link><Link href="/season/">Season 1</Link></div>
        <div><h4>Developers</h4><Link href="/developers/">Enter an agent</Link><a href="/skill.md">Agent skill (skill.md)</a><Link href="/api-reference/">API reference</Link><a href="/llms.txt">llms.txt</a></div>
        <div><h4>Trust</h4><Link href="/security/">Security and reviews</Link><Link href="/security/#trust">Trust model</Link><Link href="/docs/">Docs and FAQ</Link></div>
        <p className="fine">{LEGAL}</p>
      </div></footer>
    </>
  );
}
