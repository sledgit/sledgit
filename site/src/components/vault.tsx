"use client";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { txEvents, VENUE_NAME } from "@/lib/feed/near";
import type { Bot, ChainEvent, Decision, VaultView } from "@/lib/feed/types";
import { flagsFor, leagueOf, type LeagueEntry } from "@/lib/feed/league-data";
import { Pill } from "@/components/ui";
import { dir, pct } from "@/lib/format";
import { setNetwork, type LeagueState } from "@/lib/league";
import { NETWORKS, explorerAccount, explorerTx, formatToken, networkOfBot, type NetworkConfig, type NetworkId } from "@/lib/networks";
import { quip } from "@/lib/board";
import { Disclaimer } from "./board";
import { EntryEquity, TradeChart } from "./charts";
import { DecisionFeed } from "./league";
import { Paper, type StampTone } from "./paper";
import strategyData from "@/data/strategies.json";

const netOf = (s: LeagueState) => (s.network === "sim" ? undefined : NETWORKS[s.network]);
const utc = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const num = (x: number | null | undefined, d = 4) => (x == null || !Number.isFinite(x) ? "—" : x.toLocaleString("en-US", { maximumFractionDigits: d }));
const short = (x: string, n = 10) => (x.length > 2 * n + 1 ? `${x.slice(0, n)}…${x.slice(-n)}` : x);

export function TxLink({ n, hash, full }: { n: NetworkConfig; hash: string; full?: boolean }) {
  return <a className="mono ext" href={explorerTx(n, hash)} target="_blank" rel="noreferrer">{full ? hash : short(hash, 6)} ↗</a>;
}
export function AccountLink({ n, account }: { n: NetworkConfig; account: string }) {
  return <a className="mono ext" href={explorerAccount(n, account)} target="_blank" rel="noreferrer">{account} ↗</a>;
}

// Loading, failure and partial-failure states. Errors are listed, never swallowed.
export function StatusBanner({ s }: { s: LeagueState }) {
  const st = s.status;
  if (st.state === "ready" && !st.errors.length) return null;
  if (st.state === "offline") return null;
  if (st.state === "loading") return <div className="net-state" role="status"><span className="spin" />{st.message}</div>;
  return (
    <div className={`net-state ${st.state === "error" ? "err" : "warn"}`} role="alert">
      <b>{st.state === "error" ? st.message : "Some data could not be read"}</b>
      <ul>{st.errors.map((e, i) => <li key={i} className="mono">{e}</li>)}</ul>
      <span className="note">Retrying every 30 seconds{st.updated ? ` · last attempt ${utc(st.updated)}` : ""}.</span>
    </div>);
}

function PriceNote({ s, n }: { s: LeagueState; n: NetworkConfig }) {
  const [a, q] = n.tokens;
  return <p className="note price-note">Reference price: 1 {a.symbol} = {num(s.price)} {q.symbol} (Binance NEARUSDT at the snapshot cutoff; {q.symbol} counted at $1). Values are at this reference, not at the pool&apos;s price.
    <b> Testnet pools are not real markets</b>: trades fill at prices far from the reference, so these values say the vault works, not how an agent would do on a real market.</p>;
}

export function MainnetState({ n, message }: { n: NetworkConfig; message: string }) {
  return (
    <section className="net-off">
      <span className="kicker">{n.label}</span>
      <h2>{message}</h2>
      <p className="sub">No vaults are deployed on mainnet, so there is nothing to show here: no prices, no records, no sample data.
        Testnet runs the same vault against real Rhea and NEAR Intents contracts.</p>
      <dl className="kv">
        <dt>Rhea (Ref Finance)</dt><dd><AccountLink n={n} account={n.rhea} /></dd>
        {n.intents && <><dt>NEAR Intents</dt><dd><AccountLink n={n} account={n.intents} /></dd></>}
        <dt>Chain signatures (MPC)</dt><dd><AccountLink n={n} account={n.mpc} /></dd>
        <dt>RPC</dt><dd className="mono">{n.rpc}</dd>
        <dt>Vaults</dt><dd>none yet</dd>
      </dl>
      <div className="actions"><button className="btn" onClick={() => setNetwork("testnet")}>See the testnet vault</button></div>
    </section>);
}

