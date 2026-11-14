// The packaged skill (skills/sledgit-vault, for `npx skills add` and ClawHub) is a copy of agent/SKILL.md: same
// description and byte-identical body. Edit the canonical file, then regenerate the copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const split = (t: string) => {
  assert.ok(t.startsWith("---\n"), "frontmatter first");
  const end = t.indexOf("\n---\n", 4);
  return { front: t.slice(4, end), body: t.slice(end + 5) };
};
const field = (front: string, k: string) => front.split("\n").find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim();

test("skill: the packaged copy matches the canonical agent/SKILL.md", () => {
  const canon = split(readFileSync(join(ROOT, "agent", "SKILL.md"), "utf8"));
  const pkg = split(readFileSync(join(ROOT, "skills", "sledgit-vault", "SKILL.md"), "utf8"));
  assert.equal(pkg.body, canon.body, "body differs: regenerate skills/sledgit-vault/SKILL.md from agent/SKILL.md");
  assert.equal(field(pkg.front, "description"), field(canon.front, "description"));
  assert.equal(field(pkg.front, "name"), "sledgit-vault", "name must equal the folder name");
});
