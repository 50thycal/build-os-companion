/**
 * The gate in front of a public URL.
 *
 * This app renders one owner's private project state and is about to sit on a hostname anyone
 * can reach. The tests that matter are the ones that prove nothing gets out: not the pages, not
 * the plain-text briefing, not through a forged cookie, and not because somebody forgot to set
 * a password.
 */

import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import {
  LoginThrottle,
  clearedCookie,
  constantTimeEquals,
  issueSession,
  parseCookies,
  resolveAuth,
  sessionCookie,
  verifySession,
} from "../src/web/auth.ts";
import { CompanionApp } from "../src/app/companion-app.ts";
import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { durableSync } from "../src/sync/durable-sync.ts";
import { createCompanionServer } from "../src/web/server.ts";
import { livePartyGamesPort, PARTY_GAMES } from "./live-port.ts";

const NOW = new Date("2026-08-24T12:00:00Z");
const PASSWORD = "correct horse battery staple";

/** Strings that must never appear in a response served to someone who has not signed in. */
const PRIVATE = ["WS-001", "Subway", "OWNER_DECISION_REQUIRED", "Shelving"];

async function seededApp() {
  const db = openDatabase({ location: ":memory:" });
  const store = new CompanionStore(db);
  const ledger = new SqliteEventLedger(db);
  store.upsertProject({ ...PARTY_GAMES, displayName: "Party Games" });
  await durableSync({
    store,
    ledger,
    github: livePartyGamesPort(),
    project: store.getProject(PARTY_GAMES.id)!,
    ownerLogin: "50thycal",
    now: NOW,
  });
  return new CompanionApp({ store, ledger, ownerLogin: "50thycal", clock: () => NOW });
}

