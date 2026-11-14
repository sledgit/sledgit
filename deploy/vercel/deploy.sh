#!/usr/bin/env bash
# Build the site and deploy it to Vercel. Public by default. SITE_GATE=1 puts it back behind the passcode gate
# (middleware.js, plus noindex on static files); that needs SITE_PASSCODE set once in the Vercel project:
#   vercel env add SITE_PASSCODE production
# Uploads only the built site (and the gate when on); no source code.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${VERCEL_PROJECT:-iron-trade}"
STAGE="$(mktemp -d)/$PROJECT"
# A production build only: refuse a shell with any test switch set, build with a clean environment, then make sure no
# test hook reached the bundle (the mock wallet is compiled out unless NEXT_PUBLIC_OWNER_MOCK_WALLET=1 at build time).
if env | grep -qE '^NEXT_PUBLIC_[A-Z_]*MOCK[A-Z_]*='; then echo "refusing: a NEXT_PUBLIC_*MOCK* variable is set in this shell" >&2; exit 1; fi
# Public: pages, sitemap and robots.txt allow indexing. Gated: all of them stay closed.
INDEXABLE=1
if [ "${SITE_GATE:-0}" = 1 ]; then INDEXABLE=0; fi
(cd "$ROOT/site" && env -i PATH="$PATH" HOME="$HOME" NEXT_PUBLIC_INDEXABLE="$INDEXABLE" npm run --silent build)
if grep -rqs -e "__itMockWallet" -e "__itSent" "$ROOT/site/out"; then echo "refusing: the test wallet hook is in the build" >&2; exit 1; fi
mkdir -p "$STAGE/public"
cp -R "$ROOT/site/out/." "$STAGE/public/"
if [ "$INDEXABLE" = 1 ]; then printf 'User-agent: *\nAllow: /\nSitemap: https://sledgit.com/sitemap.xml\n' > "$STAGE/public/robots.txt"; fi
cp "$ROOT/deploy/vercel/vercel.json" "$STAGE/"
if [ "${SITE_GATE:-0}" = 1 ]; then
  cp "$ROOT/deploy/vercel/middleware.js" "$STAGE/"
  node -e 'const f=process.argv[1],v=JSON.parse(require("fs").readFileSync(f));v.headers[0].headers.unshift({key:"X-Robots-Tag",value:"noindex, nofollow, noarchive"});require("fs").writeFileSync(f,JSON.stringify(v,null,2))' "$STAGE/vercel.json"
fi
cd "$STAGE"
vercel link --yes --project "$PROJECT" >/dev/null
vercel deploy --prod --yes
