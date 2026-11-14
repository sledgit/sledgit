"use client";
// One vault: its state, funding, the agent's key, limits, freeze, withdraw and the owner's escape hatches.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { explorerAccount } from "@/lib/networks";
import { leagueFor } from "@/lib/feed/league-data";
import type { OwnerNet } from "@/lib/owner/config";
import { capRoom, type DepositCap } from "@/lib/owner/caps";
import * as chain from "@/lib/owner/chain";
import { buildPolicy, describePolicy, diffPolicy, formFromPolicy, type PolicyArgs, type PolicyForm } from "@/lib/owner/policy";
import * as T from "@/lib/owner/tx";
import { formatUnits, parseUnits } from "@/lib/owner/units";
import type { OwnerWallet } from "@/lib/owner/wallet";
import { AgentFindings, PolicyFields, useAgentCheck } from "./create";
import { TxCard } from "./tx-card";
import s from "./owner.module.css";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Display only: NEAR to 4 places, rounded down. Never used for anything that is signed. */
const roughNear = (y: bigint) => formatUnits((y / 10n ** 20n) * 10n ** 20n, 24);

interface State {
  config: chain.VaultConfig; policy: PolicyArgs; pending: chain.Pending | null; inFlight: unknown; intents: unknown;
  account: chain.AccountView; keys: number; wrapBal: bigint; quoteBal: bigint;
  reg: { wrap: boolean; quote: boolean; ownerWrap: boolean; exchange: boolean; exchangeTokens: boolean };
  deposits: Record<string, string>;
  caps: DepositCap[] | null;
}

async function load(on: OwnerNet, vault: string): Promise<State> {
  const n = on.net;
  const [config, policy, pending, inFlight, intents, account, keys, wrapBal, quoteBal, regWrap, regQuote, exchange] = await Promise.all([
    chain.vaultConfig(n, vault), chain.vaultPolicy(n, vault), chain.vaultPending(n, vault), chain.vaultInFlight(n, vault),
    chain.vaultIntents(n, vault), chain.accountView(n, vault), chain.accessKeys(n, vault),
    chain.ftBalance(n, on.wrap.id, vault), chain.ftBalance(n, on.quote.id, vault),
    chain.ftRegistered(n, on.wrap.id, vault), chain.ftRegistered(n, on.quote.id, vault), chain.exchangeStorage(n, vault),
  ]);
  const caps = await chain.vaultDepositCaps(n, vault);
  const deposits = exchange ? await chain.exchangeDeposits(n, vault) : {};
  // Funding is signed by the owner, so it's the owner's wNEAR registration that matters, whoever is viewing.
  const ownerWrap = await chain.ftRegistered(n, on.wrap.id, config.owner_id);
  const exchangeTokens = exchange && policy.tokens.every(t => t.token in deposits);
  return { config, policy, pending, inFlight, intents, account, keys, wrapBal, quoteBal,
    reg: { wrap: regWrap, quote: regQuote, ownerWrap, exchange, exchangeTokens }, deposits, caps };
}

