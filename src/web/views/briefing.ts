/**
 * Since I Last Checked.
 *
 * The read cursor moves on one thing only: the owner pressing the button at the bottom of this
 * page. Rendering the page does not move it, and neither does syncing — a cursor that advanced
 * because a background process drew a screen would quietly consume the exact piece of state the
 * owner is relying on, and they would never know which briefing they missed.
 */

import type { FactPack } from "../../briefing/fact-pack.ts";
import type { SinceLastChecked } from "../../briefing/since.ts";
import { ago, html, pluralize, raw } from "../html.ts";

function changeEntry(entry: SinceLastChecked["groups"][number]["entries"][number], now: Date): string {
  return html`<article class="card sev-${entry.severity ?? "NONE"}">
    <div class="eyebrow">
      <strong>${entry.projectName}</strong>
      <span class="chip">${entry.entityLabel}</span>
      ${raw(entry.severity && entry.severity !== "NONE" ? html`<span class="badge ${entry.severity}">${entry.severity}</span>` : "")}
      <span style="margin-left:auto">${ago(entry.occurredAt, now)}</span>
    </div>
    <p class="headline">${entry.headline}</p>
    ${raw(entry.detail ? html`<div class="row muted">${entry.detail}</div>` : "")}
    ${raw(
      entry.sourceUrl
        ? html`<div class="row"><a href="${entry.sourceUrl}" target="_blank" rel="noreferrer noopener">open ↗</a></div>`
        : "",
    )}
  </article>`;
}

export function briefingView(pack: FactPack, now: Date): string {
  const since = pack.since;
  const parts: string[] = [];

  const newCount = since.toSequence - since.fromSequence;

  if (since.isFirstLook) {
    parts.push(
      html`<div class="stale">
        <strong>First look.</strong> Nothing has been marked read yet, so everything below is
        existing state rather than news. Mark it read and from then on this page answers what
        changed since that moment.
      </div>`,
    );
  } else if (since.quiet) {
    parts.push(
      html`<div class="empty">
        <div class="big">Nothing changed</div>
        <p>
          No new events since you last checked, ${ago(since.cursor?.lastCheckedAt, now)}.
        </p>
      </div>`,
    );
  } else {
    parts.push(
      html`<div class="stale">
        ${pluralize(newCount, "new event")} since you last checked
        ${ago(since.cursor?.lastCheckedAt, now)}.
      </div>`,
    );
  }

  if (since.resolvedAttention.length > 0) {
    parts.push(html`<h2 class="section">Stopped needing you · ${since.resolvedAttention.length}</h2>`);
    parts.push(
      html`<article class="card">
        <ul class="plain">
          ${raw(
            since.resolvedAttention
              .map((item) => html`<li><span class="badge ok">resolved</span> ${item.reasonText}</li>`)
              .join(""),
          )}
        </ul>
      </article>`,
    );
  }

  for (const group of since.groups) {
    if (group.category === "RESOLVED") continue;
    parts.push(html`<h2 class="section">${group.title} · ${group.entries.length}</h2>`);
    parts.push(group.entries.map((entry) => changeEntry(entry, now)).join(""));
  }

  // The written briefing over the same state. Deterministic, and the structure a generated
  // narration would have to render without adding to.
  parts.push(html`<h2 class="section">Written briefing</h2>`);
  for (const section of pack.sections) {
    const body =
      section.facts.length === 0
        ? html`<div class="row muted">${section.emptyText}</div>`
        : raw(
            html`<ul class="plain">
              ${raw(
                section.facts
                  .map(
                    (fact) => html`<li>
                      ${raw(fact.severity && fact.severity !== "NONE" ? html`<span class="badge ${fact.severity}">${fact.severity}</span> ` : "")}
                      <strong>${fact.projectName}</strong> — ${fact.text}
                      ${raw(fact.detail ? html`<div class="muted" style="margin-top:2px">${fact.detail}</div>` : "")}
                      ${raw(fact.action ? html`<div style="margin-top:2px">→ ${fact.action}</div>` : "")}
                    </li>`,
                  )
                  .join(""),
              )}
            </ul>`,
          );

    parts.push(html`<article class="card">
      <p class="headline">${section.title}</p>
      ${raw(typeof body === "string" ? body : body.value)}
    </article>`);
  }

  parts.push(
    html`<form method="post" action="/briefing/checked" style="margin-top:18px">
      <input type="hidden" name="sequence" value="${String(since.toSequence)}">
      <!--
        The moment this briefing was generated, not the moment the button is pressed. A page
        left open for an hour must not consume attention that appeared while it sat there.
      -->
      <input type="hidden" name="checkpointAt" value="${since.generatedAt}">
      <button class="btn" type="submit" ${since.acknowledgeable ? "" : "disabled"}>
        ${since.isFirstLook ? "Start tracking from here" : "Mark as read"}
      </button>
    </form>
    <p class="muted" style="text-align:center;font-size:13px;margin-top:8px">
      Reading this page does not mark it read.
    </p>
    <form method="post" action="/sync" style="margin-top:12px">
      <button class="btn secondary" type="submit">Sync now</button>
    </form>`,
  );

  return parts.join("");
}