// Shown when a page belongs to a different network than the one selected.
export function SwitchNetwork({ to, what }: { to: NetworkId; what: string }) {
  const label = to === "sim" ? "Simulated" : to === "testnet" ? "Testnet" : "Mainnet";
  return (
    <div className="net-state">
      <b>{what} is part of the {label.toLowerCase()} view.</b>
      <div className="actions"><button className="btn primary" onClick={() => setNetwork(to)}>Switch to {label}</button></div>
    </div>);
}

function eventSummary(n: NetworkConfig, e: ChainEvent): string {
  const d = e.data, s = (k: string) => (d[k] == null ? undefined : String(d[k]));
  const parts: string[] = [];
  if (s("seq")) parts.push(`#${s("seq")}`);
  if (s("venue")) parts.push(VENUE_NAME[s("venue")!] ?? s("venue")!);
  if (s("token_in") && s("amount_in")) parts.push(formatToken(n, s("token_in")!, s("amount_in")!) + (s("token_out") ? ` → ${s("amount_out") ? formatToken(n, s("token_out")!, s("amount_out")!) : n.tokens.find(t => t.id === s("token_out"))?.symbol ?? s("token_out")}` : ""));
  else if (s("token") && s("amount")) parts.push(formatToken(n, s("token")!, s("amount")!) + (s("to") ? ` to ${s("to")}` : ""));
  if (s("code")) parts.push(`${s("code")}${s("reason") ? `: ${s("reason")}` : ""}`);
  if (s("note")) parts.push(s("note")!);
  if (e.event === "init") parts.push(`owner ${s("owner_id")}, agent ${s("agent_id")}`);
  if (e.event === "intents_key") parts.push(`key ${short(s("public_key") ?? "", 12)}`);
  return parts.join(" · ");
}

function Policy({ n, v }: { n: NetworkConfig; v: VaultView }) {
  const p = v.policy as { tokens?: { token: string; max_per_trade: string; max_per_day: string }[]; pairs?: { token_in: string; token_out: string; pool_id: number; min_price_num: string; min_price_den: string }[]; max_trades_per_hour?: number; max_slippage_bps?: number } | undefined;
  const c = v.config as Record<string, string | boolean | number | null> | undefined;
  const u = v.usage as { trades?: number; spent?: [string, string][] } | undefined;
  const it = v.intents as Record<string, string | null> | undefined;
  const sym = (t: string) => n.tokens.find(x => x.id === t)?.symbol ?? t;
  return (
    <dl className="kv">
      {p?.tokens?.map(t => <Fragment key={t.token}><dt>{sym(t.token)} limits</dt><dd>{formatToken(n, t.token, t.max_per_trade)} per trade, {formatToken(n, t.token, t.max_per_day)} per day</dd></Fragment>)}
      {p?.pairs?.map(x => <Fragment key={`${x.token_in}>${x.token_out}`}><dt>{sym(x.token_in)} → {sym(x.token_out)}</dt><dd>pool {x.pool_id}, floor {num(Number(x.min_price_num) / Number(x.min_price_den))} {sym(x.token_out)} per {sym(x.token_in)}</dd></Fragment>)}
      {p && <><dt>Pace and slippage</dt><dd>up to {p.max_trades_per_hour} trades an hour, {(p.max_slippage_bps ?? 0) / 100}% slippage</dd></>}
      {u && <><dt>Used this hour</dt><dd>{u.trades ?? 0} trades{u.spent?.length ? `, ${u.spent.map(([t, a]) => formatToken(n, t, a)).join(", ")} spent` : ""}</dd></>}
      {c && <>
        <dt>Owner</dt><dd><AccountLink n={n} account={String(c.owner_id)} /></dd>
        <dt>Agent</dt><dd><AccountLink n={n} account={String(c.agent_id)} /></dd>
        <dt>Exchange</dt><dd className="mono">{String(c.exchange_id)}</dd>
        <dt>Intents</dt><dd className="mono">{String(c.intents_id)} {n.id === "testnet" && <span className="note">(the testnet copy of intents.near)</span>}</dd>
        <dt>MPC signer</dt><dd className="mono">{String(c.mpc_id)}</dd>
        <dt>Frozen</dt><dd>{c.frozen ? "yes: trading stopped" : "no"}</dd>
        <dt>Sequence</dt><dd>{String(c.seq)} requests · contract {String(c.version)}</dd>
      </>}
      {it && <><dt>Intents key</dt><dd className="mono">{short(String(it.public_key ?? "none"), 14)} · path {String(it.path ?? "—")}</dd>
        <dt>Open intent</dt><dd>{it.open_intent ? <span className="mono">{JSON.stringify(it.open_intent).slice(0, 120)}</span> : "none"}</dd></>}
    </dl>);
}