async function serving<T>(
  auth: Parameters<typeof createCompanionServer>[0]["auth"],
  work: (base: string) => Promise<T>,
): Promise<T> {
  const app = await seededApp();
  const server = createCompanionServer({ app, auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await work(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Every route that renders owner data, including the one that is easy to forget. */
const PROTECTED = ["/", "/needs-me", "/projects", `/projects/${PARTY_GAMES.id}`, "/briefing", "/briefing.txt"];

async function signIn(base: string, password = PASSWORD): Promise<string> {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
    redirect: "manual",
  });
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie issued");
  return cookie.split(";")[0]!;
}

// ---------------------------------------------------------------------------

describe("posture at boot", () => {
  it("requires a password when one is set", () => {
    expect(resolveAuth({ password: PASSWORD, allowNoAuth: false }).mode).toBe("REQUIRED");
  });

  it("fails closed when no password and no explicit opt-out", () => {
    expect(resolveAuth({ allowNoAuth: false }).mode).toBe("UNCONFIGURED");
    expect(resolveAuth({ password: "   ", allowNoAuth: false }).mode).toBe("UNCONFIGURED");
  });

  it("runs open only when that was asked for deliberately", () => {
    expect(resolveAuth({ allowNoAuth: true }).mode).toBe("DISABLED");
  });
});

describe("an unconfigured deployment serves nothing", () => {
  it("returns 503 on every route and leaks no project state", async () => {
    await serving({ mode: "UNCONFIGURED" }, async (base) => {
      for (const path of PROTECTED) {
        const response = await fetch(base + path);
        expect(response.status, path).toBe(503);
        const body = await response.text();
        for (const secret of PRIVATE) expect(body, `${path} leaked ${secret}`).not.toContain(secret);
      }
    });
  });

  it("says which variable is missing rather than just failing", async () => {
    await serving({ mode: "UNCONFIGURED" }, async (base) => {
      expect(await (await fetch(base)).text()).toContain("COMPANION_PASSWORD");
    });
  });

  it("still answers the health probe, and reports itself unconfigured", async () => {
    await serving({ mode: "UNCONFIGURED" }, async (base) => {
      const health = await (await fetch(`${base}/healthz`)).json();
      // A host's probe has no session; if it could not pass, a correctly-locked deployment
      // would look broken. `configured` is what makes the misconfiguration visible.
      expect(health).toMatchObject({ ok: true, configured: false });
    });
  });
});

describe("signed out", () => {
  const auth = resolveAuth({ password: PASSWORD, allowNoAuth: false });

  it("redirects every protected route to the login page, leaking nothing", async () => {
    await serving(auth, async (base) => {
      for (const path of PROTECTED) {
        const response = await fetch(base + path, { redirect: "manual" });
        expect(response.status, path).toBe(303);
        expect(response.headers.get("location"), path).toContain("/login");
        const body = await response.text();
        for (const secret of PRIVATE) expect(body, `${path} leaked ${secret}`).not.toContain(secret);
      }
    });
  });

  it("remembers where the owner was going", async () => {
    await serving(auth, async (base) => {
      const response = await fetch(`${base}/needs-me`, { redirect: "manual" });
      expect(response.headers.get("location")).toBe("/login?next=%2Fneeds-me");
    });
  });

  it("refuses a wrong password", async () => {
    await serving(auth, async (base) => {
      const response = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "hunter2" }),
        redirect: "manual",
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  });

  it("rejects a forged or expired cookie", async () => {
    await serving(auth, async (base) => {
      for (const cookie of [
        "companion_session=9999999999999.nonce.notavalidsignature",
        "companion_session=1000000000000.nonce.x",
        "companion_session=garbage",
      ]) {
        const response = await fetch(base, { headers: { cookie }, redirect: "manual" });
        expect(response.status, cookie).toBe(303);
      }
    });
  });
});

describe("signed in", () => {
  const auth = resolveAuth({ password: PASSWORD, allowNoAuth: false });

  it("serves the app once the password is right", async () => {
    await serving(auth, async (base) => {
      const cookie = await signIn(base);
      for (const path of PROTECTED) {
        const response = await fetch(base + path, { headers: { cookie } });
        expect(response.status, path).toBe(200);
      }
      const needsMe = await (await fetch(`${base}/needs-me`, { headers: { cookie } })).text();
      expect(needsMe).toContain("OWNER_DECISION_REQUIRED");
    });
  });

  it("offers a way back out", async () => {
    await serving(auth, async (base) => {
      const cookie = await signIn(base);
      expect(await (await fetch(base, { headers: { cookie } })).text()).toContain("Sign out");

      const out = await fetch(`${base}/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
      expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });

  it("sends the login page away once there is a session", async () => {
    await serving(auth, async (base) => {
      const cookie = await signIn(base);
      const response = await fetch(`${base}/login`, { headers: { cookie }, redirect: "manual" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    });
  });
});

describe("the session cookie", () => {
  const auth = resolveAuth({ password: PASSWORD, allowNoAuth: false });

  it("is HttpOnly and SameSite=Lax", async () => {
    await serving(auth, async (base) => {
      const response = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: PASSWORD }),
        redirect: "manual",
      });
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toContain("HttpOnly");
      // SameSite=Lax is the CSRF defence for the mark-as-read POST: a form on another site
      // cannot send this cookie, so no separate token is needed.
      expect(cookie).toContain("SameSite=Lax");
    });
  });

  it("is marked Secure behind a proxy that terminated TLS, and not otherwise", async () => {
    await serving(auth, async (base) => {
      const overHttps = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
        body: new URLSearchParams({ password: PASSWORD }),
        redirect: "manual",
      });
      // Railway terminates TLS at its edge, so the socket here is plain HTTP even though the
      // browser used HTTPS. Reading the socket alone would drop Secure exactly where it matters.
      expect(overHttps.headers.get("set-cookie")).toContain("Secure");

      const overHttp = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: PASSWORD }),
        redirect: "manual",
      });
      expect(overHttp.headers.get("set-cookie")).not.toContain("Secure");
    });
  });

  it("only accepts a same-origin destination after login", async () => {
    await serving(auth, async (base) => {
      for (const [next, expected] of [
        ["/projects", "/projects"],
        ["https://evil.example/steal", "/"],
        ["//evil.example/steal", "/"],
      ] as const) {
        const response = await fetch(`${base}/login`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ password: PASSWORD, next }),
          redirect: "manual",
        });
        expect(response.headers.get("location"), next).toBe(expected);
      }
    });
  });
});

describe("session tokens", () => {
  const key = (resolveAuth({ password: PASSWORD, allowNoAuth: false }) as { key: Buffer }).key;

  it("verifies what it issued", () => {
    expect(verifySession(key, issueSession(key, NOW).value, NOW)).toBe(true);
  });

  it("rejects a tampered payload or signature", () => {
    const { value } = issueSession(key, NOW);
    expect(verifySession(key, `${value}x`, NOW)).toBe(false);
    expect(verifySession(key, value.replace(/^\d+/, "9999999999999"), NOW)).toBe(false);
    expect(verifySession(key, undefined, NOW)).toBe(false);
  });

  it("expires", () => {
    const { value } = issueSession(key, NOW);
    expect(verifySession(key, value, new Date("2026-10-24T12:00:00Z"))).toBe(false);
  });

  it("is invalidated by changing the password", () => {
    const { value } = issueSession(key, NOW);
    const rotated = (resolveAuth({ password: "a new password", allowNoAuth: false }) as { key: Buffer }).key;
    // Deriving the signing key from the password means a rotation signs every device out,
    // which is the behaviour you want the day you suspect it leaked.
    expect(verifySession(rotated, value, NOW)).toBe(false);
  });

  it("never issues the same token twice", () => {
    expect(issueSession(key, NOW).value).not.toBe(issueSession(key, NOW).value);
  });
});

describe("supporting pieces", () => {
  it("compares without leaking length or prefix", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcdefghijk")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });

  it("parses cookie headers", () => {
    expect(parseCookies("a=1; companion_session=xyz; b=2")).toMatchObject({ companion_session: "xyz" });
    expect(parseCookies(undefined)).toEqual({});
  });

  it("builds and clears the cookie", () => {
    expect(sessionCookie("v", 60, true)).toContain("Secure");
    expect(clearedCookie(false)).toContain("Max-Age=0");
  });

  it("throttles repeated failures, then recovers", () => {
    const throttle = new LoginThrottle({ max: 3, windowMs: 60_000 });
    expect(throttle.blocked("1.2.3.4", NOW)).toBe(false);
    for (let i = 0; i < 3; i += 1) throttle.recordFailure("1.2.3.4", NOW);
    expect(throttle.blocked("1.2.3.4", NOW)).toBe(true);

    // Another address is unaffected, and the window eventually lapses.
    expect(throttle.blocked("5.6.7.8", NOW)).toBe(false);
    expect(throttle.blocked("1.2.3.4", new Date(NOW.getTime() + 61_000))).toBe(false);
  });

  it("clears the count on a successful login", () => {
    const throttle = new LoginThrottle({ max: 2 });
    throttle.recordFailure("1.2.3.4", NOW);
    throttle.recordFailure("1.2.3.4", NOW);
    throttle.clear("1.2.3.4");
    expect(throttle.blocked("1.2.3.4", NOW)).toBe(false);
  });
});

describe("brute force", () => {
  it("stops answering after repeated wrong passwords", async () => {
    await serving(resolveAuth({ password: PASSWORD, allowNoAuth: false }), async (base) => {
      let sawThrottle = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await fetch(`${base}/login`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ password: `guess-${attempt}` }),
          redirect: "manual",
        });
        if (response.status === 429) {
          sawThrottle = true;
          break;
        }
      }
      expect(sawThrottle).toBe(true);
    });
  });
});

describe("the login page renders as markup, not as text", () => {
  const auth = resolveAuth({ password: PASSWORD, allowNoAuth: false });

  it("emits a real hidden input for the return path", async () => {
    await serving(auth, async (base) => {
      const body = await (await fetch(`${base}/login?next=%2Fneeds-me`)).text();
      // The `html` tag escapes interpolated strings, so a nested fragment that is not wrapped in
      // `raw` renders as visible source. A status-code assertion cannot see that.
      expect(body).toContain('<input type="hidden" name="next" value="/needs-me">');
      expect(body).not.toContain("&lt;input");
    });
  });

  it("emits a real error banner on a failed attempt", async () => {
    await serving(auth, async (base) => {
      const response = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "nope" }),
        redirect: "manual",
      });
      const body = await response.text();
      expect(body).toContain('<div class="error">');
      expect(body).not.toContain("&lt;div");
    });
  });

  it("still escapes a hostile return path rather than trusting it", async () => {
    await serving(auth, async (base) => {
      const body = await (await fetch(`${base}/login?next=%2F%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E`)).text();
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(body).toContain("&quot;&gt;&lt;script&gt;");
    });
  });
});
