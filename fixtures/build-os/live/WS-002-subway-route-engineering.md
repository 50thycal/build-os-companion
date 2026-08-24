# WS-002 — Subway route engineering and playtest UX

**Phase:** REVIEW
**Status:** Active
**Created:** 2026-08-23
**Updated:** 2026-08-24

## Goal

Make every Subway contract feel like a specific engineered line: players plan an ordered physical route, commit line-specific destinations and paid survey points, and then clearly execute that plan on the shared pegboard.

## Context

The first owner playtest of merged Subway v0.3 exposed a common cause behind several problems. Routes were freehand rather than engineered: every contract used its owner's color, segment lengths were arbitrary, hairpin turns were legal, station slots filled automatically, and the interface did not make the active line obvious. The same playtest found that one company held default priority for every contested construction period, committed Engineering progress was invisible until scoring, and accidental placements could not be undone.

The owner also chose to activate two previously deferred planning systems: separate Destination cards assigned to specific lines, and Survey Pins purchased and placed during Engineering. These changes are one workstream because the contract recipe, route planner, destinations, surveys, placement rules, and construction guidance depend on one another.

## Current Mental Model

```text
PROCUREMENT
  buy a distinct-colored contract with an ordered segment recipe
        ↓
ENGINEERING
  commit 3 normal objectives
  separately assign up to 2 Destination cards per line
  buy 0–5 Survey Pins at $1M each and place them publicly
  privately test routes with a non-binding ghost planner
        ↓
SCHEDULING
  lock Gantt blocks; odd/even priority is visible in advance
        ↓
STARTER PLACEMENT
        ↓
CONSTRUCTION
  active line + next length → legal glowing endpoint or exact station slot
  ordered lengths and ≤90° turns are reducer-enforced
  latest physical placement may be undone until another action occurs
        ↓
SCORING
  contracts + stations + Engineering + Destinations + fulfilled surveys
```

## Decisions Made

- **Priority alternates by calendar period.** One company is randomly assigned odd-period priority and the opponent even-period priority; Priority Permit still overrides one contested period.
- **Every contract has a permanent, distinct line color.** Company colors remain ownership and priority indicators, not route colors.
- **Every contract has an ordered segment recipe.** Construction must use the lengths in order; players do not choose the sequence.
- **Segment distance uses physical peg spacing with a small diagonal/station tolerance.** The UI shows only legal next endpoints.
- **Routes may turn at most 90°.** The limit applies at normal pegs and through station slots.
- **Station slots are selected explicitly.** The chosen dock is the visible and geometric endpoint.
- **Planning support is part of the feature.** A private, editable ghost planner lets a player test the full recipe during Engineering and Scheduling.
- **The active line is unmistakable.** The board, contract, endpoint, required length, and legal targets use the line's identity and color.
- **Committed Engineering cards show live private completion.** They remain concealed from the opponent until scoring.
- **Long Segment is removed.** It is replaced by **Network Link**: complete one line that connects two different stations, worth +3 VP.
- **Destination cards are separate commitments.** They do not count toward the three Engineering cards, score +3 VP, and are capped at two per line.
- **Survey Pins are paid public commitments.** A player may buy up to five for $1M each; each is assigned to a line and scores +1 VP if that line builds through it.
- **Undo is deliberately narrow.** Only the latest starter, Survey Pin, or construction placement can be undone, and only before another accepted game action.

## Open Decisions

None. The owner approved the Build Card on 2026-08-23 and resolved the final card-replacement question by removing Long Segment rather than changing the contract recipes around it.

## Assumptions

- Subway remains a two-player game with exactly three contracts per company.
- The 27 × 9 board and current station locations/capacities remain unchanged.
- The initial recipes are balance values for the next playtest, not final certified values.
- Survey markers are public and non-reserving; they communicate intent without creating ownership of a hole.
- Hidden Engineering and Destination commitments continue to use the project's existing social-play secrecy model. The ghost Route Planner itself is local-only and is not published to room state.

## Non-Goals

