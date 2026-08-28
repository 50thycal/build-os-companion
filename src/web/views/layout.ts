/**
 * The page shell.
 *
 * Built for a phone held in one hand. Everything load-bearing lives in the top two thirds of
 * the screen, navigation sits at the bottom within thumb reach, and tap targets are at least
 * 44px because that is what a thumb actually hits. It renders on a desktop too, but the
 * decisions were made for the phone.
 *
 * No client-side framework and no build step. The whole application is server-rendered HTML
 * with one small stylesheet, which means it loads instantly on a bad connection and there is no
 * second interpretation of the data living in a browser.
 */

import { esc, html, raw } from "../html.ts";

export type Tab = "feed" | "needs" | "projects" | "briefing";

const STYLES = `
:root {
  --bg: #0d1117; --surface: #161b22; --surface-2: #1c2129; --line: #2a3038;
  --text: #e6edf3; --muted: #9aa4b2; --faint: #6e7681;
  --accent: #4493f8; --accent-dim: #1f6feb;
  --critical: #f85149; --high: #ff7b48; --medium: #d29922; --low: #58a6ff; --ok: #3fb950;
  --radius: 12px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff; --surface: #f6f8fa; --surface-2: #eef1f4; --line: #d8dee4;
    --text: #1f2328; --muted: #59636e; --faint: #818b98;
    --accent: #0969da; --accent-dim: #0550ae;
    --critical: #cf222e; --high: #bc4c00; --medium: #9a6700; --low: #0969da; --ok: #1a7f37;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  /* Room for the fixed tab bar plus the iPhone home indicator. */
  padding-bottom: calc(72px + env(safe-area-inset-bottom));
  overscroll-behavior-y: contain;
}
a { color: var(--accent); text-decoration: none; }

header.top {
  position: sticky; top: 0; z-index: 10;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--line);
  padding: calc(10px + env(safe-area-inset-top)) 16px 10px;
}
header.top h1 { margin: 0; font-size: 19px; letter-spacing: -0.01em; }
header.top .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
header.top .bar { display: flex; align-items: baseline; gap: 12px; }
header.top form.signout { margin-left: auto; }
header.top form.signout button {
  background: none; border: none; padding: 12px 0; margin: -12px 0;
  min-height: 44px; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer;
}

main { padding: 14px 16px 24px; max-width: 720px; margin: 0 auto; }

.card {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 14px; margin-bottom: 12px;
}
.card.sev-CRITICAL { border-left: 4px solid var(--critical); }
.card.sev-HIGH { border-left: 4px solid var(--high); }
.card.sev-MEDIUM { border-left: 4px solid var(--medium); }
.card.sev-LOW { border-left: 4px solid var(--low); }

.eyebrow {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  font-size: 12px; color: var(--muted); margin-bottom: 6px;
}
.headline { font-weight: 600; font-size: 15px; margin: 0 0 6px; letter-spacing: -0.01em; }
.group { margin: 0 0 18px; }
.group-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 2px 8px; border-bottom: 1px solid var(--line); margin-bottom: 8px;
}
/* A link in a header row is still a link a thumb has to hit: 44px, paid for with padding and
   taken back with a negative margin so the row does not grow. */
.group-name {
  font-weight: 700; font-size: 16px; letter-spacing: -0.01em; text-decoration: none;
  color: var(--text); display: flex; align-items: center;
  min-height: 44px; padding-inline-end: 4px; margin-block: -10px;
}
.group-counts { flex-basis: 100%; font-size: 13px; color: var(--muted); }
.more > summary { cursor: pointer; font-size: 13px; color: var(--muted); padding: 8px 2px; min-height: 44px; display: flex; align-items: center; }
.history { margin: -2px 0 8px; font-size: 13px; color: var(--muted); }
.row { margin: 6px 0; font-size: 14px; }
.row .label {
  display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--faint); margin-bottom: 1px;
}
.row .value { color: var(--text); }
.row.needs .value { color: var(--high); font-weight: 500; }
.muted { color: var(--muted); }

.badge {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; letter-spacing: .02em;
  background: var(--surface-2); color: var(--muted); border: 1px solid var(--line);
}
.badge.CRITICAL { background: var(--critical); color: #fff; border-color: transparent; }
.badge.HIGH { background: var(--high); color: #fff; border-color: transparent; }
.badge.MEDIUM { background: var(--medium); color: #fff; border-color: transparent; }
.badge.LOW { background: var(--low); color: #fff; border-color: transparent; }
.badge.ok { background: transparent; color: var(--ok); border-color: var(--ok); }

h2.section {
  font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint);
  margin: 22px 0 10px; font-weight: 600;
}
h2.section:first-child { margin-top: 4px; }

.empty {
  text-align: center; padding: 40px 20px; color: var(--muted);
  border: 1px dashed var(--line); border-radius: var(--radius);
}
.empty .big { font-size: 17px; color: var(--text); margin-bottom: 6px; font-weight: 600; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; padding: 0 18px; border-radius: 10px;
  background: var(--accent); color: #fff; border: none;
  font-size: 15px; font-weight: 600; font-family: inherit; cursor: pointer; width: 100%;
}
.btn.secondary { background: var(--surface-2); color: var(--text); border: 1px solid var(--line); }
.btn:active { opacity: .8; }

/*
 * Inline links get a 44px tap area without a 44px footprint: vertical padding expands the hit
 * box and an equal negative margin takes the space back out of the layout. A 16px "open" link
 * is a link a thumb misses, and missing it on a phone means opening the wrong pull request.
 */
.card a:not(.btn), .empty a, .stale a {
  display: inline-flex; align-items: center;
  min-height: 44px; padding-block: 12px; margin-block: -12px;
}
a.chip { min-height: 44px; padding-block: 12px; margin-block: -9px; }

details.evidence { margin-top: 8px; }
details.evidence summary {
  cursor: pointer; font-size: 13px; color: var(--muted);
  /* A disclosure toggle is a tap target like any other: 44px, per the same guideline. */
  min-height: 44px; display: flex; align-items: center;
}
details.evidence ul { margin: 6px 0 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
details.evidence li { margin: 3px 0; }

nav.tabs {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 20;
  display: grid; grid-template-columns: repeat(4, 1fr);
  background: color-mix(in srgb, var(--bg) 94%, transparent);
  backdrop-filter: saturate(180%) blur(12px);
  border-top: 1px solid var(--line);
  padding-bottom: env(safe-area-inset-bottom);
}
nav.tabs a {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  min-height: 56px; font-size: 11px; color: var(--muted); font-weight: 500;
}
nav.tabs a.active { color: var(--accent); }
nav.tabs .glyph { font-size: 19px; line-height: 1; }
nav.tabs .count {
  position: absolute; transform: translate(16px, -12px);
  background: var(--high); color: #fff; border-radius: 999px;
  font-size: 10px; font-weight: 700; padding: 1px 5px; min-width: 16px; text-align: center;
}

.stale {
  background: color-mix(in srgb, var(--medium) 14%, transparent);
  border: 1px solid var(--medium); border-radius: var(--radius);
  padding: 10px 12px; font-size: 13px; margin-bottom: 12px;
}
ul.plain { list-style: none; padding: 0; margin: 0; }
ul.plain li { padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
ul.plain li:last-child { border-bottom: none; }
.kv { display: flex; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.chip {
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px;
  padding: 1px 7px; font-size: 12px; color: var(--muted);
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
`;

