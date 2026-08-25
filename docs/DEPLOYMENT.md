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
| **Railway** | ✅ | Volumes, a URL, and a Dockerfile build. The documented path below. |
| Fly.io | ✅ | Volumes are first-class; one small machine is enough |
| Render | ✅ | Persistent disk on a paid instance |
| A VPS, or a Raspberry Pi at home | ✅ | Simplest of all: `docker run` with a bind mount |
| Vercel / Netlify / Lambda | ❌ | Serverless filesystems are ephemeral. Every cold start would be a first sync. |

Nothing about the design is hostile to serverless — the ledger interface is deliberately
swappable, and a Postgres-backed `EventLedger` would make it possible. But that is a real piece
of work and not a config change, and for a single-owner tool the disk is cheaper than the
migration.

## Railway

The shortest correct path, and the one `railway.json` is written for.

**1. Create the service.** New Project → Deploy from GitHub repo → `50thycal/build-os-companion`.
Railway reads `railway.json`, builds the `Dockerfile`, and health-checks `/healthz`.

**2. Add a volume.** Service → **Data** → add a volume with mount path **`/data`**.

> This is the step that matters. `COMPANION_DB` already points at `/data/companion.db`, so with
> the volume attached the database survives redeploys and restarts. Without it the service comes
> up looking perfectly healthy and silently forgets everything on every deploy — including your
> read cursor, so "since I last checked" resets to "everything" each time.

**3. Set variables.** Service → **Variables**:

| Variable | Value | Why |
|---|---|---|
| `COMPANION_PASSWORD` | something long | **Required.** Without it the app refuses to serve anything. |
| `GITHUB_TOKEN` | `github_pat_…` | Read-only, scoped to the repositories you follow. |
| `COMPANION_SYNC_INTERVAL_MINUTES` | `20` *(default)* | Background refresh. `0` disables it. |

Do **not** set `PORT` — Railway assigns it and the app reads it.

**4. Get a URL.** Service → **Settings → Networking → Generate Domain**. Open it, sign in with
the password, and add it to your phone's Home Screen.

### Why the password is not optional here

A Railway domain is public. Anyone with the URL reaches the app, and every screen is your private
project state — open decisions, workstream contents, pull request titles. The password is the
only thing between that URL and your repositories, which is why an unconfigured deployment
returns `503` on every route instead of starting anyway.

`/healthz` deliberately answers before the gate, so Railway's probe passes on a correctly-locked
service. It reports `configured: false` when no password is set, so a misconfiguration shows up
as a bad health payload rather than as a service that merely looks fine.

Changing `COMPANION_PASSWORD` later signs out every device — which is what you want the day you
suspect it leaked.

### Syncing

The app syncs at startup, on the **Sync now** button, and every
`COMPANION_SYNC_INTERVAL_MINUTES` in-process. A separate Railway cron service would **not** work:
a volume attaches to exactly one service, so a second container cannot open the same database.

Background syncing never advances the read cursor, so it cannot consume a briefing you have not
seen.

---

## Docker

> **Verified in substance, not as an image.** The production install path was exercised —
> `npm ci --omit=dev` yields 12 packages, the server starts on those alone, and `/healthz` and the
> pages respond. `docker build` itself has not been run, because no daemon was available where
> this was written. Treat the first build as confirming the image, not the app.

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

The app authenticates with a **single password** (`COMPANION_PASSWORD`) and a signed, HttpOnly
session cookie that lasts 30 days — long enough that you sign in once per device. There are no
accounts; there is one owner, and the only question is whether the visitor is them.

Without a password set, the app **refuses to serve anything** rather than starting up exposed.
That default exists because the alternative failure is silent: a public URL quietly serving
private project state, looking completely healthy.

`SameSite=Lax` on the session cookie is what stops a form on another site making an
authenticated request here, which is why there is no separate CSRF token. `Secure` is set
whenever the request arrived over HTTPS, including via a proxy that terminated it.

If you would rather not rely on a password at all, the alternatives still apply: put it behind a
VPN (Tailscale is the least work), or in front of Cloudflare Access. Both compose with the
password rather than replacing it.

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
