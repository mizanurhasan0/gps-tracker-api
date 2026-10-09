# Run the API locally with Docker PostgreSQL

The local Docker Compose project runs PostgreSQL only. Run the NestJS API on
your machine with Node.js so you can start it manually, use watch mode and see
its logs directly in the terminal. The Compose project (`gps-tracker-dev`),
database volume and private `.env.local` are separate from the VPS stack.

## First start and updates

1. Install Node.js **>=22.22.0**, install the project dependencies with
   `npm ci`, and start Docker Desktop (or Docker Engine with the Compose plugin).
2. From `gps-tracker-api`, start PostgreSQL:

   ```sh
   npm run local:update
   ```

   The first run creates ignored `.env.local` with random PostgreSQL and admin
   passwords. Compose starts PostgreSQL and waits for its health check. It also
   removes an API container left by an older version of this local Compose
   setup. The database volume is preserved.

3. In a second terminal, run the API on the host:

   ```sh
   npm run start:dev
   ```

   When `.env.local` exists, the API loads it instead of `.env`, connects to
   PostgreSQL at `127.0.0.1:55432`, and applies pending schema migrations on
   startup. Stop the API with `Ctrl+C`; it can be restarted independently of
   PostgreSQL. Repeat `npm run local:update` only when you need to start or
   update the database container.

The local Compose helper requires a local Docker socket and refuses SSH/TCP
Docker contexts, so it does not send local credentials to another machine.
Keep a private backup of `.env.local` along with any local database backup. If
`.env.local` is missing while the local database volume exists, the update
script refuses to generate replacement passwords. Restore the original file;
do not delete the volume to work around this check.

The admin phone and password come from `.env.local`. The admin account is
created only when the database has no admin. Changing those variables later
does not reset an existing account. `LOCAL_ALLOW_SHORT_PASSWORDS=true` lets
local login, registration, recovery, and first-admin setup use any non-empty
password up to 128 characters. This setting is honored only when `.env.local`
is loaded; production keeps its normal password minimums. These credentials
are for local testing only. `.env.local` stays on this machine and must not be
copied to the VPS.

With PostgreSQL and the API running, add 100 repeatable demo students and
guardians with `npm run seed:local:students`. Each guardian's local password is
`pass`. Guardians created through the local admin student form also receive
`pass` by default. Repeating the command skips students already created by
this seed.

## Connect clients

| Service | Local address | Runs in |
|---|---|---|
| REST and `/health` | `http://127.0.0.1:3000` | Host API (`npm run start:dev`) |
| Socket.IO | `http://127.0.0.1:3001` | Host API (`npm run start:dev`) |
| PostgreSQL | `127.0.0.1:55432` | Docker |
| GT06 TCP listener | `127.0.0.1:5023` | Host API (`npm run start:dev`) |

For the Android emulator, set its API base URL to `http://10.0.2.2:3000`.
The app derives port `3001` for Socket.IO when the REST URL uses port `3000`.
For a physical Android device, change `LOCAL_BIND_HOST` in `.env.local` to
`0.0.0.0`, restart `npm run start:dev`, and set the app API base URL to
`http://<your-computer-LAN-IP>:3000`. Use this only on a trusted network and
allow the API ports through your computer's firewall. PostgreSQL remains bound
to the computer's loopback address. The GT06 listener stays on loopback unless
you explicitly set `TCP_HOST` in `.env.local`.

If ports 3000 or 3001 are already occupied, change `LOCAL_REST_PORT` and
`LOCAL_SOCKET_PORT` together in `.env.local`, then restart the API. The Android
app's automatic socket mapping expects 3000 and 3001, so adjust its socket
configuration if you use other ports. `LOCAL_POSTGRES_PORT` and
`LOCAL_TCP_PORT` can also be changed; rerun `npm run local:update` after
changing the PostgreSQL port.

## Useful commands

```sh
npm run local:status  # PostgreSQL container status
npm run local:logs    # follow PostgreSQL logs
npm run local:config  # validate the database Compose configuration
npm run local:stop    # stop PostgreSQL; preserve database volume
npm run start:dev     # run/restart the API on the host
```

These database commands also work as
`bash scripts/local.sh status|logs|config|stop`. API logs appear in the
terminal running `npm run start:dev`. If API startup fails, inspect that
terminal first, then check `npm run local:logs` and Docker Desktop. A changed
database password in `.env.local` does not change the password already stored
in an existing PostgreSQL volume. Restore the original value or rotate the
database role password deliberately.

## Testing and deployment boundary

The local database is for development and manual app testing.
`npm run test:unit` does not require a database. The full `npm test` suite
requires a separate, disposable `TEST_DATABASE_URL`; it creates and drops test
schemas. Never point `TEST_DATABASE_URL` at the normal local app database or
VPS database. A local update neither commits nor deploys code. Once locally
verified, use the documented [VPS deployment workflow](DEPLOYMENT.md).
