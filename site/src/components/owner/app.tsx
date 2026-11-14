"use client";
// The owner app's frame: network gate, wallet, return from redirect wallets, and the two views.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { setNetwork, useLeague } from "@/lib/league";
import { explorerTx } from "@/lib/networks";
import { OWNER_NETS, type OwnerNet } from "@/lib/owner/config";
import { ownedVaults } from "@/lib/owner/chain";
import { walletReturn } from "@/lib/owner/wallet";
import { CreateVault } from "./create";
import { ManageVault } from "./manage";
import { useOwnerWallet, WalletBar } from "./tx-card";
import s from "./owner.module.css";

function useOwnerNet(): OwnerNet | "sim" | null {
  const st = useLeague();
  if (!st) return null;
  return st.network === "sim" ? "sim" : OWNER_NETS[st.network];
}

function Returned({ on }: { on: OwnerNet }) {
  const [r, setR] = useState<ReturnType<typeof walletReturn>>();
  useEffect(() => {
    const x = walletReturn(location.search);
    if (!x.hashes.length && !x.error) return;
    setR(x);
    const u = new URL(location.href);
    ["transactionHashes", "errorCode", "errorMessage", "account_id", "public_key", "all_keys"].forEach(k => u.searchParams.delete(k));
    history.replaceState(history.state, "", u);
  }, []);
  if (!r) return null;
  return <p className="callout blue">{r.error ? <>Nothing was signed: {r.error}.</>
    : <>The wallet sent {r.hashes.length} transaction{r.hashes.length > 1 ? "s" : ""}: {r.hashes.map(h => <a key={h} href={explorerTx(on.net, h)} target="_blank" rel="noreferrer"> {h.slice(0, 10)}…</a>)}</>}</p>;
}

function Gate({ children }: { children: (on: OwnerNet) => React.ReactNode }) {
  const on = useOwnerNet();
  if (on === null) return <p className="muted">Loading…</p>;
  if (on === "sim") return <div className="callout">The owner app works on a real network. Preview mode is simulated data.
    <div className={s.row}><button className="btn primary sm" onClick={() => setNetwork("testnet")}>Switch to testnet</button></div></div>;
  // Testnet practice only. Mainnet onboarding is the skill file and the owner's own wallet, never a button here.
  if (on.id !== "testnet" || !on.factory) return <div className="callout">The vault app is testnet practice. On {on.net.label}, point your agent at <a href="/skill.md">sledgit.com/SKILL.md</a>; you sign in your own wallet.
    <div className={s.row}><button className="btn sm" onClick={() => setNetwork("testnet")}>Practise on testnet</button></div></div>;
  return <>{children(on)}</>;
}

export function VaultHome() {
  return <Gate>{on => <Home on={on} />}</Gate>;
}

function Home({ on }: { on: OwnerNet }) {
  const w = useOwnerWallet(on.id);
  const [mine, setMine] = useState<{ vaults: string[]; unreadable: string[] } | string>();
  useEffect(() => {
    if (!w.account || !on.factory) return;
    setMine(undefined);
    ownedVaults(on.net, on.factory, w.account).then(setMine, e => setMine(e instanceof Error ? e.message : String(e)));
  }, [w.account, on]);
  return (<>
    <Returned on={on} />
    <div className={s.box}><h3>Wallet · {on.net.label}</h3><WalletBar {...w} /></div>
    {w.account && <div className={s.box} style={{ marginTop: 16 }}><h3>Your vaults</h3>
      {mine === undefined ? <p className="muted">Reading the factory…</p>
        : typeof mine === "string" ? <p className={s.bad}>Could not list vaults: {mine}</p>
        : mine.vaults.length === 0 ? <p className="muted">None yet from {on.factory}.</p>
        : <ul className={s.list}>{mine.vaults.map(v => <li key={v}><span className={s.mono}>{v}</span><Link className="btn sm" href={`/vault/manage/?v=${encodeURIComponent(v)}`}>Manage</Link></li>)}</ul>}
      {typeof mine === "object" && mine.unreadable.length > 0 && <p className="muted">{mine.unreadable.length} vault(s) didn&apos;t answer and aren&apos;t listed.</p>}
    </div>}
    <div style={{ marginTop: 16 }}><CreateVault on={on} wallet={w.wallet} account={w.account} /></div>
  </>);
}

export function VaultManage() {
  const q = useSearchParams();
  const vault = (q.get("v") ?? "").trim();
  return <Gate>{on => {
    const ok = !!on.factory && /^[a-z0-9-]{2,32}$/.test(vault.slice(0, -(on.factory.length + 1))) && vault.endsWith(`.${on.factory}`);
    return ok ? <Manage on={on} vault={vault} />
      : <p className="callout">“{vault || "(none)"}” isn&apos;t a vault from {on.factory}. <Link href="/vault/">Back to your vaults</Link></p>;
  }}</Gate>;
}

function Manage({ on, vault }: { on: OwnerNet; vault: string }) {
  const w = useOwnerWallet(on.id);
  return (<>
    <Returned on={on} />
    <div className={s.box} style={{ marginBottom: 16 }}><h3>Wallet · {on.net.label}</h3><WalletBar {...w} /></div>
    <ManageVault on={on} vault={vault} wallet={w.wallet} account={w.account} />
  </>);
}
