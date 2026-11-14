"use client";
import { Suspense } from "react";
import { WiderVaultPage } from "@/components/wider-vault";

// One wider-board record: /wider/vault/?src=<venue>&id=<address>. A query page, since the site is a static export.
export default function WiderVault() {
  return <Suspense fallback={<div className="empty">Loading…</div>}><WiderVaultPage /></Suspense>;
}
