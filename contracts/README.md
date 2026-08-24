# Vendored Build OS contracts

`50thycal/build-os` is the **canonical** source of every protocol contract in this directory.
Nothing here may be edited to change protocol meaning. If a contract needs to change, the
change is made in `build-os` first and vendored down afterwards.

## Why vendor at all

The Companion has to parse checkpoints and Build OS artifacts without a network round-trip to
the protocol repository, and its tests have to run offline and deterministically. So the
contracts are copied in — and because the cost of a copy is drift, the copy is **checked**
rather than trusted.

## The two checks

| Check | When | What it proves |
|---|---|---|
| `npm test` (`tests/contract-sync.test.ts`) | Every test run, offline | The vendored file still matches the `sha256` recorded in `MANIFEST.json`, and — where an entry names a `consumedBy` copy under `src/` — that copy is byte-identical to the one here. Catches local edits. |
| `npm run contracts:check` | CI and on demand, needs network | The recorded `sha256` still matches the file at `canonicalPath` in `50thycal/build-os`. Catches upstream drift. |

The offline check is the one that gates the build, because a build must not fail when GitHub is
unreachable. The network check is the one that tells you the protocol moved.

## Not every entry is a schema

`WORKSTREAM.template.md` is vendored too. It is not parsed at runtime — it is read by
`tests/review-state-parse.test.ts`, which proves the protocol's own workstream template still
parses under this Companion's rules. Testing against an invented fixture instead would prove
only that the Companion agrees with itself; testing against the real template is what notices
when the protocol changes shape.

Entries like that have a `readBy` rather than a `consumedBy`: there is no second copy under
`src/`, so there is nothing to keep byte-identical, and the offline check verifies the hash
alone.

**One entry is currently ahead of canonical `main`.** The vendored template is the v0.5 one from
`build-os` PR #7, which is in review. Until that PR merges, `npm run contracts:check` reports
drift on that file — and that drift is the pending upgrade, not a failure. When it merges, run
`contracts:sync` and the two agree again.

## Updating a vendored contract

1. Land the change in `50thycal/build-os`.
2. `npm run contracts:sync` — pulls the canonical file, rewrites `sha256`, updates the copy
   under `src/`.
3. Review the diff. A contract change is a protocol change; treat it as one.
4. Bump `buildOsVersion` if the protocol version moved, and record the decision.
