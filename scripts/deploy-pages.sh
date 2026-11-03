#!/usr/bin/env sh
# Build the static (browser-only) dashboard and publish it to the gh-pages branch.
#   1. data:   uv run python etl/export_static.py   (after ./setup.sh has built data/tenders.duckdb)
#   2. deploy: sh scripts/deploy-pages.sh
# Then in GitHub: Settings -> Pages -> Source: "Deploy from a branch", branch gh-pages, folder / (root).
# The branch is recreated on every deploy, so old data files don't pile up in the git history.
set -eu
cd "$(dirname "$0")/.."
[ -f web/public/data/manifest.json ] || { echo "run etl/export_static.py first"; exit 1; }
# legal links shown in the dashboard footer (leave empty to hide)
export VITE_IMPRINT_URL="${VITE_IMPRINT_URL-https://jakobvongehlen.me/imprint.html}"
export VITE_PRIVACY_URL="${VITE_PRIVACY_URL-https://jakobvongehlen.me/privacy.html#tender-transparency}"
# custom domain for GitHub Pages (empty = serve under <user>.github.io/tendertransparency/)
PAGES_DOMAIN="${PAGES_DOMAIN-tender.jakobvongehlen.me}"
if [ -n "$PAGES_DOMAIN" ]; then export BASE=/; fi
(cd web && pnpm build:static)
TMP=$(mktemp -d)
cp -R web/dist/. "$TMP/"
if [ -n "$PAGES_DOMAIN" ]; then echo "$PAGES_DOMAIN" > "$TMP/CNAME"; fi
cd "$TMP"
git init -q -b gh-pages
git add -A
git commit -q -m "Static build $(date -u +%Y-%m-%dT%H:%MZ)"
git push -f "$(git -C "$OLDPWD" remote get-url origin)" gh-pages
cd - >/dev/null && rm -rf "$TMP"
echo "published to gh-pages"
