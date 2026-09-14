#!/usr/bin/env bash
# Invoked over SSH by deploy.sh; do not source this file or production .env.
set -euo pipefail
umask 077

deploy_path=${1:?Missing deployment path}
revision=${2:?Missing revision or --check}
cd "$deploy_path"
[[ -f compose.yml && -f .env ]] || { echo 'Existing compose.yml and private .env are required.' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'VPS checkout has local changes; refusing to overwrite them.' >&2; exit 1; }
command -v flock >/dev/null
if docker info >/dev/null 2>&1; then
  docker_command=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  docker_command=(sudo -n docker)
elif [[ -t 0 ]] && sudo -v && sudo -n docker info >/dev/null 2>&1; then
  docker_command=(sudo -n docker)
else
  echo 'Docker access requires Docker privileges or sudo; run deployment from an interactive terminal for password prompts.' >&2
  exit 1
fi
compose=("${docker_command[@]}" compose --ansi never)
"${compose[@]}" version
"${compose[@]}" config --quiet
[[ -n "$("${compose[@]}" ps -q postgres)" ]] || { echo 'Existing PostgreSQL service must be running.' >&2; exit 1; }
if [[ "$revision" == '--check' ]]; then
  echo "VPS ready at $(git rev-parse --short HEAD)"
  exit 0
fi
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid release commit' >&2; exit 1; }
bundle=${3:?Missing release bundle}
[[ "$bundle" =~ ^/tmp/gps-api-release\.[a-zA-Z0-9]+$ && -f "$bundle" ]] || { echo 'Invalid release bundle' >&2; exit 1; }

# One deployment per checkout, including builds, backups and health verification.
exec 9>"$(git rev-parse --git-dir)/deploy.lock"
flock -n 9 || { echo 'Another deployment is already running.' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'VPS checkout changed before the deployment lock was acquired.' >&2; exit 1; }
git bundle verify "$bundle"
git fetch --no-tags "$bundle" 'refs/heads/*:refs/deploy/*'
git cat-file -e "$revision^{commit}"
git merge-base --is-ancestor HEAD "$revision" || { echo 'Release is not a fast-forward from the VPS; manual review required.' >&2; exit 1; }
previous=$(git rev-parse HEAD)
backup_dir="$(dirname "$deploy_path")/gps-deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:12}-$$"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
printf '%s\n' "$previous" > "$backup_dir/previous-commit"
printf '%s\n' "$revision" > "$backup_dir/release-commit"
cp .env compose.yml "$backup_dir/"
git archive "$previous" | gzip > "$backup_dir/previous-source.tar.gz"
api_id=$("${compose[@]}" ps -q api)
if [[ -n "$api_id" ]]; then
  previous_image=$("${docker_command[@]}" inspect --format '{{.Image}}' "$api_id")
  rollback_image="gps-tracker-api-rollback:${previous:0:12}-$(date -u +%Y%m%d%H%M%S)"
  "${docker_command[@]}" image tag "$previous_image" "$rollback_image"
  printf 'services:\n  api:\n    image: %s\n' "$rollback_image" > "$backup_dir/rollback.compose.yml"
fi
echo "Backup directory: $backup_dir"
trap 'echo "Deployment failed. Inspect the service and backup at $backup_dir; no database restore was attempted." >&2' ERR

git merge --ff-only "$revision"
[[ "$(git rev-parse HEAD)" == "$revision" ]] || { echo 'Checkout does not match release.' >&2; exit 1; }
# Build while the current API is still serving. Do not recreate PostgreSQL.
"${compose[@]}" build --build-arg "APP_REVISION=$revision" api
"${compose[@]}" exec -T postgres pg_dump -U postgres -d gps_tracker -Fc > "$backup_dir/postgres.dump"
[[ -s "$backup_dir/postgres.dump" ]]
"${compose[@]}" exec -T postgres pg_restore --list < "$backup_dir/postgres.dump" > "$backup_dir/postgres.contents"
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 api
api_id=$("${compose[@]}" ps -q api)
actual=$("${docker_command[@]}" inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$api_id")
[[ "$actual" == "$revision" ]] || { echo 'Running image revision does not match the release.' >&2; exit 1; }
"${compose[@]}" exec -T api node -e 'fetch("http://127.0.0.1:3000/health").then(async r => { const h = await r.json(); if (!r.ok || h.status !== "ok" || h.database !== "postgresql") process.exit(1); console.log(JSON.stringify(h)); }).catch(() => process.exit(1))'
"${compose[@]}" ps
printf '%s\n' "$revision" > "$backup_dir/deployed-commit"
echo "Healthy release: $revision"
