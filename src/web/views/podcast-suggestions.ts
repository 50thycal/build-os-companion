/**
 * Suggested episodes.
 *
 * The card shape comes straight from `docs/ideas/topic-podcast-suggestions.md`: a title, why it
 * is worth an episode, where it came from, what the owner would learn, how fresh it is, and how
 * much episode it deserves. Three actions, and only one of them generates anything.
 *
 * The card deliberately carries no script and no audio. A proposal the owner has not accepted is
 * a proposal; rendering a generated episode beside it would make the approval a formality.
 */

import type { StoredSuggestionDecision, TopicSuggestion } from "../../domain/podcast-suggestion.ts";
import { SCOPE_LABELS } from "../../domain/podcast-suggestion.ts";
import { ago, html, raw } from "../html.ts";

function provenance(suggestion: TopicSuggestion): string {
  return suggestion.refs
    .map((ref) => {
      const label = `${ref.kind.replace(/_/g, " ").toLowerCase()} ${ref.id}`;
      return ref.url
        ? html`<a class="chip" href="${ref.url}" target="_blank" rel="noreferrer noopener">${label} ↗</a>`
        : html`<span class="chip">${label}</span>`;
    })
    .join(" ");
}

function suggestionCard(suggestion: TopicSuggestion, now: Date): string {
  const beats = suggestion.whatYouWouldLearn
    .map((beat) => html`<li>${beat}</li>`)
    .join("");

  return html`<article class="card">
    <div class="eyebrow">
      <strong>${suggestion.projectName}</strong>
      <span class="chip">${SCOPE_LABELS[suggestion.scope]}</span>
      <span style="margin-left:auto">${ago(suggestion.suggestedAt, now)}</span>
    </div>

    <p class="headline">${suggestion.title}</p>

    <div class="row"><span class="label">Why this is worth an episode</span><span class="value">${suggestion.whyNow}</span></div>
    <div class="row"><span class="label">Why now</span><span class="value">${suggestion.freshness}</span></div>

    ${raw(
      beats
        ? html`<div class="row">
            <span class="label">What you would learn</span>
            <ul class="plain">${raw(beats)}</ul>
          </div>`
        : "",
    )}

    <div class="row">
      <span class="label">Built from</span>
      <span class="kv">${raw(provenance(suggestion))}</span>
    </div>

    <details class="evidence">
      <summary>Why this was suggested — ${suggestion.reasonCode}</summary>
      <ul>
        ${raw(suggestion.scoreReasons.map((reason) => html`<li>${reason}</li>`).join(""))}
        <li>Scored ${String(suggestion.score)}.</li>
      </ul>
    </details>

    <form method="post" action="/podcast/suggestions/${suggestion.id}/create" style="margin-top:10px">
      <button class="btn" type="submit">Create podcast</button>
    </form>
    <div style="display:flex;gap:8px;margin-top:8px">
      <form method="post" action="/podcast/suggestions/${suggestion.id}/save" style="flex:1">
        <button class="btn secondary" type="submit">Save</button>
      </form>
      <form method="post" action="/podcast/suggestions/${suggestion.id}/dismiss" style="flex:1">
        <button class="btn secondary" type="submit">Dismiss</button>
      </form>
    </div>
  </article>`;
}

function decisionCard(decision: StoredSuggestionDecision, now: Date): string {
  const restore =
    decision.decision === "EPISODE_CREATED"
      ? html`<p class="muted" style="margin:8px 0 0;font-size:13px">
          An episode was generated from this topic. That cannot be undone from here.
        </p>`
      : html`<form method="post" action="/podcast/suggestions/${decision.suggestionId}/restore" style="margin-top:8px">
          <button class="btn secondary" type="submit">Put it back</button>
        </form>`;

  return html`<article class="card">
    <div class="eyebrow">
      <span class="chip">${decision.decision.replace(/_/g, " ").toLowerCase()}</span>
      <span style="margin-left:auto">${ago(decision.decidedAt, now)}</span>
    </div>
    <p class="headline">${decision.title}</p>
    <div class="row muted">${decision.whyNow}</div>
    ${raw(restore)}
  </article>`;
}

export function podcastSuggestionsView(
  suggestions: TopicSuggestion[],
  decisions: StoredSuggestionDecision[],
  now: Date,
): string {
  const saved = decisions.filter((d) => d.decision === "SAVED");
  const settled = decisions.filter((d) => d.decision !== "SAVED");

  const savedSection =
    saved.length > 0
      ? html`<h2 class="section">Saved for later · ${saved.length}</h2>
          ${raw(saved.map((d) => decisionCard(d, now)).join(""))}`
      : "";

  const settledSection =
    settled.length > 0
      ? html`<details class="more">
          <summary>${settled.length} already decided — dismissed, or already made</summary>
          ${raw(settled.map((d) => decisionCard(d, now)).join(""))}
        </details>`
      : "";

  const main =
    suggestions.length === 0
      ? html`<div class="empty">
          <div class="big">Nothing worth an episode yet</div>
          <p>
            Every workstream was considered. Nothing has enough of a story behind it — a finished
            arc, a cluster of decisions, a run of pull requests that belong together — to be worth
            explaining on its own. This is a real answer: the value of this page is that it stays
            quiet until something has earned it.
          </p>
        </div>`
      : html`<p class="muted" style="margin:-4px 0 14px">
            Suggestions only. Nothing is generated until you say so.
          </p>
          ${raw(suggestions.map((s) => suggestionCard(s, now)).join(""))}`;

  return main + savedSection + settledSection;
}
