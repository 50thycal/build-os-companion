# Build OS Companion

Project intelligence across the software projects you follow: one place to see what changed,
where every effort stands, and what actually needs you.

Build OS is the protocol. This is the application. They live in different repositories
(`DEC-008`), and `50thycal/build-os` stays canonical for every protocol contract.

**Status: first usable owner tool.** Durable ledger, live-validated ingestion, and a
mobile-first web app with four screens. No podcast, no TTS — deliberately, until the written
briefing proves accurate in real use.

```bash
npm install
npm test                    # 239 tests, no network
GITHUB_TOKEN=... npm start  # http://localhost:8787
```

---

## What it does

Four screens, built for a phone:

| Screen | Question it answers |
|---|---|
| **Feed** | What changed across everything I follow? |
| **Needs Me** | Does anything actually require me — and why does the system think so? |
| **Project** | For one repository: what is active, what phase, which PRs, what decisions are mine? |
| **Catch Up** | What changed since I last checked? |

Every screen reads through one object, which reads the ledger. Nothing downstream of the ledger
touches GitHub, so the four screens cannot disagree about what is true. A test serves every page
with a GitHub client that throws if anything calls it.

---

## How it works

```text
GitHub ──poll──► normalize ──► SQLite ledger (append-only, fingerprint-unique)
                                   │
                    ┌──────────────┼───────────────┐
                    ▼              ▼               ▼
              projection    artifact snapshots   attention lifecycle
                    │              │               │
                    └──────────────┴───────────────┘
                                   ▼
                            CompanionApp
                                   ▼
                 Feed · Needs Me · Project · Catch Up · fact pack
```

**Events are append-only and deduplicated by fingerprint.** The same source facts observed twice
produce the same fingerprint, so a poll that re-reads an unchanged pull request appends nothing.
This is enforced by a unique index rather than by application code, which is what makes it hold
across a restart.

**The read cursor is a sequence number, not a timestamp.** A pull request opened in January and
first observed today is new to *you*, whatever its `created_at` says. Ordering by when the
Companion learned something is the only way to answer "what changed since I last checked"
without either re-showing old news or silently dropping backdated arrivals.

**Attention is deterministic and explains itself.** Every item carries a reason code, a sentence
naming the specific thing, a recommended action, and the sources the rule looked at. There is no
opaque urgency score, because a badge you cannot interrogate is one you learn to ignore.
Suppressions are recorded too, so "why is this *not* on my list" has an answer.

**Nothing overwrites good state with a failure.** A failed poll is recorded as an event and the
project is marked stale; the last picture that was true stays on screen, labelled.

---

## Configuration

`companion.config.json`. Adding a repository is adding a line — no code change:

```json
{
  "ownerLogin": "50thycal",
  "projects": [
    { "repository": "50thycal/party-games", "displayName": "Party Games" },
    { "repository": "50thycal/build-os", "displayName": "Build OS" }
  ]
}
```

Where a repository keeps its Build OS artifacts is discovered, not assumed — the two seeded
repositories genuinely differ. Per-entry `paths` overrides are available when discovery is not
enough.

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_TOKEN` | — | Repo-scoped token. Without it the app serves stored state and syncing is off. |
| `COMPANION_DB` | `data/companion.db` | SQLite file. Back this up; it is the whole application state. |
| `COMPANION_CONFIG` | `companion.config.json` | Config path. |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address. |
| `COMPANION_SYNC_ON_START` | `1` | Set `0` to skip the sync at boot. |

Behind an HTTP proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21); it does not
read `HTTPS_PROXY` on its own.

---

## Commands

| Command | What it does |
|---|---|
| `npm start` | Sync, then serve the web app |
| `npm test` | 239 tests, offline |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run sync` | One sync cycle from the CLI |
| `npm run demo` | Print the feed for the bundled fixtures |
| `npm run contracts:check` | Compare vendored contracts against `50thycal/build-os` (needs network) |
| `npm run check:mobile` | Load every page at an iPhone viewport; fail on overflow or small tap targets |

---

## Vendored contracts

`contracts/` holds copies of Build OS protocol contracts so this package parses offline and
tests deterministically. The cost of a copy is drift, so the copy is checked rather than trusted:
an offline test pins each file to a recorded hash and to the copy `src/` loads, and
`npm run contracts:check` compares that hash against the canonical repository. The offline half
gates the build — a build must not fail when GitHub is unreachable — and the networked half is
what notices the protocol moving. See [`contracts/README.md`](contracts/README.md).

---

## What real data changed

The engine was written against hand-made fixtures and passed 120 tests. Running it against
`50thycal/party-games` and `50thycal/build-os` broke seven assumptions in an afternoon — bullets
truncated mid-clause because real artifacts hard-wrap, `merged` missing from the pull-request
list payload, mergeability permanently `unknown`, a "healthy" message on repositories with no CI
at all, and two repositories that keep their decision logs in different places.

[`docs/LIVE_SYNC_VALIDATION.md`](docs/LIVE_SYNC_VALIDATION.md) records each one, what it broke,
and what now stops it coming back — including the parts that are still **not** proven, which are
named rather than glossed.

---

## Deploying it

One Node process and one SQLite file, so deployment is mostly a question about disk. **The
database is the application state, not a cache** — lose it and the Companion does not degrade, it
forgets, and the next sync presents all of history as new. So the host must give it a persistent
filesystem, which rules out serverless platforms and rules in Fly, Railway, Render, a VPS, or a
Pi in a cupboard.

```bash
docker build -t build-os-companion .
docker run -d -p 8787:8787 -v companion-data:/data -e GITHUB_TOKEN=ghp_... build-os-companion
```

There is **no authentication**: this renders one person's private repository activity and assumes
it is not on the open internet. Put it behind a VPN or a reverse proxy.
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) covers the volume, the cron sync, the token scope, and
backing up a live database.

---

## Layout

```text
src/domain/      events, state, attention, provenance, shared phrasing
src/ledger/      fingerprints, the EventLedger interface, in-memory and SQLite implementations
src/store/       schema, migrations, projects, snapshots, attention lifecycle, read cursor
src/ingest/      GitHub polling, Build OS artifact parsing, agent checkpoints
src/projection/  rebuilding current state from the ledger
src/attention/   the deterministic rules
src/feed/        feed-card assembly
src/briefing/    since-last-checked, the fact pack, the deterministic renderer
src/app/         CompanionApp — the one read model every screen uses
src/web/         server, views, HTML helpers
docs/workstreams/ this project's own Build OS board
```

---

## Not built, on purpose

Podcast generation, TTS, two-host scripts, RSS, push notifications, webhooks, autonomous GitHub
actions, transcript ingestion, and multi-user authentication.

Podcast work stays deferred until the written fact pack proves accurate against real use. The
next step is not a feature — it is using this against Party Games during actual Build OS work and
finding out whether Needs Me is calibrated and the briefing is trustworthy.
