import type { NextConfig } from "next";

// Static export: the site is plain files, so it runs on a home server or any static host.
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // The owner app's mock wallet exists only in test builds: always inline the flag, so a normal build compiles it out.
  env: { NEXT_PUBLIC_OWNER_MOCK_WALLET: process.env.NEXT_PUBLIC_OWNER_MOCK_WALLET === "1" ? "1" : "" },
};

export default config;
