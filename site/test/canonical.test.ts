// Final review 2 F2-11: each exported page declares its own canonical URL and og:url.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
// @ts-expect-error plain .mjs build script
import { pathOf, rewrite } from "../scripts/canonical.mjs";

const out = fileURLToPath(new URL("../out", import.meta.url));

test("paths: index pages map to their route, other files are skipped", () => {
  assert.equal(pathOf(join(out, "index.html")), "/");
  assert.equal(pathOf(join(out, "leaderboard", "index.html")), "/leaderboard/");
  assert.equal(pathOf(join(out, "agents", "tn-x", "index.html")), "/agents/tn-x/");
  assert.equal(pathOf(join(out, "404.html")), null);
});

test("rewrite: canonical and og:url point at the page, same origin", () => {
  const html = '<link rel="canonical" href="https://sledgit.com/"/><meta property="og:url" content="https://sledgit.com/"/>';
  const r = rewrite(html, "/verify/");
  assert.match(r, /rel="canonical" href="https:\/\/sledgit\.com\/verify\/"/);
  assert.match(r, /og:url" content="https:\/\/sledgit\.com\/verify\/"/);
  assert.equal(rewrite("<p>no tags</p>", "/x/"), "<p>no tags</p>");
});
