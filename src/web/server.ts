/**
 * The web server.
 *
 * Node's own `http`, server-rendered HTML, no framework and no build step. For a single-owner
 * tool that is the right shape: it loads instantly on a phone with one bar of signal, there is
 * nothing to rebuild after a change, and — the part that matters architecturally — there is no
 * second copy of the interpretation logic living in a browser. Every route reads through
 * `CompanionApp` and therefore through the ledger.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { CompanionApp } from "../app/companion-app.ts";
import { layout } from "./views/layout.ts";
import { feedView } from "./views/feed.ts";
import { needsMeView, type NeedsMeItem } from "./views/needs-me.ts";
import { projectListView, projectView } from "./views/project.ts";
import { briefingView } from "./views/briefing.ts";
import { ago, esc, html } from "./html.ts";

export interface ServerOptions {
  app: CompanionApp;
  /** Sync before rendering when state is older than this. Zero disables it. */
  autoSyncAfterMinutes?: number;
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/html; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    // The pages render data from followed repositories; nothing is loaded from anywhere else.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Subtitle shown under every page title: how fresh the data is. */
function freshness(app: CompanionApp): string {
  const projects = app.projects();
  if (projects.length === 0) return "no projects followed";

  const synced = projects.map((p) => p.lastSyncedAt).filter((s): s is string => Boolean(s));
  const stale = projects.filter((p) => p.staleSince).length;
  const oldest = synced.length === projects.length ? synced.sort()[0] : undefined;

  const base = synced.length === 0 ? "never synced" : `synced ${ago(oldest ?? synced.sort()[0], app.now())}`;
  return stale > 0 ? `${base} · ${stale} failing` : base;
}

export function createCompanionServer(options: ServerOptions): Server {
  const { app } = options;

  return createServer((req, res) => {
    handle(req, res, app).catch((error: unknown) => {
      // Never leak a stack trace to the page; the owner gets a readable failure and the console
      // gets the detail.
      console.error("[companion] request failed", error);
      send(
        res,
        500,
        layout({
          title: "Something broke",
          tab: "feed",
          body: html`<div class="empty">
            <div class="big">The Companion hit an error</div>
            <p>${(error as Error).message}</p>
          </div>`,
        }),
      );
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, app: CompanionApp): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const now = app.now();

  if (req.method === "POST") {
    if (path === "/sync") {
      if (app.canSync) await app.sync();
      redirect(res, url.searchParams.get("back") ?? "/");
      return;
    }

    if (path === "/briefing/checked") {
      const body = new URLSearchParams(await readBody(req));
      const sequence = Number(body.get("sequence"));
      const checkpointAt = body.get("checkpointAt") ?? undefined;

      // Only an explicit, well-formed submission moves the cursor, and `markChecked` validates
      // both dimensions against the ledger and the clock rather than trusting the form.
      if (app.markChecked(sequence, checkpointAt) === undefined) {
        console.warn(`[companion] ignored mark-as-read: sequence=${body.get("sequence")}`);
      }
      redirect(res, "/briefing");
      return;
    }

    send(res, 405, layout({ title: "Not allowed", tab: "feed", body: "<div class='empty'>Method not allowed.</div>" }));
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, layout({ title: "Not allowed", tab: "feed", body: "<div class='empty'>Method not allowed.</div>" }));
    return;
  }

  const needsCount = app.needsMe().length;

  if (path === "/" || path === "/feed") {
    send(
      res,
      200,
      layout({
        title: "Feed",
        subtitle: freshness(app),
        tab: "feed",
        needsCount,
        body: feedView(app.feed({ limit: 60 }), now),
      }),
    );
    return;
  }

  if (path === "/needs-me") {
    const projects = new Map(app.projects().map((p) => [p.id, p.displayName ?? p.repositoryFullName]));
    const entries: NeedsMeItem[] = app.needsMe().map((item) => ({
      item,
      projectName: projects.get(item.projectId) ?? item.projectId,
      evidence: app.evidenceFor(item, 6),
    }));

    const lastSynced = app.projects().map((p) => p.lastSyncedAt).filter(Boolean).sort().at(-1);

    send(
      res,
      200,
      layout({
        title: "Needs Me",
        subtitle: entries.length === 0 ? "nothing is waiting on you" : `${entries.length} waiting`,
        tab: "needs",
        needsCount,
        body: needsMeView(entries, now, lastSynced as string | undefined),
      }),
    );
    return;
  }

  if (path === "/projects") {
    const counts = new Map(app.projects().map((p) => [p.id, app.needsMe(p.id).length]));
    send(
      res,
      200,
      layout({
        title: "Projects",
        subtitle: freshness(app),
        tab: "projects",
        needsCount,
        body: projectListView(app.projects(), now, counts),
      }),
    );
    return;
  }

  const projectMatch = /^\/projects\/([A-Za-z0-9._-]+)$/.exec(path);
  if (projectMatch) {
    const view = app.projectView(projectMatch[1]!);
    if (!view) {
      send(
        res,
        404,
        layout({
          title: "Not found",
          tab: "projects",
          needsCount,
          body: html`<div class="empty"><div class="big">No such project</div><p><a href="/projects">Back to projects</a></p></div>`,
        }),
      );
      return;
    }

    send(
      res,
      200,
      layout({
        title: view.project.displayName ?? view.project.repositoryFullName,
        subtitle: `${view.project.repositoryFullName} · synced ${ago(view.project.lastSyncedAt, now)}`,
        tab: "projects",
        needsCount,
        body: projectView(view, now),
      }),
    );
    return;
  }

  if (path === "/briefing") {
    const pack = app.briefing();
    send(
      res,
      200,
      layout({
        title: "Since I last checked",
        subtitle: pack.isFirstLook ? "first look" : `read up to ${ago(pack.since.cursor?.lastCheckedAt, now)}`,
        tab: "briefing",
        needsCount,
        body: briefingView(pack, now),
      }),
    );
    return;
  }

  // A plain-text briefing, for reading outside the app or piping somewhere.
  if (path === "/briefing.txt") {
    const { renderFactPack } = await import("../briefing/render.ts");
    send(res, 200, renderFactPack(app.briefing(), { includeRefs: url.searchParams.has("refs") }), "text/plain; charset=utf-8");
    return;
  }

  if (path === "/healthz") {
    send(res, 200, JSON.stringify({ ok: true, projects: app.projects().length }), "application/json");
    return;
  }

  send(
    res,
    404,
    layout({
      title: "Not found",
      tab: "feed",
      needsCount,
      body: html`<div class="empty"><div class="big">Not found</div><p><a href="/">Back to the feed</a></p></div>`,
    }),
  );
}
