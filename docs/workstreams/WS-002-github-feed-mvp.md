# WS-002 — GitHub feed MVP

**Phase:** REVIEW · **Status:** Active
**Created:** 2026-08-23 · **Updated:** 2026-08-24

## Goal

The owner can follow repositories and see one ranked feed of what changed across them — PRs,
review state, CI — with every card linking back to the canonical GitHub source.

## Context

This is the first independently useful product, and it must be useful before agent checkpoints
or Build OS parsing exist. It also proves the ledger: if reconciliation and idempotency are
wrong, the feed shows duplicates and the whole architecture is suspect.

## Current Mental Model

```text
poll cycle (per followed repo)
  fetch repo meta, open + recently-updated PRs, reviews, check runs
        │
        ▼
  observation snapshot  ──► normalizer ──► events (deduped by fingerprint)
        │                                        │
        ▼                                        ▼
  reconcile PR state                     ledger append
        │
        ▼
  feed assembly: rank, collapse low-value churn, render cards
```

A card answers five questions: what changed, why it matters, where it is now, is anything
blocked, what happens next.

## Decisions Made

- **Polling first, webhooks later.** Reconciliation correctness before latency.
- **Cards are not commit logs.** Raw commits and GitHub metadata do not go in the feed.

## Open Decisions

- **D1. Web stack and hosting for the owner-facing UI.** Deferred until the Companion repository
  exists; the Phase 0 package deliberately keeps card assembly as pure functions so the UI is a
  thin renderer over `FeedCard[]` whichever stack wins.

## Assumptions

- Single-owner MVP. Multi-user authorization is built correctly but not exercised.
- GitHub API rate limits are not a constraint at the expected number of followed repositories.

## Non-Goals

- No webhooks, no notifications, no action cards (review/merge from the feed).

## Build Card

Covered by design PR #4 — `plans/PROJECT_INTELLIGENCE_FEED.md` §11, §19 Phase 1.

## Implementation State

Phase 1 ingestion, projection, and card assembly landing in PR #6, headless (CLI) — no web UI,
auth, or database yet.

## Review State

Not started.

## Related Decisions

DEC-009

## Related PRs

#6

## Next Step

Wire polling sync and feed cards onto the Phase 0 domain, then decide D1 once the Companion
repository exists.