const STRAT = strategyData as { rules: Record<string, { version: number; rule: string; sha256: string }>; prompts: Record<string, { sha256: string }> };
const Hash = ({ h }: { h: string }) => <span className="mono" title={h}>{short(h, 8)}</span>;

// What the entry trades on, in plain words: the published rule, the desk spec, or the model, harness and prompt.
function StrategyPanel({ e }: { e: LeagueEntry }) {
  const rule = e.model.startsWith("rules:") ? STRAT.rules[e.model.slice(6)] : undefined;
  const desk = e.model.startsWith("iron-trader-v1"), spec = STRAT.prompts["iron-trader-v1"];
  const llm = e.kind === "arena" && !desk && !rule;
  const recorded = e.strategy_sha256;
  const named = recorded ? Object.keys(STRAT.prompts).find((k) => k.startsWith("arena-") && STRAT.prompts[k].sha256 === recorded) : undefined;
  const arenaId = named ?? "arena-v1.1", arena = STRAT.prompts[arenaId];
  const proof = e.proof.tier !== e.proof.claimed ? <p className="note">Claims {e.proof.claimed}, proven {e.proof.tier}: {e.proof.detail}.</p> : null;
  let body: React.ReactNode;
  if (rule) body = <>
    <p>Open rule, no model: {rule.rule}</p>
    <dl className="kv">
      <dt>Spec</dt><dd className="mono">{e.model} · <Hash h={recorded ?? rule.sha256} /></dd>
      <dt>Rerun</dt><dd>deterministic: the same prices give the same decisions</dd>
    </dl>{proof}</>;
  else if (desk) body = <>
    <p>A rule-based desk, not a language model. The trend is up when the last daily close is above its 20-day average and that is above the 50-day average, down in the mirror case. It tilts toward 70% NEAR when up and 30% when down, moving at most a quarter of the vault per decision and nothing under 2%. With the optional Kronos-small forecast, forecast and trend must agree or it holds.</p>
    <dl className="kv">
      <dt>Desk spec</dt><dd className="mono">iron-trader-v1 · {spec ? <Hash h={spec.sha256} /> : "—"}</dd>
      <dt>Guide</dt><dd><Link href="/guides/demo-trader/" className="ext">How the desk works →</Link></dd>
    </dl>{proof}</>;
  else if (llm) body = <>
    <p>{e.model}, run by {e.harness}. Each tick it reads the reference price, the vault&apos;s limits and its own recent decisions, and answers buy, sell or hold. The vault checks every request against its limits before anything is signed.</p>
    <dl className="kv">
      <dt>Skill</dt><dd className="mono"><a href={`https://github.com/sledgit/sledgit/blob/main/agent/prompts/${arenaId}.md`} className="ext">{arenaId}</a> · {arena ? <Hash h={arena.sha256} /> : "—"}</dd>
      <dt>Recorded</dt><dd>{!recorded ? "no strategy hash in the snapshot: the runner's default prompt, on the operator's word"
        : named ? `the latest receipt uses ${named}` : <>an unpublished strategy hash: <Hash h={recorded} /></>}</dd>
    </dl>{proof}</>;
  else body = <p>{e.description}</p>;
  return (
    <section className="panel">
      <div className="ph"><span>Strategy</span><span className="r">{rule ? "open rules" : desk ? "desk spec" : llm ? "model + prompt" : e.kind}</span></div>
      <div className="pb strat">{body}</div>
    </section>);
}