export function ManageVault({ on, vault, wallet, account }: { on: OwnerNet; vault: string; wallet: OwnerWallet | null; account: string | null }) {
  const [st, setSt] = useState<State>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(() => { load(on, vault).then(x => { setSt(x); setError(undefined); }, e => setError(err(e))); }, [on, vault]);
  useEffect(refresh, [refresh]);

  if (error) return <p className="callout">Could not read {vault}: {error}</p>;
  if (!st) return <p className="muted">Reading {vault} from {on.net.label}…</p>;
  const isOwner = !!account && account === st.config.owner_id;
  const isProposed = !!account && account === st.config.proposed_owner;
  const ownerOnly = isOwner ? undefined : "only the owner can sign this";
  const card = (plan: T.PlannedTx, disabled?: string, label?: string) =>
    <TxCard key={plan.methodName + JSON.stringify(plan.args)} plan={plan} wallet={wallet} net={on.net} disabled={disabled} label={label} onDone={r => { if (r.ok) setTimeout(refresh, 3000); }} />;
  const desc = describePolicy(st.policy, [on.wrap, on.quote]);
  const entry = leagueFor(on.id)?.entries.find(e => e.account === vault);

  return (<>
    <div className={s.grid}>
      <div className={s.box}>
        <h3>Vault</h3>
        <dl className="kv">
          <dt>Account</dt><dd><a href={explorerAccount(on.net, vault)} target="_blank" rel="noreferrer">{vault}</a></dd>
          <dt>Owner</dt><dd>{st.config.owner_id}{isOwner && " (you)"}</dd>
          <dt>Agent</dt><dd>{st.config.agent_id}</dd>
          <dt>Status</dt><dd>{st.config.frozen ? <b className={s.bad}>Frozen</b> : <span className={s.ok}>Trading allowed</span>}</dd>
          <dt>Access keys</dt><dd>{st.keys === 0 ? "0 (keyless)" : <b className={s.bad}>{st.keys}: not a keyless vault</b>}</dd>
          <dt>Balances</dt><dd>{formatUnits(st.wrapBal, on.wrap.decimals)} {on.wrap.symbol} · {formatUnits(st.quoteBal, on.quote.decimals)} {on.quote.symbol} · {roughNear(BigInt(st.account.amount))} NEAR</dd>
          <dt>Decisions</dt><dd>{st.config.seq} recorded · {entry ? <Link href={`/agents/${entry.id}/`}>record</Link> : <Link href={`/verify/?q=${encodeURIComponent(vault)}`}>verify</Link>}</dd>
        </dl>
        {!isOwner && <p className="callout">{account ? `You are signed in as ${account}, not the owner: owner actions are shown but can't be signed.` : "Connect the owner's wallet to sign owner actions."}</p>}
        {isProposed && <>{card(T.acceptOwner(vault), undefined, "Accept ownership")}</>}
      </div>
      <div className={s.box}>
        <h3>Limits</h3>
        <ul className={s.list}>{desc.caps.map(c => <li key={c.symbol}><span>{c.symbol}</span><span className={s.mono}>{c.trade} per trade · {c.day} per 24 h</span></li>)}
          {desc.bands.map(b => <li key={b}><span className={s.mono}>{b}</span></li>)}
          <li><span>Rate</span><span className={s.mono}>{st.policy.max_trades_per_hour} trades per hour · slippage ≤ {st.policy.max_slippage_bps} bps</span></li></ul>
        {st.pending && <PendingPolicy on={on} cur={st.policy} p={st.pending} vault={vault} card={card} ownerOnly={ownerOnly} />}
      </div>
    </div>

    <Fund on={on} st={st} vault={vault} owner={st.config.owner_id} card={card} ownerOnly={ownerOnly} />

    <div className={s.grid} style={{ marginTop: 16 }}>
      <div className={s.box}>
        <h3>The agent&apos;s key</h3>
        <p className="muted">The agent signs with a function-call key that can only call this vault&apos;s agent methods. This site never creates or holds that key: the agent&apos;s operator runs this once, on their machine.</p>
        <pre className={s.cmd}>{T.agentKeyCommand(st.config.agent_id, vault, on.id)}</pre>
        <p className="muted">Fund the agent account with about 1 NEAR for gas, then load <a href="/skill.md">skill.md</a> into the agent. <span className="btn sm" aria-disabled>Pick an agent: coming soon</span></p>
        <AgentChange on={on} vault={vault} owner={st.config.owner_id} card={card} ownerOnly={ownerOnly} />
      </div>
      <div className={s.box}>
        <h3>Brake and withdraw</h3>
        {st.config.frozen ? card(T.unfreeze(vault), ownerOnly, "Unfreeze") : card(T.freeze(vault), ownerOnly, "Freeze now")}
        <Withdraw on={on} vault={vault} st={st} card={card} ownerOnly={ownerOnly} />
      </div>
    </div>

    <div className={s.grid} style={{ marginTop: 16 }}>
      <ChangeLimits on={on} vault={vault} policy={st.policy} card={card} ownerOnly={ownerOnly} />
      <div className={s.box}>
        <h3>Ownership and escape hatches</h3>
        <ProposeOwner vault={vault} agent={st.config.agent_id} card={card} ownerOnly={ownerOnly} />
        <EscapeHatches on={on} vault={vault} st={st} card={card} ownerOnly={ownerOnly} />
      </div>
    </div>
  </>);
}

