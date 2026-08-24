# WS-004 — Agent session checkpoint protocol

**Phase:** READY_TO_BUILD · **Status:** Paused
**Created:** 2026-08-23 · **Updated:** 2026-08-24

## Goal

The owner can see which agent sessions are live, what each is working on, and whether any is
blocked — without anyone storing or scraping a transcript.

## Context

Today an agent's working state exists only inside its chat window. Between durable GitHub
checkpoints there is a visibility gap, and the tempting fix — reading transcripts — makes chat
the source of truth, which is the exact failure Build OS exists to prevent.

## Current Mental Model

```text
agent ──► checkpoint (state, never transcript)
              │
     ┌────────┴─────────┐
     ▼                  ▼
 committed to      posted to Companion API
 GitHub                 (ephemeral, marked derived)
     │                  │
     └────────┬─────────┘
              ▼
        SessionState
              │
   no checkpoint for threshold
              ▼
     status → UNKNOWN (never COMPLETED)
```

A session is a working context, not a conversation. Its checkpoint describes *state*:
objective, phase, completed, in progress, blockers, next step, related PR.

## Decisions Made

- **State, not transcript.** The checkpoint schema has no field that could hold conversation text.
- **Silence is never success.** An agent that stops reporting becomes `UNKNOWN`, never `COMPLETED`.
- **Durable beats ephemeral.** A committed workstream update outranks an API checkpoint whenever
  the two disagree, and the API checkpoint is marked derived in the UI.

## Open Decisions

- **D1. Authentication for the checkpoint endpoint.** Per-repository token versus GitHub App
  identity. Recommendation: per-repository token for MVP — an agent posting a checkpoint should
  not need the permissions a GitHub App identity would carry.

## Assumptions

- Agents will adopt a checkpoint call if it is one small POST with a stable schema. Anything
  requiring more ceremony will simply not be called.

## Non-Goals

- No transcript storage, no transcript scraping, no inference of session state from commit
  patterns.

## Build Card

Covered by design PR #4 — `plans/PROJECT_INTELLIGENCE_FEED.md` §8, §19 Phase 3.

## Implementation State

Contract v1 (`contracts/agent-session-checkpoint.v1.schema.json` and
`framework/AGENT_SESSION_CHECKPOINT.md`) landing in PR #5. Session state model and staleness
rules in PR #6. Intake API not yet built.

## Review State

Not started.

## Related Decisions

DEC-010

## Related PRs

#5, #6

## Next Step

Implement the checkpoint intake API against the v1 contract, with the staleness sweep that
demotes silent sessions to `UNKNOWN`.
