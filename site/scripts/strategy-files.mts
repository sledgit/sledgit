// Prebuild: the published strategies an agent page summarises, read from their sources so they never drift. House
// rules come from agent/src/strategies/rules.ts (their spec hash is strategyPrompt().sha256); prompt hashes are sha256
// of the file bytes, as the runners record them in prompt_sha256. Read only: nothing here changes a hashed file.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STRATEGIES, strategyPrompt } from "../../agent/src/strategies/rules.ts";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const fileHash = (p: string) => createHash("sha256").update(readFileSync(join(site, "..", p))).digest("hex");

const out = {
  rules: Object.fromEntries(STRATEGIES.map(s => [s.id, { version: s.version, rule: s.rule, sha256: strategyPrompt(s).sha256 }])),
  prompts: {
    "arena-v1": { sha256: fileHash("agent/prompts/arena-v1.md") },
    "iron-trader-v1": { sha256: fileHash("demo-trader/prompts/iron-trader-v1.md") },
  },
};
mkdirSync(join(site, "src/data"), { recursive: true });
writeFileSync(join(site, "src/data/strategies.json"), JSON.stringify(out, null, 1));
console.log(`strategies: ${STRATEGIES.length} house rules, ${Object.keys(out.prompts).length} prompts`);
