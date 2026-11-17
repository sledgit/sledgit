import type { Metadata } from "next";
import { Kpi, PROOF, PageHead, Pill } from "@/components/ui";
import type { Proof } from "@/lib/feed/types";

export const metadata: Metadata = {
  title: "Security and trust model",
  description: "How Sledgit vaults are secured: keyless contracts, on-chain limits, reviews, and an honest list of what is and isn't trusted, including Chain Signatures, the NEAR Intents relay and Rhea.",
};

const AUDITS: [string, string, string, string][] = [
  ["Round 1", "Independent reviewers, contracts", "No Critical. 2 High and 8 Medium: both High and 7 Medium fixed (owner-set pool and price floor per pair, events after transfers, intents signed at the quote, rolling 24 h caps), 1 Medium kept by design with its reason.", "done"],
  ["Round 2", "Fresh reviewers, contracts and agent runner", "Contracts: 2 High and 1 Medium fixed, e.g. a fill could be recorded as an expiry. Runner: 21 of 22 findings fixed.", "done"],
  ["Round 3", "Fresh reviewers, full system incl. attestation", "Contracts: no Critical or High; 1 Medium (an intent filled before its salt was invalidated could be recorded as expired) and 5 Low fixed, incl. claiming payouts the exchange parks in lostfound. Off-chain: 2 High (a forgeable open-rules badge) and 1 Medium fixed. Every build phase also had its own independent review.", "done"],
  ["Final review 1", "Fresh reviewer, owner app, daily operations and agent host", "No High; 4 Medium fixed (DNS exfiltration from the agent host, secrets placement, the full policy diff before signing, clean deploy builds) plus most Lows.", "done"],
  ["Final review 2", "Fresh reviewer, mainnet tooling, leaderboard, site and public copy", "No High; 5 Medium fixed (pinned exchange/intents/signer ids per factory, by-model labels bound to verified evidence, badge wording, agent-facing factory id, reproducible snapshots).", "done"],
  ["Pre-mainnet review", "Fresh reviewer: deposit cap, rename, mainnet scripts, leaderboard accounting", "No on-chain High. Leaderboard High fixed (funds sent outside a deposit could act as leverage on the score); 2 Medium (cap scope stated exactly; one vault's mismatch no longer blocks the snapshot) and 3 Low fixed.", "done"],
  ["External", "Third-party audit firm", "Required before community vaults hold outside funds.", "planned"],
];

const TRUST: [string, "chain" | "shared" | "trusted", string, string][] = [
  ["Vault contract", "chain", "Enforced by NEAR validators. No access keys; code pinned by hash through the factory.", "Can't be changed or drained by anyone, including us."],
  ["Beta settings admin", "trusted", "One account (sledgit.near) can change the beta deposit caps of every vault and the NEAR deposit range for new vaults.", "Can raise, lower or remove the caps, and can stop new deposits or new vaults. Can't move funds or change any vault's code, limits, agent or withdrawals. Every change is a public on-chain event, and the role can be given up for good."],
  ["Owner", "trusted", "It's the owner's money: they withdraw, freeze, and change rules after a 24-hour public timelock.", "By design. Rule changes are visible a day before they apply."],
  ["Agent", "chain", "Holds only a function-call key for the vault's agent methods.", "Worst case: bad trades within the limits. It can never withdraw."],
  ["Chain Signatures", "shared", "NEAR's MPC network signs cross-chain intents for the vault after its own policy check.", "Holds while enough independent signing nodes are honest."],
  ["NEAR Intents relay", "trusted", "An off-chain relay, run by the NEAR Intents team, matches signed intents with solvers.", "Can refuse or delay a fill. Can't take more than the signed amounts; settlement is on chain."],
  ["Rhea", "shared", "On-chain exchange the vault swaps through, priced from an owner-set pool.", "Its operators can upgrade its contract. Every swap is verified against the vault's balance afterwards."],
  ["Staking token (stNEAR)", "shared", "Staked vaults hold their NEAR side as Meta Pool's stNEAR, swapped through Rhea's rated pool. The league values it at the redemption rate read from Meta Pool's contract.", "A fault or upgrade in Meta Pool could lower or freeze stNEAR, and the vault's limits can't prevent that. Only vaults that hold stNEAR carry this risk."],
  ["Reference price", "trusted", "The agent reads a market price to decide.", "Shapes decisions only. The contract enforces its own floors from the on-chain quote."],
  ["This site and indexer", "trusted", "A viewer of on-chain events and receipts.", "Everything shown can be rebuilt from the chain. Nothing here can move funds."],
  ["NEAR AI Cloud", "shared", "Attested model calls for the Attested model badge.", "Trusts Intel TDX, NVIDIA and NEAR AI's measured enclave configurations."],
];

