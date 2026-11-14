"use client";
// Create a vault from the factory: name, agent, limits, deposit. The factory makes the caller the owner.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { OwnerNet } from "@/lib/owner/config";
import { checkAgent, factoryConfig, type FactoryConfig } from "@/lib/owner/chain";
import { buildPolicy, type PolicyForm } from "@/lib/owner/policy";
import { createVault, validVaultName, type PlannedTx } from "@/lib/owner/tx";
import { formatUnits, parseUnits } from "@/lib/owner/units";
import type { OwnerWallet } from "@/lib/owner/wallet";
import { TxCard } from "./tx-card";
import s from "./owner.module.css";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Looks the agent account up before it gets trade rights (debounced). `problems` block signing; `warnings` don't. */
export function useAgentCheck(on: OwnerNet, agent: string, owner: string, vault: string): { problems: string[]; warnings: string[]; checked: boolean } {
  const [r, setR] = useState<{ key: string; problems: string[]; warnings: string[] }>();
  const key = `${on.id}|${agent}|${owner}|${vault}`;
  useEffect(() => {
    if (!agent || !on.factory) return;
    const t = setTimeout(() => {
      checkAgent(on.net, agent, { owner, vault, factory: on.factory! })
        .then(x => setR({ key, ...x }), e => setR({ key, problems: [`couldn't check the agent: ${e instanceof Error ? e.message : String(e)}`], warnings: [] }));
    }, 400);
    return () => clearTimeout(t);
  }, [key, agent, owner, vault, on]);
  return r && r.key === key ? { problems: r.problems, warnings: r.warnings, checked: true } : { problems: [], warnings: [], checked: false };
}

export function AgentFindings({ c }: { c: { problems: string[]; warnings: string[] } }) {
  return (<>{c.problems.length > 0 && <ul className={s.errors}>{c.problems.map(e => <li key={e}>{e}</li>)}</ul>}
    {c.warnings.length > 0 && <ul className={s.list} aria-label="Agent warnings">{c.warnings.map(w => <li key={w}><span className={s.bad}>⚠ {w}</span></li>)}</ul>}</>);
}

export function PolicyFields({ on, form, set }: { on: OwnerNet; form: PolicyForm; set: (f: PolicyForm) => void }) {
  const b = on.wrap.symbol, q = on.quote.symbol;
  const f = (k: keyof PolicyForm, label: string, hint?: string) => (
    <label className={s.field}>{label}
      <input type="text" inputMode="decimal" value={form[k]} onChange={e => set({ ...form, [k]: e.target.value })} aria-label={label} />
      {hint && <span>{hint}</span>}
    </label>);
  return (<>
    {f("tradeBase", `${b} per trade`)}{f("dayBase", `${b} per rolling 24 h`)}
    {f("tradeQuote", `${q} per trade`)}{f("dayQuote", `${q} per rolling 24 h`)}
    {f("sellFloor", `Sell floor: ${q} per ${b}`, "a sale never fills below this")}
    {f("buyFloor", `Buy floor: ${b} per ${q}`, "a purchase never fills below this")}
    {f("tradesPerHour", "Trades per hour (1-60)")}{f("slippageBps", "Max slippage, bps (0-500)", "Rhea swaps only")}
    <p className={`muted ${s.wide}`}>Prices use Rhea pool {on.pool}. Caps are amounts, not percentages, and apply over a rolling 24 hours.</p>
  </>);
}

