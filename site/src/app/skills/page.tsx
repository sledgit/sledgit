import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import data from "@/data/skills.json";

export const metadata: Metadata = {
  title: "Trading skills",
  description: "Published trading rules for Sledgit vaults, each backtested on NEAR/USDC after fees, price impact and gas, with in-sample and out-of-sample results kept apart.",
};

type Period = { cagr: number; max_dd: number; trades_per_year: number; cost_drag: number; vs_hold: number; vs_stake_hold: number };
type SkillRow = {
  id: string; name: string; status: string; stake: boolean; rule: string; version: number; spec_sha256: string | null; evidence: string;
  periods: Record<"full" | "in_sample" | "out_of_sample", Period>; years: Record<string, number>; p_vs_hold: number | null; verdict: string; weekly: number[];
};
const D = data as unknown as { data: { first: string; last: string; out_of_sample_from: string }; costs: { start_usd: number; fee: number; depth_usd: number; gas_usd: number; cap: number };
  significance: { alpha: number; correction: string; test: string }; stake_apr: string; hold_weekly: number[]; skills: SkillRow[] };

const pct = (n: number, sign = true) => `${sign && n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const tone = (n: number) => ({ color: n > 0 ? "var(--up)" : n < 0 ? "var(--red)" : undefined });
const STATUS: Record<string, string> = {
  house: "Published house rule: open and re-runnable",
  research: "Research: not trading live yet",
};

function Spark({ a, b }: { a: number[]; b: number[] }) {
  const w = 320, h = 80, all = [...a, ...b].map(Math.log);
  const lo = Math.min(...all), hi = Math.max(...all);
  const pts = (s: number[]) => s.map((v, i) => `${((i / (s.length - 1)) * w).toFixed(1)},${(h - ((Math.log(v) - lo) / (hi - lo)) * h).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Backtest value against hold 50/50, log scale" preserveAspectRatio="none">
      <polyline points={pts(b)} fill="none" stroke="var(--faint)" strokeWidth="1.2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <polyline points={pts(a)} fill="none" stroke="var(--blue)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function Skills() {
  const c = D.costs;
  return (
    <>
      <PageHead eyebrow="Skills" title="Trading skills, tested after costs"
        lede={<>Each skill is a published rule a vault can run. Every one is backtested here with the same code the live house vaults run, on NEAR/USDC daily prices from {D.data.first} to {D.data.last}, after fees, price impact and gas. A backtest is not a track record, and nothing here is investment advice. All results are <b>unproven</b> until they hold up live.</>} />

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="ph"><span>Summary</span><span className="r">${c.start_usd.toLocaleString()} vault · per year</span></div>
        <div className="tblwrap"><table className="tbl">
          <thead><tr><th>Skill</th><th>Return</th><th>vs hold</th><th>vs hold, since {D.data.out_of_sample_from.slice(0, 4)}</th><th>Worst drop</th><th>Trades</th><th>Costs</th><th>Verdict</th></tr></thead>
          <tbody>{D.skills.map(s => {
            const f = s.periods.full, o = s.periods.out_of_sample;
            return <tr key={s.id}>
              <td><a href={`#${s.id}`}>{s.name}</a></td>
              <td className="num" style={tone(f.cagr)}>{pct(f.cagr)}</td>
              <td className="num" style={tone(f.vs_hold)}>{s.id === "hold" ? "—" : pct(f.vs_hold)}</td>
              <td className="num" style={tone(o.vs_hold)}>{s.id === "hold" ? "—" : pct(o.vs_hold)}</td>
              <td className="num">{pct(f.max_dd, false)}</td>
              <td className="num">{f.trades_per_year.toFixed(0)}</td>
              <td className="num">{pct(f.cost_drag, false)}</td>
              <td>{s.verdict}</td>
            </tr>;
          })}</tbody>
        </table></div>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="ph"><span>Method</span></div>
        <dl className="kv">
          <dt>Prices</dt><dd>Binance NEARUSDT daily closes, the reference feed the live vaults use. The first 200 days are warm-up only.</dd>
          <dt>Decisions</dt><dd>One per day at the close, filled at that close. Every vault starts in USDC, so the first move pays costs too.</dd>
          <dt>Costs</dt><dd>{(c.fee * 100).toFixed(1)}% pool fee, price impact of trade size ÷ ${(c.depth_usd / 1e3).toFixed(0)}k pool depth, ${c.gas_usd} gas per trade. Each trade and each day is capped at {c.cap * 100}% of the vault.</dd>
          <dt>Staking</dt><dd>Skills marked staked earn {D.stake_apr} on the NEAR side, as a liquid-staking token would. Today&apos;s vaults can&apos;t hold one yet.</dd>
          <dt>Periods</dt><dd>Results before {D.data.out_of_sample_from} are in-sample: the house rules were chosen knowing that history. Results from {D.data.out_of_sample_from} on are the fairer test.</dd>
          <dt>Significance</dt><dd>A {D.significance.test}. A skill is called promising only if p &lt; {D.significance.alpha} ({D.significance.correction}) and it beat hold out of sample. Even then it is a backtest result, not proof.</dd>
        </dl>
      </div>

      {D.skills.map(s => {
        const yrs = Object.entries(s.years);
        const won = yrs.filter(([, v]) => v > 0).length;
        return (
          <section key={s.id} id={s.id} className="panel" style={{ marginBottom: 16 }}>
            <div className="ph"><span>{s.name}</span><span className="r">{s.verdict}</span></div>
            <div className="pb">
              <p style={{ marginTop: 0 }}>{s.rule}</p>
              <p className="note">{STATUS[s.status]}{s.stake ? " · staked NEAR side" : ""} · {s.evidence}</p>
              <Spark a={s.weekly} b={D.hold_weekly} />
              <p className="note" style={{ marginTop: 4 }}><span style={{ color: "var(--blue)" }}>■</span> {s.name}{s.id !== "hold" && <> <span style={{ color: "var(--faint)" }}>■</span> Hold 50/50</>} · log scale</p>
            </div>
            <div className="tblwrap"><table className="tbl">
              <thead><tr><th>Period</th><th>Return/yr</th><th>vs hold</th><th>vs stake &amp; hold</th><th>Worst drop</th><th>Trades/yr</th><th>Costs/yr</th></tr></thead>
              <tbody>{(["full", "in_sample", "out_of_sample"] as const).map(k => {
                const p = s.periods[k];
                return <tr key={k}>
                  <td>{k === "full" ? "All" : k === "in_sample" ? "In-sample" : "Out-of-sample"}</td>
                  <td className="num" style={tone(p.cagr)}>{pct(p.cagr)}</td>
                  <td className="num" style={tone(p.vs_hold)}>{pct(p.vs_hold)}</td>
                  <td className="num" style={tone(p.vs_stake_hold)}>{pct(p.vs_stake_hold)}</td>
                  <td className="num">{pct(p.max_dd, false)}</td>
                  <td className="num">{p.trades_per_year.toFixed(0)}</td>
                  <td className="num">{pct(p.cost_drag, false)}</td>
                </tr>;
              })}</tbody>
            </table></div>
            {s.id !== "hold" && <p className="note pb" style={{ margin: 0 }}>Beat hold in {won} of {yrs.length} calendar years · p = {s.p_vs_hold}{s.spec_sha256 ? <> · spec <span className="mono" title={s.spec_sha256}>{s.spec_sha256.slice(0, 8)}</span></> : null}</p>}
          </section>
        );
      })}

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="ph"><span>Open discretion (language models)</span><span className="r">live record only</span></div>
        <div className="pb"><p style={{ marginTop: 0 }}>The two mainnet agents run the <a className="ext" href="https://github.com/sledgit/sledgit/blob/main/agent/prompts/arena-v1.1.md">arena-v1.1</a> prompt: the model reads the price, the vault&apos;s limits and its own recent decisions, and chooses buy, sell or hold. Before 2026-11-16 14:18 UTC they ran <a className="ext" href="https://github.com/sledgit/sledgit/blob/main/agent/prompts/arena-v1.md">arena-v1</a>.</p>
        <p className="note">Not backtested: a model has likely seen these years of prices in training, so a backtest would partly measure memory. Judge it only on its <Link href="/leaderboard/">live record</Link>.</p></div>
      </section>
    </>
  );
}