type Card = (plan: T.PlannedTx, disabled?: string, label?: string) => React.ReactNode;

/** Current vs proposed limits, every field. Weakened protections are marked; loud ones get a warning above Sign. */
export function PolicyDiff({ on, cur, next }: { on: OwnerNet; cur: PolicyArgs; next: PolicyArgs }) {
  const d = diffPolicy(cur, next, [on.wrap, on.quote]);
  if (d.length === 0) return <p className="muted">No change from the current limits.</p>;
  const loud = d.filter(c => c.loud);
  return (<>
    {loud.length > 0 && <p className={s.bad} role="alert">⚠ This proposal weakens protections: {loud.map(c => c.field).join("; ")}. Check it before anyone applies it.</p>}
    <ul className={s.list} aria-label="Policy changes">{d.map(c =>
      <li key={c.field}><span>{c.field}{c.weaker ? <b className={s.bad}> · weaker</b> : <span className="muted"> · stricter</span>}</span>
        <span className={s.mono}>{c.from} → {c.to}</span></li>)}</ul>
  </>);
}

function PendingPolicy({ on, cur, p, vault, card, ownerOnly }: { on: OwnerNet; cur: PolicyArgs; p: chain.Pending; vault: string; card: Card; ownerOnly?: string }) {
  const at = Number(BigInt(p.applies_at) / 1_000_000n);
  const ready = Date.now() >= at;
  return (<div className="callout blue" style={{ marginTop: 12 }}>
    <b>Proposed limits</b> apply {ready ? "now (timelock over)" : `after ${new Date(at).toUTCString()}`}. Every change against the current limits:
    <PolicyDiff on={on} cur={cur} next={p.value} />
    {card(T.applyPolicy(vault), ready ? undefined : "the 24-hour timelock isn't over", "Apply")}
    {card(T.cancelPolicy(vault), ownerOnly, "Cancel proposal")}
  </div>);
}

