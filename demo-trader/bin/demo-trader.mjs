#!/usr/bin/env node
// Entry point: runs src/cli.ts through the tsx pinned in agent/ (never a registry fetch). Install agent/ first.
import { createRequire } from "node:module";

const req = createRequire(new URL("../../agent/package.json", import.meta.url));
const { register } = await import(req.resolve("tsx/esm/api"));
register();
const { run } = await import("../src/cli.ts");
const { redact } = await import("../../agent/src/config.ts");
run(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(redact(`error: ${e.message}`));
  process.exit(1);
});