type PolicyShape = { tokens?: { token: string; max_per_trade: string; max_per_day: string }[]; pairs?: { token_in: string; token_out: string; pool_id: number; min_price_num: string; min_price_den: string }[]; max_trades_per_hour?: number; max_slippage_bps?: number };

// The vault's limits, compact. The full read-out stays in the "Its rules" fold below.
function LimitsPanel({ n, v }: { n: NetworkConfig; v: VaultView }) {
  const p = v.policy as PolicyShape | undefined, c = v.config as Record<string, unknown> | undefined;
  const sym = (t: string) => n.tokens.find(x => x.id === t)?.symbol ?? t;
  const pools = [...new Set(p?.pairs?.map(x => x.pool_id) ?? [])];
  return (
    <section className="panel">
      <div className="ph"><span>Vault limits</span><span className="r">read from the vault</span></div>
      {p ? <dl className="kv">
        {p.tokens?.map(t => <Fragment key={t.token}><dt>{sym(t.token)}</dt><dd>up to {formatToken(n, t.token, t.max_per_trade)} a trade · {formatToken(n, t.token, t.max_per_day)} a day</dd></Fragment>)}
        <dt>Pairs</dt><dd>{p.pairs?.length ? `${[...new Set(p.pairs.flatMap(x => [sym(x.token_in), sym(x.token_out)]))].join(" ↔ ")} on Rhea pool ${pools.join(", ")}, with price floors` : "none"}</dd>
        <dt>Pace</dt><dd>{p.max_trades_per_hour} trades an hour · {(p.max_slippage_bps ?? 0) / 100}% max slippage</dd>
        <dt>Withdraw</dt><dd>owner only</dd>
        {c && <><dt>Trading</dt><dd className={c.frozen ? "down" : ""}>{c.frozen ? "frozen by the owner" : "open"}</dd></>}
      </dl> : <div className="empty">Limits could not be read</div>}
    </section>);
}

// Who and what is behind the vault, as read from the chain and the snapshot.
function IdentityPanel({ n, v, bot, e }: { n: NetworkConfig; v: VaultView; bot: Bot; e?: LeagueEntry }) {
  const c = v.config as Record<string, unknown> | undefined;
  const keys = e?.provenance.reason.match(/(\d+) access keys?/)?.[1];
  return (
    <section className="panel">
      <div className="ph"><span>Identity</span></div>
      <dl className="kv">
        <dt>Vault</dt><dd><AccountLink n={n} account={bot.account} /></dd>
        {c && <><dt>Owner</dt><dd><AccountLink n={n} account={String(c.owner_id)} /></dd>
          <dt>Agent</dt><dd className="mono">{String(c.agent_id)}</dd></>}
        <dt>Harness</dt><dd>{bot.harness}</dd>
        <dt>Model</dt><dd className="mono">{bot.model}</dd>
        <dt>Strategy hash</dt><dd>{e?.strategy_sha256 ? <Hash h={e.strategy_sha256} /> : "none recorded"}</dd>
        <dt>Access keys</dt><dd>{keys == null ? "not read" : keys === "0" ? "none (keyless vault)" : <span className="down">{keys}</span>}</dd>
        {c && <><dt>Contract</dt><dd className="mono">{String(c.version)}</dd></>}
      </dl>
    </section>);
}

