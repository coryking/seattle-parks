#!/usr/bin/env bash
#
# Deploy the Seattle Parks activity-search GET shim to *.workers.dev.
#
# Auth is handled by the chezmoi-synced `wrangler` PATH shim (~/.local/bin/wrangler),
# which injects a least-privilege Workers token from 1Password
# (op://Automation/cloudflare_workers/credential) and defaults CLOUDFLARE_ACCOUNT_ID.
# Nothing to configure here — see coryking/home-it-services#77 and
# .claude/rules/shell-environment.md (headless-creds table).
#
# workers.dev subdomain is `coryking` -> deploys to seattle-activities.coryking.workers.dev
#
# Usage:
#   ./deploy.sh              # deploy
#   ./deploy.sh --dry-run    # bundle + validate, no upload

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prefer the credential-injecting shim; fall back to npx if it's not on PATH.
if command -v wrangler >/dev/null 2>&1; then
  WRANGLER=(wrangler)
else
  WRANGLER=(npx --yes wrangler@4)
fi

if [[ "${1:-}" == "--dry-run" ]]; then
  exec "${WRANGLER[@]}" deploy --dry-run
fi

"${WRANGLER[@]}" deploy

echo
echo "Smoke test:"
echo "  curl 'https://seattle-activities.coryking.workers.dev/?covers=8,9' | head"
