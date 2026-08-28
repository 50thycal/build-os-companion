/**
 * The Feed.
 *
 * Cards come from `buildFeed`, the same assembly the CLI and the briefing use. This file only
 * decides how a card looks — it makes no judgement about what matters, which is the attention
 * engine's job and is already baked into the card.
 */

import type { FeedCard } from "../../feed/cards.ts";
import type { ProjectGroup } from "../../feed/portfolio.ts";
import { ago, esc, html, raw } from "../html.ts";

export function feedCard(card: FeedCard, now: Date): string {
  const severity = card.severity !== "NONE" ? html`<span class="badge ${card.severity}">${card.severity}</span>` : "";
  const link = card.sourceUrl
    ? html`<a href="${card.sourceUrl}" rel="noreferrer noopener" target="_blank">open ↗</a>`
    : "";

  return html`<article class="card sev-${card.severity}">
    <div class="eyebrow">
      <strong>${card.projectName}</strong>
      <span class="chip">${card.entityLabel}</span>
      ${raw(severity)}
      <span style="margin-left:auto">${ago(card.occurredAt, now)}</span>
    </div>
    <p class="headline">${card.whatChanged}</p>
    ${raw(card.history ? html`<p class="history">${card.history}</p>` : "")}
    ${raw(card.whyItMatters ? html`<div class="row"><span class="label">Why it matters</span><span class="value">${card.whyItMatters}</span></div>` : "")}
    <div class="row"><span class="label">Where it stands</span><span class="value">${card.currentState}</span></div>
    ${raw(
      card.contradictions
        ? card.contradictions
            .map(
              (finding) =>
                html`<div class="row needs"><span class="label">Doesn't add up</span><span class="value">${finding}</span></div>`,
            )
            .join("")
        : "",
    )}
    <div class="row ${card.needsYou === "Nothing." ? "" : "needs"}">
      <span class="label">Needs you</span><span class="value">${card.needsYou}</span>
    </div>
    ${raw(card.nextStep ? html`<div class="row"><span class="label">Next step</span><span class="value">${card.nextStep}</span></div>` : "")}
    ${raw(link ? html`<div class="row">${raw(link)}</div>` : "")}
  </article>`;
}

/**
 * One project's header row: the four facts that decide whether to open it.
 *
 * Deliberately not a card. A card is about a thing that happened; this is about a project's
 * standing, and the owner scanning a dozen of these is asking "which of these needs me today?"
 * before they are asking "what happened in it?".
 */
function projectHeader(group: ProjectGroup, now: Date): string {
  const counts = [
    group.needsYouCount > 0 ? `${group.needsYouCount} needs you` : undefined,
    group.activeWorkstreamCount > 0
      ? `${group.activeWorkstreamCount} active workstream${group.activeWorkstreamCount === 1 ? "" : "s"}`
      : undefined,
    group.openPullRequestCount > 0
      ? `${group.openPullRequestCount} open PR${group.openPullRequestCount === 1 ? "" : "s"}`
      : undefined,
    // Said plainly rather than hidden: a repository with no Build OS layer still belongs in the
    // feed, and the owner should know which kind of project they are looking at.
    group.buildOs ? undefined : "no Build OS",
  ].filter(Boolean);

  const badge =
    group.severity !== "NONE" ? html`<span class="badge ${group.severity}">${group.severity}</span>` : "";
  const stale = group.staleSince
    ? html`<span class="badge MEDIUM">last sync failed</span>`
    : "";

  return html`<div class="group-head">
    <a class="group-name" href="/project/${group.projectId}">${group.projectName}</a>
    ${raw(badge)}${raw(stale)}
    <span style="margin-left:auto">${group.lastChangeAt ? ago(group.lastChangeAt, now) : "no activity"}</span>
    <div class="group-counts">${counts.join(" · ")}</div>
  </div>`;
}

/**
 * The feed, grouped by project.
 *
 * Each group shows its most significant cards and keeps the rest behind a disclosure rather than
 * dropping them — the owner who wants the whole of one project can have it without the feed
 * costing every other project its place on the screen.
 */
export function portfolioView(groups: ProjectGroup[], now: Date): string {
  if (groups.length === 0) return emptyFeed();

  return groups
    .map((group) => {
      const rest =
        group.collapsed.length > 0
          ? html`<details class="more">
              <summary>${group.collapsed.length} more in ${group.projectName}</summary>
              ${raw(group.collapsed.map((card) => feedCard(card, now)).join(""))}
            </details>`
          : "";
      return html`<section class="group">
        ${raw(projectHeader(group, now))}
        ${raw(group.visible.map((card) => feedCard(card, now)).join(""))}
        ${raw(rest)}
      </section>`;
    })
    .join("");
}

function emptyFeed(): string {
  return html`<div class="empty">
    <div class="big">Nothing to show yet</div>
    <p>No events have been recorded for the projects you follow. Run a sync to pull them in.</p>
    <form method="post" action="/sync"><button class="btn" type="submit">Sync now</button></form>
  </div>`;
}

export function feedView(cards: FeedCard[], now: Date): string {
  if (cards.length === 0) return emptyFeed();
  return cards.map((card) => feedCard(card, now)).join("");
}
