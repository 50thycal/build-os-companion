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

### Which repositories appear

**You do not register them.** The Companion follows any repository your credentials can read that
you have been active in recently — a rolling 60-day window — so a project enters the feed when you
start working in it and leaves when you stop.

Eligibility, in order:

1. **Owner-authored commits** in the window. The strongest signal, and it counts commits an agent
   authored under your identity, because that is your project moving.
2. **Owner-authored or updated pull requests** in the window.
3. **`pushed_at` alone**, as a fallback. It is not evidence *you* did anything — an upstream sync
   moves it on a fork, a bot moves it anywhere — so it is never enough on its own for a fork or an
   archived repository.

Private repositories are included wherever the token can read them. There is no cap on how many
projects you may have, and listing is paginated to the end of the window rather than to the first
page. A repository with no Build OS layer still appears: GitHub activity alone makes a useful
project feed, and Build OS enriches it rather than being the price of admission.

Ask what the rule currently finds, without syncing anything:

```bash
GITHUB_TOKEN=... npm run sync -- --discover --owner-login 50thycal
```

It prints what it followed, the evidence for each, and — as usefully — what it rejected and why.

### `companion.config.json`

The config file is the **exceptions** to that rule, not the rule. An empty `projects` list is a
working configuration.

```json
{
  "ownerLogin": "50thycal",
  "discovery": { "enabled": true, "lookbackDays": 60, "exclude": [] },
  "projects": [
    { "repository": "50thycal/party-games", "displayName": "Party Games" }
  ]
}
```

An entry under `projects` does two things, either or both: it **pins** the repository, so it is
followed whatever the window says, and it carries **overrides** — a display name, a default
branch, `buildOs` to force detection on or off, and `paths` for a repository that keeps its Build
OS artifacts somewhere detection would not find them. Where those artifacts live is otherwise
discovered, not assumed; the two seeded repositories genuinely differ.

`discovery.exclude` drops a repository whatever its activity says, and beats a pin.

A repository that ages out of the window is **disabled, not deleted** — its history survives — and
nothing ages out on a cycle where discovery could not answer, so a failed listing never empties
the feed. No new token is needed as your portfolio grows: a fine-grained token scoped to *All
repositories* already covers anything you start next week.

| Variable | Default | Meaning |
|---|---|---|
| `COMPANION_PASSWORD` | — | **Required.** The app refuses to serve anything without it. Changing it signs out every device. |
| `GITHUB_TOKEN` | — | Read-only. One fine-grained token with **All repositories** covers every project you follow now or later — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#the-token). Without it the app serves stored state and syncing is off. |
| `COMPANION_DB` | `data/companion.db` | SQLite file. Back this up; it is the whole application state. |
| `COMPANION_CONFIG` | `companion.config.json` | Config path. |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address. Railway assigns `PORT` — don't set it there. |
| `COMPANION_SYNC_INTERVAL_MINUTES` | `20` when a token is set | Background refresh. `0` disables it. |
| `COMPANION_SYNC_ON_START` | `1` | Set `0` to skip the sync at boot. |
| `COMPANION_ALLOW_NO_AUTH` | — | Set `1` to run with no password. Local use only, never on a public hostname. |

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
forgets, and the next sync presents all of history as new. The host must give it a persistent
filesystem, which rules out serverless platforms and rules in Railway, Fly, Render, a VPS, or a
Pi in a cupboard.

**Railway** is the documented path: deploy from the repo, add a volume at `/data`, set
`COMPANION_PASSWORD` and `GITHUB_TOKEN`, generate a domain.

```bash
# or anywhere that runs a container with a disk
docker build -t build-os-companion .
docker run -d -p 8787:8787 -v companion-data:/data \
  -e COMPANION_PASSWORD=... -e GITHUB_TOKEN=... build-os-companion
```

Access is a **single password** and a signed, 30-day session cookie — sign in once per device.
With no password set the app **refuses to serve anything**, because the alternative failure is a
public URL quietly exposing private project state while looking healthy.
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) covers the volume, background syncing, token scope,
and backing up a live database.

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
