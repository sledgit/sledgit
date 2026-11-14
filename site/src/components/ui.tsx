import type { Bot, Proof } from "@/lib/feed/types";
import type { NetworkId } from "@/lib/networks";

export const PROOF: Record<Proof, { label: string; short: string; what: string }> = {
  tee: { label: "Attested model", short: "TEE", what: "Each recorded decision has a reply signed with the key NEAR AI Cloud uses for this model, inside an Intel TDX enclave whose boot software is on Sledgit's pinned list, tied to this vault and this moment. It doesn't prove which weights ran, or that the agent asked only once." },
  tpm: { label: "Attested device (planned)", short: "TPM2", what: "Planned, not built yet: decisions from a registered device whose TPM signs the measured software. It would prove what booted, not what changed at runtime." },
  rules: { label: "Open rules", short: "Rules", what: "A deterministic strategy with a published code hash. Anyone can rerun it on the same prices and get the same decisions." },
  self: { label: "Self-reported", short: "Self", what: "The operator states the harness and model. The vault still enforces every limit and records every decision; only the model's identity is unproven." },
  computed: { label: "Computed", short: "Calc", what: "A benchmark calculated from reference prices: no vault, no decisions, no hash. It is the bar entries are measured against." },
};

function ProofIcon({ p }: { p: Proof }) {
  const c = "currentColor";
  if (p === "tee") return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M6 .8 10.6 3v3.2c0 2.6-2 4.4-4.6 5-2.6-.6-4.6-2.4-4.6-5V3z" fill="none" stroke={c} strokeWidth="1.3" /><path d="m3.9 6.1 1.5 1.5 2.8-3" fill="none" stroke={c} strokeWidth="1.3" /></svg>;
  if (p === "tpm") return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke={c} strokeWidth="1.3" /><path d="M4.5 0v2.5M7.5 0v2.5M4.5 9.5V12M7.5 9.5V12M0 4.5h2.5M0 7.5h2.5M9.5 4.5H12M9.5 7.5H12" stroke={c} strokeWidth="1" /></svg>;
  if (p === "computed") return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2 9.5 5 6l2 2 3-4.5" fill="none" stroke={c} strokeWidth="1.3" /></svg>;
  if (p === "rules") return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M4 3 1.5 6 4 9M8 3l2.5 3L8 9" fill="none" stroke={c} strokeWidth="1.3" /></svg>;
  return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="4.6" fill="none" stroke={c} strokeWidth="1.2" strokeDasharray="2 1.6" /></svg>;
}

export function Pill({ p, short }: { p: Proof; short?: boolean }) {
  return <span className={`pill ${p}`} title={PROOF[p].what}><ProofIcon p={p} />{short ? PROOF[p].short : PROOF[p].label}</span>;
}
export const BotPill = ({ bot, short }: { bot: Bot; short?: boolean }) => <Pill p={bot.proof} short={short} />;

// Marks data by where it comes from: sample (simulated preview) or testnet (real transactions, test tokens).
export function SourceTag({ net }: { net: NetworkId }) {
  if (net === "sim") return <span className="tag sample" title="Simulated: Season 1 is not live">Sample data</span>;
  if (net === "testnet") return <span className="tag testnet live" title="Read from NEAR testnet">Testnet</span>;
  return <span className="tag">Mainnet</span>;
}

export function Kpi({ k, v, s, cls }: { k: string; v: React.ReactNode; s?: React.ReactNode; cls?: string }) {
  return <div className="kpi"><div className="k">{k}</div><div className={`v ${cls ?? ""}`}>{v}</div>{s && <div className="s">{s}</div>}</div>;
}

export function PageHead({ eyebrow, title, lede, right }: { eyebrow: string; title: string; lede?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="pagehead">
      <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{lede && <p className="lede">{lede}</p>}</div>
      {right && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{right}</div>}
    </div>);
}

export function Section({ eyebrow, title, lede, right, children }: { eyebrow?: string; title: string; lede?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="section">
      <div className="sh"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2>{lede && <p>{lede}</p>}</div>{right}</div>
      {children}
    </section>);
}
