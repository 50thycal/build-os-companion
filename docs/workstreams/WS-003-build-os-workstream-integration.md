# WS-003 — Build OS workstream integration

**Phase:** REVIEW · **Status:** Active
**Created:** 2026-08-23 · **Updated:** 2026-08-24

## Goal

Show where each Build OS thread is actually sitting — phase, blocker, open decisions, next step —
rather than only what GitHub activity occurred.

## Context

A followed repository that adopts Build OS already publishes durable design state in
`docs/workstreams/`, `DECISIONS.md`, and `PROJECT_MODEL.md`. Parsing it is what turns a PR
dashboard into project intelligence.

## Current Mental Model

```text
repo files ──► detection (paths, CLAUDE.md override)
                    │
                    ▼
        ACTIVE.md parser ──┐
        workstream parser ─┼─► WorkstreamState (+ integrity warnings)
        DECISIONS parser ──┘
                    │
                    ▼
        WORKSTREAM_PHASE_CHANGED / _BLOCKED / _COMPLETED / DECISION_ADDED events
```

Two relationships the store must not flatten: one workstream may span several PRs, and one PR
may serve several workstreams. Many-to-many internally, even where the UI shows one primary.

## Decisions Made

- **Parsers are conservative.** A field that cannot be read confidently is absent, never guessed.
- **Disagreement is surfaced, not resolved.** When `ACTIVE.md` and a workstream file conflict,
  prefer the workstream file for detail and raise a Build OS integrity warning.

## Open Decisions

- **D1. How aggressively to emit `PROJECT_MODEL_CHANGED`.** A file-change trigger is noisy; a
  semantic threshold needs an LLM in the ingest path. Recommendation: emit nothing for MVP, and
  revisit once briefing quality shows whether the signal is missed.

## Assumptions

- Followed repositories broadly follow the documented Build OS layout, with per-repository path
  overrides available for those that do not.

## Non-Goals

- No writing to a followed repository's Build OS files. The Companion reads; agents write.

## Build Card

Covered by design PR #4 — `plans/PROJECT_INTELLIGENCE_FEED.md` §10, §19 Phase 2.

## Implementation State

Parsers and integrity rules implemented as pure functions in PR #6 against fixtures; live
per-repository sync not yet wired.

## Review State

Not started.

## Related Decisions

DEC-010

## Related PRs

#6

## Next Step

Promote the Phase 0 parsers to a live per-repository sync, with detection and path overrides.
