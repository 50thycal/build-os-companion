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
- **Server-rendered HTML, no framework, no build step.** (Was D1, settled in PR #1.) The bet that
  card assembly should stay pure functions paid off: the UI really is a thin renderer over
  `FeedCard[]`, which is what makes "no screen creates a second interpretation pipeline"
  testable rather than aspirational. Hosting needs a persistent disk for SQLite, which rules out
  serverless; see `docs/DEPLOYMENT.md`.

## Open Decisions

None. D1 is settled above.

## Assumptions

- Single-owner MVP. Multi-user authorization is built correctly but not exercised.
- GitHub API rate limits are not a constraint at the expected number of followed repositories.

## Non-Goals

- No webhooks, no notifications, no action cards (review/merge from the feed).

## Build Card

Covered by design PR #4 — `plans/PROJECT_INTELLIGENCE_FEED.md` §11, §19 Phase 1.

## Implementation State

Complete and shipped in PR #1. Ingestion, projection and card assembly now have a Feed screen in
front of them: server-rendered, mobile-first, reading `buildFeed` from persisted events and
persisted state rather than from GitHub. Cards collapse several events about one entity into
one, and a test asserts that.

Ingestion was corrected against real payloads along the way — `merged` is absent from the pull
request *list* endpoint, `mergeable_state` answers `unknown` on first read of any open PR, and
CI has to be read from commit statuses as well as check runs. See `docs/LIVE_SYNC_VALIDATION.md`.

## Review State

Not reviewed. Card collapsing has never been judged against a busy day in a real repository,
which is the thing worth checking.

## Related Decisions

DEC-009

## Related PRs

- [#1](https://github.com/50thycal/build-os-companion/pull/1) — the Feed screen and the live-data ingestion fixes
- build-os #6 — original card assembly

## Next Step

Owner review of the Feed against real Party Games activity: does card collapsing hide anything
that mattered, and does ranking put the right thing at the top?
