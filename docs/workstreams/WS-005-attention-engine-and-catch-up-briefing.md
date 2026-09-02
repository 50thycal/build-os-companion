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
  Shipped at 72h / 7d / 4h respectively and configurable, but still an open decision rather than
  a settled one: nothing has calibrated them against real use, and the whole value of Needs Me
  rests on it being quiet when it should be. This is the decision the next step exists to
  answer, and it cannot be answered from a fixture.

## Assumptions

- The owner will treat `Needs Me` as authoritative only if it is quiet by default.

## Non-Goals

- No notifications, no scheduled delivery, no podcast.

## Build Card

Covered by design PR #4 — `plans/PROJECT_INTELLIGENCE_FEED.md` §12, §13, §19 Phase 4.

## Implementation State

Complete and shipped in PR #1. The rule set and severity model came across from build-os PR #6;
everything downstream of them was built here:

- a Needs Me screen where every item answers four questions, the fourth being what the system
  looked at to decide — a classification the owner cannot interrogate is one they learn to
  ignore;
- `Since I last checked`, grouped by meaning rather than listed in order, with each entity in
  exactly one section;
- a fact pack over the six target sections where every fact carries references back to the
  events and entities behind it, and a deterministic renderer over it.

Attention lifecycle is compared against when the owner last checked rather than against the
event sequence, because an item can open with no event behind it — a PR goes stale when a
threshold passes while nothing happens — and those are the ones most worth reporting.

## Review State

Reviewed once, independently, on PR #1. One merge-blocking defect found and fixed: the read
cursor's sequence dimension was monotonic but its timestamp dimension was not, so a stale
browser tab re-submitting an older briefing could consume attention that had appeared after that
briefing was generated. Both dimensions now take `MAX`, the submitted checkpoint is the
briefing's own `generatedAt` rather than the click time, a sequence above the ledger maximum is
refused, and a future timestamp is clamped. Four regression cases cover it.

## Related Decisions

DEC-009

## Related PRs

- [#1](https://github.com/50thycal/build-os-companion/pull/1) — Needs Me, Since I last checked, the fact pack, the cursor fix
- build-os #6 — the original rule set

## Next Step

D1 is still open: nothing has calibrated the staleness thresholds against real use, and that is
a distinct question from whether the fact pack and briefing are trustworthy at all.

**2026-09-02 — relayed, per `CLAUDE.md`'s `solo`-mode rule on relaying an acceptance the owner
actually gave, naming the channel.** In the conversation that unblocked WS-006, the owner
confirmed directly that Needs Me and the fact pack/written briefing have held up in real use —
enough to build on top of them (see WS-006's own *Unblocked* entry). That answers the "does it
surface what genuinely needs them, and stay quiet otherwise" half of this next step. It does not
answer D1 by itself: threshold calibration is its own question, still open, and this phase stays
`REVIEW` rather than moving to `COMPLETE` on the strength of one relayed confirmation.