function Fund({ on, st, vault, owner, card, ownerOnly }: { on: OwnerNet; st: State; vault: string; owner: string; card: Card; ownerOnly?: string }) {
  const [amount, setAmount] = useState(on.defaults.fund);
  let steps: T.PlannedTx[] = [], problem: string | undefined;
  const room = capRoom(st.caps, on.wrap.id);
  try {
    if (room !== null && parseUnits(amount, 24) > room)
      throw new Error(`above this vault's deposit cap: it accepts at most ${formatUnits(room, 24)} more ${on.wrap.symbol}`);
    steps = T.fundSteps({ vault, owner, wrap: on.wrap.id, quote: on.quote.id, amount: parseUnits(amount, 24),
      vaultRegistered: { wrap: st.reg.wrap, quote: st.reg.quote }, ownerRegisteredWrap: st.reg.ownerWrap,
      exchangeStorage: st.reg.exchange, exchangeTokens: st.reg.exchangeTokens });
  } catch (e) { problem = err(e); }
  return (<div className={s.box} style={{ marginTop: 16 }}>
    <h3>Fund the vault</h3>
    <p className="muted">The contracts are reviewed, not externally audited, and this is {on.net.label}. Each step is its own transaction; do them in order. Steps already done on chain are skipped.</p>
    {st.caps && st.caps.length > 0 && <p className="muted">Deposit cap (beta, fixed for this vault): {st.caps.map(c => {
      const t = [on.wrap, on.quote].find(x => x.id === c.token);
      return t ? `${formatUnits(BigInt(c.net_deposited), t.decimals)} of ${formatUnits(BigInt(c.max), t.decimals)} ${t.symbol}` : `${c.token} ${c.net_deposited}/${c.max}`;
    }).join(" · ")} deposited, net of withdrawals. Anything above the cap is sent back.</p>}
    <label className={s.field} style={{ maxWidth: 260 }}>NEAR to wrap and deposit<input type="text" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} aria-label="Amount to fund" /></label>
    {problem ? <ul className={s.errors}><li>{problem}</li></ul> : <ol className={s.steps}>{steps.map(p => <li key={p.methodName + p.receiverId + JSON.stringify(p.args)}>{card(p, p.methodName === "storage_deposit" || p.methodName === "near_deposit" ? undefined : ownerOnly)}</li>)}</ol>}
    {(st.intents as { public_key?: string | null } | null)?.public_key == null && <details style={{ marginTop: 12 }}><summary>Optional: enable NEAR Intents swaps</summary>
      <p className="muted">Derives the vault&apos;s Chain Signatures key and registers it with {on.net.intents}, once. Only needed for the cross-chain path; Rhea swaps work without it.</p>
      {card(T.intentsSetup(vault), ownerOnly, "Set up intents")}</details>}
  </div>);
}

function Withdraw({ on, vault, st, card, ownerOnly }: { on: OwnerNet; vault: string; st: State; card: Card; ownerOnly?: string }) {
  const [token, setToken] = useState(on.wrap.id);
  const [amount, setAmount] = useState("");
  const tok = [on.wrap, on.quote].find(t => t.id === token);
  const plan = useMemo(() => {
    if (!amount) return { error: "enter an amount" };
    try {
      if (token === "near") return { plan: T.withdrawNear(vault, parseUnits(amount, 24)) };
      if (!tok) return { error: "pick a token" };
      return { plan: T.withdraw(vault, tok.id, parseUnits(amount, tok.decimals), tok.symbol, tok.decimals) };
    } catch (e) { return { error: err(e) }; }
  }, [amount, token, tok, vault]);
  const max = token === "near" ? undefined : token === on.wrap.id ? formatUnits(st.wrapBal, on.wrap.decimals) : formatUnits(st.quoteBal, on.quote.decimals);
  return (<div style={{ marginTop: 12 }}>
    <div className={s.form}>
      <label className={s.field}>Token<select value={token} onChange={e => setToken(e.target.value)} aria-label="Token to withdraw">
        <option value={on.wrap.id}>{on.wrap.symbol}</option><option value={on.quote.id}>{on.quote.symbol}</option><option value="near">NEAR (native)</option></select></label>
      <label className={s.field}>Amount<input type="text" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} aria-label="Amount to withdraw" />
        {max !== undefined && <span>vault holds {max}</span>}</label>
    </div>
    {"plan" in plan && plan.plan ? card(plan.plan, ownerOnly, "Withdraw to owner") : <p className="muted">{plan.error}</p>}
  </div>);
}

function AgentChange({ on, vault, owner, card, ownerOnly }: { on: OwnerNet; vault: string; owner: string; card: Card; ownerOnly?: string }) {
  const [agent, setAgent] = useState("");
  const c = useAgentCheck(on, agent.trim(), owner, vault);
  let plan: T.PlannedTx | undefined, problem: string | undefined;
  if (agent) { try { plan = T.setAgent(vault, agent.trim(), owner); } catch (e) { problem = err(e); } }
  return (<details style={{ marginTop: 12 }}><summary>Replace the agent</summary>
    <label className={s.field}>New agent account<input type="text" value={agent} onChange={e => setAgent(e.target.value)} aria-label="New agent account" /></label>
    {problem && <p className={s.bad}>{problem}</p>}{agent && <AgentFindings c={c} />}
    {plan && c.checked && c.problems.length === 0 && card(plan, ownerOnly, "Set agent")}
  </details>);
}

