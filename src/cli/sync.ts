/**
 * Headless sync: poll a repository, project state, and print the feed.
 *
 * There is no web UI or database yet by design — the point of this CLI is to prove the pipeline
 * against a real repository before any infrastructure is chosen. Everything it prints comes from
 * the same functions a UI will call.
 *
 *   GITHUB_TOKEN=... npm run sync -- --repo owner/name --owner-login yourlogin
 */

import { InMemoryEventLedger } from "../ledger/ledger.ts";
import { HttpGitHubClient } from "../ingest/github/client.ts";
import { detectBuildOs } from "../ingest/buildos/detect.ts";
import { syncProject } from "../sync/sync-project.ts";
import { needsMe } from "../attention/engine.ts";
import { DEFAULT_BUILD_OS_PATHS, type FollowedProject } from "../domain/state.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function relative(from: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(from).getTime()) / 60000);
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

async function main(): Promise<void> {
  const repo = arg("repo");
  const ownerLogin = arg("owner-login") ?? repo?.split("/")[0];
  const token = process.env.GITHUB_TOKEN;

  if (!repo || !token) {
    console.error("usage: GITHUB_TOKEN=... npm run sync -- --repo owner/name [--owner-login login]");
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const github = new HttpGitHubClient({ token });

  const workstreamPaths = await github.listPaths(repo, DEFAULT_BUILD_OS_PATHS.workstreamDir);
  const claudeMd = await github.readFile(repo, "CLAUDE.md");
  const detection = detectBuildOs({
    paths: [...workstreamPaths, DEFAULT_BUILD_OS_PATHS.activeWork],
    agentInstructions: claudeMd?.content,
  });

  const project: FollowedProject = {
    id: `proj_${repo.replace(/[^a-z0-9]/gi, "_")}`,
    ownerUserId: "cli",
    repositoryFullName: repo,
    defaultBranch: "main",
    buildOsDetected: detection.detected,
    buildOsVersion: detection.version,
    paths: detection.paths,
    enabled: true,
    createdAt: now.toISOString(),
  };

  const ledger = new InMemoryEventLedger();
  const result = await syncProject({ project, github, ledger, ownerLogin: ownerLogin!, now });

  console.log(`\n${repo}`);
  console.log(
    `Build OS: ${detection.detected ? `detected${detection.version ? ` (v${detection.version})` : ""}` : "not detected"} — ${detection.evidence.join("; ")}`,
  );
  console.log(
    `${result.appended.length} new events, ${result.duplicates} duplicates suppressed, ${result.state.pullRequests.length} PRs, ${result.state.workstreams.length} workstreams`,
  );

  const attention = needsMe(result.attention);
  console.log(`\n=== Needs Me (${attention.length}) ===`);
  if (attention.length === 0) console.log("Nothing.");
  for (const item of attention) {
    console.log(`\n[${item.severity}] ${item.reasonCode}`);
    console.log(`  ${item.reasonText}`);
    console.log(`  -> ${item.recommendedAction}`);
  }

  console.log(`\n=== Feed (${result.cards.length}) ===`);
  for (const card of result.cards.slice(0, 15)) {
    console.log(`\n${card.projectName} - ${card.entityLabel} - ${relative(card.occurredAt, now)}`);
    console.log(card.headline);
    if (card.whatChanged !== card.headline) console.log(card.whatChanged);
    if (card.whyItMatters) console.log(`Why it matters: ${card.whyItMatters}`);
    console.log(`Current: ${card.currentState}`);
    console.log(`Needs you: ${card.needsYou}`);
    if (card.nextStep) console.log(`Next: ${card.nextStep}`);
    if (card.sourceUrl) console.log(card.sourceUrl);
  }

  if (result.warnings.length > 0) {
    console.log(`\n=== Build OS integrity (${result.warnings.length}) ===`);
    for (const warning of result.warnings) console.log(`- [${warning.code}] ${warning.message}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
