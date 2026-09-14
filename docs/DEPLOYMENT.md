# Push and deploy the API

From the API repository on your computer:

```bash
git add <the-files-you-want-to-release>
git commit -m "Describe the release"
npm run deploy
```

Defaults are Git remote `origin`, branch `main`, SSH `hasan@147.79.71.98`,
and VPS checkout `/home/hasan/gps-tracker-api`. This updates the existing Docker
Compose installation. Initial provisioning is in [the setup guide](HISTORY_DEPLOYMENT.md).

The script requires a clean local and remote checkout. It first checks SSH,
Docker access and the existing database. It runs TypeScript checks and unit tests,
then pushes HEAD without force. If `TEST_DATABASE_URL` or
`HISTORY_TEST_DATABASE_URL` points to a disposable database, it runs the full
PostgreSQL integration suite instead. Never use the production database for tests.

The pushed commit travels as a Git bundle over SSH, so the VPS does not need a
GitHub credential. The VPS accepts only a fast-forward from its current commit.
Deployment uses a lock to prevent concurrent releases. Changes are never committed,
stashed or discarded automatically.

## SSH setup and overrides

Confirm the host fingerprint through a trusted channel and connect once manually
so it is in `known_hosts`. Automated deployment uses strict host checking and
SSH authentication. It prompts for your SSH password if a key is unavailable,
and reuses the connection for file uploads and commands. If Docker needs sudo,
the VPS prompts for your sudo password during preflight and deployment. Run the
command in an interactive terminal. No SSH or sudo password is stored. For
unattended use, configure SSH keys and Docker access separately.

```bash
ssh hasan@147.79.71.98
# If needed, use your existing key:
DEPLOY_SSH_KEY="$HOME/.ssh/your_vps_key" npm run deploy
# Or an SSH config alias and a different checkout:
DEPLOY_HOST=my-vps DEPLOY_PATH=/home/hasan/gps-tracker-api npm run deploy
npm run deploy -- --help
```

`DEPLOY_SSH_PORT`, `DEPLOY_BRANCH` and `DEPLOY_REMOTE` are also supported.
Paths may contain letters, numbers, slashes, dots, underscores and hyphens, with
no spaces. Local tools: Bash, Git, SSH/SCP, Node and installed npm dependencies.
VPS tools: Bash, Git, gzip, flock, Docker and Docker Compose with `--wait` support.
Docker must work as the SSH user or through that user's sudo privileges.
The script does not alter user privileges. Preserve the server's private `.env`.

## What happens on the VPS

1. Verify the uploaded bundle and commit; acquire the deployment lock.
2. Save previous source, commit, `.env` and Compose file to a private directory
   under `/home/hasan/gps-deploy-backups/` (next to the checkout).
3. Tag the previous running API image for recovery, then fast-forward the checkout.
4. Build the new API while the existing API continues serving.
5. Dump `gps_tracker` using PostgreSQL's custom archive format and verify that
   `pg_restore --list` can read it. A failed backup stops deployment.
6. Recreate only the API, wait up to 120 seconds for health, verify its image
   commit label and query `/health` for a working PostgreSQL connection.

The API briefly restarts and runs pending schema migrations on startup. PostgreSQL
and its volume are retained. Backups are not automatically expired; maintain
off-server copies and periodically test a full restore. Archive readability is
not a full restore rehearsal. The database dump is taken online; later writes
are not part of that snapshot.

## If deployment fails

The command exits nonzero and prints the backup directory. If the build or backup
failed, the previous API container is still running. For a startup failure, inspect:

```bash
cd /home/hasan/gps-tracker-api
sudo docker compose ps
sudo docker compose logs --tail=100 api
```

The backup contains `previous-commit`, `release-commit`, `previous-source.tar.gz`,
`.env`, `compose.yml`, `postgres.dump`, and, when an API was running,
`rollback.compose.yml`. A successful release also writes `deployed-commit`.
No automatic database restore or code rollback occurs. Before reverting an image,
verify that the previous code supports any schema migrations already applied.
To restart the saved image after that review:

```bash
cd /home/hasan/gps-tracker-api
backup_dir=/home/hasan/gps-deploy-backups/REPLACE_WITH_PRINTED_DIRECTORY
sudo docker compose --project-directory "$PWD" \
  -f "$backup_dir/compose.yml" -f "$backup_dir/rollback.compose.yml" \
  up -d --no-deps --no-build --wait api
```

This restores only the previous runtime image, not database data or the Git
checkout. Correct the problem in a new commit and redeploy. Do not restore an
old database snapshot over new production writes without a recovery plan.
