# Agent instructions — Build OS Companion

This repository follows **Build OS**, the framework in
[`50thycal/build-os`](https://github.com/50thycal/build-os). Read `docs/workstreams/ACTIVE.md`
first: it is the control board, and each row's file carries the detail.

Adopted version: v0.11
Last compatibility check: v0.11 on 2026-09-02
Operating mode: solo

## Adopted v0.11, operating in `solo` mode

Migrated 2026-09-02. `contracts/` is synced to canonical `main`, the reader understands v0.11,
and this repository now runs under it. The **operating mode is `solo`** — see `COMP-001`.

### What `solo` means here

One GitHub account, one person, one agent. There is no independent actor available to review
this repository's work, and `solo` is how a project says so out loud instead of leaving a merge
gate permanently unsatisfiable.

It is a **disclosure, not a licence**. What changes:

- The owner accepts significant work at merge, recorded as **`Owner-accepted`** with the commit
  in **`Accepted head`** — never `Reviewed head`, because nothing was reviewed.
- An acceptance is **never** an approval. It is not ranked with one, not rendered as one, and
  `isApprovingVerdict` returns `false` for it. Accepted work is never described as reviewed.
- Only the **owner** writes it. An agent writing `Owner-accepted` is approving its own work under
  another name, which is the failure `DEC-023` names upstream. An agent may **relay** an
  acceptance the owner actually gave, saying so in prose and naming the channel — and may never
  infer one from silence, from a merge, or from approval of something adjacent.
- A missing acceptance is still reported. Declaring `solo` replaces the reviewer, **not the
  record**: a PR merged with no verdict at all is `MERGED_WITHOUT_APPROVAL` exactly as before.
- Finalization legitimately precedes the verdict here, because acceptance happens at merge. That
  ordering is not reported in `solo` mode; it still is in `reviewed`.

Full rules: `framework/REVIEW_PROTOCOL.md` → *Operating modes*, in build-os.

### Adopting this is not retroactive

Work that predates 2026-09-02 was done under v0.5 and is not re-judged by v0.11. **No acceptance
is retrofitted onto anything already merged** — writing `Owner-accepted` onto a past PR would
record a decision nobody made at the time, which is the precise error this mode exists to avoid.
Where an older merge has no verdict, that stays true and stays visible.

## What that date means

It is the **adoption boundary**, not decoration. Work that predates it was done under the previous
version and is never retroactively judged by the new one — a completed workstream, a workstream
untouched since before the date, and a pull request opened and merged before it all stay outside.
That is why the line carries a date rather than a bare version, and why moving the date is a
deliberate act rather than a tidy-up.

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

**An acceptance uses the same form with `Accepted head:` in place of `Reviewed head:`**, and a
consumer keys on that field name to tell one from the other. The substitution is the whole point
and must never be normalised away:

```markdown
Build OS review verdict: Owner-accepted
Accepted head: <full 40-character SHA>
Review actor: <the owner>
Implementation actor reviewed: <the actor this verdict understood it was reviewing>
```

A **relayed** acceptance — one an agent transcribed from a decision the owner gave elsewhere —
uses the identical fields and says so in prose beneath them, naming the channel. It is parsed the
same; the prose is what distinguishes it, and it is not to be dropped when the verdict is shown
to a person.

See `framework/REVIEW_PROTOCOL.md` in build-os for the full rules. This repository implements the
reader for them in `src/ingest/github/comment-verdict.ts`.

### The owner's merge is not, by itself, a verdict

**Retired 2026-09-02 (`COMP-001`).** A standing rule here used to say that when the owner merged
without leaving a verdict comment, that merge *was* the approval, and agents should record
`Verdict: Approved` with the merge commit's second parent afterwards. It was invented on
2026-08-28 for a real problem — a single-account repository cannot obtain GitHub's review
artifact — and v0.8 later solved that same problem upstream as `solo` mode. Keeping both left two
rules for one situation, which is the drift the vendoring discipline exists to prevent.

`solo` mode replaces it, and differs in three ways that matter:

| | Retired rule | `solo` mode |
|---|---|---|
| Records | `Approved` — asserting a review that did not happen | `Owner-accepted` — true as written |
| In field | `Reviewed head` | `Accepted head`, so no check reads it as an approval |
| If nothing is recorded | Nothing to record: merging *was* the verdict | Reported, as a merge with no verdict |

The third is the substantive one. Under the retired rule a merge could not be unaccepted, so the
gate had no failing state left. Under `solo` it can, and it is reported.

**Nothing already recorded under the retired rule is rewritten.** It was the honest answer
available at the time, and re-labelling past records to match a rule that did not yet exist would
be the same error in the other direction.

