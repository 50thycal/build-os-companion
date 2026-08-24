/**
 * The Project screen.
 *
 * Per followed repository: what is being worked on, what phase it is in, which pull requests
 * carry it, what decisions are still the owner's to make, what agents are doing, and what has
 * changed lately. GitHub and the Build OS artifacts remain canonical — every line here is a
 * reading of them, and links back to the file or PR it came from.
 */

import type { PullRequestState, SessionState, WorkstreamState } from "../../domain/state.ts";
import { describeCi, describePhase, describeReview } from "../../domain/describe.ts";
import type { ProjectView } from "../../app/companion-app.ts";
import type { StoredProject } from "../../store/store.ts";
import { ago, html, pluralize, raw } from "../html.ts";
import { feedCard } from "./feed.ts";

export function projectListView(projects: StoredProject[], now: Date, counts: Map<string, number>): string {
  if (projects.length === 0) {
    return html`<div class="empty">
      <div class="big">No projects followed</div>
      <p>Add a repository to <code>companion.config.json</code> and restart.</p>
    </div>`;
  }

  return projects
    .map((project) => {
      const needs = counts.get(project.id) ?? 0;
      return html`<a href="/projects/${project.id}" style="color:inherit">
        <article class="card">
          <div class="eyebrow">
            <strong>${project.displayName ?? project.repositoryFullName}</strong>
            ${raw(needs > 0 ? html`<span class="badge HIGH">${needs} need you</span>` : html`<span class="badge ok">clear</span>`)}
            <span style="margin-left:auto">${ago(project.lastSyncedAt, now)}</span>
          </div>
          <div class="kv"><span>${project.repositoryFullName}</span></div>
          ${raw(project.staleSince ? html`<div class="row muted">Sync failing since ${ago(project.staleSince, now)}.</div>` : "")}
        </article>
      </a>`;
    })
    .join("");
}

function workstreamCard(ws: WorkstreamState, prs: PullRequestState[], sessions: SessionState[], now: Date): string {
  const related = prs.filter((pr) => ws.relatedPrNumbers.includes(pr.number));
  const working = sessions.filter((s) => s.workstreamId === ws.workstreamId);

  const prChips = related.map(
    (pr) =>
      html`<a class="chip" href="${pr.sourceUrl}" target="_blank" rel="noreferrer noopener"
        >#${pr.number} ${pr.lifecycle.toLowerCase()}</a
      >`,
  );

  return html`<article class="card">
    <div class="eyebrow">
      <span class="chip">${ws.workstreamId}</span>
      <span class="badge">${describePhase(ws.phase)}</span>
      ${raw(ws.status ? html`<span class="badge ${ws.status === "BLOCKED" ? "HIGH" : ""}">${ws.status.toLowerCase()}</span>` : "")}
      <span style="margin-left:auto">${ago(ws.updatedAt, now)}</span>
    </div>
    <p class="headline">${ws.title}</p>
    ${raw(ws.goal ? html`<div class="row"><span class="label">Goal</span><span class="value">${ws.goal}</span></div>` : "")}
    ${raw(ws.blocker ? html`<div class="row needs"><span class="label">Blocked by</span><span class="value">${ws.blocker}</span></div>` : "")}
    ${raw(ws.nextStep ? html`<div class="row"><span class="label">Next step</span><span class="value">${ws.nextStep}</span></div>` : "")}
    ${raw(
      ws.openDecisions.length > 0
        ? html`<div class="row needs"><span class="label">Open decisions</span><span class="value">${pluralize(ws.openDecisions.length, "decision")} waiting on you</span></div>`
        : "",
    )}
    ${raw(working.length > 0 ? html`<div class="row"><span class="label">Agent</span><span class="value">${working.map((s) => `${s.agentName ?? s.agent} (${s.status.toLowerCase()})`).join(", ")}</span></div>` : "")}
    ${raw(prChips.length > 0 ? html`<div class="kv" style="margin-top:8px">${raw(prChips.join(" "))}</div>` : "")}
    ${raw(
      ws.source.sourceUrl
        ? html`<div class="row"><a href="${ws.source.sourceUrl}" target="_blank" rel="noreferrer noopener">workstream file ↗</a></div>`
        : "",
    )}
  </article>`;
}

