# Decisions — Build OS Companion

Durable decisions about **this repository**: its governance, its architecture, and the
trade-offs behind both. One entry per decision, newest last, never rewritten — a decision that
turns out wrong is superseded by a later entry that says so, because the reasoning that looked
right at the time is the useful part.

## Numbering, and why it is not `DEC-`

`COMP-###` entries are this repository's own. **A bare `DEC-###` anywhere in this repository
means a decision in canonical [`50thycal/build-os`](https://github.com/50thycal/build-os)** —
`DEC-008` and `DEC-011` govern this application's extraction, and `DEC-021` and `DEC-023` govern
how verdicts may be written. Those numbers are already allocated upstream and reusing them here
would make a reference ambiguous about which repository it means.

---

## COMP-001 — Adopt `solo` mode, and retire the merge-is-a-verdict rule

**Date:** 2026-09-02 · **Status:** Accepted · **Supersedes:** the standing rule of 2026-08-28

### Decision

This repository declares Build OS **operating mode `solo`** and adopts **v0.11**. The standing
rule that *the owner's merge is itself a verdict* is retired.

### Context

This repository is worked by one GitHub account. GitHub refuses an `APPROVE` review on a pull
request the account authored, so the review artifact the v0.5 merge gate reads can never exist
here. Left alone, the gate is permanently unsatisfiable.

On 2026-08-28 that was solved locally: a merge by the owner *was* the approval, and agents
recorded `Verdict: Approved` with the merge commit's second parent afterwards. Build OS v0.8
later solved the same problem upstream, as `solo` mode. Two rules for one situation is precisely
the drift the vendoring discipline exists to prevent, so one had to go.

### Why `solo` rather than the local rule

Three differences, one of them decisive.

1. **The local rule recorded something untrue.** It wrote `Approved`, which asserts that a review
   happened. Nobody independent read the diff. `Owner-accepted` states what actually occurred —
   the owner took responsibility for unreviewed work — and is a weaker claim honestly made.
   Build OS reached this conclusion the hard way upstream, after three consecutive releases
   merged claiming a reviewer that did not exist.
2. **It put the commit in the wrong field.** `Reviewed head` is read by every check that asks
   whether something was reviewed. `Accepted head` is a separate field precisely so no such check
   can mistake an acceptance for an approval, and `isApprovingVerdict` returns `false` for it.
3. **It left the gate with no failing state.** If merging *is* approval, "merged without anyone
   accepting it" cannot occur, and `MERGED_WITHOUT_APPROVAL` becomes unreachable. Under `solo`
   the owner can merge without recording an acceptance, and that is reported. Declaring `solo`
   replaces the reviewer, not the record. A gate that cannot fail is not a gate.

A fourth, smaller: the local rule had **agents** write `Approved` for work agents did. The merge
is decent evidence, but the shape is what `DEC-023` forbids upstream. `solo` reserves the
acceptance to the owner, and allows an agent only to *relay* one the owner actually gave.

### What it costs

`solo` is a disclosure, not an improvement. This repository's significant work is accepted, not
reviewed, and now says so in every record. Nothing here becomes better-reviewed; it becomes
accurately described. The one real loss is the local rule's convenience: an acceptance must be
written, where before it was implied by the act of merging.

### What was rejected

- **Keep both rules.** They agree in spirit and conflict in mechanism, so any consumer reading
  both must guess which governs. That is the ambiguity vendoring exists to remove.
- **Keep the local rule and stay on v0.5.** Viable, and it was the standing position until today.
  Rejected because the local rule's `Approved` is the specific inaccuracy v0.8 was written to
  fix, and this repository is the one that *reads* Build OS artifacts for other projects — it
  should not run a protocol it reports as a contradiction elsewhere.
- **Adopt `solo` and retroactively record acceptances** on already-merged work. Rejected: writing
  `Owner-accepted` onto a past merge records a decision nobody made at the time. Where an older
  merge has no verdict, that remains true and remains visible.

### Consequences

- `CLAUDE.md` declares `Operating mode: solo`; the pin moves to v0.11 with an adoption boundary
  of 2026-09-02. Work before that date is not re-judged.
- Records written under the retired rule are left exactly as they are. They were the honest
  answer available at the time, and re-labelling them to match a rule that did not yet exist
  would be the same error in the other direction.
- The reader implementing all of this landed in **#16**, which is what made the choice
  actionable rather than theoretical.
