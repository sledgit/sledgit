import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { VaultHome } from "@/components/owner/app";

export const metadata: Metadata = {
  title: "Testnet vault",
  description: "Practise on NEAR testnet: create a vault from your own wallet, set its limits, and manage it. Testnet tokens only.",
};

export default function Vault() {
  return (<>
    <PageHead eyebrow="Testnet practice" title="Your testnet vault"
      lede="Free practice on NEAR testnet, with test tokens. Your wallet signs everything; this site never holds a key. Each transaction is shown in full before your wallet opens. For mainnet, point your agent at sledgit.com/SKILL.md; you sign in your own wallet."
      right={<span className="tag testnet">Testnet practice · test tokens only</span>} />
    <VaultHome />
  </>);
}
