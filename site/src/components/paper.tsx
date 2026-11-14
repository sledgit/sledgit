// Design B: a decision printed as a thermal-printer receipt, stamped once the chain check passes.
export type StampTone = "ok" | "no" | "wait";

export function Paper({ title, sub, rows, foot, stamp, flat }: {
  title: string; sub: string; rows: ([React.ReactNode, React.ReactNode] | "hr")[]; foot?: React.ReactNode;
  stamp?: { text: string; tone: StampTone }; flat?: boolean;
}) {
  return (
    <div className={`rcpt ${flat ? "flat" : ""}`}>
      <h4>{title}</h4><div className="c">{sub}</div><hr />
      {rows.map((r, i) => r === "hr" ? <hr key={i} /> : <div key={i} className="r"><span className={typeof r[0] === "string" && r[0].length < 14 ? "k" : undefined}>{r[0]}</span><span>{r[1]}</span></div>)}
      {foot && <><hr /><div className="c">{foot}</div></>}
      {stamp && <div className={`stamp ${stamp.tone === "no" ? "" : stamp.tone}`} role="status">{stamp.text}</div>}
    </div>);
}
