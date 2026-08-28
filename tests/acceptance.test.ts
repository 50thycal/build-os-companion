/**
 * The acceptance test.
 *
 * Six questions the owner should be able to answer on a phone without opening GitHub. Each one
 * is answered here from the same normalized ledger and state everything else reads — no test
 * reaches for GitHub, and the GitHub port passed in throws if anything tries.
 *
 * Data is the real Party Games material recorded on 2026-08-24.
 */

import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { CompanionApp } from "../src/app/companion-app.ts";
import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { durableSync } from "../src/sync/durable-sync.ts";
import { applyConfig, parseConfig, projectIdFor } from "../src/config/followed.ts";
import { createCompanionServer } from "../src/web/server.ts";
import { renderFactPack } from "../src/briefing/render.ts";
import type { GitHubPort } from "../src/ingest/github/client.ts";
import { livePartyGamesPort, PARTY_GAMES } from "./live-port.ts";

const SYNCED_AT = new Date("2026-08-24T12:00:00Z");
const OPENED_AT = new Date("2026-08-24T14:00:00Z");
const OWNER = "50thycal";

/** Anything that reaches a source system from a screen is a failure, not a slow path. */
const noGitHub: GitHubPort = {
  async observe() {
    throw new Error("a screen queried GitHub");
  },
  async listPaths() {
    throw new Error("a screen queried GitHub");
  },
  async readFile() {
    throw new Error("a screen queried GitHub");
  },
};

async function deployed() {
  const db = openDatabase({ location: ":memory:" });
  const store = new CompanionStore(db);
  const ledger = new SqliteEventLedger(db);

  // Both repositories are followed, from configuration.
  applyConfig(
    store,
    parseConfig({
      ownerLogin: OWNER,
      projects: [
        { repository: "50thycal/party-games", displayName: "Party Games" },
        { repository: "50thycal/build-os", displayName: "Build OS" },
      ],
    }),
    SYNCED_AT,
  );

  await durableSync({
    store,
    ledger,
    github: livePartyGamesPort(),
    project: store.getProject(PARTY_GAMES.id)!,
    ownerLogin: OWNER,
    now: SYNCED_AT,
  });

  const app = new CompanionApp({
    store,
    ledger,
    ownerLogin: OWNER,
    github: () => noGitHub,
    clock: () => OPENED_AT,
  });

  return { db, store, ledger, app };
}

