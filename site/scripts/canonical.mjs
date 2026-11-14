// Postbuild: the root layout can only declare one canonical URL, so every exported page would claim to be the home
// page (final review 2 F2-11). Rewrite each page's canonical link and og:url to its own path.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../out", import.meta.url));

function pages(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? pages(p) : n.endsWith(".html") ? [p] : [];
  });
}

/** The public path of an exported file: out/a/b/index.html → /a/b/, out/404.html → null (not a page to index). */
export function pathOf(file) {
  const rel = relative(out, file).split(sep).join("/");
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"index.html".length)}`;
  return null;
}

/** Point the canonical link and og:url at `path` on the same origin the build declared. */
export function rewrite(html, path) {
  const m = html.match(/<link rel="canonical" href="(https?:\/\/[^/"]+)\/[^"]*"/);
  if (!m) return html;
  const url = `${m[1]}${path}`;
  return html
    .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${url}"`)
    .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let n = 0;
  for (const f of pages(out)) {
    const path = pathOf(f);
    if (!path) continue;
    const html = readFileSync(f, "utf8");
    const next = rewrite(html, path);
    if (next !== html) { writeFileSync(f, next); n++; }
  }
  console.log(`canonical: ${n} page(s) point at their own URL`);
}