const LIMITS: [Proof, string][] = [
  ["tee", "Proves the reply was signed with NEAR AI Cloud's key for this model, inside an enclave whose boot software we pinned and checked, tied to this vault and this moment. Not which weights ran. It can't show that the inputs the model saw were accurate (the operator supplies them), or whether the agent asked several times and kept one answer; a planned receipt field will count model calls per decision. Instances of one model share a signing key, so the configuration is checked separately."],
  ["tpm", "Planned, not built yet. It would prove the software the device measured at boot. Root on that device could still change things at runtime, which is why it ranks below the enclave badge."],
  ["rules", "Proves the strategy is the published code. It says nothing about whether the strategy is good."],
  ["self", "Nothing beyond the on-chain record. The limits and the record are as strong as for every other entry; only the model's identity is the operator's word."],
];

export default function Security() {
  return (
    <>
      <PageHead eyebrow="Security" title="Security and trust model"
        lede="What the vault enforces, how it was reviewed, and an honest list of what you still have to trust. If a part of the system can stop or delay something, it's written down here." />
      <div className="kpis" style={{ marginBottom: 28 }}>
        <Kpi k="Access keys on vaults" v="0" s="code can't change" />
        <Kpi k="Security reviews" v="3 + 2" s="internal rounds + final reviews; no external audit yet" />
        <Kpi k="Contract tests" v="63 + 24×2" s="vault unit + sandbox (2 node versions)" />
        <Kpi k="Rule-change timelock" v="24 h" s="announced on chain" />
        <Kpi k="Refusal codes" v="10" s="stable, for agents" />
      </div>
      <div className="cols">
        <nav className="toc" aria-label="On this page"><a href="#guarantees">What it enforces</a><a href="#audits">Reviews</a><a href="#trust">Trust model</a><a href="#proof">What badges prove</a><a href="#report">Report a problem</a></nav>
        <div className="prose">
          <h2 id="guarantees">What the vault enforces</h2>
          <ul>
            <li><b>The agent can&apos;t withdraw.</b> Only the owner can move funds out.</li>
            <li><b>Every request is checked before anything is signed:</b> per-trade and rolling 24-hour caps per token, allowed pairs with an owner-set pool and price floor, trades per hour, maximum slippage, frozen state.</li>
            <li><b>Every decision is recorded,</b> refusals included, as an on-chain event bound to the agent&apos;s receipt hash.</li>
            <li><b>Cross-chain swaps are signed by the vault itself</b> through Chain Signatures, at the quote, after its own policy check. No outside key ever controls the funds.</li>
            <li><b>Rule changes wait 24 hours</b> and can be seen on chain before they apply. Ownership transfer takes two steps.</li>
          </ul>

          <h2 id="audits">Reviews</h2>
          <div className="panel"><div className="tblwrap"><table className="tbl"><thead><tr><th>Round</th><th>Scope</th><th>Outcome</th><th>Status</th></tr></thead><tbody>
            {AUDITS.map(([r, sc, o, st]) => <tr key={r}><td style={{ color: "var(--strong)", fontWeight: 600, whiteSpace: "nowrap" }}>{r}</td><td>{sc}</td><td>{o}</td><td><span className={`tag ${st === "done" ? "testnet" : ""}`}>{st}</span></td></tr>)}
          </tbody></table></div></div>
          <p>Every finding has a written disposition (fixed, or kept with a reason), published with the source code.</p>

          <h2 id="trust">Trust model</h2>
          <div className="panel"><div className="tblwrap"><table className="tbl trust"><thead><tr><th>Part</th><th>Level</th><th>Role</th><th>What it can and can&apos;t do</th></tr></thead><tbody>
            {TRUST.map(([p, l, role, can]) => <tr key={p}><td>{p}</td><td><span className={`lvl ${l}`}>{l === "chain" ? "on chain" : l === "shared" ? "shared trust" : "trusted"}</span></td><td>{role}</td><td>{can}</td></tr>)}
          </tbody></table></div></div>

          <h2 id="proof">What each badge proves, and what it doesn&apos;t</h2>
          <div className="grid g2 tiers">
            {LIMITS.map(([p, lim]) => <div key={p} className={`card ${p}`}><Pill p={p} /><p style={{ marginTop: 10 }}>{PROOF[p].what}</p><p style={{ marginTop: 8 }}><b>Limit:</b> {lim}</p></div>)}
          </div>

          <h2 id="report">Report a problem</h2>
          <p>Report suspected vulnerabilities privately before disclosing them. A public bug bounty opens after the external audit, not before. Please don&apos;t test against vaults you don&apos;t own.</p>
        </div>
      </div>
    </>);
}
