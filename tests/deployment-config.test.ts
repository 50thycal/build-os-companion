/**
 * Deployment configuration that only fails at deploy time.
 *
 * These assertions cost nothing and cover the gap the unit suite structurally cannot: a
 * Dockerfile and a `railway.json` are not exercised by `npm test`, so a mistake in either is
 * invisible until a build rejects it minutes later on someone else's machine. Each case below
 * records a failure that actually happened or would have.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const railway = JSON.parse(readFileSync(join(root, "railway.json"), "utf8"));

/** Instructions, ignoring comments and blank lines. */
const instructions = dockerfile
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

describe("the Dockerfile", () => {
  it("declares no VOLUME", () => {
    // Railway refuses to build a Dockerfile containing one: "docker VOLUME at Line 25 is not
    // supported, use Railway Volumes". The mount is the platform's to declare, and `VOLUME`
    // only ever meant an anonymous volume nobody would think to preserve.
    expect(instructions.some((line) => /^VOLUME\b/i.test(line))).toBe(false);
  });

  it("still points the database at the mount path the platform provides", () => {
    // Removing VOLUME must not remove where the data goes. Railway mounts its volume at /data;
    // this is what makes that mount the database rather than an empty directory.
    expect(dockerfile).toMatch(/COMPANION_DB=\/data\/companion\.db/);
  });

  it("health-checks whatever port it was assigned", () => {
    const healthcheck = instructions.find((line) => /^HEALTHCHECK\b/i.test(line));
    expect(healthcheck).toBeDefined();
    // A probe pinned to 8787 reports a perfectly healthy container as failing anywhere the port
    // is assigned at runtime, which is every managed host.
    expect(dockerfile).toContain("process.env.PORT");
  });

  it("tells the reader where the mount actually comes from", () => {
    // The comment is the only place this is written down inside the image.
    expect(dockerfile).toMatch(/Railway/);
    expect(dockerfile).toMatch(/mount path \/data/);
  });
});

describe("railway.json", () => {
  it("builds from the Dockerfile", () => {
    expect(railway.build).toMatchObject({ builder: "DOCKERFILE", dockerfilePath: "Dockerfile" });
  });

  it("health-checks a route that answers before the auth gate", () => {
    // `/healthz` is deliberately outside the gate: a probe carries no session, and one that
    // could not pass would make a correctly-locked deployment look broken.
    expect(railway.deploy.healthcheckPath).toBe("/healthz");
  });

  it("runs a single instance", () => {
    // The SQLite file and the in-memory login throttle both assume one writer.
    expect(railway.deploy.numReplicas).toBe(1);
  });
});

/**
 * Startup order.
 *
 * This is here rather than in the unit suite for the reason the file exists: `serve.ts` is a
 * script, not a module, so nothing else in `npm test` executes it, and the failure it guards
 * against is invisible until a container is killed on someone else's machine.
 *
 * What happened: the initial sync was awaited *before* `server.listen`. That was survivable while
 * the deployment followed two repositories and stopped being survivable the moment discovery
 * opened it to eleven — the sync ran far past `healthcheckTimeout`, `/healthz` never answered,
 * and the platform killed the container mid-sync. It reads like a build failure and is really a
 * startup that did unbounded work before agreeing to answer.
 */
const serve = readFileSync(join(root, "src/cli/serve.ts"), "utf8");

describe("the server starts before it syncs", () => {
  it("listens before the initial sync is kicked off", () => {
    const listen = serve.indexOf("server.listen(");
    const sync = serve.indexOf("app\n    .sync()");
    expect(listen).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(-1);
    expect(listen).toBeLessThan(sync);
  });

  it("never awaits the initial sync at the top level", () => {
    // `await app.sync()` outside a callback is the exact shape that blocked startup.
    expect(/^\s*(const .*=\s*)?await app\.sync\(\)/m.test(serve)).toBe(false);
  });

  it("keeps a health-check timeout the app can actually meet", () => {
    // Meetable only because listening no longer waits for GitHub. If this grows a dependency on
    // network work again, the number below stops being achievable and this suite should be the
    // thing that says so.
    expect(railway.deploy.healthcheckTimeout).toBeGreaterThan(0);
    expect(railway.deploy.healthcheckPath).toBe("/healthz");
  });

  it("tolerates a shutdown signal arriving before the schedule starts", () => {
    // The scheduler is created only after the first sync settles, so the SIGTERM handler must
    // not assume it exists — a container killed during a long first sync would otherwise die on
    // a TypeError instead of closing its database cleanly.
    expect(serve).toContain("scheduler?.stop()");
  });
});
