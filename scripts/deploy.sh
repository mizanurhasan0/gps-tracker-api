#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "${1:-}" == '--help' ]]; then
  cat <<'HELP'
Usage: npm run deploy

Commit your changes first. Deployment checks the clean main branch, runs tests,
pushes HEAD, uploads that exact commit, backs up PostgreSQL and rebuilds the VPS API.

Optional environment variables:
  DEPLOY_HOST        SSH target (default: hasan@147.79.71.98)
  DEPLOY_PATH        Existing checkout (default: /home/hasan/gps-tracker-api)
  DEPLOY_BRANCH      Local/push branch (default: main)
  DEPLOY_REMOTE      Git remote (default: origin)
  DEPLOY_SSH_KEY     SSH private-key file (default: SSH config/agent)
  DEPLOY_SSH_PORT    SSH port (default: 22)
  TEST_DATABASE_URL  Disposable PostgreSQL URL; runs the full suite when set

Without TEST_DATABASE_URL, database-free tests run. Existing VPS .env is preserved.
SSH host must already be trusted. SSH/sudo passwords are prompted when needed.
HELP
  exit 0
fi
[[ $# == 0 ]] || { echo 'Unknown argument. Use --help.' >&2; exit 1; }

target=${DEPLOY_HOST:-hasan@147.79.71.98}
deploy_path=${DEPLOY_PATH:-/home/hasan/gps-tracker-api}
branch=${DEPLOY_BRANCH:-main}
remote=${DEPLOY_REMOTE:-origin}
ssh_port=${DEPLOY_SSH_PORT:-22}
# Restrict values crossing the SSH remote-shell boundary. Use ~/.ssh/config for aliases.
[[ "$target" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ ]] || { echo 'Invalid DEPLOY_HOST' >&2; exit 1; }
[[ "$deploy_path" =~ ^/[a-zA-Z0-9_./-]+$ && "$deploy_path" != / ]] || { echo 'Invalid DEPLOY_PATH' >&2; exit 1; }
[[ "$ssh_port" =~ ^[0-9]+$ ]] || { echo 'Invalid DEPLOY_SSH_PORT' >&2; exit 1; }
git check-ref-format --branch "$branch" >/dev/null
git remote get-url "$remote" >/dev/null
[[ "$(git branch --show-current)" == "$branch" ]] || { echo "Switch to $branch before deploying." >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit or stash all changes before deploying; nothing was pushed.' >&2; exit 1; }
revision=$(git rev-parse HEAD)

# Keep the SSH control socket below Unix socket path-length limits on macOS.
local_tmp=$(mktemp -d /tmp/gps-api-deploy.XXXXXX)
remote_bundle=''
remote_helper=''
ssh_options=(-o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=auto -o "ControlPath=$local_tmp/ssh" -o ControlPersist=60)
if [[ -n "${DEPLOY_SSH_KEY:-}" ]]; then ssh_options+=(-i "$DEPLOY_SSH_KEY" -o IdentitiesOnly=yes); fi
ssh_command=(ssh "${ssh_options[@]}" -p "$ssh_port" "$target")
scp_command=(scp "${ssh_options[@]}" -P "$ssh_port")
cleanup() {
  if [[ -n "$remote_bundle" ]]; then "${ssh_command[@]}" "rm -f -- '$remote_bundle'" >/dev/null 2>&1 || true; fi
  if [[ -n "$remote_helper" ]]; then "${ssh_command[@]}" "rm -f -- '$remote_helper'" >/dev/null 2>&1 || true; fi
  ssh "${ssh_options[@]}" -p "$ssh_port" -O exit "$target" >/dev/null 2>&1 || true
  rm -rf "$local_tmp"
}
trap cleanup EXIT

echo "Checking VPS access: $target:$deploy_path"
remote_helper=$("${ssh_command[@]}" 'mktemp /tmp/gps-api-helper.XXXXXXXX')
[[ "$remote_helper" =~ ^/tmp/gps-api-helper\.[a-zA-Z0-9]+$ ]] || { remote_helper=''; echo 'Unexpected remote helper path' >&2; exit 1; }
"${scp_command[@]}" scripts/deploy-vps.sh "$target:$remote_helper"
"${ssh_command[@]}" -tt "bash '$remote_helper' '$deploy_path' --check"

npm run typecheck
npm run test:deploy
if [[ -n "${TEST_DATABASE_URL:-${HISTORY_TEST_DATABASE_URL:-}}" ]]; then
  npm test
else
  npm run test:unit
fi
# Prevent publishing different source if another process changed this checkout during checks.
[[ "$(git rev-parse HEAD)" == "$revision" && -z "$(git status --porcelain)" ]] || { echo 'Checkout changed during validation; retry after committing.' >&2; exit 1; }
echo "Pushing $revision to $remote/$branch"
git push "$remote" "$revision:refs/heads/$branch"
published=$(git ls-remote "$remote" "refs/heads/$branch" | awk '{print $1}')
[[ "$published" == "$revision" ]] || { echo 'Remote branch changed; deployment stopped.' >&2; exit 1; }

git bundle create "$local_tmp/release.bundle" "$branch"
git bundle verify "$local_tmp/release.bundle" >/dev/null
remote_bundle=$("${ssh_command[@]}" 'mktemp /tmp/gps-api-release.XXXXXXXX')
[[ "$remote_bundle" =~ ^/tmp/gps-api-release\.[a-zA-Z0-9]+$ ]] || { remote_bundle=''; echo 'Unexpected remote temporary path' >&2; exit 1; }
"${scp_command[@]}" "$local_tmp/release.bundle" "$target:$remote_bundle"
"${ssh_command[@]}" -tt "bash '$remote_helper' '$deploy_path' '$revision' '$remote_bundle'"
echo "Deployed $revision to $target"
