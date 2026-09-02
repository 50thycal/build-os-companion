# Active Work

<!-- The Companion's active-work control board. One line per workstream; anything needing a
     paragraph belongs in its file. -->

**Updated:** 2026-09-02 · **Build OS v0.11** · operating mode `solo`

Adopted v0.11 on 2026-09-02, in `solo` mode (`COMP-001`); the declaration and the adoption
boundary live in `CLAUDE.md`. The boundary keeps the *merge gate* off work that predates it — no
verdict is demanded for `#1`, which merged before the original v0.5 adoption, and nothing merged
under v0.5 is re-judged by v0.11.

It does **not** silence the state-agreement check, and that check is currently right about this
board: WS-001, WS-002, WS-003, WS-005 and WS-007 all say `REVIEW` while `#1`, the pull request
that delivered them, merged on 2026-08-25. Under v0.5 that reads as a merge-finalization step
that never recorded the next phase — which is what happened.

**Those phases are the owner's to set, not an agent's to infer.** Each of these workstreams is
waiting on the owner using the deployed application against real work, which is the only thing
that can close them; whether that has happened is not visible from the repository. The rows are
left as they are, and the discrepancy is stated here rather than resolved by guessing.

WS-008 was the first pass of exactly that real use, and has since completed. What it can and cannot
close for each of the five is recorded in its file; none of their phases were moved on its account,
because that remains the owner's call.

Its one unfinished acceptance step — running discovery against live credentials to confirm the
portfolio it finds — did not disappear with it. It sits on WS-002, which needed the same run to
close anyway.

WS-006 moved from `IDEA`/`Blocked` to `BUILDING`/`Active` on 2026-09-02: the owner confirmed
directly, in the conversation that requested this build, that Needs Me and the fact pack/written
briefing have held up in real use, which was what WS-006 was waiting on. WS-006's own file
records that as a relayed confirmation, not a PR verdict — see its *Unblocked* entry and
WS-005's *Next Step*, both dated the same day.

This board moved here from `50thycal/build-os` when the application was extracted (`DEC-008`).
Protocol contracts stay in build-os and are vendored under `contracts/`; see `contracts/README.md`.

| ID | Workstream | Phase | Status | Current Next Step | Related PR |
|---|---|---|---|---|---|
| [WS-001](WS-001-companion-domain-and-event-ledger.md) | Companion domain + event ledger | REVIEW | Active | Owner review of the durable SQLite ledger, snapshots and attention lifecycle | [#1](https://github.com/50thycal/build-os-companion/pull/1) |
| [WS-002](WS-002-github-feed-mvp.md) | GitHub feed MVP | REVIEW | Active | Run `npm run sync -- --discover --owner-login 50thycal` against live credentials and confirm the discovered portfolio; then owner review of the Feed screen | [#1](https://github.com/50thycal/build-os-companion/pull/1), [#10](https://github.com/50thycal/build-os-companion/pull/10) |
| [WS-003](WS-003-build-os-workstream-integration.md) | Build OS workstream integration | REVIEW | Active | Owner review of live artifact parsing; confirm both repository layouts stay detected | [#1](https://github.com/50thycal/build-os-companion/pull/1) |
| [WS-004](WS-004-agent-session-checkpoint-protocol.md) | Agent session checkpoint protocol | READY_TO_BUILD | Paused | Paused deliberately: no agent posts checkpoints yet, so the intake API has no producer | — |
| [WS-005](WS-005-attention-engine-and-catch-up-briefing.md) | Attention engine + catch-up briefing | REVIEW | Active | Owner review of Needs Me and the fact pack against real use before prose rendering | [#1](https://github.com/50thycal/build-os-companion/pull/1) |
| [WS-006](WS-006-podcast-renderer.md) | Podcast renderer | BUILDING | Active | Owner review of the digest and deep-dive scripts against real use | — |
| [WS-007](WS-007-owner-application.md) | Owner-facing application | REVIEW | Active | Owner uses the deployed app against Party Games during real Build OS work | [#1](https://github.com/50thycal/build-os-companion/pull/1) |
| [WS-009](WS-009-podcast-topic-suggestions.md) | Podcast topic suggestions | BUILDING | Active | Owner rules on D1: does the page propose things worth understanding, and stay quiet otherwise? | — |

<!-- Phase: IDEA · EXPLORE · MODEL · DECIDE · BUILD_CARD · READY_TO_BUILD · BUILDING · REVIEW
     Status: Active · Paused · Blocked · Abandoned
     Completed and abandoned workstreams leave this table; their files remain. -->

## Recently completed

- **[WS-008](WS-008-portfolio-discovery-and-reconciliation.md) — Real-portfolio discovery and
  reconciliation truth.** 2026-08-28, [#10](https://github.com/50thycal/build-os-companion/pull/10),
  approved by the owner's merge. The Companion now follows the portfolio the owner has actually
  been working in rather than a hand-written list of two, and a durable record that disagrees with
  GitHub becomes a visible finding rather than a stale sentence. The one acceptance step it could
  not perform — running discovery against live credentials — moved to WS-002, whose acceptance
  criterion already required the same run.

The rest are in review rather than done: the application exists but has not been used against real
work over time, which is the only thing that can close them.
