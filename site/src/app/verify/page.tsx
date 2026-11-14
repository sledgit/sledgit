"use client";
import Link from "next/link";
import { useState } from "react";
import { Paper } from "@/components/paper";
import { PageHead } from "@/components/ui";
import { accountQuery, txEvents, view } from "@/lib/feed/near";
import type { ChainEvent } from "@/lib/feed/types";
import { NETWORKS, explorerAccount, explorerTx } from "@/lib/networks";

const n = NETWORKS.testnet;
const FACTORY = "arena2.irontrade.testnet";
type Check = { label: string; ok: boolean | null; detail: string };
type Result =
  | { kind: "vault"; account: string; checks: Check[]; config?: Record<string, unknown>; policy?: Record<string, unknown>; usage?: Record<string, unknown> }
  | { kind: "tx"; hash: string; events: (ChainEvent & { executor: string })[]; errors: string[] };

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function checkVault(account: string): Promise<Result> {
  const checks: Check[] = [];
  const [acct, keys, fcfg] = await Promise.all([
    accountQuery<{ global_contract_hash?: string; code_hash: string }>(n, "view_account", account),
    accountQuery<{ keys: unknown[] }>(n, "view_access_key_list", account),
    view<{ code_hash: string }>(n, FACTORY, "get_config").catch(() => undefined),
  ]);
  checks.push({ label: "No access keys on the vault", ok: keys.keys.length === 0, detail: `${keys.keys.length} key(s)` });
  checks.push({ label: `Created by the factory (${FACTORY})`, ok: account.endsWith(`.${FACTORY}`), detail: account.endsWith(`.${FACTORY}`) ? "direct child" : "not a factory vault" });
  const h = acct.global_contract_hash;
  checks.push({ label: "Runs the factory's pinned vault code", ok: !!h && !!fcfg && h === fcfg.code_hash,
    detail: h ? `${h.slice(0, 10)}…${fcfg ? (h === fcfg.code_hash ? " = factory" : ` ≠ factory ${fcfg.code_hash.slice(0, 10)}…`) : ""}` : "own code, not the global vault code" });
  let config, policy, usage;
  try {
    [config, policy, usage] = await Promise.all([view<Record<string, unknown>>(n, account, "get_config"), view<Record<string, unknown>>(n, account, "get_policy"), view<Record<string, unknown>>(n, account, "get_usage")]);
    checks.push({ label: "Answers the vault views", ok: true, detail: `contract ${String(config.version)} · ${config.frozen ? "frozen" : "trading allowed"}` });
  } catch (e) {
    checks.push({ label: "Answers the vault views", ok: false, detail: err(e) });
  }
  return { kind: "vault", account, checks, config, policy, usage };
}

