"use client";
// One transaction: exactly what will be signed, then the wallet. Nothing is sent without this preview on screen.
import { useEffect, useState, useSyncExternalStore } from "react";
import { explorerTx, type NetworkConfig } from "@/lib/networks";
import type { PlannedTx } from "@/lib/owner/tx";
import { formatUnits } from "@/lib/owner/units";
import { ownerWallet, type OwnerWallet, type SendResult } from "@/lib/owner/wallet";
import s from "./owner.module.css";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The connected wallet for a network, kept in sync with the selector's store. */
export function useOwnerWallet(network: "testnet" | "mainnet" | null): { wallet: OwnerWallet | null; account: string | null; error?: string } {
  const [wallet, setWallet] = useState<OwnerWallet | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!network) return;
    let live = true;
    ownerWallet(network).then(w => { if (live) setWallet(w); }, e => { if (live) setError(err(e)); });
    return () => { live = false; };
  }, [network]);
  const account = useSyncExternalStore(
    cb => (wallet ? wallet.subscribe(cb) : () => {}),
    () => wallet?.accountId ?? null,
    () => null,
  );
  return { wallet, account, error };
}

export function WalletBar({ wallet, account, error }: { wallet: OwnerWallet | null; account: string | null; error?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  if (error) return <p className="callout">Wallet unavailable: {error}</p>;
  if (!wallet) return <p className="muted">Loading wallets…</p>;
  const act = (f: () => Promise<void>) => { setBusy(true); setMsg(undefined); f().catch(e => setMsg(err(e))).finally(() => setBusy(false)); };
  return (
    <div className={s.row} aria-live="polite">
      {account ? <>
        <span className="tag testnet">Connected</span><span className={s.mono}>{account}</span>
        <button className="btn sm" disabled={busy} onClick={() => act(() => wallet.signOut())}>Disconnect</button>
      </> : <>
        <span className="muted">Connect a wallet:</span>
        {wallet.wallets.map(w => <button key={w.id} className="btn sm" disabled={busy} onClick={() => act(() => wallet.signIn(w.id))}>{w.name}</button>)}
      </>}
      {msg && <span className={s.bad}>{msg}</span>}
    </div>);
}

export function TxCard({ plan, wallet, net, label = "Sign in wallet", disabled, onDone }: {
  plan: PlannedTx; wallet: OwnerWallet | null; net: NetworkConfig; label?: string; disabled?: string; onDone?: (r: SendResult) => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | SendResult>("idle");
  const send = async () => {
    if (!wallet) return;
    setState("sending");
    const r = await wallet.send(plan);
    setState(r);
    onDone?.(r);
  };
  const deposit = plan.depositYocto === 0n ? "0" : `${plan.depositYocto} yoctoNEAR (${formatUnits(plan.depositYocto, 24)} NEAR)`;
  if (!disabled && !wallet?.accountId) disabled = "connect a wallet to sign";
  return (
    <div className={s.tx} data-tx={plan.methodName}>
      <p className={s.title}>{plan.title}</p>
      <dl>
        <dt>contract</dt><dd>{plan.receiverId}</dd>
        <dt>method</dt><dd>{plan.methodName}</dd>
        <dt>deposit</dt><dd>{deposit}</dd>
        <dt>gas</dt><dd>{plan.gasTgas} Tgas</dd>
      </dl>
      <pre data-args>{JSON.stringify(plan.args, null, 2)}</pre>
      <div className={s.row}>
        <button className="btn primary sm" disabled={!wallet || !!disabled || state === "sending"} onClick={send}>{state === "sending" ? "Waiting for wallet…" : label}</button>
        {disabled && <span className="muted">{disabled}</span>}
        {typeof state === "object" && (state.ok
          ? <span className={s.ok}>{state.redirected ? "Sent to the wallet" : "Done"}{state.hash && <> · <a href={explorerTx(net, state.hash)} target="_blank" rel="noreferrer">{state.hash.slice(0, 10)}…</a></>}</span>
          : <span className={s.bad}>Failed: {state.error}{state.hash && <> · <a href={explorerTx(net, state.hash)} target="_blank" rel="noreferrer">tx</a></>}</span>)}
      </div>
    </div>);
}
