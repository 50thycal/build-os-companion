/**
 * Podcast scripts: the digest ("what changed") and deep-dive ("help me understand this") shapes
 * built on top of the fact pack.
 *
 * The property that matters is the same one `briefing.test.ts` checks for the written briefing:
 * every spoken line traces to a fact, and nothing in a script asserts something the fact pack
 * did not already carry.
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { durableSync } from "../src/sync/durable-sync.ts";
import { buildFactPack } from "../src/briefing/fact-pack.ts";
import { buildDigestPodcastScript } from "../src/podcast/digest.ts";
import { buildDeepDivePodcastScript } from "../src/podcast/deep-dive.ts";
import { renderPodcastScript } from "../src/podcast/render.ts";
import { CompanionApp } from "../src/app/companion-app.ts";
import { livePartyGamesPort, PARTY_GAMES } from "./live-port.ts";

const NOW = new Date("2026-08-24T12:00:00Z");
const OWNER = "50thycal";

function harness() {
  const db = openDatabase({ location: ":memory:" });
  const store = new CompanionStore(db);
  const ledger = new SqliteEventLedger(db);
  store.upsertProject({ ...PARTY_GAMES, displayName: "Party Games" });
  return { db, store, ledger };
}

async function seeded() {
  const h = harness();
  await durableSync({
    store: h.store,
    ledger: h.ledger,
    github: livePartyGamesPort(),
    project: h.store.getProject(PARTY_GAMES.id)!,
    ownerLogin: OWNER,
    now: NOW,
  });
  return h;
}

const pack = (h: Awaited<ReturnType<typeof seeded>>) =>
  buildFactPack({ store: h.store, ledger: h.ledger, ownerUserId: OWNER, now: NOW });

/** Every REPORTER line outside the framing segments must ground back to at least one fact ref. */
function groundedLines(segments: ReturnType<typeof buildDigestPodcastScript>["segments"]) {
  return segments
    .filter((s) => s.key !== "cold_open" && s.key !== "close")
    .flatMap((s) => s.lines)
    .filter((l) => l.speaker === "REPORTER");
}

describe("the digest podcast script", () => {
  it("opens cold, closes on what needs me, and grounds every reporter line", async () => {
    const h = await seeded();
    const script = buildDigestPodcastScript(pack(h));

    expect(script.kind).toBe("DIGEST");
    expect(script.segments[0]!.key).toBe("cold_open");
    expect(script.segments.at(-1)!.key).toBe("WHAT_NEEDS_ME");

    for (const line of groundedLines(script.segments)) {
      expect(line.refs.length).toBeGreaterThan(0);
    }
  });

  it("always includes what-needs-me, even stating its empty text", async () => {
    const h = harness();
    // No sync at all: nothing changed, nothing needs the owner.
    const built = buildFactPack({ store: h.store, ledger: h.ledger, ownerUserId: OWNER, now: NOW });
    const script = buildDigestPodcastScript(built);

    const needsMe = script.segments.at(-1)!;
    expect(needsMe.key).toBe("WHAT_NEEDS_ME");
    expect(needsMe.lines[0]!.text).toContain("No rule in the attention engine matched");
  });

  it("never asserts a fact absent from sourceFactIds", async () => {
    const h = await seeded();
    const built = pack(h);
    const script = buildDigestPodcastScript(built);

    const known = new Set(built.sections.flatMap((s) => s.facts.map((f) => f.id)));
    for (const id of script.sourceFactIds) expect(known.has(id)).toBe(true);
  });

  it("the analyst's synthesis never exceeds the section's own fact count", async () => {
    const h = await seeded();
    const script = buildDigestPodcastScript(pack(h));

    for (const segment of script.segments) {
      if (segment.key === "cold_open") continue;
      const analystLines = segment.lines.filter((l) => l.speaker === "ANALYST");
      const reporterLines = segment.lines.filter((l) => l.speaker === "REPORTER");
      // At most one synthesis line per section, and only when there was something to report.
      expect(analystLines.length).toBeLessThanOrEqual(1);
      if (analystLines.length === 1) expect(reporterLines.length).toBeGreaterThan(0);
    }
  });
});

