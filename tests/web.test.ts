/**
 * The web application.
 *
 * The architectural assertion here matters as much as the rendering ones: every page is served
 * with a GitHub port that throws if anything touches it. If a view ever grows its own call to
 * a source system, these tests fail — which is the acceptance criterion that no UI component
 * may create a second interpretation pipeline, made mechanical rather than aspirational.
 */

import { describe, expect, it } from "vitest";
import type { RepositoryFile } from "../src/ingest/github/client.ts";
import type { AddressInfo } from "node:net";

import { CompanionApp } from "../src/app/companion-app.ts";
import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { durableSync } from "../src/sync/durable-sync.ts";
import { createCompanionServer } from "../src/web/server.ts";
import { esc, ago } from "../src/web/html.ts";
import type { GitHubPort } from "../src/ingest/github/client.ts";
import { livePartyGamesPort, PARTY_GAMES } from "./live-port.ts";

const NOW = new Date("2026-08-24T14:00:00Z");
const OWNER = "50thycal";

/** A port that fails loudly. Rendering must never reach it. */
const forbiddenGitHub: GitHubPort = {
  async observe() {
    throw new Error("a view queried GitHub directly");
  },
  async listPaths() {
    throw new Error("a view queried GitHub directly");
  },
  async readFile() {
    throw new Error("a view queried GitHub directly");
  },
};

/**
 * Answer everything the attention engine could legitimately raise on the live Party Games
 * artifacts, so a test about the *empty* screen is testing an empty screen.
 *
 * Two edits, not one. Answering WS-001's open decisions used to be enough; it no longer is,
 * because WS-002 sits in REVIEW while the pull request that carried it has merged, and that
 * contradiction now reaches `Needs Me` instead of sitting below its threshold. Finalizing WS-002
 * is exactly what the owner would do about it.
 */
