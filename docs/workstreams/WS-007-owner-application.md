# WS-007 — Owner-facing application

**Phase:** REVIEW
**Status:** Active
**Created:** 2026-08-24
**Updated:** 2026-08-24

## Goal

The owner opens the Companion on a phone and, without opening GitHub, learns what changed across
their projects, what needs them, and what to do next — from the same normalized state everything
else reads.

## Context

The engine was complete and tested before any of this existed: normalized events, an append-only
ledger, GitHub ingestion, artifact parsing, projection, a deterministic attention engine and feed
assembly, with 120 passing tests and no way to look at any of it. This workstream is the step
from a tested engine to something usable.

It is also where the engine first met data it had not been written against. That mattered more
than expected — see *Decisions Made* and `docs/LIVE_SYNC_VALIDATION.md`.

## Current Mental Model

```text
GitHub ──poll──► normalize ──► SQLite ledger (append-only, fingerprint-unique)
                                   │
                    ┌──────────────┼───────────────┐
                    ▼              ▼               ▼
              projection    artifact snapshots   attention lifecycle
                    │              │               │
                    └──────────────┴───────────────┘
                                   ▼
                            CompanionApp  ← every screen reads only through here
                                   ▼
                 Feed · Needs Me · Project · Catch Up · fact pack
```

The rule the whole design rests on: nothing downstream of the ledger touches GitHub. One
interpretation of what is true, so the screens cannot disagree with each other.

## Decisions Made

- **SQLite via `node:sqlite`.** No dependency, no server, one file to back up. Synchronous, so
  the durable ledger implements the same `EventLedger` interface as the in-memory one and the
  projection, attention and feed layers are untouched by persistence existing.
- **The read cursor is a sequence, not a timestamp.** A pull request opened in January and first
  observed today is new to the owner; an `occurred_at` window silently misses it.
- **Attention lifecycle is compared against when the owner last checked**, not against the event
  sequence — because an item can open with no event behind it (a PR goes stale because time
  passed) and those are the ones most worth telling them about.
- **Artifact snapshots are stored alongside events.** The ledger genuinely cannot stand in for
  them: a workstream that gains an open decision without changing phase emits no event at all.
- **Server-rendered HTML, no framework.** Loads on one bar of signal, and leaves no second copy
  of the interpretation logic in a browser.
- **The written briefing is deterministic.** Arguably permanently: a sentence the owner can click
  through to is worth more than a smoother one they must take on faith.

## Open Decisions

None. Everything above was an implementation decision; nothing is waiting on the owner to rule.

## Non-Goals

Podcast generation, TTS, two-host scripts, RSS, push notifications, webhooks, autonomous GitHub
actions, transcript ingestion, and multi-user authentication. All deliberately out of scope until
the written fact pack proves accurate in real use.

## Implementation State

Shipped in [#1](https://github.com/50thycal/build-os-companion/pull/1): extraction with history,
seven live-data fixes, durable SQLite persistence, followed-project configuration, the four-screen
web application, the read cursor, and the fact pack. 236 tests.

## Review State

Reviewed once, independently, on PR #1. Three corrections, all applied:

- **Merge-blocking.** The read cursor's timestamp dimension was not monotonic while its sequence
  dimension was, so a stale browser tab re-submitting an older briefing could consume attention
  that appeared after that briefing was generated — and `/briefing/checked` accepted a sequence
  above the ledger maximum, which would have suppressed future events. Both fixed under WS-005.
- These workstream files disagreed with the board: headers said REVIEW while bodies still
  described the pre-build state. Reconciled — the first real Build OS integrity case this project
  has had, and it was its own.
- The mobile checker cited Apple's 44pt guideline while failing only below 32px. It now enforces
  44, and the chips and disclosure toggles were raised to match.

Still not reviewed in the way that matters: the application has never been used against real
work, which is the only thing that can tell the owner whether the attention rules are calibrated
and whether the briefing is accurate enough to trust.

## Next Step

Owner uses the deployed Companion against Party Games during actual Build OS work, and judges two
things: whether Needs Me surfaces what genuinely needs them and stays quiet otherwise, and whether
the catch-up briefing is accurate enough to act on without opening GitHub.

## Related PRs

- [#1](https://github.com/50thycal/build-os-companion/pull/1) — extraction, live validation, persistence, application

## Related Decisions

`DEC-008` (Companion is an application, Build OS is a protocol) in `50thycal/build-os`.
