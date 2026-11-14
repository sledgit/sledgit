// Final review 2 F2-04: agent-facing text must only name locked, current factories (never the legacy one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FACTORIES } from "../src/provenance.js";

const files = ["../site/public/llms.txt", "../skills/sledgit-vault/SKILL.md", "SKILL.md", "../demo-trader/README.md", "../demo-trader/skill/SKILL.md"];

test("F2-04: every factory id named in agent-facing text is a known, locked, non-retired factory", () => {
  const current = new Set([...FACTORIES.testnet, ...FACTORIES.mainnet].filter((f) => f.locked && !f.retired).map((f) => f.id));
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url.replace(/test\/[^/]+$/, "")), "utf8");
    for (const m of text.matchAll(/[Ff]actory[^`\n]{0,40}`([a-z0-9.-]+\.(?:testnet|near))`/g)) {
      assert.ok(current.has(m[1]), `${f} names factory ${m[1]}, which isn't a locked current factory`);
    }
    assert.doesNotMatch(text, /`irontrade\.testnet`|claude\.irontrade\.testnet/, `${f} names the legacy factory or its vault`);
  }
});
