import { readFileSync } from "node:fs";
// Post cards built from a league snapshot. Pure functions: the same snapshot gives the same cards.
// Card text uses fixed templates, registry names, numbers and refusal codes only; never agent-written notes.

const NETWORKS = {
  testnet: { stamp: "TESTNET", suffix: ".testnet", pools: [1103], explorer: "https://testnet.nearblocks.io/txns/" },
  // Mainnet USDC is the implicit (64-hex) account below: implicit ids carry no network suffix, so the exact id is listed.
  mainnet: { stamp: "MAINNET", suffix: ".near", pools: [4512], explorer: "https://nearblocks.io/txns/",
    implicitTokens: ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"] },
};
export const MAX_TEXT = 280;
const DAY_MS = 86_400_000;
// Words and names that must never reach a public card (marketing plan rules).
const FORBIDDEN = [/@/, /guarantee/i, /profit/i, /\bearn/i];
// Names that must never appear in a card live outside the public repo: one per line in the file named by
// SLEDGIT_BLOCKLIST (the daily job supplies it). Without it only the generic rules above apply.
const BLOCKLIST = (() => {
  const f = process.env.SLEDGIT_BLOCKLIST ?? process.env.IRON_TRADE_BLOCKLIST; // legacy: remove after the server redeploy
  if (!f) return [];
  return readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
})();
// The vault's refusal codes (same wording as site/src/app/refusals/page.tsx).
const REFUSAL_TEXT = {
  trade_cap: "per-trade cap", daily_cap: "24 h cap", rate_limit: "trades-per-hour limit", pair_not_allowed: "pair not allowed",
  unpriceable: "can't be priced", frozen: "vault frozen by its owner", busy: "another swap in flight",
  unsettled: "last intent not recorded", intents_not_set_up: "cross-chain not set up", zero_amount: "zero amount",
};

/** The network's stamp, after checking every account, token and pool in the snapshot belongs to that network. */
export function stampFor(snap) {
  const net = NETWORKS[snap.network];
  if (!net) throw new Error(`unknown network ${JSON.stringify(snap.network)}`);
  const wrong = (id) => !id.endsWith(net.suffix);
  for (const e of snap.entries) if (wrong(e.account)) throw new Error(`stamp mismatch: ${e.account} is not a ${snap.network} account`);
  for (const p of snap.season.canonical_pools) if (!net.pools.includes(p)) throw new Error(`stamp mismatch: pool ${p} is not a ${snap.network} pool`);
  for (const e of snap.entries) for (const d of e.decisions) {
    for (const t of [d.token_in, d.token_out]) if (t && !t.endsWith(net.suffix) && !(net.implicitTokens ?? []).includes(t)) throw new Error(`stamp mismatch: token ${t} on ${snap.network}`);
  }
  return net.stamp;
}

const pct = (x) => (x == null ? "n/a" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`);
const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const seasonDay = (snap) => Math.floor((snap.as_of_ms - snap.season.start_ms) / DAY_MS) + 1;
const scored = (snap) => snap.entries.filter((e) => e.kind === "arena" || e.kind === "house");
const registered = (e) => !e.id.startsWith("u-");

/** Exact token amount in human units, no float rounding of the integer part. */
export function units(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, 4);
  return frac ? `${int}.${frac}` : int;
}

export function checkText(text) {
  if ([...text].length > MAX_TEXT) throw new Error(`text is ${[...text].length} characters (max ${MAX_TEXT})`);
  if (/https?:\/\//.test(text)) throw new Error("links go in the reply, not the post");
  for (const re of [...FORBIDDEN, ...BLOCKLIST]) if (re.test(text)) throw new Error(`text contains a forbidden term: ${re}`);
  return text;
}

function card(kind, snap, stamp, body) {
  const id = `${snap.network}-${snap.season.id}-${kind}-${body.key}`;
  const text = checkText(`${stamp} · ${body.text}`);
  return { id, kind, network: snap.network, stamp, season: snap.season.id, as_of_ms: snap.as_of_ms,
    derived_sha256: snap.derived_sha256, text, alt: checkText(`${stamp}. ${body.alt}`), link: body.link, lines: body.lines, title: body.title };
}

/** Daily recap: ranked entries against the hold line, refusals in the last 24 h, proof tiers. */
export function recapCard(snap, siteUrl) {
  const stamp = stampFor(snap);
  const es = scored(snap).filter(registered);
  const ranked = es.filter((e) => e.ranked);
  const above = ranked.filter((e) => e.vs_hold_after_gas > 0).length;
  const since = snap.as_of_ms - DAY_MS;
  const refusals = es.reduce((n, e) => n + e.decisions.filter((d) => d.event === "refuse" && d.block_time_ms > since).length, 0);
  const tier = (t) => es.filter((e) => e.proof.tier === t).length;
  const top = ranked.slice(0, 3).map((e, i) => `${i + 1}. ${e.name} ${pct(e.vs_hold_after_gas)} vs hold`);
  const day = seasonDay(snap);
  const headline = ranked.length ? `${above} of ${ranked.length} ranked entries are above the hold line after costs.` : `No entry is ranked yet (ranking starts on day 7).`;
  // Long names can push the post past the limit: drop top-list lines from the bottom until it fits (the image keeps all 3).
  const post = (k) => [`Season ${snap.season.id}, day ${day}.`, headline, ...top.slice(0, k), `Refusals in 24 h: ${refusals}.`,
    `Proof: ${tier("tee")} attested model, ${tier("rules")} open rules, ${tier("self")} self-reported.`, `Receipts ↓`].join("\n");
  let k = top.length;
  while (k > 0 && [...`${stamp} · ${post(k)}`].length > MAX_TEXT) k--;
  const text = post(k);
  const lines = [`Season ${snap.season.id} · day ${day}`, headline, ...top,
    `Refusals in the last 24 h: ${refusals}`, `Attested model ${tier("tee")} · Open rules ${tier("rules")} · Self-reported ${tier("self")}`];
  return card("recap", snap, stamp, { key: `d${day}-${snap.as_of_ms}`, title: "Daily recap", lines, text,
    alt: `Sledgit daily recap, season ${snap.season.id} day ${day}. ${headline} ${refusals} refusals in the last 24 hours.`, link: `${siteUrl}/leaderboard/` });
}

/** The policy in force when a decision was made: init, then each policy_applied before it. */
function policyAt(events, t) {
  let p = null;
  for (const ev of [...events].sort((a, b) => a.block_time_ms - b.block_time_ms)) {
    if (ev.block_time_ms > t) break;
    if ((ev.event === "init" || ev.event === "policy_applied") && ev.data?.policy) p = ev.data.policy;
  }
  return p;
}

/** Refusal cards: at most `max` in the last 24 h, preferring a code not posted before or an attempt over 2× its cap. */
export function refusalCards(snap, { tokens, agentEvents, seenCodes = [], max = 2, includeFixtures = false }) {
  const stamp = stampFor(snap);
  const net = NETWORKS[snap.network];
  const tok = Object.fromEntries(tokens.map((t) => [t.id, t]));
  const since = snap.as_of_ms - DAY_MS;
  const pool = snap.entries.filter((e) => registered(e) && (includeFixtures || e.kind === "arena" || e.kind === "house"));
  const cands = [];
  for (const e of pool) for (const d of e.decisions) {
    if (d.event !== "refuse" || (!includeFixtures && d.block_time_ms <= since)) continue;
    const t = tok[d.token_in];
    if (!t || !d.amount_in || !d.code) continue;
    const pol = policyAt(agentEvents[e.id] ?? [], d.block_time_ms);
    const lim = pol?.tokens?.find((x) => x.token === d.token_in);
    const cap = d.code === "trade_cap" ? lim?.max_per_trade : d.code === "daily_cap" ? lim?.max_per_day : null;
    const ratio = cap ? Number((BigInt(d.amount_in) * 1000n) / BigInt(cap)) / 1000 : 0;
    cands.push({ e, d, t, cap, ratio, fresh: !seenCodes.includes(d.code) });
  }
  cands.sort((a, b) => (b.fresh - a.fresh) || (b.ratio - a.ratio) || (b.d.block_time_ms - a.d.block_time_ms) || (a.d.tx < b.d.tx ? -1 : 1));
  return cands.filter((c) => includeFixtures || c.fresh || c.ratio > 2).slice(0, max).map(({ e, d, t, cap }) => {
    const amount = `${units(d.amount_in, t.decimals)} ${t.symbol}`;
    const rule = REFUSAL_TEXT[d.code] ?? d.code;
    const limit = cap ? `; ${rule} ${units(cap, t.decimals)} ${t.symbol}` : `; ${rule}`;
    const who = e.name;
    const text = `${who} asked to ${d.side} ${amount}${limit}. Refused by the contract (${d.code}). The refusal is a receipt ↓`;
    return card("refusal", snap, stamp, { key: `${e.id}-s${d.seq}`, title: "Refused by the vault",
      lines: [`${who}`, `asked to ${d.side} ${amount}`, cap ? `${rule}: ${units(cap, t.decimals)} ${t.symbol}` : rule, `refused · ${d.code}`, utc(d.block_time_ms)],
      text, alt: `${who} asked to ${d.side} ${amount}${limit}. The vault refused with code ${d.code}.`, link: `${net.explorer}${d.tx}` });
  });
}

/** Rank change: a ranked entry enters or leaves the top 3, or crosses the hold line. */
export function rankChangeCards(prev, snap, siteUrl) {
  const stamp = stampFor(snap);
  if (prev && prev.network !== snap.network) throw new Error("previous snapshot is from another network");
  const rank = (s) => new Map(scored(s).filter((e) => e.ranked && registered(e)).map((e, i) => [e.id, { i, e }]));
  const was = prev ? rank(prev) : new Map(), now = rank(snap);
  const out = [];
  for (const [id, { i, e }] of now) {
    const p = was.get(id);
    const crossed = p && Math.sign(p.e.vs_hold_after_gas) !== Math.sign(e.vs_hold_after_gas);
    const top = i < 3 && (!p || p.i >= 3);
    if (!crossed && !top) continue;
    const side = e.vs_hold_after_gas > 0 ? "above" : "below";
    const what = top ? `entered the top 3 (#${i + 1})` : `moved ${side} the hold line`;
    out.push(card("rank", snap, stamp, { key: `${id}-${snap.as_of_ms}`, title: "Rank change",
      lines: [e.name, what, `${pct(e.vs_hold_after_gas)} vs hold after costs`, `Proof: ${e.proof.tier}`],
      text: `${e.name} ${what}: ${pct(e.vs_hold_after_gas)} vs holding, after costs. Proof tier: ${e.proof.tier}. Record ↓`,
      alt: `${e.name} ${what}, ${pct(e.vs_hold_after_gas)} against holding after costs.`, link: `${siteUrl}/agents/${id}/` }));
  }
  return out.slice(0, 1);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 1200×675 SVG. Deterministic: no clock, no randomness. */
export function cardSvg(c) {
  const stampColor = c.stamp === "MAINNET" ? "#2fb36b" : "#d9a33a";
  const rows = c.lines.map((l, i) => `<text x="72" y="${250 + i * 64}" font-size="${i === 0 ? 40 : 32}" fill="${i === 0 ? "#eaf2fb" : "#9fb3c8"}" font-family="Helvetica, Arial, sans-serif">${esc(l)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">` +
    `<rect width="1200" height="675" fill="#090d13"/>` +
    `<rect x="72" y="64" width="${c.stamp.length * 22 + 36}" height="48" rx="8" fill="${stampColor}"/>` +
    `<text x="90" y="98" font-size="28" font-weight="700" fill="#090d13" font-family="Helvetica, Arial, sans-serif">${c.stamp}</text>` +
    `<text x="72" y="182" font-size="56" font-weight="700" fill="#3d9be9" font-family="Helvetica, Arial, sans-serif">${esc(c.title)}</text>` +
    rows +
    `<text x="72" y="620" font-size="24" fill="#5f7286" font-family="Helvetica, Arial, sans-serif">Sledgit · season ${esc(c.season)} · as of ${esc(utc(c.as_of_ms))} · receipts on chain</text>` +
    `</svg>`;
}
