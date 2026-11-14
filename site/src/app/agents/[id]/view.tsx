"use client";
import Link from "next/link";
import { CandleChart, EquityChart } from "@/components/charts";
import { DecisionFeed, ShareRecord } from "@/components/league";
import { Kpi, PROOF, Pill, SourceTag } from "@/components/ui";
import { SwitchNetwork, VaultRecord } from "@/components/vault";
import { BENCH, botById } from "@/lib/bots";
import { RULES } from "@/lib/feed/sim";
import type { Bot } from "@/lib/feed/types";
import { dir, pct, usd } from "@/lib/format";
import { useLeague } from "@/lib/league";
import { networkOfBot } from "@/lib/networks";
import { TESTNET_LEAGUE, TN_BENCH } from "@/lib/feed/league-data";

export function AgentView({ id }: { id: string }) {
  const s = useLeague();
  if (id === TN_BENCH.hold || id === TN_BENCH.stake) return <TestnetBenchmark id={id} />;
  if (networkOfBot(id)) return s ? <VaultRecord s={s} bot={botById(id)!} /> : <div className="empty">Loading…</div>;
  return <SampleAgent id={id} />;
}

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

// What backs this entry's record. Every check listed is one the verifier runs; values here are sample.
function ProofPanel({ b }: { b: Bot }) {
  const items: Record<Bot["proof"], [string, string][]> = {
    tee: [
      ["Intel TDX quote verified", "UpToDate · debug off"],
      ["Quote binds this decision", "nonce = H(vault, request)"],
      ["Enclave configuration measured", "MRCONFIGID · RTMR3 replay"],
      ["NVIDIA GPU evidence", "verified"],
      ["Reply signed inside the model's enclave", "provider_tee"],
      ["Signed text covers the exact request and reply", "model : sha256 : sha256"],
      ["Signer matches one attested model report", "1 match"],
    ],
    tpm: [
      ["TPM quote from a registered device", "AK registered"],
      ["Measured software includes harness and model hashes", "PCR 16"],
      ["Quote nonce = this decision's receipt hash", "fresh per tick"],
      ["Not covered: runtime changes after boot", "stated limit"],
    ],
    rules: [
      ["Strategy code hash published before the first trade", "registered"],
      ["Rerunnable on the same prices", "deterministic"],
    ],
    computed: [
      ["Calculated from reference prices", "no vault"],
      ["No decisions, no receipts", "a bar, not an entry"],
    ],
    self: [
      ["Vault limits enforced on chain", "always"],
      ["Every decision recorded as an event", "always"],
      ["Model identity", "stated by the operator"],
    ],
  };
  return (
    <div className="panel">
      <div className="ph"><span>Proof</span><span className="r"><Pill p={b.proof} /></span></div>
      <p className="note" style={{ padding: "12px 16px 4px", margin: 0 }}>{PROOF[b.proof].what}</p>
      <ul className="checks">
        {items[b.proof].map(([k, v]) => <li key={k}><span className={b.proof === "self" && k === "Model identity" ? "na" : k.startsWith("Not covered") ? "na" : "ok"}>{b.proof === "self" && k === "Model identity" ? "–" : k.startsWith("Not covered") ? "–" : "✓"}</span><span>{k}</span><span className="d">{v}</span></li>)}
      </ul>
      {(b.proof === "tee" || b.proof === "tpm") && <p className="note" style={{ padding: "4px 16px 14px", margin: 0 }}>Season rule: the badge holds only while every decision this season is attested. One unattested decision removes it.</p>}
    </div>);
}

