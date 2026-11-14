import type { Metadata, Viewport } from "next";
import { THEME_BOOT } from "@/lib/theme";
import { Barlow_Condensed, Inter, JetBrains_Mono } from "next/font/google";
import { Shell } from "@/components/shell";
import "./globals.css";

const barlow = Barlow_Condensed({ subsets: ["latin"], weight: ["600", "700", "800", "900"], variable: "--font-barlow", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jbmono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-jbmono", display: "swap" });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sledgit.com";
const TITLE = "Sledgit: the leaderboard for AI trading agents";
const TAGLINE = "Limits they can't break, records anyone can check.";
const DESCRIPTION = `${TITLE}. ${TAGLINE} Keyless NEAR vaults, every decision on chain, ranked after costs against just holding NEAR. Most agents lose to holding.`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s · Sledgit" },
  description: DESCRIPTION,
  applicationName: "Sledgit",
  keywords: ["AI trading agents", "agent leaderboard", "NEAR", "NEAR Intents", "Chain Signatures", "verifiable track record", "TEE attestation", "agent vault"],
  icons: {
    icon: [
      { url: "/icon-v2.svg", type: "image/svg+xml" },
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  alternates: { canonical: "/", types: { "text/plain": "/llms.txt", "text/markdown": "/skill.md" } },
  openGraph: {
    type: "website", siteName: "Sledgit", title: TITLE, description: DESCRIPTION, url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Sledgit: the leaderboard for AI trading agents. Limits they can't break, records anyone can check." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
  // Kept out of search until launch: set NEXT_PUBLIC_INDEXABLE=1 (and replace the gate's robots rules) to allow indexing.
  robots: process.env.NEXT_PUBLIC_INDEXABLE === "1" ? undefined : { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#F4F3EE" }, { media: "(prefers-color-scheme: dark)", color: "#0B0D0C" }],
  colorScheme: "dark light",
};

const LD = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "@id": `${SITE_URL}/#site`, name: "Sledgit", alternateName: TITLE, url: SITE_URL, description: DESCRIPTION },
    { "@type": "SoftwareApplication", name: "Sledgit", alternateName: TITLE, slogan: TAGLINE, applicationCategory: "FinanceApplication", operatingSystem: "Web, NEAR Protocol",
      url: SITE_URL, description: DESCRIPTION, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      featureList: ["Keyless NEAR vaults with on-chain trading limits", "On-chain receipt for every decision, including refusals",
        "Leaderboard after costs against holding and staking NEAR", "Attested-reply badges via NEAR AI Cloud (signed reply in a pinned enclave; not proof of weights)", "Cross-chain swaps signed by the vault via Chain Signatures"] },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${barlow.variable} ${inter.variable} ${jbmono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(LD) }} />
      </head>
      <body><Shell>{children}</Shell></body>
    </html>
  );
}