- More players, maps, stations, Company Cards, multiple project cycles, or a bot.
- Server-side per-player state filtering.
- A general room-level undo/history system.
- A full rebalance of contract prices, mobilization, second crew, or station values.
- Resolving WS-001's retrospective D1–D4 rulings; WS-002 builds on the merged v0.3 behavior.

## Build Card

# Build Card — Subway Route Engineering & Playtest UX

**Workstream:** WS-002
**Status:** Approved
**Date:** 2026-08-23
**Build Spec:** [WS-002 Build Spec](../build-specs/WS-002-subway-route-engineering.md)

### Goal

Make each subway line feel like a specific engineered project: players plan an ordered route, commit destinations and survey points, and then clearly execute that plan on the shared pegboard.

### Current behavior

Lines allow arbitrary segment lengths and very sharp turns. Routes use company colors, priority generally belongs to one player, station slots fill automatically, and players receive little help planning or identifying their active line.

Engineering objectives show results only at final scoring. Destination cards, Survey Pins, route previews, and undo do not exist.

### New behavior

Procurement gives each contract a permanent line color and ordered segment recipe.

During Engineering, players commit three normal Engineering cards, separately assign Destination cards to owned lines (maximum two per line), purchase 0–5 Survey Pins for $1M each, assign/place those pins publicly, and use a private Route Planner to test possible alignments.

Construction alternates priority by period and guides the player through the active line's ordered recipe. Only endpoints with the correct length and legal turn glow.

### Mental model / flow

```text
Procure colored contracts with ordered recipes
        ↓
Commit Engineering cards and line-specific Destinations
        ↓
Buy/place Survey Pins and privately preview routes
        ↓
Schedule construction blocks
        ↓
Place starters
        ↓
Build: active line → required length → legal endpoint/slot
        ↓
Live objective progress → scoring
```

### Initial segment recipes

| Contract | Ordered segment lengths |
|---|---|
| Short | 3–4–3–4 |
| Branch | 5–5–3–4–4 |
| Medium | 3–4–3–4–3–4 |
| Express | 5–4–5–4–5–4 |
| Crosstown | 4–3–4–3–4–3–4 |
| Long | 4–5–4–4–5–4–4–5 |

Lengths are measured in physical peg spaces with a small tolerance for diagonals and station-slot geometry.

### Important rules

- Randomly select one company for odd-period priority; the opponent receives even periods. Priority Permit still overrides one contested period.
- Every contract has a distinct, permanent line color. Company colors remain for ownership and priority indicators.
- Every turn between consecutive segments must be 90° or less, including turns through stations.
- Station connections require selecting the exact open station slot.
- The active line, endpoint, next required length, and legal destinations must always be obvious.
- The contract displays completed, current, and future segment lengths.
- The private Route Planner supports an editable ghost route during Engineering and Scheduling.
- The player's committed Engineering cards show `COMPLETE` as soon as their conditions are met and remain hidden from the opponent until scoring.
- Remove Long Segment. Replace it with **Network Link**: complete one line that connects two different stations, worth +3 VP.
- Destination cards do not count toward the three Engineering commitments. A line may receive at most two. Each completed Destination scores +3 VP, even if the assigned line ultimately remains incomplete.
- Survey Pins cost $1M each; each player may buy up to five. Each pin is assigned to one line and scores +1 VP if that line builds through its normal peg hole.
- Survey Pins are public, non-reserving, and cannot occupy stations. Different players' pins may share a hole; one player may not stack personal pins together.
- Players alternate Survey Pin placement, beginning with the odd-period priority company.
- Undo restores the player's most recent starter, Survey Pin, or construction placement only. It expires immediately when another accepted game action occurs. Purchases, cards, and locked schedules cannot be undone.

### Non-goals

- More than two players; new maps or station layouts; Company powers; additional project cycles.
- Server-side hidden-state filtering.
- Unlimited action history or negotiated opponent-approved undo.
- Final balance certification; these values receive another live playtest after implementation.

### Definition of done

