/**
 * Print the feed for the bundled fixtures. No token, no network.
 *
 *   npm run demo
 *
 * The point is that a reviewer can see exactly what the pipeline produces without credentials —
 * and that the output comes from the same functions a UI will call.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { InMemoryEventLedger } from "../ledger/ledger.ts";
import { normalizeGitHubObservation } from "../ingest/github/normalize.ts";
import { reconcileBuildOsState } from "../ingest/buildos/reconcile.ts";
import { normalizeWorkstreams, normalizeDecisions } from "../ingest/buildos/normalize.ts";
import { parseDecisions, toDecisionRecords } from "../ingest/buildos/parse.ts";
import { validateCheckpoint } from "../ingest/checkpoint/validate.ts";
import { applyStaleness, toSessionState } from "../ingest/checkpoint/normalize.ts";
import { buildProjectState, projectPullRequests } from "../projection/project.ts";
import { computeAttention, needsMe } from "../attention/engine.ts";
import { buildFeed } from "../feed/cards.ts";
import { DEFAULT_THRESHOLDS } from "../domain/attention.ts";
import type { GitHubObservation } from "../ingest/github/types.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const read = (...p: string[]) => readFileSync(join(FIXTURES, ...p), "utf8");
const readJson = <T>(...p: string[]) => JSON.parse(read(...p)) as T;

const PROJECT = "proj_cargo_ship";
const NOW = new Date("2026-08-23T18:00:00Z");

const ledger = new InMemoryEventLedger();

// Two poll cycles, so transitions are real rather than assumed.
ledger.append(
  normalizeGitHubObservation(readJson<GitHubObservation>("github", "observation-cycle-1.json"), {
    projectId: PROJECT,
  }),
  NOW,
);
const previous = new Map(projectPullRequests(ledger.all()).map((p) => [p.number, p]));
ledger.append(
  normalizeGitHubObservation(readJson<GitHubObservation>("github", "observation-cycle-2.json"), {
    projectId: PROJECT,
    previous,
  }),
  NOW,
);

const reconciled = reconcileBuildOsState(PROJECT, {
  activeBoardPath: "docs/workstreams/ACTIVE.md",
  activeBoardMarkdown: read("build-os", "ACTIVE.md"),
  workstreamFiles: readdirSync(join(FIXTURES, "build-os"))
    .filter((n) => /^WS-\d{3}/.test(n))
    .sort()
    .map((n) => ({ path: `docs/workstreams/${n}`, markdown: read("build-os", n) })),
  observedAt: NOW.toISOString(),
});

ledger.append(normalizeWorkstreams(reconciled.workstreams, { projectId: PROJECT }), NOW);

const decisions = toDecisionRecords(
  PROJECT,
  "docs/DECISIONS.md",
  parseDecisions(read("build-os", "DECISIONS.md")),
);
ledger.append(
  normalizeDecisions(decisions, { projectId: PROJECT, observedAt: NOW.toISOString() }),
  NOW,
);

const checkpoint = validateCheckpoint(readJson("checkpoints", "blocked-on-owner.json"));
const sessions = checkpoint.ok
  ? applyStaleness(
      [
        toSessionState(checkpoint.checkpoint, {
          projectId: PROJECT,
          checkpointSource: "API",
          receivedAt: NOW.toISOString(),
        }),
      ],
      NOW,
      DEFAULT_THRESHOLDS,
    )
  : [];

const state = buildProjectState({
  projectId: PROJECT,
  events: ledger.all(),
  workstreams: reconciled.workstreams,
  sessions,
  decisions,
  integrityWarnings: reconciled.warnings,
  conflicts: reconciled.conflicts,
});

const attention = computeAttention({ state, ownerLogin: "50thycal", now: NOW });
const cards = buildFeed({
  projectId: PROJECT,
  projectName: "50thycal/cargo-ship",
  state,
  events: ledger.all(),
  attention,
  now: NOW,
});

console.log(
  `${ledger.size()} events - ${state.pullRequests.length} PRs - ${state.workstreams.length} workstreams - ${state.sessions.length} sessions`,
);

const blocking = needsMe(attention);
console.log(`\n=== Needs Me (${blocking.length}) ===`);
for (const item of blocking) {
  console.log(`\n[${item.severity}] ${item.reasonCode}\n  ${item.reasonText}\n  -> ${item.recommendedAction}`);
}

console.log(`\n=== Feed (top 6 of ${cards.length}) ===`);
for (const card of cards.slice(0, 6)) {
  console.log(`\n${card.projectName} - ${card.entityLabel}`);
  console.log(card.whatChanged);
  if (card.whyItMatters) console.log(`Why it matters: ${card.whyItMatters}`);
  console.log(`Current: ${card.currentState}`);
  console.log(`Needs you: ${card.needsYou}`);
  if (card.nextStep) console.log(`Next: ${card.nextStep}`);
}

console.log(`\n=== Build OS integrity (${state.integrityWarnings.length}) ===`);
for (const w of state.integrityWarnings) console.log(`- [${w.code}] ${w.message}`);
