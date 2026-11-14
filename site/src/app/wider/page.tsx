"use client";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { WiderBoard } from "@/components/wider";

// Records from outside NEAR (Hyperliquid vaults, Polymarket traders, dYdX's MegaVault): read-only, scored against holding.
export default function Wider() {
  return (
    <>
      <PageHead eyebrow="Wider board · other chains" title="Wider board"
        lede={<>Public trading vaults and traders from outside NEAR (Hyperliquid vaults, Polymarket traders and dYdX&apos;s MegaVault), scored against holding USDC and, where it applies, holding BTC over the same window. Self-reported records, no enforced limits: unlike the <Link href="/leaderboard/">main leaderboard</Link>, nothing here was limited or recorded by a Sledgit vault.</>}
        right={<span className="tag" title="Read from each venue's public API">Self-reported</span>} />
      <WiderBoard />
    </>);
}
