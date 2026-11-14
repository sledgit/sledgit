#!/usr/bin/env node
// Card queue for @sledgit_com. Nothing here posts: a person approves each card and posts it by hand.
//   generate --league <dir> [--prev <snapshot.json>] [--queue <dir>] [--site <url>]
//   list     [--queue <dir>]
//   approve  <id> [--queue <dir>]      prints the post text and the reply link
//   skip     <id> [--queue <dir>]
//   weekly   --league <dir> [--out <dir>]
//   sample   --league <dir> --out <dir>  recap + a refusal from the test vaults (never queued)
import fs from "node:fs";
import path from "node:path";
import { recapCard, refusalCards, rankChangeCards, cardSvg } from "../src/cards.mjs";
import { weekly } from "../src/weekly.mjs";
import { toPng } from "../src/render.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const queue = path.resolve(opt("--queue", path.join(here, "..", "queue")));
const site = opt("--site", process.env.SLEDGIT_SITE ?? process.env.IRON_TRADE_SITE ?? "https://sledgit.com"); // legacy: remove after the server redeploy
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function loadLeague(dir) {
  const snap = readJson(path.join(dir, "snapshot.json"));
  const inputs = readJson(path.join(dir, "inputs.json"));
  const agentEvents = {};
  for (const f of fs.readdirSync(path.join(dir, "agents"))) {
    if (f.endsWith(".json")) { const a = readJson(path.join(dir, "agents", f)); agentEvents[a.entry?.id ?? f.replace(/\.json$/, "")] = a.events ?? []; }
  }
  return { snap, tokens: inputs.tokens, agentEvents };
}

function write(dir, c) {
  fs.mkdirSync(dir, { recursive: true });
  const svg = cardSvg(c);
  fs.writeFileSync(path.join(dir, "card.svg"), svg);
  fs.writeFileSync(path.join(dir, "card.png"), toPng(svg));
  fs.writeFileSync(path.join(dir, "post.json"), JSON.stringify({ id: c.id, kind: c.kind, stamp: c.stamp, network: c.network,
    season: c.season, as_of_ms: c.as_of_ms, derived_sha256: c.derived_sha256, text: c.text, alt: c.alt, link: c.link, status: "pending" }, null, 2) + "\n");
}

const statePath = () => path.join(queue, "state.json");
const loadState = () => (fs.existsSync(statePath()) ? readJson(statePath()) : { seen_codes: [] });

function setStatus(id, status) {
  const p = path.join(queue, id, "post.json");
  if (!fs.existsSync(p)) throw new Error(`no card ${id}`);
  const post = readJson(p);
  post.status = status;
  fs.writeFileSync(p, JSON.stringify(post, null, 2) + "\n");
  if (status === "approved" && post.kind === "refusal") {
    const st = loadState();
    const code = /\(([a-z_]+)\)/.exec(post.text)?.[1];
    if (code && !st.seen_codes.includes(code)) { st.seen_codes.push(code); fs.writeFileSync(statePath(), JSON.stringify(st, null, 2) + "\n"); }
  }
  return post;
}

try {
  if (cmd === "generate") {
    const { snap, tokens, agentEvents } = loadLeague(opt("--league"));
    const prev = opt("--prev") && fs.existsSync(opt("--prev")) ? readJson(opt("--prev")) : null;
    const st = loadState();
    const cards = [recapCard(snap, site), ...refusalCards(snap, { tokens, agentEvents, seenCodes: st.seen_codes }), ...rankChangeCards(prev, snap, site)];
    let added = 0;
    for (const c of cards) { const d = path.join(queue, c.id); if (!fs.existsSync(d)) { write(d, c); added++; console.log(`queued ${c.id}`); } }
    console.log(`${added} new card(s) in ${queue}`);
  } else if (cmd === "list") {
    if (!fs.existsSync(queue)) { console.log("queue empty"); process.exit(0); }
    for (const d of fs.readdirSync(queue).sort()) {
      const p = path.join(queue, d, "post.json");
      if (fs.existsSync(p)) { const post = readJson(p); console.log(`${post.status.padEnd(8)} ${post.id}`); }
    }
  } else if (cmd === "approve") {
    const post = setStatus(args[1], "approved");
    console.log(`--- post (attach ${path.join(queue, post.id, "card.png")}) ---\n${post.text}\n--- reply ---\n${post.link}\n--- alt text ---\n${post.alt}`);
  } else if (cmd === "skip") {
    setStatus(args[1], "skipped"); console.log(`skipped ${args[1]}`);
  } else if (cmd === "weekly") {
    const { snap, tokens, agentEvents } = loadLeague(opt("--league"));
    const out = path.resolve(opt("--out", path.join(here, "..", "out")));
    const w = weekly(snap, { tokens, agentEvents });
    fs.mkdirSync(out, { recursive: true });
    const f = path.join(out, `weekly-${new Date(w.as_of_ms).toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(f, JSON.stringify(w, null, 2) + "\n");
    console.log(f);
  } else if (cmd === "sample") {
    const { snap, tokens, agentEvents } = loadLeague(opt("--league"));
    const out = path.resolve(opt("--out"));
    const cards = [recapCard(snap, site), ...refusalCards(snap, { tokens, agentEvents, includeFixtures: true, max: 1 })];
    for (const c of cards) { write(path.join(out, c.kind), c); console.log(path.join(out, c.kind, "card.png")); }
  } else {
    console.error("usage: posting.mjs generate|list|approve|skip|weekly|sample (see the header)"); process.exit(2);
  }
} catch (e) {
  console.error(`error: ${e.message}`); process.exit(1);
}
