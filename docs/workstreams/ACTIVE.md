# Active Work

<!-- The Companion's active-work control board. One line per workstream; anything needing a
     paragraph belongs in its file. -->

**Updated:** 2026-08-24 · **Build OS v0.4**

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

<!-- Phase: IDEA · EXPLORE · MODEL · DECIDE · BUILD_CARD · READY_TO_BUILD · BUILDING · REVIEW
     Status: Active · Paused · Blocked · Abandoned
     Completed and abandoned workstreams leave this table; their files remain. -->

## Recently completed

None yet. Every workstream above is in review rather than done: the application exists but has
not been used against real work, which is the only thing that can close them.
