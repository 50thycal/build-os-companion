/**
 * Minimal HTML helpers.
 *
 * No template engine. The views render structured data that has already been decided by the
 * domain, so what is left is escaping and small formatting — and a dependency-free server is
 * one less thing between the owner and their own data.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape text for HTML.
 *
 * Everything the views render — pull request titles, workstream goals, decision questions —
 * comes from repositories the owner follows, and a PR title containing a tag is ordinary rather
 * than hostile. It still cannot be allowed to become markup.
 */
export function esc(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Tagged template that escapes interpolations. `raw()` opts a value out. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, chunk, i) => {
    if (i === 0) return chunk;
    const value = values[i - 1];
    const rendered = Array.isArray(value)
      ? value.map((v) => (isRaw(v) ? v.value : esc(v))).join("")
      : isRaw(value)
        ? value.value
        : esc(value);
    return out + rendered + chunk;
  }, "");
}

interface Raw {
  readonly __raw: true;
  readonly value: string;
}

export function raw(value: string): Raw {
  return { __raw: true, value };
}

function isRaw(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && (value as Raw).__raw === true;
}

/**
 * "3 hours ago". Coarse on purpose: the owner wants to know whether something is fresh, and a
 * relative time to the minute invites reading precision into a polled observation.
 */
export function ago(iso: string | undefined, now: Date): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";

  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function pluralize(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
