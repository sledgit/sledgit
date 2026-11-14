// Public links and the interest-signup endpoint, set at build time.
export const SITE = {
  xHandle: process.env.NEXT_PUBLIC_X_HANDLE ?? "sledgit_com",          // e.g. "sledgit" (no @)
  interestEndpoint: process.env.NEXT_PUBLIC_INTEREST_URL ?? "", // POST {email}; empty = signups not open yet
};
export const xUrl = () => (SITE.xHandle ? `https://x.com/${SITE.xHandle}` : "");
