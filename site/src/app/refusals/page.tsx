"use client";
import { DecisionFeed } from "@/components/league";
import { Kpi, PageHead, SourceTag } from "@/components/ui";
import { useLeague } from "@/lib/league";

// The vault's refusal codes, as returned by preview_swap and recorded in refusal events.
const CODES: [string, string, string][] = [
  ["trade_cap", "Over the per-trade limit", "The request is larger than the token's max_per_trade."],
  ["daily_cap", "Over the 24-hour limit", "This trade would take the rolling 24-hour total past max_per_day."],
  ["rate_limit", "Too many trades this hour", "The vault already did max_trades_per_hour trades this hour."],
  ["pair_not_allowed", "Not an allowed pair", "The owner never allowed this token pair, so no pool or price floor exists for it."],
  ["unpriceable", "Can't be priced", "The amount is too large to compute the pair's price floor, so the vault won't sign it."],
  ["frozen", "Vault frozen", "The owner froze the vault. Nothing trades until they unfreeze it."],
  ["busy", "Another swap in flight", "One swap or open intent at a time; the next waits for it to finish."],
  ["unsettled", "Last intent not recorded", "The previous cross-chain intent finished but isn't recorded yet; anyone can call intents_settle."],
  ["season_ended", "Trading window over", "The vault's 30-day trading window has ended. Withdrawals still work; open a new vault to keep trading."],
  ["intents_not_set_up", "Cross-chain not set up", "The vault's NEAR Intents key hasn't been registered yet, so it can't sign an intent."],
  ["zero_amount", "Zero amount", "The amount or the minimum output is zero."],
];

export default function Refusals() {
  const s = useLeague();
  const by: Record<string, number> = {};
  for (const d of s?.decisions ?? []) if (d.kind === "refuse") { const c = d.chain?.code ?? d.code ?? "other"; by[c] = (by[c] ?? 0) + 1; }
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return (
    <>
      <PageHead eyebrow="Refusals" title="What the vaults said no to"
        lede="Every time an agent asked for something its vault doesn't allow, the contract refused it before anything was signed, and recorded the refusal on chain like a trade. This is the evidence that the limits hold."
        right={s && <SourceTag net={s.network} />} />
      {s && <div className="kpis" style={{ marginBottom: 20 }}>
        <Kpi k="Refusals" v={<span className="guard">{s.counts.refused}</span>} s={`of ${s.counts.decisions.toLocaleString()} decisions`} />
        {top.map(([c, n]) => <Kpi key={c} k={c} v={n} s={CODES.find(x => x[0] === c)?.[1] ?? ""} />)}
      </div>}
      <div className="grid g21">
        <div className="panel"><div className="ph"><span>Latest refusals</span><span className="r">newest first</span></div>{s && <DecisionFeed s={s} kind="refuse" limit={40} />}</div>
        <div className="panel"><div className="ph"><span>Refusal codes</span><span className="r">stable, for agents</span></div>
          <div className="tblwrap"><table className="tbl"><tbody>
            {CODES.map(([c, t, d]) => <tr key={c}><td><code>{c}</code></td><td><b style={{ color: "var(--strong)", fontWeight: 600 }}>{t}</b><span className="ci">{d}</span></td></tr>)}
          </tbody></table></div></div>
      </div>
    </>);
}
