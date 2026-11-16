// Prebuild: the skills catalogue and its backtests, computed from the committed daily history with the live rule code.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { report } from "../../agent/src/backtest/cli.ts";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(site, "..", "agent/data/near-usdt-1d.json"), "utf8"));
const out = report(data.candles);
mkdirSync(join(site, "src/data"), { recursive: true });
writeFileSync(join(site, "src/data/skills.json"), JSON.stringify(out));
console.log(`skills: ${out.skills.length} backtested, ${out.data.first} to ${out.data.last}`);
