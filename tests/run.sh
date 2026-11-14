#!/usr/bin/env bash
# Sledgit test suite: one command, human report at the end.
#
#   tests/run.sh                  everything (about 5 minutes)
#   tests/run.sh --quick          skip the sandbox suite
#   tests/run.sh --site <url>     also check a deployed site (gated; set SITE_PASSCODE to check pages)
#
# Report: tests/out/report.md and tests/out/report.html. Exit code is non-zero if any check fails.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/out"
QUICK=0; SITE_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --site) SITE_URL="${2:?--site needs a url}"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done
# One run at a time: concurrent runs share tests/out and would wipe each other's logs.
LOCK="$ROOT/tests/.run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "another tests/run.sh is running (remove $LOCK if it isn't)"; exit 2; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
rm -rf "$OUT"; mkdir -p "$OUT/logs"

RESULTS=()   # "status|name|seconds|detail"
FAILED=0

# run <name> <command...>: logs to tests/out/logs/<name>.log
run() {
  local name="$1"; shift
  local log="$OUT/logs/$name.log" t0=$SECONDS
  printf '%-34s ' "$name"
  if (cd "$ROOT" && "$@") >"$log" 2>&1; then
    printf 'PASS (%ss)\n' $((SECONDS - t0))
    RESULTS+=("PASS|$name|$((SECONDS - t0))|$(summary "$log")")
  else
    printf 'FAIL (%ss)  see tests/out/logs/%s.log\n' $((SECONDS - t0)) "$name"
    RESULTS+=("FAIL|$name|$((SECONDS - t0))|$(tail -n 15 "$log" | sed 's/|/¦/g' | tr '\n' '\r')")
    FAILED=$((FAILED + 1))
  fi
}

skip() { printf '%-34s SKIP  %s\n' "$1" "$2"; RESULTS+=("SKIP|$1|0|$2"); }

# One line of evidence for passing steps: the test counts where there are any.
summary() { grep -hE '^test result:' "$1" | sed 's/; finished in.*//' | paste -sd ' ' - ; }

need() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- checks

contracts_unit()    { cd contracts && cargo test -p sledgit-vault --lib && cargo test -p sledgit-factory --lib &&
  (cd vault && cargo test --example deploy_and_lock --example deploy_mainnet --example arena_setup --example season1_mainnet --example testnet_suite); }
contracts_clippy()  { cd contracts && cargo clippy --target wasm32-unknown-unknown -p sledgit-vault -p sledgit-factory -- -D warnings; }
contracts_build()   {
  (cd contracts/vault && cargo near build non-reproducible-wasm) &&
  (cd contracts/test-token && cargo near build non-reproducible-wasm) &&
  (cd contracts/mock-mpc && cargo near build non-reproducible-wasm) &&
  (cd contracts/factory && cargo near build non-reproducible-wasm) &&
  shasum -a 256 contracts/target/near/sledgit_vault/sledgit_vault.wasm
}
# Mainnet's nearcore and the next release (testnet runs it first). Override with NEAR_MAINNET / NEAR_NEXT.
NEAR_MAINNET="${NEAR_MAINNET:-2.13.4}"; NEAR_NEXT="${NEAR_NEXT:-2.14.0}"
contracts_sandbox()      { cd contracts/vault && NEAR_SANDBOX_VERSION="$NEAR_MAINNET" cargo test --test sandbox -- --test-threads 2; }
contracts_sandbox_next() { cd contracts/vault && NEAR_SANDBOX_VERSION="$NEAR_NEXT" cargo test --test sandbox -- --test-threads 2; }
# demo-trader runs on agent/src and agent's own tsx/tsc, so the agent's dependencies come first.
demo_trader_unit()  { { [ -d agent/node_modules ] || (cd agent && npm ci --silent); } && cd demo-trader && npm run --silent typecheck && npm test; }
site_typecheck()    { cd site && npm run --silent typecheck; }
site_unit()         { cd site && npm test; }
agent_unit()        { cd agent && { [ -d node_modules ] || npm ci --silent; } && npm run --silent typecheck && npm test; }
# The MCP server imports agent/src, so the agent's dependencies are installed first.
mcp_unit()          { { [ -d agent/node_modules ] || (cd agent && npm ci --silent); } && cd mcp && { [ -d node_modules ] || npm ci --silent; } && npm run --silent typecheck && npm test; }
site_build()        { cd site && npm run --silent build; }
site_no_private_paths() {
  # The built site must not carry local paths or key-shaped strings. No build means nothing was checked: fail.
  [ -f site/out/index.html ] || { echo "site/out/index.html missing: build the site first"; return 1; }
  # Key shapes: OpenAI/Anthropic (sk-, sk-ant-…), GitHub (ghp_, github_pat_), Slack (xox?-), AWS (AKIA…), NEAR ed25519.
  ! grep -rlIE '/Users/|/home/[a-z]+/|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ed25519:[1-9A-HJ-NP-Za-km-z]{80,}' site/out || return 1
  # The build output is git-ignored, so the repo scan never sees it: scan it here too when gitleaks is installed.
  if need gitleaks; then gitleaks dir site/out --no-banner --redact; fi
}
gate_unit()         { node --test deploy/vercel/middleware.test.mjs; }
posting_unit()      { cd posting && { [ -d node_modules ] || npm ci --silent; } && npm test; }
repo_secret_scan() {
  # Scan exactly the files git would track (respects .gitignore); .gitleaksignore lists reviewed false positives.
  local tmp; tmp="$(mktemp -d)"
  if git rev-parse --git-dir >/dev/null 2>&1; then
    { git ls-files; git ls-files --others --exclude-standard; } | sort -u > "$tmp/files"
    rsync -a --files-from="$tmp/files" ./ "$tmp/tree/"
  else
    rsync -a --exclude node_modules --exclude target --exclude venv --exclude .next --exclude out ./ "$tmp/tree/"
  fi
  cp .gitleaksignore "$tmp/tree/" 2>/dev/null || true
  (cd "$tmp/tree" && gitleaks dir . --no-banner --redact)
  local rc=$?; rm -rf "$tmp"; return $rc
}
gitleaks_missing() { echo "gitleaks is not installed: install it (brew install gitleaks) or set IT_SKIP_SECRET_SCAN=1"; return 1; }
live_site() {
  # Pre-launch the site must be gated and unindexable. With SITE_PASSCODE in the environment, also unlock it.
  local base="${SITE_URL%/}" p code bad=0 jar; jar="$(mktemp)"
  for p in "" leaderboard/ join/ agents/qwen36/ receipt/ llms.txt skill.md api-reference.json; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$base/$p")
    echo "locked $code /$p"; [ "$code" = 401 ] || bad=1
  done
  curl -s --max-time 20 "$base/robots.txt" | grep -A1 '^User-agent: \*$' | grep -q '^Disallow: /$' && echo "robots disallow ok" || { echo "robots.txt not disallowing"; bad=1; }
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$base/og.png"); echo "og.png public $code"; [ "$code" = 200 ] || bad=1
  curl -s --max-time 20 "$base/" | grep -q 'property="og:image"' && echo "gate page carries preview tags" || { echo "gate page has no og:image"; bad=1; }
  curl -sI --max-time 20 "$base/" | grep -qi '^x-robots-tag: noindex' && echo "x-robots-tag ok" || { echo "x-robots-tag missing"; bad=1; }
  if [ -n "${SITE_PASSCODE:-}" ]; then
    curl -s -c "$jar" -o /dev/null --max-time 20 --data-urlencode "code=$SITE_PASSCODE" -d "next=/" "$base/__unlock"
    for p in "" leaderboard/ join/ agents/qwen36/ verify/ developers/ security/ llms.txt skill.md apple-touch-icon.png; do
      code=$(curl -s -b "$jar" -o /dev/null -w '%{http_code}' --max-time 20 "$base/$p")
      echo "unlocked $code /$p"; [ "$code" = 200 ] || bad=1
    done
  else
    echo "SITE_PASSCODE not set: unlocked pages not checked"
  fi
  rm -f "$jar"
  return $bad
}

echo "Sledgit tests: $ROOT"
for t in cargo npm shasum; do need "$t" || { echo "missing required tool: $t"; exit 2; }; done
need cargo-near || { echo "missing cargo-near: cargo install cargo-near --locked"; exit 2; }

run contracts-unit contracts_unit
run contracts-clippy contracts_clippy
run contracts-build contracts_build
if [ $QUICK = 1 ]; then skip contracts-sandbox "--quick"; skip contracts-sandbox-next "--quick"
else run contracts-sandbox contracts_sandbox; run contracts-sandbox-next contracts_sandbox_next; fi
run agent-unit agent_unit
run mcp-unit mcp_unit
run demo-trader-unit demo_trader_unit
run site-typecheck site_typecheck
run site-unit site_unit
run site-build site_build
run site-no-private-paths site_no_private_paths
run gate-unit gate_unit
run posting-unit posting_unit
# A missing scanner is a failure, not a pass: set IT_SKIP_SECRET_SCAN=1 to skip it knowingly (it is then reported).
if need gitleaks; then run repo-secret-scan repo_secret_scan
elif [ "${IT_SKIP_SECRET_SCAN:-0}" = 1 ]; then skip repo-secret-scan "IT_SKIP_SECRET_SCAN=1 (gitleaks not installed)"
else run repo-secret-scan gitleaks_missing; fi
if [ -n "$SITE_URL" ]; then run live-site live_site; fi

# ---------------------------------------------------------------- report

VERSION="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo "no commits")"
DIRTY="$(cd "$ROOT" && [ -n "$(git status --porcelain 2>/dev/null)" ] && echo " + uncommitted changes")"
WASM="$ROOT/contracts/target/near/sledgit_vault/sledgit_vault.wasm"
WASM_SHA="$( [ -f "$WASM" ] && shasum -a 256 "$WASM" | cut -c1-16 || echo "not built")"
PASSN=$(printf '%s\n' "${RESULTS[@]}" | grep -c '^PASS'); SKIPN=$(printf '%s\n' "${RESULTS[@]}" | grep -c '^SKIP')
VERDICT=$([ $FAILED = 0 ] && echo "PASS" || echo "FAIL")
WHEN="$(date -u '+%Y-%m-%d %H:%M UTC')"

{
  echo "# Sledgit test report"
  echo
  echo "**$VERDICT**: $PASSN passed, $FAILED failed, $SKIPN skipped · $WHEN"
  echo
  echo "Version: \`$VERSION\`$DIRTY · vault wasm sha256 \`${WASM_SHA}…\`${SITE_URL:+ · site $SITE_URL}"
  echo
  echo "| Check | Result | Time | Detail |"
  echo "|---|---|---|---|"
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r s n t d <<<"$r"
    [ "$s" = FAIL ] && d="see logs/$n.log"
    echo "| $n | $s | ${t}s | ${d:-} |"
  done
  if [ $FAILED -gt 0 ]; then
    echo; echo "## Failures"
    for r in "${RESULTS[@]}"; do
      IFS='|' read -r s n t d <<<"$r"
      [ "$s" = FAIL ] || continue
      echo; echo "### $n"; echo; echo '```'; printf '%s\n' "$d" | tr '\r' '\n'; echo '```'
    done
  fi
} > "$OUT/report.md"

{
  echo "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Sledgit tests</title>"
  echo "<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1e2329}"
  echo "table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eaecef;padding:6px 8px;text-align:left;vertical-align:top}"
  echo ".PASS{color:#0b8a5f;font-weight:600}.FAIL{color:#d9304e;font-weight:600}.SKIP{color:#707a8a}pre{background:#f5f5f5;padding:10px;overflow:auto;font-size:12px}</style>"
  echo "<h1>Sledgit test report</h1><p class=$VERDICT>$VERDICT: $PASSN passed, $FAILED failed, $SKIPN skipped · $WHEN</p>"
  echo "<p>Version <code>$VERSION</code>$DIRTY · vault wasm sha256 <code>${WASM_SHA}…</code></p><table><tr><th>Check<th>Result<th>Time<th>Detail"
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r s n t d <<<"$r"
    if [ "$s" = FAIL ]; then d="<pre>$(printf '%s' "$d" | tr '\r' '\n' | sed 's/&/\&amp;/g; s/</\&lt;/g')</pre>"; fi
    echo "<tr><td>$n<td class=$s>$s<td>${t}s<td>${d:-}"
  done
  echo "</table>"
} > "$OUT/report.html"

echo
echo "$VERDICT: $PASSN passed, $FAILED failed, $SKIPN skipped. Report: tests/out/report.md"
[ $FAILED = 0 ]
