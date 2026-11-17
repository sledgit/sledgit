# Tests

One command runs everything and ends with a report:

```
tests/run.sh                 # all checks, about 5 minutes
tests/run.sh --quick         # skip the sandbox suite
tests/run.sh --site <url>    # also check a deployed copy of the site
SITE_PASSCODE=… tests/run.sh --quick --site https://sledgit.com
```

The report goes to `tests/out/report.md` and `tests/out/report.html`, with a verdict line, the version tested and
the vault WASM hash. Each step's full log is in `tests/out/logs/`. The exit code is non-zero if anything fails,
so the suite can run from cron or CI.

## What it checks

| Check | What it proves |
|---|---|
| contracts-unit | Every vault rule and failure path, using mocked chain calls; plus a property test that caps can never be exceeded |
| contracts-clippy | No lint warnings on the WASM target |
| contracts-build | Vault and test token build with cargo-near; prints the vault WASM sha256 |
| contracts-sandbox | 27 tests: the real vault WASM against the real mainnet binaries of Rhea (v1.9.21) and NEAR Intents (`intents.near` v0.4.5), pinned with hashes in `contracts/vault/tests/res/`, in a local NEAR sandbox running **mainnet's nearcore (2.13.4)**. Rhea: a full swap, refusals, access control, private callbacks, stranger deposits refunded, freeze, payout failure detection and recovery, keyless (immutable) vault. NEAR Intents: a swap signed by the vault and settled against a solver, replay, underpayment and tampering rejected, cancel, one open intent, owner-only fund moves, a foreign key can't sign for the vault. Signing uses `contracts/mock-mpc`, a test stand-in for Chain Signatures with the same API |
| contracts-sandbox-next | The same 27 tests on the **next nearcore release (2.14.0)**, which testnet runs first, so a protocol upgrade can't surprise us. Override versions with `NEAR_MAINNET` / `NEAR_NEXT` |
| agent-unit | The agent runner: receipts, decisions, refusal handling, receipt verification (only children of a locked factory with its pinned code verify; dry runs fail), the TEE verifier on real recorded NEAR AI evidence, and the pinned NEAR AI measurement policy (other software gets no badge) |
| mcp-unit | The read-only MCP server: every tool on a mocked chain, vault provenance, forged-event, failed-receipt, oversized-body and HTTP-gate cases, the real TEE bundle, and the packaged skill matching agent/SKILL.md |
| site-typecheck, site-build | The website compiles and exports |
| site-unit | Owner app: exact unit conversion, policy form ↔ contract args (mirrors `Policy::validate`), every transaction builder, gas against the contract's own `TG_` minimums |
| site-no-private-paths | The built site carries no local paths or key-shaped strings (OpenAI/Anthropic `sk-…`, GitHub, Slack, AWS, NEAR ed25519); with gitleaks installed, `site/out` is also scanned, since the repo scan never sees the git-ignored build |
| gate-unit | The passcode gate (`deploy/vercel/middleware.js`): redirects after unlocking stay on the site (backslash, tab and `//` tricks fall back to `/`); the cookie is an expiring HMAC under `SITE_COOKIE_SECRET`, revoked by rotating the secret or changing the passcode; wrong codes from one IP wait 1.5 s, 3 s, 6 s… (up to 30 s) and more than 8 unlock attempts in flight get 429 |
| posting-unit | Post cards (`posting/`): the TESTNET/MAINNET stamp must match every account, token and pool in the snapshot; text ≤ 280 characters with no links, mentions or private names; no agent-written text reaches a card; refusal amounts and caps from the vault's own events; deterministic output; the weekly race data schema |
| repo-secret-scan | gitleaks over exactly the files git would track; reviewed false positives are listed in `.gitleaksignore`. A missing gitleaks **fails** this check; `IT_SKIP_SECRET_SCAN=1` skips it knowingly and the report shows the skip |
| live-site | With `--site`: every page is behind the passcode gate (401); only the link-preview image and icons are public, and the gate page carries the preview tags; `robots.txt` admits only the X and Facebook preview crawlers and disallows everyone else; every response says `noindex`. With `SITE_PASSCODE` in the environment it also unlocks and checks every page returns 200 |

## Requirements

Rust (the toolchain in `contracts/rust-toolchain.toml` installs automatically), `cargo install cargo-near --locked`,
Node 20+, `shasum`, `rsync`; `gitleaks` is required for the secret scan (set `IT_SKIP_SECRET_SCAN=1` to skip it knowingly). The sandbox suite downloads
the NEAR sandbox binary on first run.

## Version pins

`near-sdk` is pinned to 5.29.1. Version 5.30 imports the host function
`promise_batch_action_universal_state_init`, which only exists from nearcore 2.14 (protocol 88). On mainnet's 2.13.4
(protocol 86, checked 2026-10-28), 5.30 contracts fail to deploy ("Link Error: unknown or invalid import"); the
`contracts-sandbox` check catches this. Move to 5.30 once mainnet runs 2.14. The Rust toolchain is 1.96.0, matching
NEAR's reproducible-build image (`sourcescan/cargo-near:0.21.1-rust-1.96.0`).

No secrets are needed. The only one read is the optional `SITE_PASSCODE`, from the environment, never printed.
The deployed gate also uses `SITE_COOKIE_SECRET` (a random value set in Vercel, never in the repo). Edge isolates don't
share memory, so the per-IP delay and the in-flight cap are per isolate: the global limit is a Vercel WAF rate-limit
rule on `POST /__unlock`. Use a random passcode of 16+ characters. Every bug fix lands with a test here.