const TABS: { id: Tab; href: string; glyph: string; label: string }[] = [
  { id: "feed", href: "/", glyph: "◎", label: "Feed" },
  { id: "needs", href: "/needs-me", glyph: "！", label: "Needs Me" },
  { id: "projects", href: "/projects", glyph: "▤", label: "Projects" },
  { id: "briefing", href: "/briefing", glyph: "✦", label: "Catch Up" },
];

export interface LayoutOptions {
  title: string;
  subtitle?: string;
  tab: Tab;
  /** Shown on the Needs Me tab. Omitted when zero — a badge reading 0 is noise. */
  needsCount?: number;
  /** Render the sign-out control. False when the app is running without a password. */
  signOut?: boolean;
  body: string;
}

export function layout(options: LayoutOptions): string {
  const nav = TABS.map((tab) => {
    const badge =
      tab.id === "needs" && options.needsCount
        ? html`<span class="count">${options.needsCount}</span>`
        : "";
    return html`<a href="${tab.href}" class="${tab.id === options.tab ? "active" : ""}">
      <span class="glyph">${raw(tab.glyph)}</span>${raw(badge)}<span>${tab.label}</span>
    </a>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Companion">
<title>${esc(options.title)} · Build OS Companion</title>
<style>${STYLES}</style>
</head>
<body>
<header class="top">
  <div class="bar">
    <h1>${esc(options.title)}</h1>
    ${options.signOut ? `<form class="signout" method="post" action="/logout"><button type="submit">Sign out</button></form>` : ""}
  </div>
  ${options.subtitle ? `<div class="sub">${esc(options.subtitle)}</div>` : ""}
</header>
<main>${options.body}</main>
<nav class="tabs">${nav}</nav>
</body>
</html>`;
}
