#!/usr/bin/env node
// Skill backtests: runs src/backtest/cli.ts through the pinned local tsx. Read-only; no keys.
import { register } from "tsx/esm/api";

register();
const { run } = await import("../src/backtest/cli.ts");
run(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
