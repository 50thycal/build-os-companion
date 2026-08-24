/**
 * Single-owner authentication.
 *
 * The Companion renders one person's private project state — open decisions, workstream
 * contents, pull request titles. On a public hostname that is the entire threat model: there is
 * nothing to authorize, only someone to let in.
 *
 * So this is deliberately the smallest thing that works: one password, checked once, and a
 * signed cookie that keeps the owner logged in afterwards. No user table, no sessions store, no
 * dependency. The cookie is a claim the server itself signed, so it can be verified without
 * storing anything — which matters because the alternative is a sessions table that outlives
 * the thing it protects.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "companion_session";

/** How long a login lasts. Long, because re-typing a password on a phone is the thing that
 *  makes owners disable authentication entirely. */
const SESSION_DAYS = 30;

export interface AuthConfig {
  /** The owner's password. Absent means the app is unconfigured and must not serve anything. */
  password?: string;
  /**
   * Run with no password at all. Only ever set deliberately, for a local run on a laptop —
   * never on a host with a public hostname.
   */
  allowNoAuth: boolean;
}

export type AuthState =
  /** A password is set; requests need a valid session. */
  | { mode: "REQUIRED"; password: string; key: Buffer }
  /** Explicitly opted out. Everything is served to everyone. */
  | { mode: "DISABLED" }
  /** No password and no opt-out: fail closed, and say why. */
  | { mode: "UNCONFIGURED" };

/**
 * Decide the posture at boot.
 *
 * Fails **closed**. A Companion deployed without a password would sit on a public URL serving
 * private repository state to anyone who found it, and would look completely healthy doing so —
 * the failure is silent, which is exactly the kind that should refuse to start instead.
 */
export function resolveAuth(config: AuthConfig): AuthState {
  const password = config.password?.trim();
  if (password) {
    // The signing key derives from the password, so changing the password invalidates every
    // outstanding session for free. That is the behaviour you want the day you suspect a leak.
    return {
      mode: "REQUIRED",
      password,
      key: createHmac("sha256", "build-os-companion/session").update(password).digest(),
    };
  }
  return config.allowNoAuth ? { mode: "DISABLED" } : { mode: "UNCONFIGURED" };
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** A cookie value the server can verify without having stored anything. */
export function issueSession(key: Buffer, now: Date): { value: string; maxAgeSeconds: number } {
  const expiresAt = now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  // A nonce means two logins never produce the same cookie, so one leaking does not confirm
  // anything about another.
  const payload = `${expiresAt}.${randomBytes(9).toString("base64url")}`;
  return { value: `${payload}.${sign(key, payload)}`, maxAgeSeconds: SESSION_DAYS * 24 * 60 * 60 };
}

/** Whether a cookie was signed by this key and has not expired. */
export function verifySession(key: Buffer, value: string | undefined, now: Date): boolean {
  if (!value) return false;

  const cut = value.lastIndexOf(".");
  if (cut <= 0) return false;

  const payload = value.slice(0, cut);
  const provided = value.slice(cut + 1);

  if (!constantTimeEquals(provided, sign(key, payload))) return false;

  const expiresAt = Number(payload.slice(0, payload.indexOf(".")));
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

/**
 * Compare without leaking how much of the value matched.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself be a signal, so both sides are
 * hashed to a fixed width first.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHmac("sha256", "compare").update(a).digest();
  const right = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * `Secure` is set whenever the request arrived over HTTPS, including via a proxy that terminated
 * it — Railway and every similar host do exactly that and forward `x-forwarded-proto`.
 *
 * `SameSite=Lax` is doing real work beyond tidiness: it means a form on another site cannot make
 * an authenticated POST here, which is the CSRF defence for the mark-as-read endpoint. There is
 * no separate token because there does not need to be.
 */
export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const flags = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (secure) flags.push("Secure");
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; ${flags.join("; ")}`;
}

export function clearedCookie(secure: boolean): string {
  const flags = ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) flags.push("Secure");
  return `${SESSION_COOKIE}=; ${flags.join("; ")}`;
}

/**
 * Slow down guessing.
 *
 * In-memory and per-process, which is enough for a single-owner app on one instance: the point
 * is to make an online guessing attack take longer than anyone will bother with, not to survive
 * a distributed one. A restart clearing it is an acceptable trade for having no storage.
 */
export class LoginThrottle {
  readonly #attempts = new Map<string, { count: number; until: number }>();
  readonly #max: number;
  readonly #windowMs: number;

  constructor(options: { max?: number; windowMs?: number } = {}) {
    this.#max = options.max ?? 8;
    this.#windowMs = options.windowMs ?? 10 * 60 * 1000;
  }

  blocked(key: string, now: Date): boolean {
    const entry = this.#attempts.get(key);
    if (!entry) return false;
    if (entry.until <= now.getTime()) {
      this.#attempts.delete(key);
      return false;
    }
    return entry.count >= this.#max;
  }

  recordFailure(key: string, now: Date): void {
    const entry = this.#attempts.get(key);
    if (!entry || entry.until <= now.getTime()) {
      this.#attempts.set(key, { count: 1, until: now.getTime() + this.#windowMs });
      return;
    }
    entry.count += 1;
  }

  clear(key: string): void {
    this.#attempts.delete(key);
  }
}
