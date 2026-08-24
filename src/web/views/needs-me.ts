/**
 * Needs Me.
 *
 * Four questions per item, and all four are mandatory: what needs me, why, what should I do,
 * and what did the system look at to decide that. The last one is the reason this screen can be
 * trusted — a classification the owner cannot interrogate is one they will eventually learn to
 * ignore, and an ignored attention list is worse than none.
 *
 * An empty screen means the deterministic engine matched no rule. It says exactly that, rather
 * than showing a cheerful blank, because "nothing needs you" and "nothing was checked" have to
 * be distinguishable.
 */

import type { CompanionEvent } from "../../domain/events.ts";
import type { Severity } from "../../domain/attention.ts";
import type { TrackedAttentionItem } from "../../store/store.ts";
import { ago, html, raw } from "../html.ts";

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

const GROUP_TITLES: Record<string, string> = {
  CRITICAL: "Critical",
  HIGH: "Needs you now",
  MEDIUM: "Worth a look",
  LOW: "Minor",
};

export interface NeedsMeItem {
  item: TrackedAttentionItem;
  projectName: string;
  evidence: CompanionEvent[];
}

function attentionCard(entry: NeedsMeItem, now: Date): string {
  const { item } = entry;

  const sources = item.evidence.map(
    (source) =>
      html`<li>
        ${source.sourceType.replace(/_/g, " ").toLowerCase()}: <code>${source.sourceId}</code>
        ${raw(source.sourceUrl ? html` — <a href="${source.sourceUrl}" target="_blank" rel="noreferrer noopener">open ↗</a>` : "")}
      </li>`,
  );

  const events = entry.evidence.map(
    (event) => html`<li>${ago(event.occurredAt, now)} — ${event.summaryShort}</li>`,
  );

  return html`<article class="card sev-${item.severity}">
    <div class="eyebrow">
      <strong>${entry.projectName}</strong>
      <span class="chip">${item.entityId}</span>
      <span class="badge ${item.severity}">${item.severity}</span>
      <span style="margin-left:auto">waiting ${ago(item.firstSeenAt, now)}</span>
    </div>

    <div class="row"><span class="label">Why</span><span class="value">${item.reasonText}</span></div>
    <div class="row needs"><span class="label">Do next</span><span class="value">${item.recommendedAction}</span></div>

    <details class="evidence">
      <summary>Why the system thinks so — ${item.reasonCode}</summary>
      <ul>
        <li>Rule <code>${item.reasonCode}</code> matched on ${item.entityType.replace(/_/g, " ").toLowerCase()} <code>${item.entityId}</code>.</li>
        <li>First seen ${ago(item.firstSeenAt, now)}; last confirmed ${ago(item.lastSeenAt, now)}.</li>
      </ul>
      <ul>${raw(sources.join(""))}</ul>
      ${raw(events.length > 0 ? html`<ul>${raw(events.join(""))}</ul>` : "")}
    </details>
  </article>`;
}

export function needsMeView(entries: NeedsMeItem[], now: Date, lastSyncedAt?: string): string {
  if (entries.length === 0) {
    return html`<div class="empty">
      <div class="big">Nothing needs you</div>
      <p>
        The attention engine checked every pull request, workstream and agent session it has
        state for, and no rule matched. This is a real answer, not an empty page.
      </p>
      <p class="muted">Last synced ${ago(lastSyncedAt, now)}.</p>
    </div>`;
  }

  const sections = SEVERITY_ORDER.map((severity) => {
    const group = entries.filter((entry) => entry.item.severity === severity);
    if (group.length === 0) return "";
    return html`<h2 class="section">${GROUP_TITLES[severity] ?? severity} · ${group.length}</h2>
      ${raw(group.map((entry) => attentionCard(entry, now)).join(""))}`;
  });

  return sections.join("");
}
