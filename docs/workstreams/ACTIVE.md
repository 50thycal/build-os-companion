# Active Work

<!-- The Companion's active-work control board. One line per workstream; anything needing a
     paragraph belongs in its file. -->

**Updated:** 2026-08-28 · **Build OS v0.5**

Adopted v0.5 on 2026-08-27; the declaration and the adoption boundary live in `CLAUDE.md`. The
boundary keeps the *merge gate* off work that predates it — no verdict is demanded for `#1`,
which merged before adoption.

It does **not** silence the state-agreement check, and that check is currently right about this
board: WS-001, WS-002, WS-003, WS-005 and WS-007 all say `REVIEW` while `#1`, the pull request
that delivered them, merged on 2026-08-25. Under v0.5 that reads as a merge-finalization step
that never recorded the next phase — which is what happened.

**Those phases are the owner's to set, not an agent's to infer.** Each of these workstreams is
waiting on the owner using the deployed application against real work, which is the only thing
that can close them; whether that has happened is not visible from the repository. The rows are
left as they are, and the discrepancy is stated here rather than resolved by guessing.

WS-008 is the first pass of exactly that real use. It is deliberately a workstream of its own
rather than an expansion of the five in REVIEW: the findings cut across all of them, and folding
a cross-cutting build into five rows would leave none of them reviewable. What that pass can and
cannot close for each of them is recorded in `WS-008`, and none of their phases are moved here —
that remains the owner's call.

This board moved here from `50thycal/build-os` when the application was extracted (`DEC-008`).
Protocol contracts stay in build-os and are vendored under `contracts/`; see `contracts/README.md`.

| ID | Workstream | Phase | Status | Current Next Step | Related PR |
|---|---|---|---|---|---|
| [WS-001](WS-001-companion-domain-and-event-ledger.md) | Companion domain + event ledger | REVIEW | Active | Owner review of the durable SQLite ledger, snapshots and attention lifecycle | [#1](https://github.com/50thycal/build-os-companion/pull/1) |
| [WS-002](WS-002-github-feed-mvp.md) | GitHub feed MVP | REVIEW | Active | Owner review of the Feed screen; confirm card collapsing against real Party Games activity | [#1](https://github.com/50thycal/build-os-companion/pull/1) |
| [WS-003](WS-003-build-os-workstream-integration.md) | Build OS workstream integration | REVIEW | Active | Owner review of live artifact parsing; confirm both repository layouts stay detected | [#1](https://github.com/50thycal/build-os-companion/pull/1) |
| [WS-004](WS-004-agent-session-checkpoint-protocol.md) | Agent session checkpoint protocol | READY_TO_BUILD | Paused | Paused deliberately: no agent posts checkpoints yet, so the intake API has no producer | — |
| [WS-005](WS-005-attention-engine-and-catch-up-briefing.md) | Attention engine + catch-up briefing | REVIEW | Active | Owner review of Needs Me and the fact pack against real use before prose rendering | [#1](https://github.com/50thycal/build-os-companion/pull/1) |
| [WS-006](WS-006-podcast-renderer.md) | Podcast renderer | IDEA | Blocked | Blocked until the written fact pack proves accurate in real use against Party Games | — |
| [WS-007](WS-007-owner-application.md) | Owner-facing application | REVIEW | Active | Owner uses the deployed app against Party Games during real Build OS work | [#1](https://github.com/50thycal/build-os-companion/pull/1) |
| [WS-008](WS-008-portfolio-discovery-and-reconciliation.md) | Real-portfolio discovery and reconciliation truth | BUILDING | Active | Independent review of the dogfood implementation head | — |

<!-- Phase: IDEA · EXPLORE · MODEL · DECIDE · BUILD_CARD · READY_TO_BUILD · BUILDING · REVIEW
     Status: Active · Paused · Blocked · Abandoned
     Completed and abandoned workstreams leave this table; their files remain. -->

## Recently completed

None yet. Every workstream above is in review rather than done: the application exists but has
not been used against real work, which is the only thing that can close them.
