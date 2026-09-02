/**
 * Podcast script views: read-only transcripts of what `buildDigestPodcastScript` /
 * `buildDeepDivePodcastScript` produced. Script only — no audio yet, per WS-006's own non-goals.
 */

import type { FactPack } from "../../briefing/fact-pack.ts";
import type { PodcastScript } from "../../podcast/types.ts";
import { html, raw } from "../html.ts";

const FIELD_STYLE =
  "width:100%;min-height:44px;padding:12px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);font:inherit;box-sizing:border-box";
/** A checkbox's default control box is well under the 44px tap-target floor; size it directly. */
const CHECKBOX_STYLE = "width:44px;height:44px;margin:-10px 0 0;flex-shrink:0";
const LINK_STYLE = "display:inline-flex;align-items:center;min-height:44px;padding-block:12px;margin-block:-12px";

function scriptBody(script: PodcastScript): string {
  return script.segments
    .map(
      (segment) => html`<article class="card">
        <p class="headline">${segment.title}</p>
        <ul class="plain">
          ${raw(
            segment.lines
              .map((line) => html`<li><span class="chip">${line.speaker}</span> ${line.text}</li>`)
              .join(""),
          )}
        </ul>
      </article>`,
    )
    .join("");
}

/**
 * `txtHref` is omitted for a freshly generated deep dive: those scripts are not persisted at a
 * stable URL yet, so there is nothing for a text link to point at without misleadingly reusing
 * the digest's.
 */
export function podcastScriptView(script: PodcastScript, txtHref?: string): string {
  return html`<p class="muted" style="margin:-4px 0 14px">Script only — no audio yet.</p>
    ${raw(scriptBody(script))}
    <p class="muted" style="text-align:center;font-size:13px;margin-top:8px">
      ${raw(txtHref ? html`<a href="${txtHref}" style="${LINK_STYLE}">plain text</a> · ` : "")}${raw(
        script.kind === "DIGEST"
          ? html`<a href="/podcast/suggestions" style="${LINK_STYLE}">suggested episodes</a> ·
              <a href="/podcast/deep-dive" style="${LINK_STYLE}">start a deep dive</a>`
          : "",
      )}
    </p>`;
}

export function podcastDeepDiveFormView(pack: FactPack): string {
  const facts = pack.sections.flatMap((section) => section.facts.map((fact) => ({ fact, sectionTitle: section.title })));

  return html`<form method="post" action="/podcast/deep-dive">
    <p class="row">
      <span class="label">Episode title</span>
      <input name="title" required style="${FIELD_STYLE}">
    </p>
    <p class="row">
      <span class="label">Why this, now</span>
      <textarea name="whyNow" required rows="3" style="${FIELD_STYLE}"></textarea>
    </p>
    <p class="muted" style="font-size:13px">Pick the facts this episode should be grounded in.</p>
    ${raw(
      facts.length === 0
        ? html`<div class="empty"><p>Nothing in the current fact pack to build a deep dive from yet.</p></div>`
        : facts
            .map(
              ({ fact, sectionTitle }) => html`<label class="row" style="display:flex;gap:8px;align-items:center">
                <input type="checkbox" name="factId" value="${fact.id}" style="${CHECKBOX_STYLE}">
                <span><strong>${sectionTitle}</strong> — ${fact.text}</span>
              </label>`,
            )
            .join(""),
    )}
    <button class="btn" type="submit" style="margin-top:14px" ${facts.length === 0 ? "disabled" : ""}>
      Generate deep-dive script
    </button>
  </form>`;
}
