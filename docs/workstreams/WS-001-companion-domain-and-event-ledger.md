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

None currently. The persistence engine (Postgres assumed) is implementation discretion.

## Assumptions

- Polling is sufficient for MVP; webhooks are a later delivery optimization, not a correctness fix.
- Event volume stays small enough that a relational ledger with in-process projection is adequate.

## Non-Goals

- No webhooks, no queue infrastructure, no TTS.
- No transcript ingestion of any kind.

## Build Card

Covered by design PR #4 — `plans/PROJECT_INTELLIGENCE_FEED.md` §7, §19 Phase 0.

## Implementation State

Phase 0 landing in PR #6 (`companion/` package: domain models, event taxonomy, fingerprints,
provenance, precedence resolver, projection). Checkpoint contract in PR #5.

## Review State

Not started.

## Related Decisions

DEC-008 (application boundary), DEC-009 (ledger architecture and source precedence)

## Related PRs

#5, #6

## Next Step

Land Phase 0 domain, parsers, attention rules, and fixtures; confirm the acceptance properties
(idempotency, provenance survival, state rebuild, precedence) are covered by tests.
