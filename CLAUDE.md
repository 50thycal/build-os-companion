# Agent instructions — Build OS Companion

This repository follows **Build OS**, the framework in
[`50thycal/build-os`](https://github.com/50thycal/build-os). Read `docs/workstreams/ACTIVE.md`
first: it is the control board, and each row's file carries the detail.

Adopted version: v0.5
Last compatibility check: v0.11 on 2026-09-02 — contracts synced to v0.11 and the reader
understands it. The **pin** stays at v0.5 deliberately: see *Reading v0.11, governed by v0.5*.

## Reading v0.11, governed by v0.5

Checked 2026-09-02, then migrated **partially and on purpose**. Two different things wear the
same version number here, and this repository has moved one of them:

| | Version | What it means |
|---|---|---|
| **What the reader understands** | v0.11 | The protocol this Companion can parse in *other* projects' artifacts |
| **What this project runs under** | v0.5 | The protocol governing this repository's own workstreams and merges |

Syncing a contract and teaching the parser a verdict changes the first. It says nothing about the
second, and conflating them would be the same mistake as reading an acceptance as an approval.

### What the reader gained

`contracts/` is synced to canonical `main` and `npm run contracts:check` passes again. Both
vendored entries had drifted; both moved for reasons that bear directly on what this parses.

- **`Owner-accepted`** (v0.8) as a sixth verdict, recorded in **`Accepted head:`** rather than
  `Reviewed head:` — deliberately a different field, so an acceptance can never be read as an
  approval. It clears the gate only in `solo` mode, and an outstanding `Changes required` still
  closes it.
- **Operating modes** (v0.8). A project declares `reviewed` or `solo` in its framework block;
  absent means `reviewed`. `Owner-accepted` on a `reviewed` project is
  `OWNER_ACCEPTED_IN_REVIEWED_MODE` and the PR is treated as unreviewed.
- **`VERDICT_UNSUPPORTED`** (v0.10): a workstream claiming a verdict that nothing outside it
  records. Narrow by design — it fires only when the PR carries no position at all — because its
  target is a finalization commit that pre-wrote the verdict it expected, not a real verdict that
  merely fails to clear the gate.
- **Relayed acceptances** (v0.11): parsed identically to a posted one, with the prose kept rather
  than normalised away. That prose is the entire difference between an acceptance the owner wrote
  and an agent's report of one.
- **`owner_result`** in the checkpoint schema (v0.6). The schema sets
  `additionalProperties: false`, so before the sync a checkpoint carrying this field was
  *rejected*, not ignored — the concrete cost of a stale contract, and why a drifted hash is
  worth failing a build over.

**Where the framework block lives.** Canonical Build OS has no `CLAUDE.md` — it is a protocol
repository, not a codebase an agent works in — and keeps its framework block in `VERSION.md`,
saying so there. Detection reads that file only for a repository with no instructions file.
`README.md` is deliberately not a fallback: it carries a worked example declaring `reviewed`,
which would give a genuinely `solo` project the opposite answer.

### What is still deferred, and why it is the whole of it

**The pin stays at v0.5 because one question is open, and it is a design decision.** The *owner's
merge is itself a verdict* rule below was invented here on 2026-08-28 for a single-account
repository. v0.8 formalised that same situation upstream as **`solo` mode**.

They agree in spirit and differ in mechanism — the local rule reads the merge commit's second
parent, `solo` mode expects a recorded `Owner-accepted`. Adopting v0.8 for this repository's own
governance without reconciling them would leave two rules for one situation, which is exactly the
drift the vendoring discipline exists to prevent.

So this repository declares **no operating mode**, and therefore reads as `reviewed` — the
stricter default — until that is settled. Pick one, say why in `docs/DECISIONS.md`, then move the
pin and declare the mode in the same change. Nothing about the reader waits on it.

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