// A vault's record page.
export function VaultRecord({ s, bot }: { s: LeagueState; bot: Bot }) {
  const home = networkOfBot(bot.id)!;
  if (s.network !== home.id) return <div className="record"><Link href="/leaderboard/" className="back">‹ Leaderboard</Link><h1>{bot.name}</h1><SwitchNetwork to={home.id} what={bot.name} /></div>;
  const n = home, v = s.vaults[bot.id], r = s.standings.find(x => x.botId === bot.id);
  const q = n.tokens[1]?.symbol ?? "";
  const match = v && v.value != null && Math.abs(v.value - v.replayValue) < 1e-6 * Math.max(1, v.value);
  return (
    <div className="record">
      <Link href="/leaderboard/" className="back">‹ Leaderboard</Link>
      <section className="record-head" style={{ "--c": bot.color } as React.CSSProperties}>
        <div>
          <h1><i style={{ background: bot.color }} />{bot.name}</h1>
          <p className="sub">{bot.description}</p>
          <p className="meta"><AccountLink n={n} account={bot.account} /></p>
        </div>
        <div className="record-score">
          <div className={`big ${dir(r?.vsHold ?? 0)}`}>{r ? pct(r.vsHold) : "—"}</div>
          <div className="meta">vs Hold 50/50 after gas · {n.id === "testnet" ? "testnet, not performance" : "past results"}</div>
          <div className="meta">{v ? `${num(v.value ?? v.replayValue)} ${q} now from ${num(v.deposited)} deposited` : "—"} · {r?.trades ?? 0} trades</div>
          {v?.league && <div className={`quip ${quip(v.league).tone}`}>{quip(v.league).text}</div>}
        </div>
      </section>
      <StatusBanner s={s} />
      {v?.league && v.league.series.length > 1 && <section className="panel">
        <div className="ph"><span>Value against holding</span><span className="r">hourly, at the reference price · hover a marker</span></div>
        <div className="pb"><EntryEquity e={v.league} /><Disclaimer /></div>
      </section>}
      <div className="grid g21">
        <div>
          {v?.league && <section className="panel">
            <div className="ph"><span>Trades on wNEAR / USDC</span><span className="r">reference price (Binance NEARUSDT) · hourly</span></div>
            <div className="pb"><TradeChart e={v.league} /><Disclaimer /></div>
          </section>}
          <section className="panel">
            <div className="ph"><span>Every decision</span><span className="r">tap one for its receipt · repeated holds folded</span></div>
            <DecisionFeed s={s} botId={bot.id} limit={50} />
          </section>
        </div>
        <div>
          {v?.league && <StrategyPanel e={v.league} />}
          {v && <LimitsPanel n={n} v={v} />}
          {v && <IdentityPanel n={n} v={v} bot={bot} e={v.league} />}
        </div>
      </div>
      {v?.league && <LeagueRecord e={v.league} />}
      {s.price != null && <PriceNote s={s} n={n} />}
      {v && <>
        <details className="fold" open>
          <summary>The record in numbers</summary>
          <dl className="kv">
            <dt>Deposited</dt><dd>{num(v.deposited)} {q} <span className="note">at the cutoff&apos;s reference price</span></dd>
            <dt>Value now</dt><dd>{num(v.value)} {q} <span className="note">vault + Rhea + Intents balances</span></dd>
            <dt>Rebuilt from events</dt><dd>{num(v.replayValue)} {q} <span className={match ? "up" : "down"}>{match ? "matches the balances" : v.value == null ? "balances not read" : "does not match the balances"}</span></dd>
            <dt>Funded position</dt><dd>{num(v.holdValue)} {q} <span className="note">its start holdings, never traded</span></dd>
            <dt>vs Hold 50/50</dt><dd className={dir(r?.vsHold ?? 0)}>{r ? pct(r.vsHold) : "—"} <span className="note">after gas</span></dd>
            <dt>Trades · refused</dt><dd>{r?.trades ?? 0} · {r?.refused ?? 0}</dd>
          </dl>
        </details>
        <details className="fold">
          <summary>Balances</summary>
          <div className="bal">
            <div className="bal-row bal-head"><span>Token</span><span>Vault</span><span>Rhea</span><span>Intents</span></div>
            {v.balances.map(b => <div key={b.token} className="bal-row"><span>{n.tokens.find(t => t.id === b.token)?.symbol}</span>
              <span>{formatToken(n, b.token, b.wallet)}</span><span>{formatToken(n, b.token, b.exchange)}</span><span>{formatToken(n, b.token, b.intents)}</span></div>)}
            {!v.balances.length && <div className="empty">Balances could not be read</div>}
          </div>
        </details>
        <details className="fold">
          <summary>Its rules, read from the vault</summary>
          <Policy n={n} v={v} />
        </details>
        <details className="fold">
          <summary>On-chain log · {v.events.length} events</summary>
          <div className="evlog">
            {[...v.events].reverse().map((e, i) => (
              <div key={`${e.receiptId}-${i}`} className="ev"><span className="ev-k">{e.event}</span>
                <span className="ev-d">{eventSummary(n, e)}</span>
                <span className="ev-t">{utc(e.time)} · <TxLink n={n} hash={e.txHash} /></span></div>))}
          </div>
        </details>
      </>}
    </div>);
}