function pullRequestRow(pr: PullRequestState): string {
  return html`<li>
    <a href="${pr.sourceUrl}" target="_blank" rel="noreferrer noopener">#${pr.number}</a>
    ${pr.title}
    <div class="kv" style="margin-top:3px">
      <span class="chip">${pr.lifecycle.toLowerCase()}</span>
      <span>${describeCi(pr.ciState)}</span>
      <span>${describeReview(pr.reviewState)}</span>
      ${raw(pr.workstreamIds.length > 0 ? html`<span class="chip">${pr.workstreamIds.join(", ")}</span>` : "")}
    </div>
  </li>`;
}

export function projectView(view: ProjectView, now: Date): string {
  const { project, state } = view;
  const parts: string[] = [];

  if (project.staleSince) {
    parts.push(
      html`<div class="stale">
        Sync has been failing since ${ago(project.staleSince, now)}${project.lastError ? `: ${project.lastError}` : ""}.
        Everything below is the last state that was read successfully.
      </div>`,
    );
  }

  parts.push(html`<h2 class="section">Active workstreams · ${view.activeWorkstreams.length}</h2>`);
  parts.push(
    view.activeWorkstreams.length > 0
      ? view.activeWorkstreams.map((ws) => workstreamCard(ws, state.pullRequests, view.activeSessions, now)).join("")
      : html`<div class="empty"><div class="big">No active workstreams</div><p>Nothing is in flight in this project.</p></div>`,
  );

  if (view.openDecisions.length > 0) {
    parts.push(html`<h2 class="section">Decisions waiting on you · ${view.openDecisions.length}</h2>`);
    parts.push(
      html`<article class="card sev-HIGH">
        <ul class="plain">
          ${raw(
            view.openDecisions
              .map(
                (d) => html`<li>
                  <span class="chip">${d.workstreamId} ${d.key}</span>
                  <div style="margin-top:4px">${d.question}</div>
                  ${raw(d.detail ? html`<details class="evidence"><summary>Full entry</summary><div class="muted" style="font-size:13px">${d.detail}</div></details>` : "")}
                </li>`,
              )
              .join(""),
          )}
        </ul>
      </article>`,
    );
  }

  parts.push(html`<h2 class="section">Open pull requests · ${view.openPullRequests.length}</h2>`);
  parts.push(
    view.openPullRequests.length > 0
      ? html`<article class="card"><ul class="plain">${raw(view.openPullRequests.map(pullRequestRow).join(""))}</ul></article>`
      : html`<div class="empty"><div class="big">No open pull requests</div></div>`,
  );

  if (view.activeSessions.length > 0) {
    parts.push(html`<h2 class="section">Agent sessions · ${view.activeSessions.length}</h2>`);
    parts.push(
      html`<article class="card">
        <ul class="plain">
          ${raw(
            view.activeSessions
              .map(
                (s) => html`<li>
                  <strong>${s.agentName ?? s.agent}</strong>
                  <span class="chip">${s.status.toLowerCase()}</span>
                  <div class="muted" style="margin-top:3px">${s.objective}</div>
                  ${raw(s.blockers.length > 0 ? html`<div class="row needs"><span class="value">Blocked: ${s.blockers[0]!.description}</span></div>` : "")}
                </li>`,
              )
              .join(""),
          )}
        </ul>
      </article>`,
    );
  }

  if (view.recentlyMergedPullRequests.length > 0) {
    parts.push(html`<h2 class="section">Recently merged</h2>`);
    parts.push(
      html`<article class="card"><ul class="plain">${raw(view.recentlyMergedPullRequests.map(pullRequestRow).join(""))}</ul></article>`,
    );
  }

  if (state.integrityWarnings.length > 0) {
    parts.push(html`<h2 class="section">Build OS records disagree · ${state.integrityWarnings.length}</h2>`);
    parts.push(
      html`<article class="card sev-LOW">
        <ul class="plain">${raw(state.integrityWarnings.map((w) => html`<li><code>${w.code}</code><div class="muted">${w.message}</div></li>`).join(""))}</ul>
      </article>`,
    );
  }

  parts.push(html`<h2 class="section">Recent changes</h2>`);
  parts.push(
    view.recentCards.length > 0
      ? view.recentCards.map((card) => feedCard(card, now)).join("")
      : html`<div class="empty"><div class="big">Nothing recorded yet</div></div>`,
  );

  return parts.join("");
}
