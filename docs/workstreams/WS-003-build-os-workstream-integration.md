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

Complete and shipped in PR #1. Live per-repository sync is wired, with detection and path
overrides, and the parsers have met real artifacts — which broke three assumptions the
fixture-only tests never touched:

- list items were read to the end of the *line*, not the end of the item, so every hard-wrapped
  open decision was truncated mid-clause;
- a decision entry is a paragraph, so `question` is now its opening sentences and `detail` keeps
  the entry whole;
- the two followed repositories lay their artifacts out differently — party-games keeps
  `docs/DECISIONS.md`, build-os keeps `DECISIONS.md` at its root — so detection probes candidate
  locations rather than assuming the convention.

## Review State

Not reviewed. Both repositories now parse with no integrity warnings and no conflicts, including
this repository's own board.

## Related Decisions

DEC-010

## Related PRs

- [#1](https://github.com/50thycal/build-os-companion/pull/1) — live sync, path discovery, the three parser fixes
- build-os #6 — original parsers

## Next Step

Owner review of the parsed state against the source files: does the Project screen say what the
artifacts actually say? D1 stays open.
