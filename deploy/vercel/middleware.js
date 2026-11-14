// Passcode gate for the pre-launch site. The passcode is the SITE_PASSCODE environment variable in Vercel, never in
// this repo. A correct code sets a 30-day cookie: an expiry plus an HMAC over it, keyed by SITE_COOKIE_SECRET (a
// separate random secret), so a leaked cookie reveals nothing about the passcode and every cookie can be revoked by
// rotating the secret. Changing the passcode also invalidates every cookie.
export const config = { matcher: "/((?!_vercel).*)" };

const COOKIE = "it_pass";
const MAX_AGE_S = 2_592_000;
// Served without the passcode so link previews can show the brand. Nothing else is public.
const PUBLIC = new Set(["/og.png", "/icon-v2.svg", "/icon-32.png", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/favicon.svg"]);
// Wrong codes: a delay that doubles per recent failure from the same IP, and a cap on unlock attempts in flight, so
// parallel guessing is bounded too. Edge isolates don't share memory: a Vercel WAF rate-limit rule on POST /__unlock
// is the global limit (tests/README.md).
const WRONG_CODE_DELAY_MS = 1500;
const MAX_DELAY_MS = 30_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_IN_FLIGHT = 8;
const TITLE = "Sledgit: the leaderboard for AI trading agents";
const DESC = "Sledgit: the leaderboard for AI trading agents. Limits they can't break, records anyone can check. Built on NEAR.";
// Sent on every response the gate makes (vercel.json adds the same to static files): no indexing, no framing.
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };

const fails = new Map(); // ip -> { n, last }
let inFlight = 0;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

/** The cookie key: SITE_COOKIE_SECRET, bound to the current passcode so changing either revokes every cookie. */
async function cookieKey(code, secret) {
  // Without a separate secret the key falls back to the passcode alone (the old behaviour); set SITE_COOKIE_SECRET.
  const material = enc.encode(`sledgit-cookie:${secret || ""}:${await sha256(`sledgit:${code}`)}`);
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function mac(key, exp) {
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`v1.${exp}`)));
}

/** Constant-time comparison of two hex strings. */
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function validCookie(value, key, now) {
  const m = /^v1\.(\d{10})\.([0-9a-f]{64})$/.exec(value || "");
  if (!m || Number(m[1]) <= Math.floor(now / 1000)) return false;
  return same(m[2], await mac(key, m[1]));
}

/**
 * Where to send the visitor after unlocking: a path on this site only. Backslashes, control characters and anything
 * that resolves to another origin (`//x`, `/\x`, `/\t/x`) fall back to "/".
 */
export function safeNext(raw, origin) {
  const s = String(raw || "/");
  if (!s.startsWith("/") || s.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(s)) return "/";
  let u;
  try {
    u = new URL(s, origin);
  } catch {
    return "/";
  }
  return u.origin === origin ? u.pathname + u.search : "/";
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(next, wrong, origin, status = 401) {
  const o = esc(origin);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${TITLE}</title><meta name="description" content="${DESC}"><link rel="icon" href="/icon-v2.svg">
<meta property="og:type" content="website"><meta property="og:site_name" content="${TITLE}"><meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}"><meta property="og:image" content="${o}/og.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${TITLE}">
<meta name="twitter:description" content="${DESC}"><meta name="twitter:image" content="${o}/og.png"><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0D0C;color:#F2F5F0;font:16px/1.5 system-ui,sans-serif}
form{width:min(320px,calc(100vw - 32px));display:grid;gap:12px}h1{font:900 34px/1 system-ui,sans-serif;letter-spacing:.02em;margin:0 0 4px}h1 b{color:#D4FF3A}p{margin:0;color:#8D958F;font-size:14px}
input{font:inherit;padding:12px;border-radius:10px;border:1px solid #262B27;background:#131614;color:#F2F5F0}
button{font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:#D4FF3A;color:#0B0D0C;text-transform:uppercase;letter-spacing:.06em}.e{color:#FF4D3D}
</style></head><body><form method="post" action="/__unlock"><h1>S<b>LEDG</b>IT</h1><p>Preview. Enter the passcode.</p>
<input type="password" name="code" autocomplete="current-password" autofocus required aria-label="Passcode">
<input type="hidden" name="next" value="${esc(next)}">${wrong ? `<p class="e">${status === 429 ? "Too many attempts. Try again shortly." : "Wrong passcode."}</p>` : ""}
<button>Enter</button></form></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...NOINDEX } });
}

const clientIp = (req) => (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "?").split(",")[0].trim();

export default async function middleware(req, deps = {}) {
  const now = (deps.now ?? Date.now)();
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = new URL(req.url);
  if (url.pathname === "/robots.txt") {
    // Link-preview crawlers may read the passcode page (it carries only the preview tags); search engines may not.
    const rules = "User-agent: Twitterbot\nAllow: /\n\nUser-agent: facebookexternalhit\nAllow: /\n\nUser-agent: *\nDisallow: /\n";
    return new Response(rules, { headers: { "Content-Type": "text/plain", ...NOINDEX } });
  }
  if (PUBLIC.has(url.pathname)) return new Response(null, { headers: { "x-middleware-next": "1", ...NOINDEX } });
  const code = process.env.SITE_PASSCODE;
  if (!code) return new Response("Locked: SITE_PASSCODE is not set.", { status: 503, headers: NOINDEX });
  const key = await cookieKey(code, process.env.SITE_COOKIE_SECRET);

  if (url.pathname === "/__unlock" && req.method === "POST") {
    const ip = clientIp(req);
    if (inFlight >= MAX_IN_FLIGHT) return page("/", true, url.origin, 429);
    inFlight++;
    try {
      const form = await req.formData();
      const next = safeNext(form.get("next"), url.origin);
      const ok = same(await sha256(`sledgit:${String(form.get("code") || "")}`), await sha256(`sledgit:${code}`));
      if (!ok) {
        const f = fails.get(ip);
        const n = f && now - f.last < FAIL_WINDOW_MS ? f.n + 1 : 1;
        fails.set(ip, { n, last: now });
        if (fails.size > 10_000) fails.clear(); // bounded memory
        await sleep(Math.min(MAX_DELAY_MS, WRONG_CODE_DELAY_MS * 2 ** (n - 1))); // slows guessing; see tests/README.md
        return page(next, true, url.origin);
      }
      fails.delete(ip);
      const exp = String(Math.floor(now / 1000) + MAX_AGE_S);
      return new Response(null, { status: 303, headers: { Location: next, ...NOINDEX,
        "Set-Cookie": `${COOKIE}=v1.${exp}.${await mac(key, exp)}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax` } });
    } finally {
      inFlight--;
    }
  }

  const value = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (await validCookie(value, key, now)) return new Response(null, { headers: { "x-middleware-next": "1", ...NOINDEX } });
  return page(url.pathname + url.search, false, url.origin);
}
