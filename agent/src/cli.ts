#!/usr/bin/env -S npx --no tsx
// sledgit: operate a Sledgit vault as its agent. Testnet by default. Prefer bin/sledgit.mjs (pinned local tsx).
import { main } from "./main.js";
import { redact } from "./config.js";

main(process.argv.slice(2)).then((code) => process.exit(code), (e: Error) => {
  console.error(redact(`error: ${e.message}`));
  process.exit(1);
});
