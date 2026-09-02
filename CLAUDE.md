# Agent instructions — Build OS Companion

This repository follows **Build OS**, the framework in
[`50thycal/build-os`](https://github.com/50thycal/build-os). Read `docs/workstreams/ACTIVE.md`
first: it is the control board, and each row's file carries the detail.

Adopted version: v0.5
Last compatibility check: v0.11 on 2026-09-02 — **six versions behind, and the vendored
contracts have drifted.** See *Canonical is ahead* below before doing protocol work.

## Canonical is ahead — v0.5 adopted, v0.11 released

Checked 2026-09-02. This is not just a stale version line: **`npm run contracts:check` fails
against canonical right now**, on both vendored entries.

| Vendored file | `sha256` in `MANIFEST.json` | On canonical `main` |
|---|---|---|
| `agent-session-checkpoint.v1.schema.json` | `9001e808…be46` | `b70b62b1…35b3` |
| `WORKSTREAM.template.md` | `36edf386…4a78` | `2407dba2…0c56` |

Both moved for real reasons, and both bear directly on what this Companion parses:

- **The checkpoint schema gained an optional `owner_result`** enum — `SHIP` / `DECISION` /
  `BLOCKED` (v0.6). Absent in every checkpoint written before it, which is absent metadata
  rather than an error.
- **The workstream template gained the `Owner-accepted` verdict and an `Accepted head`
  field** (v0.8, v0.10), plus the rule that a finalization commit never writes a verdict it
  does not yet have.

### What a migration has to include

**Not just `contracts:sync`.** Syncing the hashes without touching
`src/ingest/github/comment-verdict.ts` would leave the reader silently not understanding
`Owner-accepted` or `Accepted head` — a parser that reports "no verdict" where one exists is
worse than a check that fails loudly. `contracts/README.md` already says it: a contract change
is a protocol change, and should be treated as one.

The reader work, in rough order of size:

1. **`Owner-accepted`** as a sixth verdict (v0.8), recorded in **`Accepted head:`** rather than
   `Reviewed head:` — deliberately a different field, so an acceptance can never be read as an
   approval. It clears the gate only in `solo` mode.
2. **Operating modes** (v0.8): a project declares `reviewed` or `solo` in its framework block.
   `Owner-accepted` on a `reviewed` project is `OWNER_ACCEPTED_IN_REVIEWED_MODE`.
3. **`VERDICT_UNSUPPORTED`** (v0.10): a workstream claiming a verdict nothing outside it records.
4. **Relayed acceptances** (v0.11): an agent may transcribe an acceptance the owner gave
   elsewhere, and must name the channel. Parsed identically; the prose must not be normalised
   away, because it is the whole difference between an authenticated verdict and a reported one.

### The standing rule and `solo` mode overlap

**Worth deciding deliberately at migration.** The *owner's merge is itself a verdict* rule below
was invented here on 2026-08-28 for a single-account repository. v0.8 formalised that same
situation upstream as **`solo` mode**, where the owner accepts at merge and it is recorded as
`Owner-accepted`.

They agree in spirit and differ in mechanism — the local rule reads the merge commit's second
parent, `solo` mode expects a recorded acceptance. Adopting v0.8 without reconciling them would
leave two rules for one situation, which is exactly the drift the vendoring discipline exists to
prevent. Pick one, and say why in `docs/DECISIONS.md`.

### Meanwhile

The v0.5 pin is still honest and still covers current work — later versions do not reach back,
and nothing already merged is retroactively judged. What is *not* honest is a green
`contracts:check`, because it is not green. Treat a failure there as expected until this is
migrated, and do not silence it by re-recording the hashes alone.

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

### The owner's merge is itself a verdict

**Standing rule, set by the owner on 2026-08-28.** When the owner merges a pull request in this
repository without leaving a verdict comment, that merge *is* the approval. It is a deliberate act,
not an oversight, and nothing is to report it as a missing verdict.

The evidence is as good as a comment's, which is why this is a form of the rule rather than a hole
in it: a merge names the commit it approved at the moment it happens, and it cannot be edited
afterwards. That is the same property `Reviewed head:` exists to provide.

**The reviewed head is the merge commit's *second* parent** — the pull request head that was
merged. The first parent is the base branch as it stood before the merge, which is the one commit
the owner was certainly *not* approving. Read it with `git log -1 --format='%P' <merge>` and take
the second SHA.

What it does **not** do is make the merge independent, and it grants nothing to an agent. An agent
still never merges its own significant work, and a verdict recorded this way names the owner as the
review actor because the owner is who performed it. Agents record it in the workstream's Review
State after the fact:

    **Verdict:** Approved
    **Reviewed head:** <second parent of the merge commit — the PR head>
    **Reviewed PR:** #<n>
    **Finalization:** Recorded after merge; the owner's merge is the verdict (CLAUDE.md).

The merge-finalization commit remains the norm while a pull request is still open. This rule only
says what to do once a merge has already happened without one: record it, rather than leaving a
workstream claiming it is unreviewed.
