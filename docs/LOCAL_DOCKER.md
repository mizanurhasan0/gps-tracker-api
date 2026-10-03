# Run the API locally with Docker

The local stack runs the NestJS API and PostgreSQL in Docker. Its Compose project
(`gps-tracker-dev`), database volume and private `.env.local` are separate from
the VPS stack. You do not need to install Node or PostgreSQL on the host.

## First start and updates

1. Install Docker Desktop (or Docker Engine with the Compose plugin) and start it.
2. From `gps-tracker-api`, run:

   ```sh
   npm run local:update
   ```

   If Node/npm is not installed on the host, run the equivalent command:

   ```sh
   bash scripts/local.sh update
   ```

The first run creates ignored `.env.local` with random PostgreSQL and admin
passwords, builds the API image, starts PostgreSQL, waits for its health check,
starts the API and waits for `GET /health`. Repeat the same command after source
changes. PostgreSQL data remains in the named volume. The API applies pending
schema migrations when it starts. Do not use `docker compose down -v` unless you
intend to delete local data.
The script requires a local Docker socket and refuses SSH/TCP Docker contexts,
so it does not send local credentials to another machine.

Keep a private backup of `.env.local` along with any local database backup. If
`.env.local` is missing while the local database volume exists, the update
script refuses to generate replacement passwords. Restore the original file;
do not delete the volume to work around this check.

The first admin login uses phone `01700000000`; the password is the
`ADMIN_PASSWORD` value in `.env.local`. The admin account is created only when
the database has no admin. Changing that variable later does not reset the
existing password. These credentials are for local testing only. `.env.local`
stays on this machine and must not be copied to the VPS.

## Connect clients

The default host ports are:

| Service | Local address |
|---|---|
| REST and `/health` | `http://127.0.0.1:3000` |
| Socket.IO | `http://127.0.0.1:3001` |
| PostgreSQL | `127.0.0.1:55432` |
| GT06 TCP listener | `127.0.0.1:5023` |

For the Android emulator, set its API base URL to `http://10.0.2.2:3000`.
The app derives port `3001` for Socket.IO when the REST URL uses port `3000`.
For a physical Android device, change `LOCAL_BIND_HOST` in `.env.local` to
`0.0.0.0`, rerun the update command, and set the app API base URL to
`http://<your-computer-LAN-IP>:3000`. Use this only on a trusted network and
allow the two ports through your computer's firewall. PostgreSQL remains bound
to the computer's loopback address, as does the GT06 TCP listener.

If ports 3000 or 3001 are already occupied, change `LOCAL_REST_PORT` and
`LOCAL_SOCKET_PORT` together in `.env.local`. The Android app's automatic socket
mapping expects 3000 and 3001, so adjust its socket configuration if you use
other ports. `LOCAL_POSTGRES_PORT` and `LOCAL_TCP_PORT` can also be changed.

## Useful commands

```sh
npm run local:status  # container and health status
npm run local:logs    # follow API logs
npm run local:config  # validate Compose configuration
npm run local:stop    # stop containers; preserve database volume
```

These commands also work as `bash scripts/local.sh status|logs|config|stop`.
If startup fails, inspect `npm run local:logs` and Docker Desktop. A changed
database password in `.env.local` does not change the password already stored
in an existing PostgreSQL volume. Restore the original value or rotate the
database role password deliberately.

## Testing and deployment boundary

The local stack is for development and manual app testing. `npm run test:unit`
does not require a database. The full `npm test` suite requires a separate,
disposable `TEST_DATABASE_URL`; it creates and drops test schemas. Never point
`TEST_DATABASE_URL` at the normal local app database or VPS database. A local
update neither commits nor deploys code. Once locally verified, use the
documented [VPS deployment workflow](DEPLOYMENT.md).