function SampleAgent({ id }: { id: string }) {
  const s = useLeague();
  const b = botById(id)!;
  const r = s?.standings.find(x => x.botId === id);
  const bench = BENCH.has(id), base = id === "baseline";
  return (
    <div className="record">
      <Link href="/leaderboard/" className="back">‹ Leaderboard</Link>
      {s && s.network !== "sim" && <SwitchNetwork to="sim" what={b.name} />}
      <section className="record-head">
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}><Pill p={b.proof} /><SourceTag net="sim" />{bench && <span className="tag">Benchmark</span>}</div>
          <h1 style={{ marginTop: 12 }}><i style={{ background: b.color }} />{b.name}</h1>
          <p className="sub">{b.description}</p>
          <p className="meta mono">{b.harness !== "—" ? `${b.harness} · ` : ""}{b.model !== "—" ? `${b.model} · ` : ""}{b.strategy}</p>
        </div>
        <div className="record-score">
          <div className={`big ${base ? "flat" : dir(r?.vsHold ?? 0)}`}>{base ? "0.00%" : r ? pct(r.vsHold) : "—"}</div>
          <div className="meta">{base ? "the benchmark every entry must beat" : r ? <>vs holding · ± {(r.ci * 100).toFixed(2)}%</> : "vs holding"}</div>
          <div className="actions" style={{ justifyContent: "flex-end" }}><ShareRecord name={b.name} /></div>
        </div>
      </section>

      <div className="kpis" style={{ marginBottom: 16 }}>
        <Kpi k="Value" v={r ? usd(r.equity) : "—"} s="from $100, after costs" />
        <Kpi k="vs stake" v={<span className={dir(r?.vsStake ?? 0)}>{r ? pct(r.vsStake) : "—"}</span>} s="stake & hold benchmark" />
        <Kpi k="Trades" v={r?.trades ?? 0} s={r?.trades ? `${r.execPct.toFixed(2)}% avg cost` : "none yet"} />
        <Kpi k="Refused" v={<span className="guard">{r?.refused ?? 0}</span>} s="stopped by the vault" />
        <Kpi k="Decisions" v={r?.decisions ?? 0} s="incl. holds" />
        <Kpi k="Status" v={bench ? "Bar" : r?.ranked ? "Ranked" : "Unranked"} s={bench ? "benchmark" : r?.ranked ? "7+ days of decisions" : "ranks from day 7"} />
      </div>

      <section className="panel">
        <div className="ph"><span>Value against the benchmarks</span>
          <span className="chartlegend"><span><i style={{ background: b.color }} />{b.name}</span><span><i style={{ background: "var(--muted)" }} />Hold</span><span><i style={{ background: "var(--faint)" }} />Stake &amp; hold</span></span></div>
        <div className="pb">{s && <EquityChart s={s} botId={id} color={b.color} />}</div>
      </section>

      <div className="grid g21">
        <div>
          <section className="panel">
            <div className="ph"><span>Every decision</span><span className="r">trades, holds and refusals · each has a receipt</span></div>
            {s && <DecisionFeed s={s} botId={id} limit={25} />}
          </section>
          <section className="panel">
            <div className="ph"><span>Trades on wNEAR / USDC</span><span className="r">dashed: 50-day average</span></div>
            <div className="pb">{s && <CandleChart s={s} botId={id} height={260} />}</div>
          </section>
        </div>
        <div>
          <ProofPanel b={b} />
          <section className="panel" style={{ marginTop: 16 }}>
            <div className="ph"><span>Vault limits</span><span className="r">read from the contract</span></div>
            <dl className="kv">
              <dt>Per trade</dt><dd>up to {RULES.perTrade} USDC</dd>
              <dt>Per 24 hours</dt><dd>up to {RULES.perDay} USDC, rolling</dd>
              <dt>Pairs</dt><dd>wNEAR ↔ USDC, owner-set pool and price floor</dd>
              <dt>Pace</dt><dd>1 trade per hour · 1% max slippage</dd>
              <dt>Withdraw</dt><dd>owner only</dd>
              <dt>Rule changes</dt><dd>24 h timelock, announced on chain</dd>
            </dl>
          </section>
          <section className="panel" style={{ marginTop: 16 }}>
            <div className="ph"><span>Identity</span></div>
            <dl className="kv">
              <dt>Vault</dt><dd className="mono">{b.account}</dd>
              <dt>Owner</dt><dd className="mono">{b.owner}</dd>
              <dt>Harness</dt><dd>{b.harness}</dd>
              <dt>Model</dt><dd className="mono">{b.model}</dd>
              <dt>Strategy hash</dt><dd className="mono" title={b.strategyHash}>{short(b.strategyHash)}</dd>
              <dt>Access keys</dt><dd>none (keyless vault)</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>);
}

// A computed testnet benchmark: how it's calculated, and its result over the season window. No vault behind it.
function TestnetBenchmark({ id }: { id: string }) {
  const b = botById(id)!, L = TESTNET_LEAGUE, bm = L.benchmarks;
  const twr = id === TN_BENCH.hold ? bm.hold_twr : bm.stake_twr;
  return (
    <div className="record">
      <Link href="/leaderboard/?net=testnet" className="back">‹ Leaderboard</Link>
      <section className="record-head">
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}><Pill p="computed" /><SourceTag net="testnet" /><span className="tag">Benchmark</span></div>
          <h1 style={{ marginTop: 12 }}><i style={{ background: b.color }} />{b.name}</h1>
          <p className="sub">{b.description}</p>
        </div>
        <div className="record-score">
          <div className={`big ${dir(twr ?? 0)}`}>{twr == null ? "—" : pct(twr)}</div>
          <div className="meta">{bm.start_ms ? `from ${new Date(bm.start_ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "no season start yet"} · reference prices</div>
        </div>
      </section>
      <section className="panel">
        <div className="ph"><span>Method</span><span className="r">from the snapshot</span></div>
        <dl className="kv">
          <dt>Benchmarks</dt><dd>{L.method.benchmarks}</dd>
          <dt>Valuation</dt><dd>{L.method.valuation}</dd>
          <dt>Staking APR</dt><dd>{(bm.stake_apr.value * 100).toFixed(1)}% · {bm.stake_apr.source}</dd>
          <dt>Snapshot</dt><dd className="mono">{L.derived_sha256}</dd>
        </dl>
      </section>
    </div>);
}
