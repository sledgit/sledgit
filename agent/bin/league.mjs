#!/usr/bin/env node
// Leaderboard snapshot: runs src/league/cli.ts through the pinned local tsx. Read-only; no keys.
import { register } from "tsx/esm/api";

register();
const { run } = await import("../src/league/cli.ts");
run(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