function nothingOutstanding(readFile: (repo: string, path: string) => Promise<RepositoryFile | undefined>) {
  return async (repo: string, path: string) => {
    const file = await readFile(repo, path);
    if (!file) return file;
    if (path.includes("WS-001")) {
      return { ...file, content: file.content.replace(/^## Open Decisions[\s\S]*$/m, "## Open Decisions\n\nNone.\n") };
    }
    if (path.includes("WS-002")) {
      return {
        ...file,
        content: file.content
          .replace(/^\*\*Phase:\*\* REVIEW/m, "**Phase:** COMPLETE")
          .replace(/^\*\*Status:\*\* Active/m, "**Status:** Complete"),
      };
    }
    return file;
  };
}

async function seeded(options: { sync?: boolean; noDecisions?: boolean } = {}) {
  const db = openDatabase({ location: ":memory:" });
  const store = new CompanionStore(db);
  const ledger = new SqliteEventLedger(db);
  store.upsertProject({ ...PARTY_GAMES, displayName: "Party Games" });

  if (options.sync !== false) {
    const port = livePartyGamesPort();
    const github = options.noDecisions
      ? { ...port, readFile: nothingOutstanding(port.readFile) }
      : port;

    await durableSync({
      store,
      ledger,
      github,
      project: store.getProject(PARTY_GAMES.id)!,
      ownerLogin: OWNER,
      now: new Date("2026-08-24T12:00:00Z"),
    });
  }

  const app = new CompanionApp({
    store,
    ledger,
    ownerLogin: OWNER,
    github: () => forbiddenGitHub,
    clock: () => NOW,
  });

  return { db, store, ledger, app };
}

/** Serve on an ephemeral port for the duration of one call. */
async function withServer<T>(app: CompanionApp, work: (base: string) => Promise<T>): Promise<T> {
  const server = createCompanionServer({ app });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await work(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const ROUTES = ["/", "/needs-me", "/projects", `/projects/${PARTY_GAMES.id}`, "/briefing", "/briefing.txt", "/healthz"];

describe("routes", () => {
  it("serves every page without touching GitHub", async () => {
    const { app } = await seeded();
    await withServer(app, async (base) => {
      for (const route of ROUTES) {
        const response = await fetch(base + route);
        expect(response.status, route).toBe(200);
        const body = await response.text();
        expect(body, route).not.toContain("queried GitHub directly");
        expect(body.length, route).toBeGreaterThan(0);
      }
    });
  });

  it("returns 404 for an unknown project rather than an error page", async () => {
    const { app } = await seeded();
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/projects/does-not-exist`);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("No such project");
    });
  });

  it("declares a mobile viewport and a restrictive content policy", async () => {
    const { app } = await seeded();
    await withServer(app, async (base) => {
      const response = await fetch(base);
      const body = await response.text();
      expect(body).toContain('name="viewport"');
      expect(body).toContain("viewport-fit=cover");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    });
  });
});

describe("the feed", () => {
  it("renders cards assembled by the feed layer, not raw events", async () => {
    const { app } = await seeded();
    const cards = app.feed();

    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      // Every card answers the five questions the layer promises.
      expect(card.headline).not.toBe("");
      expect(card.currentState).not.toBe("");
      expect(card.needsYou).not.toBe("");
      expect(card.eventIds.length).toBeGreaterThan(0);
    }
  });

  it("collapses several events about one pull request into one card", async () => {
    const { app } = await seeded();
    const pr141 = app.feed().find((c) => c.entityId === "pr:141")!;
    expect(pr141.eventIds.length).toBeGreaterThan(1);
    expect(app.feed().filter((c) => c.entityId === "pr:141")).toHaveLength(1);
  });

  it("shows the owner what to do about a card that needs them", async () => {
    const { app } = await seeded();
    await withServer(app, async (base) => {
      const body = await (await fetch(base)).text();
      expect(body).toContain("Needs you");
      expect(body).toContain("Where it stands");
      expect(body).toContain("WS-001");
    });
  });
});

describe("needs me", () => {
  it("lists each item with why, what to do, and the evidence behind it", async () => {
    const { app } = await seeded();
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/needs-me`)).text();

      expect(body).toContain("Why");
      expect(body).toContain("Do next");
      expect(body).toContain("Why the system thinks so");
      expect(body).toContain("OWNER_DECISION_REQUIRED");
      expect(body).toContain("Answer the open decisions");
    });
  });

  it("says an empty screen means no rule matched", async () => {
    const { app } = await seeded({ noDecisions: true });
    expect(app.needsMe()).toHaveLength(0);

    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/needs-me`)).text();
      expect(body).toContain("Nothing needs you");
      expect(body).toContain("no rule matched");
    });
  });

  it("never lists a suppressed item", async () => {
    const { app } = await seeded();
    expect(app.needsMe().every((item) => item.severity !== "NONE")).toBe(true);
    expect(app.needsMe().every((item) => item.reasonCode !== "AUTONOMOUS_PROGRESS")).toBe(true);
  });
});

describe("project view", () => {
  it("shows workstreams, phases, PRs, decisions and recent change", async () => {
    const { app } = await seeded();
    const view = app.projectView(PARTY_GAMES.id)!;

    expect(view.activeWorkstreams.map((w) => w.workstreamId)).toEqual(["WS-002", "WS-001"]);
    expect(view.openDecisions).toHaveLength(8);
    expect(view.openPullRequests.map((p) => p.number)).toEqual([142]);
    expect(view.recentlyMergedPullRequests.map((p) => p.number)).toContain(141);
    expect(view.recentCards.length).toBeGreaterThan(0);
  });

  it("renders the decision text in full rather than a truncated fragment", async () => {
    const { app } = await seeded();
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/projects/${PARTY_GAMES.id}`)).text();
      expect(body).toContain("Shelving.");
      // The regression that started all this: the entry used to stop at the file's line wrap.
      expect(body).not.toMatch(/eat its<\//);
      expect(body).toContain("Recommendation:");
    });
  });

  it("warns that a stale project is showing its last good state", async () => {
    const { app, store, ledger } = await seeded();
    await durableSync({
      store,
      ledger,
      github: livePartyGamesPort({ failWith: new Error("403 Forbidden") }),
      project: store.getProject(PARTY_GAMES.id)!,
      ownerLogin: OWNER,
      now: NOW,
    });

    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/projects/${PARTY_GAMES.id}`)).text();
      expect(body).toContain("Sync has been failing");
      expect(body).toContain("last state that was read successfully");
      // The workstreams survived the failure.
      expect(body).toContain("WS-001");
    });
  });
});

describe("the read cursor is the owner's to move", () => {
  it("is not advanced by rendering the briefing", async () => {
    const { app } = await seeded();
    await withServer(app, async (base) => {
      await fetch(`${base}/briefing`);
      await fetch(`${base}/briefing`);
      await fetch(`${base}/briefing.txt`);
      expect(app.readCursor()).toBeUndefined();
    });
  });

  it("is not advanced by syncing", async () => {
    const { app, store, ledger } = await seeded();
    await durableSync({
      store,
      ledger,
      github: livePartyGamesPort(),
      project: store.getProject(PARTY_GAMES.id)!,
      ownerLogin: OWNER,
      now: NOW,
    });
    expect(app.readCursor()).toBeUndefined();
  });

  it("advances only on an explicit post from the button", async () => {
    const { app, ledger } = await seeded();
    const sequence = ledger.latestSequence();

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/briefing/checked`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sequence: String(sequence) }),
        redirect: "manual",
      });

      expect(response.status).toBe(303);
      expect(app.readCursor()!.lastSeq).toBe(sequence);

      // And the briefing then reports nothing new.
      const body = await (await fetch(`${base}/briefing`)).text();
      expect(body).toContain("Nothing changed");
    });
  });

  it("ignores a malformed sequence rather than corrupting the cursor", async () => {
    const { app } = await seeded();
    await withServer(app, async (base) => {
      await fetch(`${base}/briefing/checked`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sequence: "not-a-number" }),
        redirect: "manual",
      });
      expect(app.readCursor()).toBeUndefined();
    });
  });

  it("tells the owner the first look is not news", async () => {
    const { app } = await seeded();
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/briefing`)).text();
      expect(body).toContain("First look");
      expect(body).toContain("Start tracking from here");
      expect(body).toContain("Reading this page does not mark it read");
    });
  });
});

describe("html", () => {
  it("escapes text that could otherwise become markup", () => {
    expect(esc(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(esc("Tom & Jerry's")).toBe("Tom &amp; Jerry&#39;s");
    expect(esc(undefined)).toBe("");
  });

  it("escapes a pull request title rendered into a page", async () => {
    const { store, ledger } = await seeded({ sync: false });
    await durableSync({
      store,
      ledger,
      github: livePartyGamesPort({
        transform: (pr) => (pr.number === 142 ? { ...pr, title: `<img src=x onerror="alert(1)">` } : pr),
      }),
      project: store.getProject(PARTY_GAMES.id)!,
      ownerLogin: OWNER,
      now: new Date("2026-08-24T12:00:00Z"),
    });

    const app = new CompanionApp({ store, ledger, ownerLogin: OWNER, clock: () => NOW });
    await withServer(app, async (base) => {
      const body = await (await fetch(base)).text();
      expect(body).toContain("&lt;img src=x");
      expect(body).not.toContain(`<img src=x onerror=`);
    });
  });

  it("renders coarse relative times", () => {
    const now = new Date("2026-08-24T12:00:00Z");
    expect(ago("2026-08-24T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-08-24T11:30:00Z", now)).toBe("30m ago");
    expect(ago("2026-08-24T06:00:00Z", now)).toBe("6h ago");
    expect(ago("2026-08-20T12:00:00Z", now)).toBe("4d ago");
    expect(ago(undefined, now)).toBe("never");
  });
});
