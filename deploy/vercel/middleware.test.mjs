// Passcode gate tests (audit round 3 R3-07, R3-08). Run: node --test deploy/vercel/middleware.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import middleware, { safeNext } from "./middleware.js";

const ORIGIN = "https://site.example";
process.env.SITE_PASSCODE = "correct horse battery";
// Test-only secrets, generated so no key-shaped literal sits in the repo.
const SECRET_A = "test-secret-".padEnd(32, "a");
const SECRET_B = "test-secret-".padEnd(32, "b");
process.env.SITE_COOKIE_SECRET = SECRET_A;
const noSleep = { sleep: async () => {} };

const unlock = (code, next = "/", ip = "203.0.113.1", deps = noSleep) => {
  const body = new URLSearchParams({ code, next });
  return middleware(new Request(`${ORIGIN}/__unlock`, { method: "POST", body, headers: { "x-real-ip": ip } }), deps);
};
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
const get = (path, cookie, deps = {}) => middleware(new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} }), deps);

test("R3-07: next is same-origin only; the reviewer's payloads and their variants fall back to /", () => {
  for (const p of ["/\\evil.com", "/\t/evil.com", "/\\/evil.com", "//evil.com", "/\\\\evil.com", "https://evil.com", "evil.com",
    "/\n/evil.com", "/\u0000/evil.com", "/\r\n//evil.com"]) {
    assert.equal(safeNext(p, ORIGIN), "/", JSON.stringify(p));
  }
  assert.equal(safeNext("/leaderboard/?net=testnet", ORIGIN), "/leaderboard/?net=testnet");
  // Encoded slashes stay a path on this site.
  assert.equal(new URL(safeNext("/%2F%2Fevil.com", ORIGIN), ORIGIN).origin, ORIGIN);
  assert.equal(new URL(safeNext("/%5Cevil.com", ORIGIN), ORIGIN).origin, ORIGIN);
});

test("R3-07: a correct code redirects only within the site", async () => {
  for (const p of ["/\\evil.com", "/\t/evil.com", "/\\/evil.com"]) {
    const res = await unlock("correct horse battery", p, "203.0.113.9");
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
  }
});

test("R3-08: the cookie is an expiring HMAC under SITE_COOKIE_SECRET, not a hash of the passcode", async () => {
  const res = await unlock("correct horse battery", "/", "203.0.113.2");
  const c = cookieOf(res);
  assert.match(c, /^it_pass=v1\.\d{10}\.[0-9a-f]{64}$/);
  assert.equal((await get("/", c)).headers.get("x-middleware-next"), "1");
  // A different secret (rotation) or passcode revokes it.
  process.env.SITE_COOKIE_SECRET = SECRET_B;
  assert.equal((await get("/", c)).status, 401);
  process.env.SITE_COOKIE_SECRET = SECRET_A;
  process.env.SITE_PASSCODE = "another passcode";
  assert.equal((await get("/", c)).status, 401);
  process.env.SITE_PASSCODE = "correct horse battery";
  // Expired, tampered and old-format cookies are refused.
  const [, exp, mac] = /v1\.(\d+)\.([0-9a-f]+)/.exec(c);
  assert.equal((await get("/", c, { now: () => (Number(exp) + 1) * 1000 })).status, 401);
  assert.equal((await get("/", `it_pass=v1.${Number(exp) + 999}.${mac}`)).status, 401);
  assert.equal((await get("/", `it_pass=${"a".repeat(64)}`)).status, 401);
});

test("R3-08: wrong codes from one IP wait longer each time; parallel attempts beyond the cap get 429", async () => {
  const waits = [];
  const deps = { sleep: async (ms) => { waits.push(ms); } };
  for (let i = 0; i < 4; i++) assert.equal((await unlock("wrong", "/", "198.51.100.7", deps)).status, 401);
  assert.deepEqual(waits, [1500, 3000, 6000, 12000]);
  // A success clears the IP's count.
  await unlock("correct horse battery", "/", "198.51.100.7", deps);
  waits.length = 0;
  await unlock("wrong", "/", "198.51.100.7", deps);
  assert.deepEqual(waits, [1500]);

  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { sleep: () => gate };
  const pending = Array.from({ length: 8 }, (_, i) => unlock("wrong", "/", `192.0.2.${i}`, slow));
  const over = await unlock("wrong", "/", "192.0.2.99", slow);
  assert.equal(over.status, 429);
  release();
  await Promise.all(pending);
});

test("the gate page escapes the origin and stays noindex", async () => {
  const res = await get("/x");
  assert.equal(res.status, 401);
  assert.match(res.headers.get("x-robots-tag"), /noindex/);
  assert.match(await res.text(), /og:image" content="https:\/\/site\.example\/og\.png"/);
});
