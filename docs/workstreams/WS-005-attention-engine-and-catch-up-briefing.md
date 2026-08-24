# WS-005 — Attention engine + catch-up briefing

**Phase:** REVIEW · **Status:** Active
**Created:** 2026-08-23 · **Updated:** 2026-08-24

## Goal

`Needs Me` tells the owner every blocking action and nothing else; `Since I last checked` tells
them what actually moved, as narrative rather than backlog.

## Context

This is the value above a GitHub activity feed. It is also the easiest thing to get wrong: an
attention list that surfaces healthy autonomous progress trains the owner to ignore it, and a
list nobody trusts is worse than no list.

## Current Mental Model

```text
current state ──► deterministic rules ──► AttentionItem
                                            ├── severity: CRITICAL…NONE
                                            ├── reason_code (enumerated)
                                            └── reason_text (explains itself)

surfaces:  owner decision open · Build Card awaiting approval · PR waiting on owner
           · CI failed with nobody fixing it · workstream blocked on owner
           · changes-requested unresolved · stale beyond threshold while expected active

suppresses: normal commits · CI running · agent resolving review comments
            · intentionally paused workstreams · healthy autonomous implementation
```

`AUTONOMOUS_PROGRESS` is a real internal outcome, not an absence of a rule: the engine records
*why* it decided something did not need the owner.

## Decisions Made

- **Deterministic first, LLM second.** Rules decide attention; an LLM may later re-rank within
  a severity band, never invent one.
- **Every badge explains itself.** No unexplained urgency score. Reason code plus reason text.

## Open Decisions

- **D1. Staleness thresholds.** How long is "stalled" for a PR, a workstream, a session?
  Recommendation: start at 72h / 7d / 4h respectively, configurable, and tune from real use —
  guessing precisely now would be false precision.

## Assumptions

- The owner will treat `Needs Me` as authoritative only if it is quiet by default.

## Non-Goals

- No notifications, no scheduled delivery, no podcast.

## Build Card

Covered by design PR #4 — `plans/PROJECT_INTELLIGENCE_FEED.md` §12, §13, §19 Phase 4.

## Implementation State

Deterministic rule set, severity model, and reason codes implemented in PR #6 with table-driven
tests. `Since I last checked` and the written briefing not yet built.

## Review State

Not started.

## Related Decisions

DEC-009

## Related PRs

#6

## Next Step

Extend the deterministic rules into the `Needs Me` view and a `Since I last checked` narrative,
then produce the fact pack the written briefing consumes.
