import type { Metadata } from "next";
import ref from "../../../public/api-reference.json";
import { PageHead } from "@/components/ui";

export const metadata: Metadata = {
  title: "API reference",
  description: "Read-only views of Sledgit vaults and the factory: config, policy, usage, preview_swap, refusal codes and events. Free NEAR JSON-RPC calls, no account needed.",
};

type View = { method: string; args: Record<string, string>; returns: unknown };
const show = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x, null, 2));

function Views({ title, list, account }: { title: string; list: View[]; account: string }) {
  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="ph"><span>{title}</span><span className="r mono">{account}</span></div>
      <div className="tblwrap"><table className="tbl"><thead><tr><th>Method</th><th>Args</th><th>Returns</th></tr></thead><tbody>
        {list.map(v => <tr key={v.method}><td><code>{v.method}</code></td>
          <td className="mono" style={{ fontSize: 12 }}>{Object.keys(v.args).length ? Object.entries(v.args).map(([k, t]) => <div key={k}>{k}: <span className="muted">{t}</span></div>) : <span className="muted">none</span>}</td>
          <td><pre style={{ margin: 0, padding: "8px 10px", fontSize: 11.5 }}>{show(v.returns)}</pre></td></tr>)}
      </tbody></table></div>
    </div>);
}

export default function ApiReference() {
  return (
    <>
      <PageHead eyebrow="Developers" title="API reference"
        lede="Every view below is a free NEAR JSON-RPC call: no account, no key, no rate card. Agents should read these before acting; anyone can use them to check a record."
        right={<><a className="btn" href="/api-reference.json">api-reference.json</a><a className="btn" href="/skill.md">SKILL.md</a></>} />
      <pre>{`POST ${ref.networks.testnet.rpc}
{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final",
 "account_id":"${ref.networks.testnet.example_vault}","method_name":"preview_swap",
 "args_base64":"<base64 of {"token_in":"wrap.testnet","token_out":"usdc.itachicara.testnet","amount_in":"5000000000000000000000000","min_amount_out":"1"}>"}}`}</pre>
      <p className="note" style={{ margin: "0 0 24px" }}>{ref.transport} {ref.amounts}</p>
      <Views title="Vault views" list={ref.vault_views as View[]} account="<name>.arena2.irontrade.testnet" />
      <Views title="Factory views" list={ref.factory_views as View[]} account={ref.networks.testnet.factory} />
      <div className="grid g2">
        <div className="panel"><div className="ph"><span>Refusal codes</span><span className="r">returned by preview_swap and in refuse events</span></div>
          <div className="pb" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{ref.refusal_codes.map(c => <code key={c}>{c}</code>)}</div></div>
        <div className="panel"><div className="ph"><span>Events</span><span className="r mono">standard: {ref.events.standard} (legacy {ref.events.legacy_standard})</span></div>
          <div className="pb"><p className="note" style={{ marginTop: 0 }}>{ref.events.format}.</p><div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{ref.events.names.map(c => <code key={c}>{c}</code>)}</div></div></div>
      </div>
    </>);
}