function ProposeOwner({ vault, agent, card, ownerOnly }: { vault: string; agent: string; card: Card; ownerOnly?: string }) {
  const [owner, setOwner] = useState("");
  let plan: T.PlannedTx | undefined, problem: string | undefined;
  if (owner) { try { plan = T.proposeOwner(vault, owner.trim(), agent); } catch (e) { problem = err(e); } }
  return (<details><summary>Transfer ownership (two steps)</summary>
    <p className="muted">The new owner must accept from their own wallet, so a typo can't hand the vault to nobody.</p>
    <label className={s.field}>New owner account<input type="text" value={owner} onChange={e => setOwner(e.target.value)} aria-label="New owner account" /></label>
    {problem && <p className={s.bad}>{problem}</p>}{plan && card(plan, ownerOnly, "Propose owner")}
  </details>);
}

function ChangeLimits({ on, vault, policy, card, ownerOnly }: { on: OwnerNet; vault: string; policy: PolicyArgs; card: Card; ownerOnly?: string }) {
  const spec = { base: on.wrap, quote: on.quote, pool: on.pool };
  const [form, setForm] = useState<PolicyForm | null>(() => formFromPolicy(policy, spec));
  if (!form) return <div className={s.box}><h3>Change limits</h3><p className="muted">This vault&apos;s policy uses tokens, pairs or a pool this form doesn&apos;t cover exactly, so a change from here would rewrite it; change it with the CLI.</p></div>;
  const b = buildPolicy(form, spec, policy);
  return (<div className={s.box}>
    <h3>Change limits</h3>
    <p className="muted">New limits apply only after a 24-hour timelock, so the public record always shows them before they take effect.</p>
    <div className={s.form}><PolicyFields on={on} form={form} set={setForm} /></div>
    {b.errors.length > 0 ? <ul className={s.errors}>{b.errors.map(e => <li key={e}>{e}</li>)}</ul>
      : b.policy && <><PolicyDiff on={on} cur={policy} next={b.policy} />{card(T.proposePolicy(vault, b.policy), ownerOnly, "Propose limits")}</>}
  </div>);
}

function EscapeHatches({ on, vault, st, card, ownerOnly }: { on: OwnerNet; vault: string; st: State; card: Card; ownerOnly?: string }) {
  const tokens = [on.wrap, on.quote];
  const onExchange = tokens.map(t => ({ t, v: BigInt(st.deposits[t.id] ?? "0") })).filter(x => x.v > 0n);
  const intent = st.intents as { open_intent?: unknown } | null;
  return (<details style={{ marginTop: 12 }}><summary>Escape hatches</summary>
    <p className="muted">For when something went wrong mid-swap. None of these can move funds anywhere but the vault or its owner.</p>
    {onExchange.map(x => <div key={x.t.id}>{card(T.exchangeWithdraw(vault, x.t.id, x.v, x.t.symbol, x.t.decimals), ownerOnly, `Bring back ${x.t.symbol}`)}</div>)}
    {tokens.map(t => <div key={t.id}>{card(T.claimLostfound(vault, t.id, t.symbol), ownerOnly, `Claim ${t.symbol} lost-and-found`)}</div>)}
    {st.inFlight != null && card(T.clearStuck(vault), ownerOnly, "Clear stuck swap")}
    {intent?.open_intent != null && <>{card(T.intentsSettle(vault), undefined, "Settle intent")}{card(T.intentsCancel(vault), ownerOnly, "Cancel intent")}{card(T.intentsAbandon(vault), ownerOnly, "Abandon intent")}</>}
  </details>);
}
