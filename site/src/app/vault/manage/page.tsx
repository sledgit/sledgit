import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHead } from "@/components/ui";
import { VaultManage } from "@/components/owner/app";

export const metadata: Metadata = {
  title: "Manage testnet vault",
  description: "Practise on NEAR testnet: fund your vault with test tokens, set up its agent's key, change its limits, freeze it or withdraw.",
};

export default function Manage() {
  return (<>
    <PageHead eyebrow="Testnet practice" title="Manage testnet vault"
      lede="Freeze stops trading at once. Withdrawals go to the owner only. New limits wait 24 hours before they apply."
      right={<span className="tag testnet">Testnet practice · test tokens only</span>} />
    <Suspense fallback={<p className="muted">Loading…</p>}><VaultManage /></Suspense>
  </>);
}