describe("the deep-dive podcast script", () => {
  it("groups selected facts into one beat per section and grounds every beat line", async () => {
    const h = await seeded();
    const built = pack(h);
    const allFacts = built.sections.flatMap((s) => s.facts);
    expect(allFacts.length).toBeGreaterThan(0);

    const selected = allFacts.slice(0, 2);
    const beats = built.sections
      .map((section) => ({ title: section.title, facts: section.facts.filter((f) => selected.some((s) => s.id === f.id)) }))
      .filter((b) => b.facts.length > 0);

    const script = buildDeepDivePodcastScript({
      topic: { title: "How the Ops channel became a control plane", whyNow: "It just went through a real rewrite." },
      beats,
      generatedAt: built.generatedAt,
      ownerUserId: built.ownerUserId,
      projects: built.projects,
    });

    expect(script.kind).toBe("DEEP_DIVE");
    expect(script.segments[0]!.key).toBe("cold_open");
    expect(script.segments.at(-1)!.key).toBe("close");
    expect(script.sourceFactIds.sort()).toEqual(selected.map((f) => f.id).sort());

    for (const line of groundedLines(script.segments)) {
      expect(line.refs.length).toBeGreaterThan(0);
    }
  });

  it("says so rather than inventing content when no facts were approved", () => {
    const script = buildDeepDivePodcastScript({
      topic: { title: "A topic with nothing behind it yet", whyNow: "Just an idea." },
      beats: [],
      generatedAt: NOW.toISOString(),
      ownerUserId: OWNER,
      projects: [],
    });

    expect(script.sourceFactIds).toHaveLength(0);
    const body = script.segments.find((s) => s.key === "no_facts");
    expect(body?.lines[0]!.text).toContain("No approved facts");
  });
});

describe("rendering", () => {
  it("is deterministic: the same script renders identically", async () => {
    const h = await seeded();
    const script = buildDigestPodcastScript(pack(h));
    expect(renderPodcastScript(script)).toBe(renderPodcastScript(script));
  });

  it("can show the references behind each line", async () => {
    const h = await seeded();
    const text = renderPodcastScript(buildDigestPodcastScript(pack(h)), { includeRefs: true });
    expect(text).toContain("refs: ");
  });
});

describe("CompanionApp", () => {
  it("builds a digest script through the same read model the briefing page uses", async () => {
    const h = await seeded();
    const app = new CompanionApp({ store: h.store, ledger: h.ledger, ownerLogin: OWNER, clock: () => NOW });

    const script = app.digestPodcastScript();
    expect(script.kind).toBe("DIGEST");
    expect(script.generatedAt).toBe(app.briefing().generatedAt);
  });

  it("builds a deep-dive script from selected fact ids, grouped by the section they came from", async () => {
    const h = await seeded();
    const app = new CompanionApp({ store: h.store, ledger: h.ledger, ownerLogin: OWNER, clock: () => NOW });
    const built = app.briefing();
    const someFact = built.sections.flatMap((s) => s.facts)[0]!;

    const script = app.deepDivePodcastScript({
      topic: { title: "A focused explainer", whyNow: "Worth understanding on its own." },
      factIds: [someFact.id],
    });

    expect(script.sourceFactIds).toEqual([someFact.id]);
  });

  it("produces an honest deep dive when no fact ids match anything in the current pack", async () => {
    const h = await seeded();
    const app = new CompanionApp({ store: h.store, ledger: h.ledger, ownerLogin: OWNER, clock: () => NOW });

    const script = app.deepDivePodcastScript({
      topic: { title: "Nothing behind this", whyNow: "Testing the empty path." },
      factIds: ["does-not-exist"],
    });

    expect(script.sourceFactIds).toHaveLength(0);
  });
});