- [x] Players can privately preview an entire ordered route before construction.
- [x] Every placement is validated against segment length, the 90° limit, spatial rules, and the selected station slot.
- [x] Unique line colors and active-line highlighting remain clear on desktop and phone.
- [x] Destination and Survey commitments are assigned, tracked, completed, and scored correctly.
- [x] Odd/even priority and Priority Permit overrides resolve correctly.
- [x] Limited undo safely restores all affected construction state.
- [x] Existing Engineering objectives show live private completion.
- [x] Rules, persisted-state version, automated behavior tests, and project memory are updated.
- [x] Subway build, lint, rules tests, and desktop/mobile playtests pass.

---

**After this change, the system should** let players design recognizable subway routes before construction and then clearly execute those routes under meaningful geometric, financial, destination, and timing constraints.

## Implementation State

**Built and validated; awaiting independent review.** The complete Build Spec is implemented on the WS-002 branch and handed off in PR [#141](https://github.com/50thycal/party-games/pull/141).

What exists now:

- `LineContract.recipe` is the authoritative shape of every contract; `nodes` is gone and node count, build periods, Gantt block length, completion, progress, and tests all derive from the recipe. All six approved recipes are proven buildable on the 27 × 9 board by the rules harness.
- Segment length is physical Euclidean peg distance within ±0.5; turns are capped at 90° inclusive from the second segment onward. Station docks are named explicitly, and a dock's offset position is what both the drawing and the geometry use.
- Every contract has a permanent distinct color, a letter code, and a dash pattern; company ownership moved to peg rings, badges, and labels.
- Odd/even period priority is randomised at start; the schedule board shows the leader for every period, with Priority Permit overrides marked.
- `ENGINEERING` has substeps `PLAN` → `SURVEY`. One lock action commits three objectives, any Destination assignments (max two per line), and a 0–5 Survey Pin purchase charged exactly once. Purchased pins are then placed publicly in alternating order, odd-period company first.
- Long Segment is deleted; Network Link (+3 VP, one completed line connecting two distinct stations) replaces it.
- A client-local Route Planner sketches a whole recipe during Engineering and Scheduling without dispatching, reserving, or persisting anything.
- `UNDO_PLACEMENT` walks back the latest starter, Survey Pin, or construction node from a single bounded pre-placement snapshot, surviving the phase change it caused and expiring on any later accepted action.
- `SUBWAY_STATE_VERSION` is 6; v5 rooms restart per `DEC-008`.

Validation: `./scripts/test-subway.sh`, `npm run build`, and `npm run lint` all pass, plus a scripted two-player desktop (1440px) and phone (390px) playthrough from Procurement to Results covering a fulfilled Destination, a fulfilled and a blocked Survey Pin, both docks of a station, a refused dock race, a Priority Permit override, and undo at both a starter and a build — with no console error and no horizontal overflow.

## Review State

Ready for independent review. The reviewer should compare the approved Build Card, the Build Spec, the PR handoff, the code, and the tests — with particular attention to geometry consistency between the reducer and the view, exact-dock races, the Engineering substep transitions, Destination and Survey scoring, and undo restoration and expiry.

Open for the owner's next playtest, not for review: the recipes, +3 Destinations, and $1M/+1 Survey Pins are unbalanced starting values by design, and the ordered recipe plus the 90° cap strands lines noticeably more often than v0.3 did.

## Related Decisions

- Existing: `DEC-008` (Subway state versioning), `DEC-010` (forced 3/3 ownership), `DEC-011` (shelved lines receive no starter), `DEC-012` (Build OS v0.4).
- Added by this implementation: `DEC-013` (a contract is its ordered recipe; permanent line identity), `DEC-014` (Destinations and Survey Pins as paid commitments beside the three Engineering cards), `DEC-015` (one-placement-deep undo via a pre-placement snapshot).

## Related PRs

[#141](https://github.com/50thycal/party-games/pull/141) — the WS-002 branch, now carrying the implementation and the full Build OS Implementation Handoff. No second implementation PR was opened.

## Next Step

Independent design review of PR #141 against the approved Build Card and Build Spec, then an owner playtest to settle the balance of the recipes, Destination VP, and Survey Pin pricing.