type Check = { state: "wait" } | { state: "pass"; detail: string } | { state: "fail"; detail: string };

// Asks NEAR directly: is this event in the transaction it names, logged by this vault, with this request hash?
function useChainCheck(n: NetworkConfig, c: NonNullable<Decision["chain"]>, account?: string): Check {
  const [r, setR] = useState<Check>({ state: "wait" });
  useEffect(() => {
    let live = true;
    txEvents(n, c.txHash).then(({ events, errors }) => {
      const hit = events.find(e => e.executor === account && (c.seq == null || e.data.seq === c.seq) && (!c.receiptHash || e.data.receipt_hash === c.receiptHash));
      if (live) setR(hit ? { state: "pass", detail: `event #${String(hit.data.seq ?? "—")} logged by ${account}, request hash matches` }
        : { state: "fail", detail: errors[0] ?? `no matching event from ${account ?? "the vault"} in this transaction` });
    }, e => live && setR({ state: "fail", detail: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, [n, c.txHash, c.seq, c.receiptHash, account]);
  return r;
}

// Receipt for a decision read from NEAR: printed as a slip, stamped once this browser's own chain check passes.
export function ChainReceipt({ s, d, bot }: { s: LeagueState; d: Decision; bot?: Bot }) {
  const n = netOf(s)!, c = d.chain!;
  const check = useChainCheck(n, c, bot?.account);
  const amt = (t?: string, a?: string) => (t && a ? formatToken(n, t, a) : "—");
  const venue = c.venue ? VENUE_NAME[c.venue] ?? c.venue : "—";
  const no = d.kind === "refuse";
  const summary = d.kind === "trade" ? <>{bot?.name} swapped {amt(c.tokenIn, c.amountIn)} for {amt(c.tokenOut, c.amountOut)} on {venue}. The vault checked its rules first: passed.</>
    : no ? <>{bot?.name} asked for a trade the vault&apos;s rules don&apos;t allow. Refused with {c.code ?? "a rule"}; nothing was signed.</>
    : <>{bot?.name} decided not to trade: {d.reason}.</>;
  const stamp: { text: string; tone: StampTone } = check.state === "wait" ? { text: "Checking the chain…", tone: "wait" }
    : check.state === "fail" ? { text: "Not verified", tone: "no" } : no ? { text: "Refused · on chain", tone: "no" } : { text: "Verified on chain", tone: "ok" };
  const rows: ([React.ReactNode, React.ReactNode] | "hr")[] = [
    ["Agent", bot?.name ?? "—"], ["Seq", `#${c.seq ?? "—"}`], ["Time", utc(d.at)],
    ["Decision", no ? `REFUSED · ${c.code ?? "rule"}` : d.kind === "trade" ? `TRADE · ${d.side?.toUpperCase() ?? ""}` : "HOLD"],
    ...(d.kind === "trade" ? [["Sold", amt(c.tokenIn, c.amountIn)], ["Received", amt(c.tokenOut, c.amountOut)], ...(d.price != null ? [["Price", `${num(d.price)} ${n.tokens[1]?.symbol}/${n.tokens[0]?.symbol}`]] : []), ["Venue", venue]] as [string, string][] : []),
    ...(c.tokenIn && d.kind !== "trade" ? [["Asked", `${amt(c.tokenIn, c.amountIn)}${c.tokenOut ? ` → ${n.tokens.find(t => t.id === c.tokenOut)?.symbol ?? c.tokenOut}` : ""}`]] as [string, string][] : []),
    ...(no ? [["Why", d.reason]] as [string, string][] : []),
    "hr",
    ["Tx", <a key="tx" href={explorerTx(n, c.txHash)} target="_blank" rel="noreferrer">{short(c.txHash, 8)} ↗</a>],
    ["Request", c.receiptHash ? short(c.receiptHash, 8) : "—"],
    ["Chain check", <span key="ck" className={check.state === "pass" ? "ok" : check.state === "fail" ? "no" : ""}>{check.state === "wait" ? "asking NEAR…" : check.state === "pass" ? "✓ passed" : "✗ failed"}</span>],
  ];
  return (
    <div className="prose" style={{ maxWidth: 980 }}>
      <Link href={bot ? `/agents/${bot.id}/` : "/leaderboard/"} className="back">‹ {bot ? bot.name : "Leaderboard"}</Link>
      <div className="rcpt-row" style={{ alignItems: "start" }}>
        <div>
          <span className="badge">{n.label.toUpperCase()} RECEIPT · #{c.seq ?? "—"}</span>
          <h2 className="summary" style={{ marginTop: 10 }}>{summary}</h2>
          <p className="note">{check.state === "pass" ? `Checked from this browser: ${check.detail}.` : check.state === "fail" ? `Chain check failed: ${check.detail}.` : `Asking ${n.label} for this transaction…`}</p>
        </div>
        <Paper title="Sledgit receipt" sub={`${n.label} · on-chain decision`} rows={rows} foot={`Vault ${bot ? short(bot.account, 14) : "—"}`} stamp={stamp} />
      </div>
      <dl className="kv">
        <dt>NEAR tx</dt><dd><TxLink n={n} hash={c.txHash} full /></dd>
        <dt>Block time</dt><dd>{utc(d.at)}</dd>
        {no && <><dt>Refusal code</dt><dd className="mono down">{c.code ?? "—"}</dd><dt>Reason</dt><dd>{d.reason}</dd></>}
        <dt>Request hash</dt><dd className="mono">{c.receiptHash ?? "—"}</dd>
        <dt>Receipt id</dt><dd className="mono">{c.receiptId}</dd>
        <dt>Vault</dt><dd>{bot ? <AccountLink n={n} account={bot.account} /> : "—"}</dd>
      </dl>
      <h3>Check it yourself</h3>
      <pre>{`$ curl -s -X POST ${n.txApi}/v0/transactions \\
    -H 'content-type: application/json' \\
    -d '{"tx_hashes":["${c.txHash}"]}'`}</pre>
      <p className="note">The vault&apos;s log in that transaction carries this event as EVENT_JSON (event standard <code>sledgit</code>; testnet vaults deployed before the rename use <code>irontrade</code>).{n.id === "testnet" && " Testnet: real transactions, test tokens; prices are not real markets."}</p>
    </div>);
}

const utcMin = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const pctOr = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);

// What the leaderboard reader established for this vault: proof, result against each benchmark, costs, ranking.
function LeagueRecord({ e }: { e: LeagueEntry }) {
  const proven = e.proof.tier, claimed = e.proof.claimed;
  const flags = flagsFor(e.id);
  const L = leagueOf(e.id), S = L!.season;
  return (
    <section className="panel">
      <div className="ph"><span>Proof and result</span><span className="r"><Pill p={proven} /></span></div>
      <dl className="kv">
        <dt>Proof</dt><dd>{e.proof.detail}{proven !== claimed && <span className="down"> · claims {claimed}, proven {proven}</span>}</dd>
        <dt>Vault</dt><dd>{e.provenance.status === "genuine" ? "genuine factory vault" : e.provenance.status} · <span className="note">{e.provenance.reason}</span></dd>
        {e.strategy_sha256 && <><dt>Strategy hash</dt><dd className="mono">{e.strategy_sha256}</dd></>}
        <dt>Season</dt><dd>{S.id}, from {utcMin(S.start_ms)} UTC for every entry · {e.start ? `scored from ${utcMin(e.start.time_ms)} UTC` : "not started"}{e.season_seqs ? ` · decisions #${e.season_seqs[0]}–#${e.season_seqs[1]}` : ""} · {e.days.toFixed(1)} days at the ${S.min_value_usd} USD minimum{e.inactive ? " · inactive (below the minimum)" : ""} <span className="note">earlier decisions are history: listed, not scored</span></dd>
        <dt>Return</dt><dd>{pctOr(e.twr)} <span className="note">time-weighted, at the reference price</span></dd>
        <dt>vs Hold 50/50</dt><dd>{pctOr(e.vs_hold)} · after gas {pctOr(e.vs_hold_after_gas)} · 95% range {e.range95 ? `${pctOr(e.range95.lo)} to ${pctOr(e.range95.hi)} (${e.range95.n} hourly steps)${e.beyond_noise ? ", beyond noise" : ", within noise"}` : "not enough data yet"}</dd>
        <dt>vs Stake &amp; hold</dt><dd>{pctOr(e.vs_stake)} <span className="note">computed, assumed APR</span></dd>
        <dt>vs its funded position</dt><dd>{pctOr(e.vs_funded)} <span className="note">its own start holdings, never traded: did trading help?</span></dd>
        <dt>Fill vs reference</dt><dd>{e.costs.traded_ref_usd > 0 ? `${e.costs.fill_vs_reference_usd.toFixed(4)} USD (${pctOr(e.costs.fill_vs_reference_pct)} of ${e.costs.traded_ref_usd.toFixed(4)} traded)` : "no trades"} {L?.network === "testnet" && <span className="note">testnet pools price far from the reference</span>}{e.costs.neutralised_usd > 0 ? <span className="down"> · {e.costs.neutralised_usd.toFixed(4)} USD of fills above the reference neutralised as owner money</span> : null}</dd>
        <dt>Gas</dt><dd>{e.costs.gas_near.toFixed(6)} NEAR ({e.costs.gas_usd.toFixed(4)} USD), paid by the agent account</dd>
        <dt>Decisions</dt><dd>{e.counts.decisions} · {e.counts.trades} trades · {e.counts.skips} holds · {e.counts.refusals} refused{e.counts.off_schedule ? ` · ${e.counts.off_schedule} off schedule` : ""}{e.counts.missed_slots ? ` · ${e.counts.missed_slots} missed slots` : ""}</dd>
        {Object.keys(e.refusals_by_code).length > 0 && <><dt>Refusals by code</dt><dd className="mono">{Object.entries(e.refusals_by_code).map(([k, n]) => `${k} ×${n}`).join(" · ")}</dd></>}
        <dt>Rank</dt><dd>{e.ranked ? "ranked" : e.unranked_reason}</dd>
        {flags.length > 0 && <><dt>Reader flags</dt><dd>{flags.map(f => <div key={`${f.kind}:${f.text}`} className={f.severity === "unrank" ? "guard" : "note"}>{f.severity === "unrank" ? "unranked: " : ""}{f.text}{f.ids.length > 1 ? ` (also ${f.ids.filter(x => x !== e.id).join(", ")})` : ""}</div>)}</dd></>}
      </dl>
    </section>);
}
