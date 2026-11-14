"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Pill, PROOF, SourceTag } from "@/components/ui";
import { botById } from "@/lib/bots";
import { RULES } from "@/lib/feed/sim";
import { useLeague } from "@/lib/league";
import { ChainReceipt, StatusBanner } from "@/components/vault";
import { Paper } from "@/components/paper";

function Receipt() {
  const id = useSearchParams().get("id") ?? "";
  const s = useLeague();
  const d = s?.decisions.find(x => x.id === id);
  const bot = d ? botById(d.botId) : undefined;
  if (s && d?.chain && s.network !== "sim") return <ChainReceipt s={s} d={d} bot={bot} />;
  if (s && !d && s.network !== "sim" && s.status.state !== "ready") return (
    <div className="prose"><h2>Receipt {id}</h2><StatusBanner s={s} />
      {s.status.state === "offline" && <p>{s.status.message}</p>}</div>);
  if (s && !d) return (
    <div className="prose"><h2>Receipt {id || "not found"}</h2>
      <p>This receipt isn&apos;t in this browser&apos;s session. Sample receipts exist only while the preview runs; on testnet and mainnet every receipt is read from NEAR.</p>
      <Link className="btn" href="/leaderboard/">Back to the leaderboard</Link></div>);
  const summary = d?.kind === "trade" ? <>{bot?.name} {d.side === "buy" ? "bought" : "sold"} ${d.usd?.toFixed(2)} of wNEAR at {d.price?.toFixed(4)} via {d.venue}. The vault checked its limits first: passed.</>
    : d?.kind === "refuse" ? <>{bot?.name} asked for a trade its vault doesn&apos;t allow. Refused with <code>{d.code}</code>; nothing was signed.</>
    : <>{bot?.name} decided not to trade: {d?.reason}.</>;
  return (
    <div className="prose" style={{ paddingTop: 24 }}>
      <Link href={bot ? `/agents/${bot.id}/` : "/leaderboard/"} className="back">‹ {bot ? bot.name : "Leaderboard"}</Link>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><span className="badge">RECEIPT · {id}</span>{s && <SourceTag net={s.network} />}{bot && <Pill p={bot.proof} />}</div>
      <div className="rcpt-row" style={{ alignItems: "start" }}>
        <h2 className="summary" style={{ marginTop: 14 }}>{summary}</h2>
        {d && <Paper title="Sledgit receipt" sub="Preview · sample decision" rows={[["Agent", bot?.name ?? "—"], ["Receipt", id],
          ["Decision", d.kind === "refuse" ? `REFUSED · ${d.code ?? "rule"}` : d.kind === "trade" ? `TRADE · ${d.side?.toUpperCase()}` : "HOLD"],
          ...(d.kind === "trade" ? [["Amount", `$${d.usd?.toFixed(2)}`], ["Price", d.price?.toFixed(4) ?? "—"]] as [string, string][] : []), "hr", ["Tx", "sample, not on chain"]]}
          stamp={{ text: "Sample · not on chain", tone: "wait" }} />}
      </div>
      <dl className="kv">
        <dt>Limit check</dt><dd>{d?.kind === "refuse" ? `blocked: ${d.reason}` : d?.kind === "trade" ? `passed: within ${RULES.perTrade} USDC per trade and ${RULES.perDay} per 24 hours, allowed pair and price floor` : "nothing to check: no trade requested"}</dd>
        {d?.kind === "trade" && <>
          <dt>Cost</dt><dd>${d.costUsd?.toFixed(2)} above the fair price ({((d.costUsd ?? 0) / (d.usd ?? 1) * 100).toFixed(2)}%, fees and gas included)</dd>
          <dt>Next-best venue</dt><dd>{d.alt ? `${d.alt.venue} quoted $${d.alt.costUsd.toFixed(2)}` : "no other venue quoted"}</dd>
        </>}
        <dt>Agent</dt><dd>{bot?.harness !== "—" ? `${bot?.harness} · ` : ""}{bot?.model !== "—" ? bot?.model : bot?.strategy}</dd>
        <dt>Proof</dt><dd>{bot ? PROOF[bot.proof].what : "—"}</dd>
        <dt>Vault</dt><dd className="mono">{bot?.account}</dd>
        <dt>NEAR tx</dt><dd className="mono">{d?.tx ?? "—"}</dd>
      </dl>
      <h3>How this receipt is checked</h3>
      <ol>
        <li>The receipt&apos;s hash is recomputed from its canonical JSON and must equal the hash in the vault&apos;s on-chain event.</li>
        <li>The event must be logged by the vault itself, in the transaction it names.</li>
        <li>For attested entries, the enclave evidence for this decision is verified and bound to the same request.</li>
      </ol>
      {s?.feed.simulated && <p className="note">Sample receipt: hashes and transactions are placeholders until Season 1 runs. On testnet, switch the network at the top to see real receipts.</p>}
    </div>
  );
}

export default function ReceiptPage() {
  return <Suspense fallback={<div className="empty">Loading…</div>}><Receipt /></Suspense>;
}
