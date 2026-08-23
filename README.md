# Build OS Companion

Project intelligence across followed software projects: one place to see what changed, where
every effort sits, and what actually needs the owner.

**Status: Phase 0 complete, Phase 1 in progress.** Domain, ledger, parsers, attention engine, and
feed assembly are implemented and tested. There is no web UI, database, or authentication yet —
by design (see below).

Design: [`plans/PROJECT_INTELLIGENCE_FEED.md`](../plans/PROJECT_INTELLIGENCE_FEED.md) and PR #4.
Workstreams: [`docs/workstreams/`](../docs/workstreams/) — WS-001 … WS-006.

---

## Why this package lives here (for now)

The Companion is an application; Build OS is a protocol. They belong in different repositories,
and `DEC-008` records that decision: the target is `50thycal/build-os-companion`.

Until that repository exists, this package is **staged** here — self-contained, with its own
manifest, importing nothing outside `companion/`. It moves before any infrastructure (database,
web server, authentication) is added. The one file that crosses the boundary is the checkpoint
schema, which is vendored and verified against the canonical copy by `tests/contract-sync.test.ts`.

---

## Run it

```bash
npm install
npm test          # 120 tests, no network
npm run demo      # print the feed for the bundled fixtures
npm run typecheck
```

Against a real repository:

```bash
GITHUB_TOKEN=... npm run sync -- --repo owner/name --owner-login yourlogin
```

`npm run demo` output, abridged:

```text
=== Needs Me (6) ===

[HIGH] PR_CI_FAILED
  PR #84 has failing CI and no agent session is working on it.
  -> Open the failing check and decide whether to fix, re-run, or hand it to an agent.

[HIGH] OWNER_DECISION_REQUIRED
  WS-002 is waiting on 2 decisions, starting with: When an abandoned construction is
  discarded, does the card return to the deck or leave the game?
  -> Answer the open decisions so the design can move on.

=== Feed ===

50thycal/cargo-ship - PR #84
CI failed on PR #84: tests. Also: PR #84 opened; PR #84 is ready for review.
Why it matters: Carries WS-001.
Current: CI failed, no review yet.
Needs you: PR #84 has failing CI and no agent session is working on it.
Next: Await the implementation PR and review it against the Build Card.
```

---

## Shape

```text
src/
  domain/      events, state, attention, provenance and precedence
  ledger/      fingerprints and the append-only event ledger
  ingest/
    github/    observation types, state derivation, normalizer, polling client
    buildos/   markdown parsers, board/file reconciliation, detection, normalizer
    checkpoint/ contract validation, session state, staleness
  projection/  rebuild current state from the ledger
  attention/   deterministic rules with reason codes
  feed/        card assembly and ranking
  sync/        one poll cycle, end to end
  cli/         sync (live) and demo (fixtures)
fixtures/      Build OS documents, GitHub observations, checkpoints
tests/         120 tests
```

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) for what each layer guarantees and why.

---

## What is deliberately not here

- **No database.** The ledger is an interface with an in-memory implementation; Postgres slots in
  behind it. Choosing a store before the domain settled would have been the wrong order.
- **No web UI or auth.** Card content is data, so a UI is a thin renderer over `FeedCard[]`.
- **No webhooks.** Polling first, because reconciliation and idempotency have to be right before
  latency is worth optimising — and a webhook is a delivery mechanism, not a guarantee of state.
- **No LLM anywhere.** Every summary in the feed today is deterministic. Semantic compression is
  a later layer over facts that already exist.
- **No podcast, no TTS.** WS-006 is blocked on a validated written briefing, on purpose.