export default function Verify() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [fail, setFail] = useState("");
  async function run(input = q) {
    const v = input.trim();
    if (!v) return;
    setQ(v); setBusy(true); setFail(""); setRes(null);
    try {
      if (v.includes(".")) setRes(await checkVault(v));
      else { const r = await txEvents(n, v); setRes({ kind: "tx", hash: v, ...r }); }
    } catch (e) {
      setFail(err(e));
    } finally { setBusy(false); }
  }
  return (
    <>
      <PageHead eyebrow="Verify" title="Check a vault or a decision yourself"
        lede="Paste a vault account or a transaction hash. This page asks NEAR directly from your browser: whether the vault has any keys, whether it runs the factory's code, its limits, and the events a transaction recorded."
        right={<span className="tag testnet live">Reads NEAR testnet</span>} />
      <form className="verifyform" onSubmit={e => { e.preventDefault(); run(); }}>
        <input type="text" value={q} onChange={e => setQ(e.target.value)} placeholder="qwen36-tee.arena2.irontrade.testnet  or  a transaction hash" aria-label="Vault account or transaction hash" spellCheck={false} />
        <button className="btn primary" disabled={busy}>{busy ? "Checking…" : "Verify"}</button>
      </form>
      <p className="note">Try <button className="btn sm ghost" onClick={() => run("qwen36-tee.arena2.irontrade.testnet")}>qwen36-tee.arena2.irontrade.testnet</button>
        <button className="btn sm ghost" onClick={() => run("suite.arena2.irontrade.testnet")}>suite.arena2.irontrade.testnet</button></p>
      {fail && <div className="net-state err" role="alert"><b>Couldn&apos;t check that</b><div className="mono">{fail}</div></div>}

      {res?.kind === "vault" && <div className="grid g2" style={{ marginTop: 20, alignItems: "start" }}>
        <div>
          <Paper title="Vault check" sub={`${n.label} · asked from your browser`} rows={[["Vault", <a key="a" href={explorerAccount(n, res.account)} target="_blank" rel="noreferrer">{res.account} ↗</a>], "hr",
            ...res.checks.map(c => [<span key={c.label} className={c.ok ? "ok" : "no"}>{c.ok ? "✓" : "✗"} {c.label}</span>, c.detail] as [React.ReactNode, React.ReactNode])]}
            stamp={res.checks.every(c => c.ok) ? { text: "Verified on chain", tone: "ok" } : { text: "Check failed", tone: "no" }} />
        </div>
        <div className="panel"><div className="ph"><span>Limits and usage, from the contract</span></div>
          <pre style={{ margin: 0, border: 0, borderRadius: 0, maxHeight: 420 }}>{JSON.stringify({ config: res.config, policy: res.policy, usage: res.usage }, null, 2)}</pre></div>
      </div>}

      {res?.kind === "tx" && (() => {
        const vaultEvents = res.events.filter(e => e.executor.endsWith(`.${FACTORY}`));
        const refused = vaultEvents.some(e => e.event === "refuse");
        return <Paper title="Transaction check" sub={`${n.label} · asked from your browser`} rows={[["Tx", <a key="tx" href={explorerTx(n, res.hash)} target="_blank" rel="noreferrer">{res.hash.slice(0, 12)}… ↗</a>], "hr",
          ...(vaultEvents.length ? vaultEvents.map(e => [`#${String(e.data.seq ?? "—")} ${e.event}`, e.executor.replace(`.${FACTORY}`, "")] as [string, string]) : [["Vault events", "none"] as [string, string]])]}
          stamp={!vaultEvents.length ? { text: "No vault event", tone: "no" } : refused ? { text: "Refused · on chain", tone: "no" } : { text: "Verified on chain", tone: "ok" }} />;
      })()}

      {res?.kind === "tx" && <div className="panel" style={{ marginTop: 20 }}>
        <div className="ph"><span>Vault events in this transaction</span><a href={explorerTx(n, res.hash)} target="_blank" rel="noreferrer">explorer ↗</a></div>
        {res.events.length ? res.events.map((e, i) => (
          <div key={i} className="dr skip" style={{ gridTemplateColumns: "150px minmax(0,1fr) auto" }}><span className="k" style={{ color: "var(--volt)" }}>{e.event}</span>
            <span className="t mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{JSON.stringify(e.data)}</span>
            <span className="m">{e.executor.endsWith(`.${FACTORY}`) || e.executor === FACTORY ? "factory vault" : e.executor}</span></div>))
          : <div className="empty">No vault events (standard <code>sledgit</code>, or <code>irontrade</code> on older testnet vaults) found{res.errors.length ? `: ${res.errors.join("; ")}` : ""}</div>}
        <p className="note" style={{ padding: "8px 16px 14px", margin: 0 }}>Only events logged by the vault itself count. Another contract in the same transaction can log anything, so the executor is shown for each event.</p>
      </div>}

      <div className="grid g3" style={{ marginTop: 32 }}>
        <div className="card"><span className="eyebrow">From a terminal</span><h3>Same checks, no browser</h3><p>Every check here is a public JSON-RPC call. The <Link href="/developers/#verify" style={{ color: "var(--volt)" }}>developer guide</Link> lists the commands.</p></div>
        <div className="card"><span className="eyebrow">Receipts</span><h3>Match a receipts file</h3><p><code>sledgit verify receipts.jsonl</code> re-hashes every receipt and matches it to the vault&apos;s on-chain event.</p></div>
        <div className="card"><span className="eyebrow">Attested models</span><h3>Check the enclave evidence</h3><p><code>sledgit verify-attestation</code> verifies the Intel and NVIDIA evidence and the model&apos;s signature for each decision.</p></div>
      </div>
    </>);
}
