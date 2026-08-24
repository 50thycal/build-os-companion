# WS-001 — Companion domain + event ledger

**Phase:** REVIEW · **Status:** Active
**Created:** 2026-08-23 · **Updated:** 2026-08-24

## Goal

A normalized, append-only event ledger and current-state projection that every downstream
renderer — feed, written briefing, podcast — reads from, so those renderers can never disagree
about what happened.

## Context

Design PR #4 and `plans/PROJECT_INTELLIGENCE_FEED.md`. The failure mode this exists to prevent:
a feed built directly on GitHub payloads and a podcast built directly on a second pipeline,
which drift apart and force the owner to reconcile them by hand.

## Current Mental Model

```text
GitHub  ─┐
Build OS ├─► normalizers ─► Event (append-only, fingerprinted, provenanced)
sessions─┘                        │
                                  ▼
                          state projection
                    (projects, PRs, workstreams, sessions)
                                  │
                                  ▼
                    attention engine (deterministic rules)
                                  │
                  ┌───────────────┼───────────────┐
                Feed          Briefing         Podcast
```

Two properties carry the design:

- **Idempotency** — every event carries a `source_fingerprint` derived from the source facts,
  so the same input observed twice produces one event.
- **Precedence** — when sources disagree: canonical Build OS artifact > GitHub PR/CI state >
  explicit session checkpoint > AI-derived inference. Conflicts surface; they never merge silently.

## Decisions Made

- **One ledger, many renderers.** Feed and podcast are renderers, not pipelines (DEC-009).
- **Events are owner-meaningful, not webhook-shaped.** GitHub subtypes normalize into events
  the owner would recognize as "something happened".
- **LLM output is never canonical state.** Summaries are derived and carry provenance.

## Open Decisions

None. The persistence engine was the one open question here and it is settled: SQLite via
`node:sqlite`, chosen because it is synchronous — which let the durable ledger implement the
existing `EventLedger` interface unchanged, so nothing above it knows persistence exists. The
interface stays the seam if a server-backed store is ever needed.

## Assumptions

- Polling is sufficient for MVP; webhooks are a later delivery optimization, not a correctness fix.
- Event volume stays small enough that a relational ledger with in-process projection is adequate.

## Non-Goals

- No webhooks, no queue infrastructure, no TTS.
- No transcript ingestion of any kind.

## Build Card

Covered by design PR #4 — `plans/PROJECT_INTELLIGENCE_FEED.md` §7, §19 Phase 0.

## Implementation State

Complete and shipped in PR #1. Domain models, event taxonomy, fingerprints, provenance and the
precedence resolver came across from build-os PR #6; the durable half was built here:

- `SqliteEventLedger` implementing the existing interface, with idempotency enforced by a unique
  index on `source_fingerprint` rather than by application code — which is what makes it hold
  across a restart.
- An insertion sequence distinct from `occurred_at`, because the read cursor has to order by
  when the Companion *learned* something, not when it happened.
- Artifact snapshots alongside events. The ledger cannot stand in for them: a workstream that
  gains an open decision without changing phase emits no event at all.
- Attention lifecycle rows carrying first-seen and cleared timestamps.

## Review State

Not reviewed. An independent review of PR #1 found the read cursor's timestamp dimension was not
monotonic while its sequence dimension was — a stale browser tab could consume attention that
appeared after the briefing it was submitting. Fixed under WS-005 with four regression cases.
Awaiting owner review.

## Related Decisions

DEC-008 (application boundary), DEC-009 (ledger architecture and source precedence)

## Related PRs

- [#1](https://github.com/50thycal/build-os-companion/pull/1) — durable ledger, snapshots, attention lifecycle
- build-os #5, #6 — the original domain, before extraction

## Next Step

Owner review of the persistence design, particularly whether the two orderings (`occurred_at`
versus insertion sequence) are drawn where they should be.
