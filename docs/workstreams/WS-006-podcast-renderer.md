# WS-006 — Podcast renderer

**Phase:** IDEA · **Status:** Blocked
**Created:** 2026-08-23 · **Updated:** 2026-08-24

## Goal

A two-host audio catch-up — 5-minute, 15-minute, or deep dive — that the owner can listen to
away from a screen and still know what needs them.

## Context

The point of the shared event/state layer is that the podcast is a renderer, not a second
product. It exists in the plan from the start so the architecture is built to support it; it is
deliberately last so it cannot be built on unvalidated state.

## Current Mental Model

```text
events + state ──► fact pack ──► written briefing ──► outline ──► script ──► TTS
                       ▲              ▲
                       │              │
              every spoken claim   the debugging layer:
              traces to a fact     if the text is wrong,
                                   the audio is wrong
```

Two roles, each doing real work:

- **Reporter** — what happened, factual state, chronological transitions.
- **Analyst** — implications, cross-project connections, risks, blockers, what needs the owner.

The final segment of every briefing answers one question: what needs me next?

## Decisions Made

- **The written briefing is a required intermediate.** Not an optimization — it is where factual
  errors are caught before they are spoken.
- **Every factual statement is grounded in the fact pack.** No host may assert anything absent
  from it.

## Open Decisions

Not yet formed. TTS provider, voice selection, and delivery (private RSS versus in-app) are all
open, and none can be settled sensibly before the briefing exists.

## Assumptions

- Two hosts make a briefing more informative rather than merely longer. If that proves false in
  listening tests, one narrator plus a clear attention section is the fallback.

## Non-Goals

- No TTS work, no audio pipeline, no provider selection until WS-005 produces a validated
  written briefing.

## Build Card

Not ready.

## Implementation State

None.

## Review State

Not started.

## Related Decisions

None yet.

## Related PRs

None yet.

## Next Step

**Blocked** until WS-005 produces a validated fact pack and written briefing. Nothing external
is missing; this is a deliberate sequencing constraint from design PR #4.
