/**
 * The login page, and the page shown when the app has no password configured.
 *
 * Both are deliberately standalone rather than wrapped in the app shell: neither should show
 * the tab bar, because there is nothing behind it the visitor is allowed to reach yet.
 */

import { esc, html, raw } from "../html.ts";

const SHELL_STYLES = `
:root { --bg:#0d1117; --surface:#161b22; --line:#2a3038; --text:#e6edf3; --muted:#9aa4b2;
        --accent:#4493f8; --critical:#f85149; --radius:12px; }
@media (prefers-color-scheme: light) {
  :root { --bg:#fff; --surface:#f6f8fa; --line:#d8dee4; --text:#1f2328; --muted:#59636e;
          --accent:#0969da; --critical:#cf222e; }
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body {
  margin:0; min-height:100dvh; background:var(--bg); color:var(--text);
  font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  display:flex; align-items:center; justify-content:center;
  padding:24px calc(20px + env(safe-area-inset-left)) calc(24px + env(safe-area-inset-bottom));
}
.box { width:100%; max-width:380px; }
h1 { font-size:21px; margin:0 0 6px; letter-spacing:-0.01em; }
p.sub { color:var(--muted); font-size:14px; margin:0 0 20px; }
form { display:flex; flex-direction:column; gap:12px; }
label { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
input[type=password] {
  width:100%; min-height:48px; padding:0 14px; border-radius:10px;
  border:1px solid var(--line); background:var(--surface); color:var(--text);
  font-size:17px; font-family:inherit;
}
input[type=password]:focus { outline:2px solid var(--accent); outline-offset:1px; }
button {
  min-height:48px; border:none; border-radius:10px; background:var(--accent); color:#fff;
  font-size:16px; font-weight:600; font-family:inherit; cursor:pointer;
}
button:active { opacity:.85; }
.error {
  background:color-mix(in srgb, var(--critical) 14%, transparent);
  border:1px solid var(--critical); border-radius:var(--radius);
  padding:10px 12px; font-size:14px; margin-bottom:16px;
}
.setup { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:16px; }
.setup code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; }
.setup pre {
  background:var(--bg); border:1px solid var(--line); border-radius:8px;
  padding:10px; overflow-x:auto; font-size:13px; margin:10px 0 0;
}
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · Build OS Companion</title>
<style>${SHELL_STYLES}</style>
</head>
<body><div class="box">${body}</div></body>
</html>`;
}

export function loginPage(options: { error?: string; next?: string } = {}): string {
  // `autocomplete="current-password"` is what lets iOS offer the saved password, which is the
  // difference between logging in once and being asked every time.
  // Nested `html` fragments must be wrapped in `raw`: the tag escapes interpolated strings, and
  // a fragment is a string like any other. Without this the markup renders as visible text.
  return page(
    "Sign in",
    html`
      ${options.error ? raw(html`<div class="error">${options.error}</div>`) : ""}
      <h1>Build OS Companion</h1>
      <p class="sub">This is a private tool. Sign in to continue.</p>
      <form method="post" action="/login">
        ${options.next ? raw(html`<input type="hidden" name="next" value="${options.next}">`) : ""}
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password"
               autofocus required inputmode="text">
        <button type="submit">Sign in</button>
      </form>
    `,
  );
}

/**
 * Shown on every route when no password is set and no explicit opt-out was given.
 *
 * The application refuses to serve anything rather than quietly exposing private project state,
 * and says exactly which variable is missing — a security default nobody can act on becomes a
 * security default somebody disables.
 */
export function setupRequiredPage(): string {
  return page(
    "Configuration needed",
    html`
      <h1>Not configured</h1>
      <p class="sub">
        The Companion will not serve your project state until it can protect it.
      </p>
      <div class="setup">
        <p style="margin-top:0">Set a password and restart:</p>
        <pre>COMPANION_PASSWORD=your-password-here</pre>
        <p style="font-size:14px;color:var(--muted)">
          On Railway, add it under <strong>Variables</strong> on the service. Changing it later
          signs out every device.
        </p>
        <p style="font-size:14px;color:var(--muted);margin-bottom:0">
          Running locally and genuinely want no password? Set
          <code>COMPANION_ALLOW_NO_AUTH=1</code>. Never do this on a public hostname.
        </p>
      </div>
    `,
  );
}
