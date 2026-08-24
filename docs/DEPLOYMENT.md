# Deploying the Companion

One Node process and one SQLite file. That is the whole thing, and it is why deployment is
mostly a question about disk rather than about architecture.

## The constraint that decides everything

**The database is the application state**, not a cache. It holds the event ledger, every
project's last known state, the lifecycle of each attention item, and the owner's read cursor.
Lose it and the Companion does not degrade — it forgets. The next sync backfills history and
presents all of it as new, because from the ledger's point of view it is.

So the host must give the process a **persistent filesystem**. That single requirement rules some
options in and others out:

| Host | Works | Why |
|---|---|---|
| Fly.io | ✅ | Volumes are first-class; one small machine is enough |
| Railway / Render | ✅ | Persistent disks available on a paid instance |
| A VPS, or a Raspberry Pi at home | ✅ | Simplest of all: `docker run` with a bind mount |
| Vercel / Netlify / Lambda | ❌ | Serverless filesystems are ephemeral. Every cold start would be a first sync. |

Nothing about the design is hostile to serverless — the ledger interface is deliberately
swappable, and a Postgres-backed `EventLedger` would make it possible. But that is a real piece
of work and not a config change, and for a single-owner tool the disk is cheaper than the
migration.

## Docker

```bash
docker build -t build-os-companion .
docker run -d --name companion \
  -p 8787:8787 \
  -v companion-data:/data \
  -e GITHUB_TOKEN=ghp_... \
  build-os-companion
```

The volume is the load-bearing flag. Without it the container starts fine and quietly loses
everything on restart, which is the worst failure mode available.

## Without Docker

```bash
npm ci --omit=dev
GITHUB_TOKEN=ghp_... COMPANION_DB=/var/lib/companion/companion.db npm start
```

## Keeping it synced

The app syncs at start and on the **Sync now** button. For hands-off updates, run the CLI on a
timer — every 15–30 minutes is plenty, since GitHub is polled and nothing here is latency
sensitive:

```cron
*/20 * * * * cd /srv/companion && GITHUB_TOKEN=... npm run sync >> /var/log/companion-sync.log 2>&1
```

Syncing never advances the read cursor, so a background sync cannot consume a briefing the owner
has not seen.

## The token

A classic or fine-grained token with **read** access to the repositories in
`companion.config.json`. Nothing here writes to GitHub — there are no autonomous actions, by
design — so a read-only token is the correct scope and the safest one.

Behind an HTTP proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21). It does not
read `HTTPS_PROXY` on its own, and the failure looks like a `401` rather than a connection error,
which is confusing enough to be worth knowing in advance.

## Exposure

There is **no authentication**. This is a single-owner tool that renders one person's private
repository activity, and it assumes it is not on the open internet. Put it behind a VPN
(Tailscale is the least work), a reverse proxy with basic auth, or bind it to localhost and
reach it through an SSH tunnel.

Do not put it on a public address and rely on the URL being unguessable. Everything on those
screens is private project state.

## Backups

Copy the file:

```bash
docker exec companion node -e "
  const {DatabaseSync} = require('node:sqlite');
  new DatabaseSync('/data/companion.db').exec(\"VACUUM INTO '/data/backup.db'\");
"
```

`VACUUM INTO` is safe to run while the application is using the database, which a plain file copy
is not — WAL mode means the `.db` file alone can be an incomplete picture.