async function pages(app: CompanionApp): Promise<Record<string, string>> {
  const server = createCompanionServer({ app });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const routes: Record<string, string> = {
      feed: "/",
      needsMe: "/needs-me",
      projects: "/projects",
      project: `/projects/${PARTY_GAMES.id}`,
      briefing: "/briefing",
    };
    const out: Record<string, string> = {};
    for (const [name, route] of Object.entries(routes)) {
      const response = await fetch(base + route);
      expect(response.status, route).toBe(200);
      out[name] = await response.text();
    }
    return out;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("the owner opens the Companion on a phone", () => {
  it("1. answers what changed across the followed projects", async () => {
    const { app } = await deployed();
    const rendered = await pages(app);

    // Both followed projects are present as projects; Party Games has recorded activity.
    expect(rendered.projects).toContain("Party Games");
    expect(rendered.projects).toContain("Build OS");

    const cards = app.feed();
    expect(cards.length).toBeGreaterThan(0);
    expect(rendered.feed).toContain("PR #142");
    expect(rendered.feed).toContain("Where it stands");

    // Nothing on the page came from a live source system.
    for (const page of Object.values(rendered)) expect(page).not.toContain("queried GitHub");
  });

  it("2. answers which workstreams are active", async () => {
    const { app } = await deployed();
    const view = app.projectView(PARTY_GAMES.id)!;
    const rendered = await pages(app);

    expect(view.activeWorkstreams.map((w) => w.workstreamId).sort()).toEqual(["WS-001", "WS-002"]);
    expect(view.activeWorkstreams.every((w) => w.phase === "REVIEW")).toBe(true);
    expect(rendered.project).toContain("Active workstreams · 2");
    expect(rendered.project).toContain("Subway v0.3 gameplay redesign");
  });

  it("3. answers which PRs are waiting", async () => {
    const { app } = await deployed();
    const view = app.projectView(PARTY_GAMES.id)!;
    const rendered = await pages(app);

    expect(view.openPullRequests.map((p) => p.number)).toEqual([142]);
    expect(rendered.project).toContain("Open pull requests · 1");
    // And which workstream it carries, both ways.
    expect(view.state.pullRequests.find((p) => p.number === 141)!.workstreamIds).toEqual(["WS-002"]);
  });

  it("4. answers whether anything requires the owner, and why", async () => {
    const { app } = await deployed();
    const rendered = await pages(app);
    const needs = app.needsMe();

    // Two things, and the second one is the point of the whole application: the live Party
    // Games records say WS-002 is in REVIEW while the pull request that carried it has merged.
    // That contradiction used to be a LOW project-level item, below the threshold this screen
    // uses, so the owner could never see it here.
    expect(needs).toHaveLength(2);
    expect(needs[0]!.reasonCode).toBe("OWNER_DECISION_REQUIRED");
    expect(needs[0]!.severity).toBe("HIGH");
    expect(needs[1]!.reasonCode).toBe("BUILD_OS_INTEGRITY");
    expect(needs[1]!.severity).toBe("MEDIUM");
    expect(needs[1]!.reasonText).toContain("WS-002 is still in REVIEW");

    // Each of the four questions the screen must answer.
    expect(rendered.needsMe).toContain("Why");                       // what and why
    expect(rendered.needsMe).toContain("Do next");                   // what to do
    expect(rendered.needsMe).toContain("Why the system thinks so");   // the evidence
    expect(rendered.needsMe).toContain("OWNER_DECISION_REQUIRED");

    // Nothing suppressed ever reaches the screen.
    expect(needs.every((item) => item.severity !== "NONE")).toBe(true);
  });

  it("5. answers what changed since the owner last checked, and only then", async () => {
    const { app, store, ledger } = await deployed();

    // First visit: a first look, not news.
    expect(app.since().isFirstLook).toBe(true);
    let rendered = await pages(app);
    expect(rendered.briefing).toContain("First look");

    // Reading it changes nothing.
    expect(app.readCursor()).toBeUndefined();

    // The owner marks it read.
    app.markChecked(app.since().toSequence);
    expect(app.since().quiet).toBe(true);

    // Something then happens: PR #142 merges.
    await durableSync({
      store,
      ledger,
      github: livePartyGamesPort({
        observedAt: "2026-08-24T13:00:00Z",
        transform: (pr) =>
          pr.number === 142
            ? {
                ...pr,
                state: "closed",
                merged: true,
                mergedAt: "2026-08-24T12:30:00Z",
                closedAt: "2026-08-24T12:30:00Z",
                updatedAt: "2026-08-24T12:30:00Z",
              }
            : pr,
      }),
      project: store.getProject(PARTY_GAMES.id)!,
      ownerLogin: OWNER,
      now: new Date("2026-08-24T13:00:00Z"),
    });

    const since = app.since();
    expect(since.quiet).toBe(false);
    expect(since.isFirstLook).toBe(false);

    // Reported as finished, categorised rather than dumped in order.
    const finished = since.groups.find((g) => g.category === "FINISHED")!;
    expect(finished.entries.map((e) => e.entityId)).toContain("pr:142");

    rendered = await pages(app);
    expect(rendered.briefing).toContain("Finished");
    expect(rendered.briefing).toContain("#142");
    // The decision item was already known, so it is not re-announced as new.
    expect(since.newAttention).toHaveLength(0);
  });

  it("6. answers what to do next", async () => {
    const { app } = await deployed();
    const pack = app.briefing();
    const next = pack.sections.find((s) => s.key === "WHAT_NEXT")!;

    expect(next.facts.length).toBeGreaterThan(0);
    expect(next.facts[0]!.text).toContain("Answer the open decisions");

    // And it is grounded: every fact in the pack traces to a real entity or event.
    const known = new Set(app.feed().flatMap((c) => c.eventIds));
    for (const fact of pack.sections.flatMap((s) => s.facts)) {
      expect(fact.refs.length).toBeGreaterThan(0);
      for (const ref of fact.refs.filter((r) => r.kind === "EVENT")) {
        expect(known.has(ref.id)).toBe(true);
      }
    }
  });

  it("renders the whole briefing as text from the same pack", async () => {
    const { app } = await deployed();
    const text = renderFactPack(app.briefing());

    for (const heading of [
      "What changed",
      "What needs me",
      "What finished",
      "What agents and workstreams are doing",
      "What is blocked",
      "What to look at next",
    ]) {
      expect(text).toContain(`## ${heading}`);
    }
  });

  it("keeps every answer available after a restart with no sync", async () => {
    const { app, store, ledger } = await deployed();
    const before = {
      feed: app.feed().length,
      needs: app.needsMe().length,
      workstreams: app.projectView(PARTY_GAMES.id)!.activeWorkstreams.length,
    };

    // A new process against the same storage, with no ability to sync at all.
    const restarted = new CompanionApp({ store, ledger, ownerLogin: OWNER, clock: () => OPENED_AT });
    expect(restarted.canSync).toBe(false);

    expect(restarted.feed().length).toBe(before.feed);
    expect(restarted.needsMe().length).toBe(before.needs);
    expect(restarted.projectView(PARTY_GAMES.id)!.activeWorkstreams.length).toBe(before.workstreams);

    const rendered = await pages(restarted);
    expect(rendered.needsMe).toContain("OWNER_DECISION_REQUIRED");
    expect(rendered.project).toContain("WS-001");
  });

  it("shows both followed repositories, one of which has no recorded activity yet", async () => {
    const { app } = await deployed();
    const ids = app.projects().map((p) => p.id);

    expect(ids).toContain(projectIdFor("50thycal/party-games"));
    expect(ids).toContain(projectIdFor("50thycal/build-os"));

    // build-os has never synced; it is listed as clear rather than as an error.
    const buildOs = app.projectView(projectIdFor("50thycal/build-os"))!;
    expect(buildOs.activeWorkstreams).toHaveLength(0);
    expect(buildOs.project.lastSyncedAt).toBeUndefined();
  });
});
