/**
 * The Feed.
 *
 * Cards come from `buildFeed`, the same assembly the CLI and the briefing use. This file only
 * decides how a card looks — it makes no judgement about what matters, which is the attention
 * engine's job and is already baked into the card.
 */

import type { FeedCard } from "../../feed/cards.ts";
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
    ${raw(card.whyItMatters ? html`<div class="row"><span class="label">Why it matters</span><span class="value">${card.whyItMatters}</span></div>` : "")}
    <div class="row"><span class="label">Where it stands</span><span class="value">${card.currentState}</span></div>
    <div class="row ${card.needsYou === "Nothing." ? "" : "needs"}">
      <span class="label">Needs you</span><span class="value">${card.needsYou}</span>
    </div>
    ${raw(card.nextStep ? html`<div class="row"><span class="label">Next step</span><span class="value">${card.nextStep}</span></div>` : "")}
    ${raw(link ? html`<div class="row">${raw(link)}</div>` : "")}
  </article>`;
}

export function feedView(cards: FeedCard[], now: Date): string {
  if (cards.length === 0) {
    return html`<div class="empty">
      <div class="big">Nothing to show yet</div>
      <p>No events have been recorded for the projects you follow. Run a sync to pull them in.</p>
      <form method="post" action="/sync"><button class="btn" type="submit">Sync now</button></form>
    </div>`;
  }
  return cards.map((card) => feedCard(card, now)).join("");
}
