# Decisions — Party Games

Why does the system work this way? Lightweight ADRs, appended in order, newest at the bottom.
This log follows [Build OS v0.4](https://github.com/50thycal/build-os).

## How to add an entry

1. **Record consequential decisions only.** A decision belongs here if it constrains future work,
   is expensive to reverse, resolves a real trade-off where the losing option was defensible, was
   an owner decision with lasting effect, or deliberately accepts a cost. Naming, file layout, and
   choices any competent engineer would make the same way do not belong here.
2. **Use the next free `DEC-nnn`.** IDs are stable: never reused, never renumbered.
3. **Never rewrite an accepted entry** because the architecture later changed. Add a new entry
   that supersedes it, and change *only* the old entry's `Status` line to
   `Superseded by DEC-0NN`. The original context and rationale stay exactly as written — that
   record is the whole point of the file.
4. **Write `Alternatives considered: Unknown / not documented`** rather than inventing a rationale
   that was never recorded.
5. **Ship the entry in the same pull request as the change it explains.**
6. **An *open* decision does not belong here.** A choice still awaiting owner judgment lives in
   its workstream file under `Open Decisions` (`docs/workstreams/`). It graduates to a `DEC-nnn`
   once it is both settled and consequential — recording an unratified implementer ruling as an
   accepted decision launders it into history.

Format:

```text
### DEC-nnn — <Decision stated as a decision>

**Date:** YYYY-MM-DD
**Status:** Proposed · Accepted · Superseded by DEC-0NN · Deprecated

**Context**
**Decision**
**Rationale**
**Alternatives considered**
**Consequences**
```

> **Provenance note.** `DEC-001`–`DEC-008` were reconstructed on 2026-08-22 from repository
> evidence — commit messages, the original `docs/history/SPEC.md`, and the code itself — when this
> log was created. Rationale is quoted or paraphrased from what those commits actually state.
> Decisions whose reasoning could not be established from the repository were deliberately left
> out rather than invented.

---

### DEC-001 — Games are plugins; the engine stays game-agnostic

**Date:** 2025-12-06
**Status:** Accepted

**Context**
The project's founding goal (`docs/history/SPEC.md` §1–2) was to be able to build many small party
games quickly. The alternative most such projects fall into is one codebase per game, or a shared
codebase where each new game requires edits to shared routing, lobby, and networking code.

**Decision**
Define a single `GameTemplate<S, A>` contract — `initialState`, `reducer`, `getPhase`, optional
`isActionAllowed` — that every game satisfies. The engine (rooms, players, action dispatch,
persistence, syncing) knows nothing about any specific game. Adding a game means adding a folder
and registering it; no engine file changes.

**Rationale**
Stated in the spec as "developer speed, clarity, and extensibility": the shared infrastructure is
written once, and iteration cost per game stays flat as the number of games grows. Pure
`(state, action) => newState` rules are also testable without a server.

**Alternatives considered**
- **A game-aware engine with per-game branches.** Rejected in the spec's framing: it makes every
  new game a change to shared code.

**Consequences**
- Seven games now share one deploy, one lobby, and one persistence layer.
- The engine cannot optimise for any single game — a game needing different transport or timing
  guarantees has to work within the shared model or change it for everyone.
- Game rules are pure, so they can be driven directly by test harnesses and simulators
  (`scripts/subway-rules-test.ts`, `/test`).

---

### DEC-002 — Views live on the client, not in the game template

**Date:** 2025-12-07
**Status:** Accepted

**Context**
The original spec put `views: { HostView, PlayerView }` inside `GameTemplate`, which meant the
server-side game registry transitively imported React components. Commit `f40d186` changed this
while adding game selection.

**Decision**
Remove views from `GameTemplate` — "the engine is now logic-only". Game UI is resolved through a
separate client-side registry (`src/games/views.ts`) that maps a game id to a single `GameView`
component receiving `{state, room, playerId, isHost, dispatchAction}`.

**Rationale**
Keeps the server bundle free of client components and makes the room page fully generic: it looks
up a component by id and renders it, so it never changes when games are added. A single
`GameView` (rather than separate host/player views) lets each game decide for itself how much the
host and player screens differ.

**Alternatives considered** — Unknown / not documented.

**Consequences**
- Every game is registered **twice**: logic in `gameRegistry.ts`, UI plus player-facing metadata
  in `views.ts`. The two can drift.
- `minPlayers`/`maxPlayers` are now duplicated between the template and `gameOptions`.
- `GameTemplate.getPhase` survived the change but lost its consumer; nothing calls it today.

---

### DEC-003 — Sync by polling, not WebSockets

**Date:** 2025-12-06
**Status:** Accepted

**Context**
Real-time multiplayer normally implies a socket layer. The spec (§8) chose to defer that: "Phase 1
(MVP) — Polling … Advantages: zero complexity, great for early playtesting", with a stated Phase 2
upgrade path that would leave reducer and game code untouched.

**Decision**
Clients `GET /api/get-room` once per second and re-render from the returned snapshot. Actions are
ordinary `POST`s. No sockets, no push.

**Rationale**
Zero infrastructure on a serverless host, no connection lifecycle to manage, and party games at
this scale tolerate ~1s latency. The action/reducer contract is transport-independent, so the
upgrade stays available.

**Alternatives considered**
- **WebSockets from the start** (spec §8 Phase 2, §11). Deferred as unneces