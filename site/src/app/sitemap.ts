import type { MetadataRoute } from "next";
import { ALL_BOTS } from "@/lib/bots";

export const dynamic = "force-static";

// Empty until launch: NEXT_PUBLIC_INDEXABLE=1 lists every public page.
export default function sitemap(): MetadataRoute.Sitemap {
  if (process.env.NEXT_PUBLIC_INDEXABLE !== "1") return [];
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sledgit.com";
  const pages = ["", "leaderboard", "refusals", "verify", "season", "developers", "api-reference", "security", "docs"];
  return [...pages.map(p => ({ url: `${base}/${p ? `${p}/` : ""}`, changeFrequency: "daily" as const })),
    ...ALL_BOTS.map(b => ({ url: `${base}/agents/${b.id}/`, changeFrequency: "hourly" as const }))];
}