export function CreateVault({ on, wallet, account }: { on: OwnerNet; wallet: OwnerWallet | null; account: string | null }) {
  const d = on.defaults;
  const [cfg, setCfg] = useState<FactoryConfig>();
  const [cfgErr, setCfgErr] = useState<string>();
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [deposit, setDeposit] = useState(d.deposit);
  const [form, setForm] = useState<PolicyForm>({ tradeBase: d.tradeBase, dayBase: d.dayBase, tradeQuote: d.tradeQuote, dayQuote: d.dayQuote,
    sellFloor: d.sellFloor, buyFloor: d.buyFloor, tradesPerHour: String(d.tradesPerHour), slippageBps: String(d.slippageBps) });
  const [created, setCreated] = useState(false);

  useEffect(() => {
    if (!on.factory) return;
    factoryConfig(on.net, on.factory).then(setCfg, e => setCfgErr(err(e)));
  }, [on]);

  const built = useMemo((): { plan?: PlannedTx; errors: string[] } => {
    if (!on.factory || !cfg) return { errors: [] };
    if (!account) return { errors: ["connect a wallet: the vault's owner is the account that signs"] };
    const p = buildPolicy(form, { base: on.wrap, quote: on.quote, pool: on.pool });
    const errors = [...p.errors];
    if (name && !validVaultName(name)) errors.push("vault name: 2-32 characters of a-z, 0-9 and inner '-'");
    if (!name || !agent) errors.push("enter a vault name and the agent's account");
    let dep = 0n;
    try { dep = parseUnits(deposit, 24); } catch (e) { errors.push(`deposit: ${err(e)}`); }
    if (errors.length || !p.policy) return { errors };
    try {
      return { plan: createVault({ factory: on.factory, name, owner: account, agent: agent.trim(), policy: p.policy, deposit: dep,
        minDeposit: BigInt(cfg.min_deposit), maxDeposit: BigInt(cfg.max_deposit ?? "100000000000000000000000000") }), errors: [] };
    } catch (e) { return { errors: [err(e)] }; }
  }, [on, cfg, account, name, agent, deposit, form]);

  const vault = `${name}.${on.factory}`;
  const agentCheck = useAgentCheck(on, agent.trim(), account ?? "", vault);
  if (!on.factory) return <p className="callout">Creating vaults on {on.net.label} opens when its factory is deployed.</p>;
  if (cfgErr) return <p className="callout">Could not read the factory ({on.factory}): {cfgErr}</p>;
  return (
    <div className={s.box}>
      <h3>Create a testnet practice vault</h3>
      <div className={s.form}>
        <label className={s.field}>Vault name<input type="text" value={name} onChange={e => setName(e.target.value.toLowerCase())} placeholder="my-agent" aria-label="Vault name" />
          <span>{name ? vault : `<name>.${on.factory}`}</span></label>
        <label className={s.field}>Agent account<input type="text" value={agent} onChange={e => setAgent(e.target.value)} placeholder="my-agent-bot.testnet" aria-label="Agent account" />
          <span>a separate account; it gets a key that can only call this vault</span></label>
        <label className={`${s.field} ${s.wide}`}>NEAR to send with creation<input type="text" inputMode="decimal" value={deposit} onChange={e => setDeposit(e.target.value)} aria-label="Deposit" />
          <span>{cfg ? `between ${formatUnits(BigInt(cfg.min_deposit), 24)} and ${formatUnits(BigInt(cfg.max_deposit ?? "0"), 24)} NEAR; it pays the vault's storage and gas reserve` : "reading the factory…"}</span></label>
        <PolicyFields on={on} form={form} set={setForm} />
      </div>
      {cfg?.deposit_caps && cfg.deposit_caps.length > 0 && <p className="muted">Beta deposit cap, fixed for the life of every vault this factory creates: {cfg.deposit_caps.map(c => {
        const t = [on.wrap, on.quote].find(x => x.id === c.token);
        return t ? `${formatUnits(BigInt(c.max), t.decimals)} ${t.symbol}` : `${c.token} ${c.max}`;
      }).join(" and ")}, net of withdrawals. Anything above it is sent back to you.</p>}
      {built.errors.length > 0 && <ul className={s.errors}>{built.errors.map(e => <li key={e}>{e}</li>)}</ul>}
      {agent && <AgentFindings c={agentCheck} />}
      {built.plan && agentCheck.checked && agentCheck.problems.length === 0 && <>
        <p className="callout">Once its operator adds a key, <b>{agent.trim()}</b> can trade up to {form.dayBase} {on.wrap.symbol} and {form.dayQuote} {on.quote.symbol} per rolling 24 h,
          selling no lower than {form.sellFloor} {on.quote.symbol} per {on.wrap.symbol}. It can never withdraw.</p>
        <TxCard plan={built.plan} wallet={wallet} net={on.net} label="Create testnet vault in wallet" onDone={r => setCreated(r.ok)} /></>}
      {created && <p className={s.row}><Link className="btn" href={`/vault/manage/?v=${encodeURIComponent(vault)}`}>Fund and manage {vault} →</Link></p>}
    </div>);
}
