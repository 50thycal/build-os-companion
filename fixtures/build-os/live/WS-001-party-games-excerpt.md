<!-- Recorded verbatim from 50thycal/party-games docs/workstreams/WS-001-subway-v0-3-redesign.md
     on 2026-08-24, during Phase 2 live-ingestion validation. Trimmed to the sections that
     disproved the parser's assumptions; every line kept is byte-identical to the real file,
     including its hard wrapping, which is the whole point of the fixture. -->

# WS-001 — Subway v0.3 gameplay redesign

**Phase:** REVIEW
**Status:** Active
**Created:** 2026-08-23 *(retrofitted; the work itself ran 2026-08-19 → 2026-08-22)*
**Updated:** 2026-08-23

## Next Step

Independent design review of merged Subway v0.3 against the reconstructed intent above, and an
owner ruling on D1–D4.

## Open Decisions

**Rulings needing owner ratification.** Each was made by the implementer where the brief was
silent or ambiguous, and each changes what a player experiences. None has been owner-approved.
They are listed here rather than written into `DECISIONS.md`, because an unratified decision is
an open question, not a rationale.

- **D1. Shelving.** A company may leave a contract off the schedule entirely and eat its
  incomplete penalty (−4 to −8 VP). Introduced because a company forced above the horizon would
  otherwise have *no* legal schedule and Scheduling would deadlock. **This is product behavior,
  not a termination detail**: it turns "which contracts can I finish?" into a live strategic
  choice, and it interacts with the second-crew price (D6). *Options:* keep as is · keep but
  make shelving cost something beyond the penalty · remove and prevent over-commitment during
  Procurement instead. *Recommendation:* keep for now — with the cap at three, over-commitment
  is rarer than it was at four, but the escape valve still prevents a hard deadlock.
- **D2. "Five procurement decisions" is descriptive, not a gate.** The brief specified five
  decisions per company; the implementation tracks and displays `decisionsUsed` but never blocks
  on it, because Discount Yard cleanup can need more and gating could strand a contract unowned.
  **This is a departure from a stated brief requirement.** *Options:* accept descriptive ·
  restore the gate and change yard cleanup so it cannot exceed the budget · drop the counter
  from the UI entirely. *Recommendation:* accept descriptive, and consider dropping the display
  — a counter that never binds invites players to think it does.
- **D3. Distressed sale / floor deadlock.** Termination mechanics (above). Product-visible only
  in a corner case, but the corner is reachable: it decides who ends up owning a contract nobody
  wants and at what price. *Recommendation:* ratify as implementation discretion; no ADR.
- **D4. Surge Crew targets any other incomplete line of yours**, not only one scheduled in that
  period — otherwise the card is dead whenever a single block is running. This changes the
  card's power against the schedule players just paid to lock. *Options:* keep · restrict to
  scheduled lines and accept dead draws · restrict and compensate elsewhere.

**Balance questions raised by PR #137 and not answered.** These are playtest hypotheses, not
decisions:

- **D5.** Mobilization makes late starts free, but a large portfolio *must* start early to fit
  16 periods — so the surcharge may be an unavoidable tax rather than a choice.
- **D6.** Second crew ($2M/period) versus incomplete penalties (−4 to −8) decides whether
  compressing or shelving is correct. Watch which one play-testers pick.
- **D7.** Nothing rewards finishing early, so there is little reason to start before you must,
  beyond racing for stations.
- **D8.** Whether the forced 3/3 split (`DEC-010`) is dull in play. The recorded future move is
  relaxing "every contract sells" together with the cap — not either alone.
