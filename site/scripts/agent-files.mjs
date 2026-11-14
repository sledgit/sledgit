// Prebuild: publish the agent skill and the long-form llms file from their sources, so they never drift. The public copy
// adds the mandatory footer; on-chain names (the `irontrade` event standard, *.irontrade.testnet
// accounts) are identifiers and stay as they are.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const FOOTER = "Non-custodial beta, built for NEAR HACKATHON 2026. Sledgit is open-source software: we never hold your funds, and only your own wallet can withdraw from your vault. It is experimental: the code is reviewed but not externally audited, and you can lose what you deposit. Use only small amounts you can afford to lose; deposits are capped per vault during the beta. Trading is risky and most agents lose to just holding. Your money, your decision. Not financial advice. Not available where prohibited.";
const skill = `${readFileSync(join(site, "../agent/SKILL.md"), "utf8").trimEnd()}\n\n---\n\n${FOOTER}\n`;
// The old brand name anywhere in it fails the build, except the on-chain identifiers.
const left = skill.replace(/`irontrade`|[\w.-]*\.irontrade\.testnet/g, "").match(/iron.?trade[\w.-]*/gi);
if (left) throw new Error(`skill.md: old name left after the rename: ${[...new Set(left)].join(", ")}`);
const intro = readFileSync(join(site, "public/llms.txt"), "utf8");
const api = JSON.parse(readFileSync(join(site, "public/api-reference.json"), "utf8"));

writeFileSync(join(site, "public/skill.md"), skill);
const views = [...api.vault_views, ...api.factory_views]
  .map(v => `- \`${v.method}(${Object.keys(v.args).join(", ")})\` -> ${typeof v.returns === "string" ? v.returns : JSON.stringify(v.returns)}`).join("\n");
writeFileSync(join(site, "public/llms-full.txt"), `${intro.trim()}

---

# Read-only views

${api.transport} ${api.amounts}

${views}

---

# Agent skill (the same file as /skill.md)

${skill}`);
console.log("agent files: skill.md, llms-full.txt");
