# GharSe: read-only database inspection (GoDaddy MySQL/MariaDB)

Purpose: report what the GoDaddy database actually is (server type and version, storage engine, charset, isolation,
CHECK support, connection limits, grants, TLS) before any migration code is written. It only ever sends `SELECT`/`SHOW`.
It creates, alters and deletes nothing, and it never prints the host, database name, user or password.

## Option 1: phpMyAdmin (no setup)
Open the database in cPanel > phpMyAdmin > SQL tab, paste `inspect.sql`, run, and share the result tables.
(If a statement errors on your server version, run the others one by one.)

## Option 2: from a terminal (your Mac, or the GoDaddy terminal if you have one)
```bash
export DB_HOST=...  DB_PORT=...  DB_NAME=...  DB_USER=...
read -s DB_PASSWORD && export DB_PASSWORD          # types invisibly, never stored in history
node node_modules/prisma/build/index.js generate --schema tools/db-inspect/schema.prisma   # once; needs no database
node tools/db-inspect/inspect.cjs --selftest       # optional: proves the safety features
node tools/db-inspect/inspect.cjs                  # the inspection
unset DB_PASSWORD
```
If the first step says the database is not reachable, GoDaddy's host is internal or remote access is off: use Option 1,
run it in the GoDaddy terminal, or add your IP under cPanel > Remote MySQL. If it mentions TLS, retry with
`DB_INSPECT_SSL=accept_invalid_certs` and then `DB_INSPECT_SSL=strict`.

The generated client in `.client/` is isolated: it does not touch the application's Prisma client.

## Option 3: one-shot runner on a hosted environment (for example GoDaddy Node.js hosting)
Use this only when the `DB_*` variables exist inside the hosting runtime and you have no terminal there.
`run-on-host.cjs` is temporary tooling for the migration decision, not part of the application. It lives on a throwaway
branch, never on `main`.

1. In the hosting environment add ONE extra variable (not a secret): `GHARSE_DB_INSPECT=READ_ONLY_ONCE`.
   Optional: `GHARSE_DB_INSPECT_MAX_SECONDS` (inspection limit, default 120, max 600) and
   `GHARSE_DB_INSPECT_IDLE_SECONDS` (how long to stay up so logs can be read, default 600, max 1800).
2. Run `node tools/db-inspect/run-on-host.cjs`, either in a terminal, or by pointing the temporary deployment's start
   command / entry file at that file. If the platform needs a web server it uses `PORT` and serves ONE FIXED SENTENCE to
   every request: no result or database detail is ever served over HTTP.
3. Read the report in the runtime logs (host, database, user, password, grants and connection strings are redacted).
   The process exits by itself after the time limits. A marker in the OS temp folder prevents running twice in one container.
4. Redeploy the application and delete the temporary branch.

Safety: only `SELECT`/`SHOW` are sent, on a session the server is told is READ ONLY (and re-checked before every query).
The runner never runs migrations, creates tables, alters schema or writes data. Everything the inspector prints on stdout or
stderr (including output from the native Prisma engine) is redacted by the runner before it is shown.
Check the safety features any time with `node tools/db-inspect/run-on-host.cjs --selftest` and
`node tools/db-inspect/inspect.cjs --selftest` (neither needs a database).
