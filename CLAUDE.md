# Agent instructions — Build OS Companion

This repository follows **Build OS**, the framework in
[`50thycal/build-os`](https://github.com/50thycal/build-os). Read `docs/workstreams/ACTIVE.md`
first: it is the control board, and each row's file carries the detail.

Adopted version: v0.5
Last compatibility check: v0.5 on 2026-08-27

## What that date means

It is the **adoption boundary**, not decoration. Work that predates it was done under v0.4 and is
never retroactively judged by v0.5's merge gate — a completed workstream, a workstream untouched
since before the date, and a pull request opened and merged before it all stay outside. That is
why the line carries a date rather than a bare version, and why moving the date is a deliberate
act rather than a tidy-up.

Re-check it when Build OS releases a version, per `framework/FRAMEWORK_SYNC.md` in that
repository, and record the outcome here — including a decision to defer, which is a legitimate
result and belongs on the record.

## Where things live

| Artifact | Path |
|---|---|
| Control board | `docs/workstreams/ACTIVE.md` |
| Workstreams | `docs/workstreams/WS-*.md` |
| Decisions | `docs/DECISIONS.md` |
| Architecture | `ARCHITECTURE.md` |
| Vendored protocol contracts | `contracts/` — see `contracts/README.md` |

Protocol contracts are **canonical in build-os** and vendored here with hashes pinned. Never edit
a file under `contracts/` to fix a local problem: change it upstream and re-sync, or the copy
stops being evidence of anything.

## Review

This repository is worked by one GitHub account, which is exactly the case v0.5's comment verdict
form exists for: the login is transport, not identity. A verdict is a comment carrying
`Build OS review verdict:`, `Reviewed head:` with a full 40-character SHA, `Review actor:`, and
`Implementation actor reviewed:`. Do not edit a verdict after posting — an edited comment cannot
clear the gate. Corrections go in a new comment.

See `framework/REVIEW_PROTOCOL.md` in build-os for the full rules. This repository implements the
reader for them in `src/ingest/github/comment-verdict.ts`.
