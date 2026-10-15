import { loadGovernance } from "./governance.js";
/** @type implementation @purpose Drive the internal control-plane workspace. */
const $ = (id) => document.getElementById(id);
const API = "/api/internal/v1";
let currentUser = null;
let legacyToken = null;
let internalUsers = [];
let eligibleAssignees = [];
let datasets = [];
let samplingJobs = [];
let frameSets = [];
let policies = [];
let templates = [];
let campaigns = [];
let groundTruths = [];
let pipelines = [];
let selectedPipelineId = null;
let groundTruthDetail;
let groundTruthRequest = 0;
let runnerPresence = { available_count: 0, busy_count: 0, total_count: 0, heartbeat_ttl_seconds: 360, runners: [] };
let evidenceUrls = [];

function normaliseList(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

async function api(path, options = {}) {
  const response = await apiResponse(path, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || result.error || `Request failed (${response.status})`);
  return result;
}

async function apiResponse(path, options = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (legacyToken && !headers.has("authorization")) headers.set("authorization", `Bearer ${legacyToken}`);
  return fetch(`${API}${path}`, {
    ...options,
    credentials: "same-origin",
    headers,
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function firstPresent(item, ...keys) {
  for (const key of keys) if (item?.[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
  return null;
}

function statusBadge(status = "draft") {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(String(status).replaceAll("_", " "))}</span>`;
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 4000);
}

function setConnected(connected) {
  $("login-panel").hidden = connected;
  $("workspace").hidden = !connected;
  $("sign-out").hidden = !connected;
  $("connection").classList.toggle("connected", connected);
  $("connection").innerHTML = `<span></span>${connected ? ` ${escapeHtml(currentUser?.email || "Signed in")}` : " Not connected"}`;
}

function renderUsers() {
  $("internal-users-table").innerHTML = internalUsers.length
    ? `<table><thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th>Verification</th><th>Action</th></tr></thead><tbody>${internalUsers.map((user) => `<tr><td>${escapeHtml(user.display_name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.roles.join(", ").replaceAll("_", " "))}</td><td>${statusBadge(user.status)}</td><td>${user.email_verified ? "Verified" : "Pending"}</td><td>${user.email_verified || user.status !== "active" ? "—" : `<button class="secondary" type="button" data-resend-invitation="${escapeHtml(user.id)}">Resend invitation</button>`}</td></tr>`).join("")}</tbody></table>`
    : '<p class="muted">No named users are registered yet.</p>';
}

function showPage(name) {
  const valid = ["overview", "pipelines", "datasets", "sampling", "frame-sets", "policies", "templates", "reviews", "ground-truth", "evaluations", "models", "releases", "operations"];
  if (!valid.includes(name)) name = "overview";
  document.querySelectorAll(".page").forEach((page) => { page.hidden = page.dataset.page !== name; });
  document.querySelectorAll("nav [data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === name));
  $("page-title").textContent = { evaluations: "Evaluations", models: "Models", releases: "Releases", operations: "Operations", overview: "Overview", pipelines: "Pipelines", datasets: "Datasets", sampling: "Sampling jobs", "frame-sets": "Frame sets", policies: "Policies", templates: "Templates", reviews: "Review campaigns", "ground-truth": "Ground truth" }[name];
  document.body.classList.remove("menu-open");
  $("menu-toggle").setAttribute("aria-expanded", "false");
}

function renderOverview(payload = {}) {
  const metrics = payload.metrics || payload.counts || {};
  const values = [
    ["Datasets", metrics.datasets ?? datasets.length, "Registered source collections"],
    ["Pipelines", pipelines.length, "Linked workflow progress"],
    ["Sampling jobs", metrics.sampling_jobs ?? samplingJobs.length, "Durable scheduling records"],
    ["Available runners", runnerPresence.available_count, `Seen within ${Math.round(runnerPresence.heartbeat_ttl_seconds / 60)} minutes`],
    ["Frame sets", metrics.frame_sets ?? frameSets.length, "Immutable sampling outputs"],
    ["Templates", templates.length, "Registered review inputs"],
    ["Active campaigns", campaigns.filter((item) => !["completed", "cancelled"].includes(item.status)).length, "Independent review assignments"],
    ["Approved ground truth", groundTruths.filter((item) => item.approval_status === "approved").length, "Approved diagnostic versions"],
  ];
  $("overview-cards").innerHTML = values.map(([label, value, detail]) => `<article class="metric"><small>${label}</small><strong>${escapeHtml(value)}</strong><small>${detail}</small></article>`).join("");
  renderOverviewPipelines();
}

function renderOverviewPipelines() {
  $("overview-pipelines").innerHTML = pipelines.length
    ? `<div class="overview-pipeline-list">${pipelines.slice(0, 5).map((pipeline) => `<button class="overview-pipeline" type="button" data-overview-pipeline="${escapeHtml(pipeline.id)}"><span><strong>${escapeHtml(pipeline.name)}</strong><small>${escapeHtml(pipeline.resources.length)} linked resources · ${escapeHtml(pipeline.progress.completed_count)}/${escapeHtml(pipeline.progress.total_count)} complete</small></span><span>${statusBadge(pipeline.progress.status)}<small>${escapeHtml(pipeline.progress.percentage)}%</small></span></button>`).join("")}</div>`
    : '<p class="muted">No pipelines yet. Create a pipeline to track related datasets, frame sets, templates, reviews, and evaluations.</p>';
}

function renderRunnerPresence() {
  $("available-runner-count").textContent = runnerPresence.available_count;
  $("busy-runner-count").textContent = `${runnerPresence.busy_count} busy`;
  $("runner-heartbeat-note").textContent = `Heartbeats expire after ${Math.round(runnerPresence.heartbeat_ttl_seconds / 60)} minutes without contact.`;
  if (!runnerPresence.runners.length) {
    $("runner-list").innerHTML = '<p class="muted">No runners have checked in recently.</p>';
    return;
  }
  $("runner-list").innerHTML = runnerPresence.runners.map((runner) => `<div><strong>${escapeHtml(runner.runner_id)}</strong>${statusBadge(runner.status)}<small>${runner.current_job_id ? `Job ${escapeHtml(runner.current_job_id)}` : `Last seen ${escapeHtml(formatDate(runner.last_seen_at))}`}</small></div>`).join("");
}

function shortChecksum(value) {
  return value ? `${String(value).slice(0, 12)}…${String(value).slice(-8)}` : "—";
}

function renderFrameSets() {
  const query = $("frame-set-filter").value.trim().toLowerCase();
  const filtered = frameSets.filter((item) => `${item.id || ""} ${item.dataset_version_id || ""} ${item.sampling_job_id || ""}`.toLowerCase().includes(query));
  $("frame-set-summary").textContent = `${frameSets.length} registered frame set${frameSets.length === 1 ? "" : "s"}`;
  if (!filtered.length) {
    $("frame-sets-table").innerHTML = `<div class="empty-state"><strong>${query ? "No matching frame sets" : "No frame sets yet"}</strong><p>${query ? "Try another filter." : "A frame set appears after a runner successfully finalizes verified sampling artifacts."}</p></div>`;
    return;
  }
  $("frame-sets-table").innerHTML = `<table><thead><tr><th>Frame set</th><th>Dataset / job</th><th>Coverage</th><th>Engine</th><th>Checksum</th><th>Created</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${filtered.map((item) => `<tr><td><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.manifest_schema_version || "Unknown schema")}</small></td><td><strong>${escapeHtml(item.dataset_version_id || "—")}</strong><small>${escapeHtml(item.sampling_job_id || "—")}</small></td><td><strong>${escapeHtml(item.frame_count ?? 0)} frames</strong><small>${escapeHtml(item.source_count ?? 0)} sources</small></td><td><strong>${escapeHtml(item.engine?.name || "—")}</strong><small>${escapeHtml(item.engine?.version || "Unknown version")}</small></td><td><code title="${escapeHtml(item.sha256 || "")}">${escapeHtml(shortChecksum(item.sha256))}</code></td><td>${escapeHtml(formatDate(item.created_at))}</td><td class="actions"><button class="job-action secondary" type="button" data-frame-set-id="${escapeHtml(item.id)}">Inspect</button></td></tr>`).join("")}</tbody></table>`;
}

function clearEvidenceUrls() {
  evidenceUrls.forEach((url) => URL.revokeObjectURL(url));
  evidenceUrls = [];
}

function renderRegistry() {
  $("policies-table").innerHTML = policies.length ? `<table><thead><tr><th>Policy</th><th>Version</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>${policies.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.annotation_schema_version)}</small></td><td>${escapeHtml(item.version)}</td><td>${statusBadge(item.status)}</td><td>${escapeHtml(formatDate(item.created_at))}</td><td><button class="secondary" type="button" data-policy-inspect="${escapeHtml(item.id)}">Instructions</button></td></tr>`).join("")}</tbody></table>` : '<div class="empty-state"><strong>No registered policies</strong><p>Register the instructions and version that reviewers will follow.</p></div>';
  $("templates-table").innerHTML = templates.length ? `<table><thead><tr><th>Template</th><th>Inputs</th><th>Frames</th><th>Status</th><th>Actions</th></tr></thead><tbody>${templates.map((item) => `<tr><td><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.schema_version)}</small></td><td><strong>${escapeHtml(item.frame_set_id)}</strong><small>${escapeHtml(policies.find((policy) => policy.id === item.policy_version_id)?.name || item.policy_version_id)}</small></td><td>${escapeHtml(item.frame_count)}</td><td>${statusBadge(item.status)}</td><td><button class="secondary" type="button" data-template-inspect="${escapeHtml(item.id)}">Inspect</button> <button class="secondary" type="button" data-template-download="${escapeHtml(item.id)}">Download</button></td></tr>`).join("")}</tbody></table>` : '<div class="empty-state"><strong>No registered templates</strong><p>Select a ready frame set and an active policy to prepare review inputs.</p></div>';
  const ready = frameSets.filter((item) => item.status === "ready");
  const selectedCorpus = $("policy-corpus-frame-set").value;
  $("policy-corpus-frame-set").innerHTML = '<option value="">Enter checksums manually</option>' + ready.filter((item) => item.source_count === 5).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)} · 5 sources</option>`).join("");
  $("policy-corpus-frame-set").value = selectedCorpus;
  const active = policies.filter((item) => item.status === "active" && item.annotation_schema_version === "object-annotations.v1");
  $("template-frame-set").innerHTML = ready.length ? ready.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)} · ${escapeHtml(item.frame_count)} frames</option>`).join("") : '<option value="">No ready frame sets</option>';
  $("template-policy").innerHTML = active.length ? active.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.version)}</option>`).join("") : '<option value="">No active policies</option>';
  $("template-form").querySelector('[type="submit"]').disabled = !ready.length || !active.length;
}

async function inspectRegistry(collection, id) {
  $("registry-title").textContent = id;
  $("registry-detail").textContent = "Loading…";
  $("registry-dialog").showModal();
  try {
    const payload = await api(`/${collection}/${encodeURIComponent(id)}${collection === "templates" ? "/artifact" : ""}`);
    const item = payload.data || payload;
    $("registry-detail").innerHTML = `<pre>${escapeHtml(collection === "policies" ? `${item.name} · ${item.version}\n\n${item.document}` : prettyJson(item))}</pre>`;
    if (collection === "policies" && ["active", "deprecated"].includes(item.status)) {
      const form = document.createElement("form");
      form.innerHTML = `<label>Policy lifecycle<select name="action">${item.status === "active" ? '<option value="deprecate">Deprecate</option>' : ''}<option value="retire">Retire</option></select></label><label>Reason<textarea name="reason" maxlength="2000" required></textarea></label><p class="form-status" role="status"></p><button type="submit">Record transition</button>`;
      form.onsubmit = async (event) => {
        event.preventDefault(); const submit = form.querySelector("button"); submit.disabled = true;
        try { const value = Object.fromEntries(new FormData(form)); await api(`/policies/${encodeURIComponent(id)}/${value.action}`, { method: "POST", headers: { "content-type": "application/json", "if-match": String(item.revision) }, body: JSON.stringify({ reason: value.reason }) }); $("registry-dialog").close(); await loadAll(); }
        catch (error) { form.querySelector(".form-status").textContent = error.message; } finally { submit.disabled = false; }
      };
      $("registry-detail").append(form);
    }
  } catch (error) { $("registry-detail").textContent = error.message; }
}

async function downloadTemplate(id) {
  try {
    const response = await apiResponse(`/templates/${encodeURIComponent(id)}/artifact`);
    if (!response.ok) throw new Error(`Template unavailable (${response.status})`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = `${id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); }
}

async function listAll(path) {
  const items = [];
  let offset = 0;
  const limit = path === "/pipelines" ? 20 : 100;
  do {
    const payload = await api(`${path}?limit=${limit}&offset=${offset}`);
    items.push(...normaliseList(payload, "data"));
    if (!payload.pagination?.has_more) return { data: items };
    offset = payload.pagination.next_offset;
  } while (Number.isSafeInteger(offset));
  throw new Error("Invalid resource pagination");
}

function renderCampaigns() {
  $("campaigns-table").innerHTML = campaigns.length ? `<table><thead><tr><th>Campaign</th><th>Template</th><th>Progress</th><th>Status</th><th>Actions</th></tr></thead><tbody>${campaigns.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></td><td><code>${escapeHtml(item.template_id)}</code><small>${escapeHtml(item.frame_count)} frames</small></td><td>${item.assignments.map((assignment) => `<small>${escapeHtml(assignment.role)}: ${escapeHtml(assignment.status)}${assignment.role === "adjudicator" ? "" : ` · ${escapeHtml(assignment.reviewed_frames)}/${escapeHtml(item.frame_count)}`}${assignment.revoked_at ? " · revoked" : ""}</small>`).join("")}</td><td>${statusBadge(item.status)}</td><td><button class="secondary" type="button" data-campaign-inspect="${escapeHtml(item.id)}">Inspect</button></td></tr>`).join("")}</tbody></table>` : '<div class="empty-state"><strong>No managed campaigns</strong><p>Create one from a registered template to start independent review.</p></div>';
  const available = templates.filter((item) => item.status === "ready");
  $("campaign-template").innerHTML = available.length ? available.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)} · ${escapeHtml(item.frame_count)} frames</option>`).join("") : '<option value="">No ready templates</option>';
  $("campaign-form").querySelector('[type="submit"]').disabled = !available.length;
}

function renderPipelines() {
  $("pipeline-create-button").hidden = Array.isArray(currentUser?.roles) && !currentUser.roles.some((role) => ["owner", "operator", "researcher", "review_coordinator"].includes(role));
  $("pipeline-summary").textContent = `${pipelines.length} pipeline${pipelines.length === 1 ? "" : "s"}`;
  $("pipelines-table").innerHTML = pipelines.length ? `<table><thead><tr><th>Pipeline</th><th>Progress</th><th>Resources</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${pipelines.map((pipeline) => `<tr><td><strong>${escapeHtml(pipeline.name)}</strong><small>${escapeHtml(pipeline.id)}</small></td><td>${statusBadge(pipeline.progress.status)}<small>${escapeHtml(pipeline.progress.completed_count)}/${escapeHtml(pipeline.progress.total_count)} resources · ${escapeHtml(pipeline.progress.percentage)}%</small></td><td>${pipeline.resources.map((resource) => `<small>${escapeHtml(resource.resource_type.replaceAll("_", " "))}: ${escapeHtml(resource.label)} · ${escapeHtml(resource.status)}</small>`).join("") || '<small class="muted">No resources linked</small>'}</td><td>${escapeHtml(formatDate(pipeline.updated_at))}</td><td><button class="secondary" type="button" data-pipeline-inspect="${escapeHtml(pipeline.id)}">Inspect</button></td></tr>`).join("")}</tbody></table>` : '<div class="empty-state"><strong>No pipelines yet</strong><p>Create a pipeline to group related data, sampling, review, and evaluation resources.</p></div>';
}

function renderPipelineDetail(pipeline) {
  selectedPipelineId = pipeline.id;
  $("pipeline-detail-title").textContent = pipeline.name;
  const canManage = !Array.isArray(currentUser?.roles) || currentUser.roles.some((role) => ["owner", "operator", "researcher", "review_coordinator"].includes(role));
  const resources = pipeline.resources.length ? `<table><thead><tr><th>Resource</th><th>Reference / lineage</th><th>Status</th><th></th></tr></thead><tbody>${pipeline.resources.map((resource) => `<tr><td>${escapeHtml(resource.resource_type.replaceAll("_", " "))}</td><td><strong>${escapeHtml(resource.label)}</strong><small>${escapeHtml(resource.resource_id)}</small>${Object.entries(resource.lineage || {}).map(([kind, id]) => `<small>${escapeHtml(kind.replaceAll("_id", "").replaceAll("_", " "))}: ${escapeHtml(id)}</small>`).join("")}</td><td>${statusBadge(resource.status)}</td><td>${canManage ? `<button class="text-button" type="button" data-pipeline-unlink-type="${escapeHtml(resource.resource_type)}" data-pipeline-unlink-id="${escapeHtml(resource.resource_id)}">Unlink</button>` : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">No resources linked yet.</p>';
  $("pipeline-detail").innerHTML = `<div class="detail-metrics"><div><small>Progress</small>${statusBadge(pipeline.progress.status)}</div><div><small>Completed resources</small><strong>${escapeHtml(pipeline.progress.completed_count)} / ${escapeHtml(pipeline.progress.total_count)}</strong></div><div><small>Completion</small><strong>${escapeHtml(pipeline.progress.percentage)}%</strong></div><div><small>Pipeline status</small>${statusBadge(pipeline.status)}</div></div><p>${escapeHtml(pipeline.description || "No description.")}</p><section class="detail-section"><h3>Linked resources</h3>${resources}</section>${canManage ? `<form id="pipeline-resource-form" class="detail-section"><h3>Link an existing resource</h3><label for="pipeline-resource-type">Resource type</label><select id="pipeline-resource-type" name="resource_type" required><option value="dataset">Dataset</option><option value="dataset_version">Dataset version</option><option value="sampling_job">Sampling job</option><option value="frame_set">Frame set</option><option value="template">Template</option><option value="review_campaign">Review campaign</option><option value="evaluation_run">Evaluation run</option><option value="model_version">Model version</option><option value="pipeline_release">Pipeline release</option></select><label for="pipeline-resource-id">Resource ID</label><input id="pipeline-resource-id" name="resource_id" list="pipeline-resource-options" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,127}"><datalist id="pipeline-resource-options"></datalist><p class="field-help">Choose a known resource or enter an ID; the API verifies that it exists.</p><p class="form-status" role="status"></p><button type="submit">Link resource</button></form>` : ""}`;
  $("pipeline-resource-type")?.addEventListener("change", updatePipelineResourceOptions);
  updatePipelineResourceOptions();
  $("pipeline-detail-dialog").showModal();
}

function updatePipelineResourceOptions() {
  const type = $("pipeline-resource-type")?.value;
  if (!type) return;
  const known = {
    dataset: datasets.map((item) => [item.id, item.name || item.id]),
    dataset_version: datasets.filter((item) => item.latest_version?.id).map((item) => [item.latest_version.id, `${item.name || item.id} · ${item.latest_version.id}`]),
    sampling_job: samplingJobs.map((item) => [item.id, `${item.id} · ${item.status}`]),
    frame_set: frameSets.map((item) => [item.id, `${item.id} · ${item.frame_count} frames`]),
    template: templates.map((item) => [item.id, `${item.id} · ${item.status}`]),
    review_campaign: campaigns.map((item) => [item.id, `${item.name || item.id} · ${item.status}`]),
    evaluation_run: [],
    model_version: [],
    pipeline_release: [],
  };
  $("pipeline-resource-options").innerHTML = (known[type] || []).map(([id, label]) => `<option value="${escapeHtml(id)}" label="${escapeHtml(label)}"></option>`).join("");
}

async function inspectPipeline(pipelineId) {
  $("pipeline-detail-title").textContent = pipelineId;
  $("pipeline-detail").textContent = "Loading…";
  $("pipeline-detail-dialog").showModal();
  try { renderPipelineDetail((await api(`/pipelines/${encodeURIComponent(pipelineId)}`)).data); }
  catch (error) { $("pipeline-detail").textContent = error.message; }
}

function showInvitations(invitations) {
  $("invitation-links").replaceChildren();
  for (const [role, invitation] of Object.entries(invitations)) {
    for (const [labelText, value, copiedMessage] of [
      [`${role} assignment link`, invitation.url, "Assignment link copied."],
      [`${role} job token`, invitation.job_token || invitation.api_token, "Job token copied."],
    ]) {
      const label = document.createElement("label"); label.textContent = labelText;
      const input = document.createElement("input"); input.readOnly = true; input.value = value; input.autocomplete = "off"; input.setAttribute("aria-label", labelText);
      const button = document.createElement("button"); button.type = "button"; button.className = "secondary"; button.textContent = "Copy";
      button.onclick = () => navigator.clipboard.writeText(input.value).then(() => toast(copiedMessage)).catch(() => { input.focus(); input.select(); toast("Select and copy the value."); });
      $("invitation-links").append(label, input, button);
    }
  }
  $("invitations-dialog").showModal();
}

async function inspectCampaign(id) {
  $("campaign-title").textContent = id; $("campaign-detail").textContent = "Loading…";
  if (!$("campaign-dialog").open) $("campaign-dialog").showModal();
  try {
    const item = (await api(`/review-campaigns/${encodeURIComponent(id)}`)).data;
    $("campaign-title").textContent = item.name;
    const terminal = ["completed", "cancelled"].includes(item.status);
    const assignments = item.assignments.map((assignment) => {
      const identityRole = assignment.role === "adjudicator" ? "adjudicator" : "reviewer";
      const eligible = eligibleAssignees.filter((user) => user.roles.includes(identityRole));
      const bound = assignment.assignee_user_id ? `${escapeHtml(assignment.assignee_display_name || assignment.assignee_email)} · ${escapeHtml(assignment.assignee_email || "")}` : "Unbound; assignment token alone is accepted";
      const canBind = !terminal && assignment.status === "pending" && !assignment.job_token_issued_at;
      const bindControl = canBind ? `<div class="input-action"><select aria-label="${escapeHtml(assignment.role)} verified assignee" data-assignee-select="${escapeHtml(assignment.role)}"><option value="">Select verified ${identityRole}</option>${eligible.map((user) => `<option value="${escapeHtml(user.id)}" ${assignment.assignee_user_id === user.id ? "selected" : ""}>${escapeHtml(user.display_name)} · ${escapeHtml(user.email)}</option>`).join("")}</select><button class="secondary" type="button" data-assignment-action="assign" data-campaign="${escapeHtml(item.id)}" data-role="${escapeHtml(assignment.role)}" ${eligible.length ? "" : "disabled"}>Bind verified identity</button></div>` : "";
      return `<article><h4>${escapeHtml(assignment.role)}</h4><p>${statusBadge(assignment.status)} · ${escapeHtml(assignment.reviewed_frames)} frames reviewed${assignment.revoked_at ? " · revoked" : ""}</p><p><strong>Identity:</strong> ${bound}</p>${bindControl}<p class="muted">Expires ${escapeHtml(formatDate(assignment.expires_at))}${assignment.job_token_issued_at ? ` · Token issued ${escapeHtml(formatDate(assignment.job_token_issued_at))}` : " · No job token issued"}</p>${terminal ? "" : `${assignment.revoked_at ? "" : `<button class="secondary" type="button" data-assignment-action="revoke" data-campaign="${escapeHtml(item.id)}" data-role="${escapeHtml(assignment.role)}">Revoke job token</button>`} ${assignment.status === "complete" ? "" : `<button class="secondary" type="button" data-assignment-action="issue" data-campaign="${escapeHtml(item.id)}" data-role="${escapeHtml(assignment.role)}">${assignment.job_token_issued_at ? "Regenerate job token" : "Generate job token"}</button>`}`}</article>`;
    }).join("");
    $("campaign-detail").innerHTML = `<section class="detail-section"><h3>Inputs and progress</h3><p>${statusBadge(item.status)} · ${escapeHtml(item.frame_count)} frames</p><p>Template <code>${escapeHtml(item.template_id)}</code></p><p>SHA-256 <code>${escapeHtml(item.template_sha256)}</code></p></section><section class="detail-section"><h3>Assignments</h3><p class="muted">Optionally bind a verified named reviewer or adjudicator before issuing a job token. Bound assignments require both that user's verified Internals session and the separate assignment token. Unbound existing assignments retain token-only compatibility.</p>${assignments}</section><section class="detail-section"><h3>Audit history</h3>${item.audit_events.map((event) => `<p><strong>${escapeHtml(event.action)}</strong> · ${escapeHtml(formatDate(event.created_at))}${event.details.role ? ` · ${escapeHtml(event.details.role)}` : ""}</p>`).join("")}</section>${item.result_url ? `<p>The adjudicated artifact is a ground-truth candidate. Validation and approval remain pending.</p><button type="button" data-campaign-result="${escapeHtml(item.id)}">Download candidate</button>` : ""}${terminal ? "" : `<button class="secondary danger" type="button" data-campaign-cancel="${escapeHtml(item.id)}">Cancel campaign</button>`}`;
  } catch (error) { $("campaign-detail").textContent = error.message; }
}

async function campaignAction(button) {
  button.disabled = true;
  try {
    if (button.dataset.campaignResult) {
      const id = button.dataset.campaignResult;
      const response = await fetch(`/api/v1/campaigns/${encodeURIComponent(id)}/result`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`Candidate unavailable (${response.status})`);
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
      link.href = url; link.download = `${id}.candidate.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    const id = button.dataset.campaignCancel || button.dataset.campaign;
    const path = button.dataset.campaignCancel ? `/review-campaigns/${id}/cancel` : `/review-campaigns/${id}/assignments/${button.dataset.role}/${button.dataset.assignmentAction}`;
    const data = {};
    if (button.dataset.assignmentAction === "assign") {
      const select = $("campaign-detail").querySelector(`[data-assignee-select="${button.dataset.role}"]`);
      if (!select?.value) throw new Error("Select a verified eligible user before binding the assignment");
      data.user_id = select.value;
    }
    const payload = await api(path, { method: "POST", ...(Object.keys(data).length ? { headers: { "content-type": "application/json" }, body: JSON.stringify(data) } : {}) });
    if (payload.invitation) showInvitations({ [button.dataset.role]: payload.invitation });
    await inspectCampaign(id); await loadAll();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

function groundTruthBadge(item) { return statusBadge(item.approval_status === "pending" ? item.status : item.approval_status); }
function renderGroundTruth() {
  $("ground-truth-table").innerHTML = groundTruths.length ? `<table><thead><tr><th>Candidate</th><th>Campaign</th><th>Status</th><th>Scope</th><th>Actions</th></tr></thead><tbody>${groundTruths.map((item) => `<tr><td><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(shortChecksum(item.sha256))}</small></td><td>${escapeHtml(item.campaign_name)}<small>${escapeHtml(item.campaign_id)}</small></td><td>${groundTruthBadge(item)}</td><td>${escapeHtml(item.approval_scope || "Not approved")}</td><td><button class="secondary" type="button" data-ground-truth-inspect="${escapeHtml(item.id)}">Inspect</button></td></tr>`).join("")}</tbody></table>` : '<div class="empty-state"><strong>No ground-truth candidates</strong><p>Complete managed adjudication to register an immutable candidate.</p></div>';
}

async function inspectGroundTruth(id) {
  const request = ++groundTruthRequest;
  groundTruthDetail = undefined; $("ground-truth-title").textContent = id; $("ground-truth-detail").textContent = "Loading…";
  if (!$("ground-truth-dialog").open) $("ground-truth-dialog").showModal();
  try {
    const item = (await api(`/ground-truth/${encodeURIComponent(id)}`)).data;
    let report = null, reportError = "";
    if (item.latest_validation_id) {
      try { report = await api(`/ground-truth/${id}/validations/${item.latest_validation_id}/report`); }
      catch (error) { reportError = error.message; }
    }
    if (request !== groundTruthRequest || !$("ground-truth-dialog").open) return;
    groundTruthDetail = item;
    const gates = report?.annotation_validation?.corpus_adequacy_gates || {}, counts = report?.annotation_validation?.counts;
    const errors = [...(reportError ? [reportError] : []), ...(report?.integrity?.errors || []), ...(report?.annotation_validation?.errors || [])];
    $("ground-truth-detail").innerHTML = `<section class="detail-section"><h3>Frozen inputs</h3><p>${groundTruthBadge(item)} · revision ${escapeHtml(item.revision)}</p><p>Campaign ${escapeHtml(item.campaign_name)}</p><p>Template <code>${escapeHtml(item.template_id)}</code></p><p>Candidate SHA-256 <code>${escapeHtml(item.sha256)}</code></p>${item.superseded_by_id ? `<p>Replaced by <code>${escapeHtml(item.superseded_by_id)}</code></p>` : ""}<div class="detail-actions"><button class="secondary" type="button" data-ground-truth-download>Download candidate</button><button class="secondary" type="button" data-ground-truth-policy>Read pinned policy</button></div></section><section class="detail-section"><h3>Latest validation</h3>${reportError ? `<p class="job-error">${escapeHtml(reportError)}</p>` : ""}${report ? `<p>${report.passed ? "Passed the diagnostic validation gates." : "Validation did not pass."}</p>${counts ? `<p>${escapeHtml(counts.sources)} sources · ${escapeHtml(counts.frames)} frames · ${escapeHtml(counts.non_person_objects)} non-person objects · ${escapeHtml(counts.non_person_classes)} non-person classes</p>` : ""}${Object.entries(gates).map(([gate, passed]) => `<p>${passed ? "✓" : "✕"} ${escapeHtml(gate.replaceAll("_", " "))}</p>`).join("")}${errors.map((error) => `<p class="job-error">${escapeHtml(error)}</p>`).join("")}` : '<p>No validation has been recorded.</p>'}</section><section class="detail-section"><h3>Validation history</h3>${item.validations.map((run) => `<p>${escapeHtml(formatDate(run.created_at))} · ${run.passed ? "Passed" : "Failed"} <button class="secondary" type="button" data-ground-truth-report="${escapeHtml(run.id)}">Inspect report</button></p>`).join("") || '<p class="muted">No reports.</p>'}</section><section class="detail-section"><h3>Decision history</h3>${item.decisions.map((decision) => `<p><strong>${escapeHtml(decision.decision)}</strong> · ${escapeHtml(decision.actor_reference)} · ${escapeHtml(formatDate(decision.created_at))}<br>${escapeHtml(decision.reason)}</p>`).join("") || '<p class="muted">No approval or rejection has been recorded.</p>'}</section><div class="detail-actions">${item.approval_status === "pending" ? `<button type="button" data-ground-truth-action="validate">Run validation</button>${item.status === "valid" && report?.passed ? '<button type="button" data-ground-truth-action="approve">Approve for diagnostic evaluation</button>' : ""}<button class="secondary danger" type="button" data-ground-truth-action="reject">Reject candidate</button>` : item.approval_status === "approved" ? '<button class="secondary" type="button" data-ground-truth-action="supersede">Supersede with approved version</button>' : ""}</div>`;
  } catch (error) { if (request === groundTruthRequest) $("ground-truth-detail").textContent = error.message; }
}

async function groundTruthAction(button) {
  if (!groundTruthDetail) return;
  const item = groundTruthDetail, action = button.dataset.groundTruthAction;
  if (button.hasAttribute("data-ground-truth-policy")) { await inspectRegistry("policies", item.policy_version_id); return; }
  if (button.hasAttribute("data-ground-truth-download")) {
    try {
      const response = await apiResponse(`/ground-truth/${item.id}/artifact`);
      if (!response.ok) throw new Error(`Candidate unavailable (${response.status})`);
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
      link.href = url; link.download = `${item.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { toast(error.message); }
    return;
  }
  if (button.dataset.groundTruthReport) {
    $("registry-title").textContent = "Validation report"; $("registry-detail").textContent = "Loading…"; $("registry-dialog").showModal();
    try { $("registry-detail").innerHTML = `<pre>${escapeHtml(prettyJson(await api(`/ground-truth/${item.id}/validations/${button.dataset.groundTruthReport}/report`)))}</pre>`; }
    catch (error) { $("registry-detail").textContent = error.message; }
    return;
  }
  if (action === "validate") {
    button.disabled = true;
    try { await api(`/ground-truth/${item.id}/validate`, { method: "POST", headers: { "content-type": "application/json", "if-match": String(item.revision) }, body: "{}" }); await inspectGroundTruth(item.id); await loadAll(); }
    catch (error) { toast(error.message); button.disabled = false; }
    return;
  }
  const form = $("ground-truth-decision-form"); form.reset(); form.querySelector(".form-status").textContent = "";
  form.dataset.id = item.id; form.dataset.revision = item.revision; form.dataset.action = action;
  $("ground-truth-decision-title").textContent = { approve: "Approve for diagnostic evaluation", reject: "Reject candidate", supersede: "Supersede approved version" }[action];
  $("ground-truth-decision-target").textContent = `${item.id} · revision ${item.revision} · SHA-256 ${item.sha256}`;
  $("ground-truth-approval-fields").hidden = action !== "approve"; $("ground-truth-attest").required = action === "approve";
  $("ground-truth-replacement-fields").hidden = action !== "supersede";
  const replacements = groundTruths.filter((replacement) => replacement.id !== item.id && replacement.template_id === item.template_id && replacement.status === "approved" && replacement.approval_status === "approved");
  $("ground-truth-replacement").innerHTML = replacements.length ? replacements.map((replacement) => `<option value="${escapeHtml(replacement.id)}">${escapeHtml(replacement.campaign_name)} · ${escapeHtml(replacement.id)}</option>`).join("") : '<option value="">No approved version over this template</option>';
  form.querySelector('[type="submit"]').disabled = action === "supersede" && !replacements.length;
  $("ground-truth-decision-dialog").showModal();
}

async function loadEvidence(frameSetId, frame) {
  const target = document.querySelector(`[data-evidence-id="${CSS.escape(frame.id)}"]`);
  if (!target) return;
  try {
    const response = await apiResponse(`/frame-sets/${encodeURIComponent(frameSetId)}/frames/${encodeURIComponent(frame.id)}/evidence`);
    if (!response.ok) throw new Error(`Evidence unavailable (${response.status})`);
    const url = URL.createObjectURL(await response.blob());
    if (!$("frame-set-dialog").open) { URL.revokeObjectURL(url); return; }
    evidenceUrls.push(url);
    target.innerHTML = `<img src="${url}" alt="Frame at ${escapeHtml(frame.timestamp_seconds)} seconds" loading="lazy">`;
  } catch (error) {
    target.innerHTML = `<span>${escapeHtml(error.message)}</span>`;
  }
}

async function inspectFrameSet(frameSetId) {
  const dialog = $("frame-set-dialog");
  clearEvidenceUrls();
  $("frame-set-dialog-title").textContent = frameSetId;
  $("frame-set-detail").innerHTML = '<div class="empty-state"><strong>Loading frame-set evidence…</strong></div>';
  dialog.showModal();
  try {
    const payload = await api(`/frame-sets/${encodeURIComponent(frameSetId)}`);
    const item = payload.data || payload;
    const sources = normaliseList(item.sources);
    const frames = normaliseList(item.frames);
    $("frame-set-detail").innerHTML = `<div class="detail-metrics"><div><small>Status</small>${statusBadge(item.status)}</div><div><small>Coverage</small><strong>${escapeHtml(item.frame_count)} frames / ${escapeHtml(item.source_count)} sources</strong></div><div><small>Engine</small><strong>${escapeHtml(item.engine?.name || "—")} ${escapeHtml(item.engine?.version || "")}</strong></div><div><small>Created</small><strong>${escapeHtml(formatDate(item.created_at))}</strong></div></div><div class="detail-actions"><button type="button" data-manifest-download="${escapeHtml(item.id)}">Download authenticated manifest</button></div><section class="detail-section"><h3>Integrity</h3><dl class="integrity-list"><div><dt>Manifest SHA-256</dt><dd><code>${escapeHtml(item.sha256 || "—")}</code></dd></div><div><dt>Configuration SHA-256</dt><dd><code>${escapeHtml(item.engine?.configuration_sha256 || "—")}</code></dd></div><div><dt>Dataset version</dt><dd>${escapeHtml(item.dataset_version_id || "—")}</dd></div><div><dt>Sampling job</dt><dd>${escapeHtml(item.sampling_job_id || "—")}</dd></div></dl></section><section class="detail-section"><h3>Source provenance</h3><div class="source-list">${sources.map((source) => `<article><strong>${escapeHtml(source.dataset_source_id)}</strong><span>Source ${escapeHtml(Number(source.ordinal) + 1)} · ${escapeHtml(source.duration_seconds)}s · ${escapeHtml(source.size_bytes)} bytes</span><code>${escapeHtml(source.source_sha256)}</code></article>`).join("") || '<p class="muted">No source records.</p>'}</div></section><section class="detail-section"><h3>Private frame evidence</h3><div class="evidence-grid">${frames.map((frame) => `<article><div class="evidence-image" data-evidence-id="${escapeHtml(frame.id)}"><span>Loading evidence…</span></div><div><strong>${escapeHtml(frame.timestamp_seconds)}s</strong><small>${escapeHtml(frame.reasons?.join(", ") || "Unspecified reason")}</small><code title="${escapeHtml(frame.artifact?.sha256 || "")}">${escapeHtml(shortChecksum(frame.artifact?.sha256))}</code></div></article>`).join("") || '<p class="muted">No frame records.</p>'}</div></section>`;
    frames.forEach((frame) => loadEvidence(item.id, frame));
  } catch (error) {
    $("frame-set-detail").innerHTML = `<div class="empty-state"><strong>Unable to load frame set</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function downloadManifest(frameSetId) {
  try {
    const response = await apiResponse(`/frame-sets/${encodeURIComponent(frameSetId)}/manifest`);
    if (!response.ok) throw new Error(`Manifest unavailable (${response.status})`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url; link.download = `${frameSetId}.manifest.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); }
}

function renderDatasets() {
  const query = $("dataset-filter").value.trim().toLowerCase();
  const filtered = datasets.filter((item) => `${item.name || ""} ${item.description || ""}`.toLowerCase().includes(query));
  if (!filtered.length) {
    $("datasets-table").innerHTML = `<div class="empty-state"><strong>${query ? "No matching datasets" : "No datasets yet"}</strong><p>${query ? "Try another filter." : "Create a dataset to begin the managed evaluation chain."}</p></div>`;
    return;
  }
  $("datasets-table").innerHTML = `<table><thead><tr><th>Name</th><th>Sources</th><th>Latest version</th><th>Status</th><th>Created</th></tr></thead><tbody>${filtered.map((item) => `<tr><td><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(item.description || item.id || "")}</small></td><td>${escapeHtml(item.source_count ?? item.latest_version?.source_count ?? "—")}</td><td><strong>${escapeHtml(item.latest_version?.version ? `v${item.latest_version.version}` : "—")}</strong><small>${escapeHtml(item.latest_version?.id || "")}</small></td><td>${statusBadge(item.latest_version?.status || item.status || "draft")}</td><td>${escapeHtml(formatDate(item.created_at))}</td></tr>`).join("")}</tbody></table>`;
}

function renderSampling() {
  $("sampling-summary").textContent = `${samplingJobs.length} scheduling record${samplingJobs.length === 1 ? "" : "s"}`;
  if (!samplingJobs.length) {
    $("sampling-table").innerHTML = '<div class="empty-state"><strong>No sampling jobs yet</strong><p>Schedule a durable record. A connected runner can claim it, or you can continue to use the legacy CLI.</p></div>';
    return;
  }
  $("sampling-table").innerHTML = `<table class="sampling-jobs"><thead><tr><th>Job</th><th>Dataset / method</th><th>Lifecycle</th><th>Runner</th><th>Created</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${samplingJobs.map((item) => {
    const status = item.status || "queued";
    const attempt = firstPresent(item, "attempt", "attempt_count", "attempts");
    const maxAttempts = firstPresent(item, "max_attempts");
    const runner = firstPresent(item, "runner_id", "lease_owner", "claimed_by", "worker_id") || firstPresent(item.lease, "runner_id", "owner", "holder");
    const leaseUntil = firstPresent(item, "lease_expires_at", "lease_until") || firstPresent(item.lease, "expires_at", "until");
    const action = ["queued", "running"].includes(status)
      ? `<button class="job-action danger" type="button" data-job-action="cancel" data-job-id="${escapeHtml(item.id)}">Cancel</button>`
      : ["failed", "cancelled"].includes(status)
        ? `<button class="job-action secondary" type="button" data-job-action="retry" data-job-id="${escapeHtml(item.id)}">Retry</button>`
        : "";
    const attemptLabel = attempt === null ? "No attempts recorded" : `Attempt ${escapeHtml(attempt)}${maxAttempts === null ? "" : ` of ${escapeHtml(maxAttempts)}`}`;
    return `<tr><td><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(item.id || "")}</small></td><td><strong>${escapeHtml(item.input?.dataset_version_id || "—")}</strong><small>${escapeHtml(item.input?.method || "—")}</small></td><td>${statusBadge(status)}<small>${attemptLabel}</small></td><td><strong>${escapeHtml(runner || "Unassigned")}</strong><small>${leaseUntil ? `Lease until ${escapeHtml(formatDate(leaseUntil))}` : "No active lease"}</small></td><td>${escapeHtml(formatDate(item.created_at))}</td><td class="actions"><button class="job-action secondary" type="button" data-job-inspect="${escapeHtml(item.id)}">Details</button>${action}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function prettyJson(value) {
  return value === null || value === undefined ? "—" : JSON.stringify(value, null, 2);
}

async function inspectJob(jobId) {
  $("job-dialog-title").textContent = jobId;
  $("job-detail").innerHTML = '<div class="empty-state"><strong>Loading job details…</strong></div>';
  $("job-dialog").showModal();
  try {
    const payload = await api(`/sampling-jobs/${encodeURIComponent(jobId)}`);
    const job = payload.data || payload;
    const attempts = normaliseList(job.attempts);
    const inputRows = Object.entries(job.input || {}).map(([key, value]) => `<div><dt>${escapeHtml(key.replaceAll("_", " "))}</dt><dd>${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</dd></div>`).join("");
    const attemptRows = attempts.map((attempt) => `<tr><td>${escapeHtml(attempt.attempt_number)}</td><td>${statusBadge(attempt.status)}</td><td>${escapeHtml(attempt.worker_id || "—")}</td><td>${escapeHtml(formatDate(attempt.started_at || attempt.leased_at))}</td><td>${escapeHtml(formatDate(attempt.finished_at))}</td><td>${escapeHtml(attempt.error_message || "—")}</td></tr>`).join("");
    $("job-detail").innerHTML = `<div class="detail-metrics"><div><small>Status</small>${statusBadge(job.status)}</div><div><small>Attempts</small><strong>${escapeHtml(job.attempt_count)} of ${escapeHtml(job.max_attempts)}</strong></div><div><small>Runner</small><strong>${escapeHtml(job.lease_owner || "—")}</strong></div><div><small>Created</small><strong>${escapeHtml(formatDate(job.created_at))}</strong></div></div><section class="detail-section"><h3>Configuration</h3><dl class="integrity-list">${inputRows}</dl></section><section class="detail-section"><h3>Lifecycle</h3><dl class="integrity-list"><div><dt>Started</dt><dd>${escapeHtml(formatDate(job.started_at))}</dd></div><div><dt>Completed</dt><dd>${escapeHtml(formatDate(job.completed_at))}</dd></div><div><dt>Last heartbeat</dt><dd>${escapeHtml(formatDate(job.heartbeat_at))}</dd></div><div><dt>Lease expires</dt><dd>${escapeHtml(formatDate(job.lease_expires_at))}</dd></div><div><dt>Cancellation requested</dt><dd>${escapeHtml(formatDate(job.cancellation_requested_at))}</dd></div><div><dt>Updated</dt><dd>${escapeHtml(formatDate(job.updated_at))}</dd></div></dl>${job.error_message ? `<p class="job-error"><strong>Latest error</strong><br>${escapeHtml(job.error_message)}</p>` : ""}</section><section class="detail-section"><h3>Attempt history</h3>${attempts.length ? `<div class="attempt-table"><table><thead><tr><th>#</th><th>Status</th><th>Runner</th><th>Started</th><th>Finished</th><th>Error</th></tr></thead><tbody>${attemptRows}</tbody></table></div>` : '<p class="muted">No attempts have been recorded.</p>'}</section>${job.progress ? `<section class="detail-section"><h3>Progress</h3><pre>${escapeHtml(prettyJson(job.progress))}</pre></section>` : ""}${job.output ? `<section class="detail-section"><h3>Output</h3><pre>${escapeHtml(prettyJson(job.output))}</pre></section>` : ""}`;
  } catch (error) {
    $("job-detail").innerHTML = `<div class="empty-state"><strong>Unable to load job details</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function runJobAction(button) {
  const { jobAction, jobId } = button.dataset;
  if (!jobAction || !jobId) return;
  button.disabled = true;
  try {
    await api(`/sampling-jobs/${encodeURIComponent(jobId)}/${jobAction}`, { method: "POST" });
    toast(jobAction === "cancel" ? "Cancellation requested." : "Sampling job queued for retry.");
    await loadAll();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}

function populateDatasetSelect() {
  const available = datasets.filter((item) => item.latest_version?.id && ["ready", "frozen"].includes(item.latest_version.status));
  $("sampling-dataset").innerHTML = available.length ? available.map((item) => `<option value="${escapeHtml(item.latest_version.id)}">${escapeHtml(item.name || item.id)} · v${escapeHtml(item.latest_version.version || 1)} · ${escapeHtml(item.latest_version.status)}</option>`).join("") : '<option value="">No ready or frozen dataset versions</option>';
  $("sampling-dataset").disabled = !available.length;
  $("sampling-form").querySelector('[type="submit"]').disabled = !available.length;
}

function parseSourceUrls(value) {
  const sources = value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  if (!sources.length) throw new Error("Enter at least one source video URL.");
  for (const url of sources) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`Invalid source URL: ${url}`); }
    if (parsed.protocol !== "https:") throw new Error(`Source URLs must use HTTPS: ${url}`);
  }
  return sources.map((url) => ({ url }));
}

async function loadAll() {
  const results = await Promise.allSettled([api("/overview"), api("/datasets"), api("/sampling-jobs"), listAll("/frame-sets"), api("/runners"), listAll("/policies"), listAll("/templates"), listAll("/review-campaigns"), listAll("/ground-truth"), listAll("/pipelines"), api("/reviewers")]);
  if (results[0].status === "rejected" && results[0].reason.message.match(/401|403|unauth|forbid/i)) throw results[0].reason;
  datasets = results[1].status === "fulfilled" ? normaliseList(results[1].value, "data", "datasets", "items") : [];
  samplingJobs = results[2].status === "fulfilled" ? normaliseList(results[2].value, "data", "sampling_jobs", "jobs", "items") : [];
  frameSets = results[3].status === "fulfilled" ? normaliseList(results[3].value, "data", "frame_sets", "items") : [];
  if (results[4].status === "fulfilled") runnerPresence = results[4].value.data || runnerPresence;
  policies = results[5].status === "fulfilled" ? normaliseList(results[5].value, "data") : [];
  templates = results[6].status === "fulfilled" ? normaliseList(results[6].value, "data") : [];
  campaigns = results[7].status === "fulfilled" ? normaliseList(results[7].value, "data") : [];
  groundTruths = results[8].status === "fulfilled" ? normaliseList(results[8].value, "data") : [];
  pipelines = results[9].status === "fulfilled" ? normaliseList(results[9].value, "data") : [];
  eligibleAssignees = results[10].status === "fulfilled" ? normaliseList(results[10].value, "data") : [];
  if (currentUser?.roles?.includes("owner")) {
    try {
      internalUsers = normaliseList(await api("/users"), "data");
      $("identity-admin-panel").hidden = false;
      renderUsers();
    } catch (error) {
      $("identity-admin-panel").hidden = true;
      toast(`Could not load identity administration: ${error.message}`);
    }
  } else {
    $("identity-admin-panel").hidden = true;
  }
  renderOverview(results[0].status === "fulfilled" ? results[0].value : {});
  renderGroundTruth(); renderCampaigns(); renderPipelines(); renderRegistry(); renderRunnerPresence(); renderDatasets(); renderSampling(); renderFrameSets(); populateDatasetSelect();
  renderOverviewPipelines();
  await loadGovernance({ api, apiResponse, escapeHtml, prettyJson, toast, refresh: loadAll, user: currentUser, engines: results[0].status === "fulfilled" ? results[0].value.engines : {} });
  const unavailable = results.filter((item) => item.status === "rejected").length;
  if (unavailable) toast(`${unavailable} control-plane resource${unavailable === 1 ? " is" : "s are"} not available yet.`);
}

async function acceptSession() {
  currentUser = (await api("/auth/me")).data;
  setConnected(true);
  await loadAll();
}

async function initialiseAuth() {
  const mode = (await api("/auth/status")).data.authentication;
  const params = new URLSearchParams(location.hash.slice(1));
  const authToken = params.get("auth-token");
  if (authToken) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    try {
      await api("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: authToken }) });
      await acceptSession();
      return;
    } catch (error) {
      $("login-status").textContent = error.message;
    }
  }
  const legacyMode = mode === "administrator_token";
  $("login-eyebrow").textContent = legacyMode ? "Administrator access" : "Named account access";
  $("login-instructions").textContent = legacyMode
    ? "Enter the administrator token. Access lasts for this browser session, up to 12 hours."
    : "Use your verified email address. We will send a one-time sign-in link.";
  $("legacy-login-form").hidden = !legacyMode;
  $("login-form").hidden = legacyMode;
  $("bootstrap-form").hidden = legacyMode;
  $("bootstrap-note").hidden = legacyMode;
  if (legacyMode) {
    try {
      await api("/overview");
      currentUser = { email: "Administrator token", roles: ["owner"] };
      setConnected(true);
      await loadAll();
    } catch (error) {
      if (!/401|unauthor/i.test(error.message)) $("legacy-login-status").textContent = error.message;
      setConnected(false);
    }
    return;
  }

  try {
    await acceptSession();
  } catch (error) {
    if (/network|fetch/i.test(error.message)) $("login-status").textContent = error.message;
  }
  const setup = await api("/auth/status");
  const available = setup.data.bootstrap_available;
  $("bootstrap-form").hidden = !available;
  $("bootstrap-note").hidden = !available;
}

async function requestSignIn(event) {
  event.preventDefault();
  const submit = $("login-form").querySelector('[type="submit"]');
  submit.disabled = true;
  $("login-status").textContent = "Sending sign-in link…";
  try {
    await api("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("login-email").value.trim() }) });
    $("login-status").textContent = "If the address belongs to a verified account, a sign-in link has been sent.";
  } catch (error) {
    $("login-status").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function bootstrapOwner(event) {
  event.preventDefault();
  const form = $("bootstrap-form"), submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  $("bootstrap-status").textContent = "Creating owner account…";
  try {
    await api("/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${$("bootstrap-token").value}` },
      body: JSON.stringify({ email: $("bootstrap-email").value.trim(), display_name: $("bootstrap-name").value.trim() }),
    });
    $("bootstrap-status").textContent = "Verification email sent. Follow its link to finish setup.";
    form.reset();
    form.hidden = true;
    $("bootstrap-note").hidden = true;
  } catch (error) {
    $("bootstrap-status").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function connectLegacyAdministrator(event) {
  event.preventDefault();
  const form = $("legacy-login-form"), submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  $("legacy-login-status").textContent = "Checking administrator access…";
  legacyToken = $("legacy-admin-token").value;
  try {
    await api("/auth/admin-session", { method: "POST" });
    legacyToken = null;
    await api("/overview");
    currentUser = { email: "Administrator token", roles: ["owner"] };
    form.reset();
    setConnected(true);
    await loadAll();
  } catch (error) {
    legacyToken = null;
    $("legacy-login-status").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function submitForm(form, path, body) {
  const status = form.querySelector(".form-status");
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true; status.textContent = "Saving…";
  try {
    await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    form.closest("dialog").close(); form.reset(); toast("Saved successfully."); await loadAll();
  } catch (error) { status.textContent = error.message; }
  finally { submit.disabled = form.id === "sampling-form" ? $("sampling-dataset").disabled : form.id === "template-form" && (!$("template-frame-set").value || !$("template-policy").value); }
}

$("login-form").addEventListener("submit", requestSignIn);
$("legacy-login-form").addEventListener("submit", connectLegacyAdministrator);
$("bootstrap-form").addEventListener("submit", bootstrapOwner);
$("sign-out").onclick = async () => {
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $("invitation-links").replaceChildren();
  try { await api("/auth/logout", { method: "POST" }); }
  finally { currentUser = null; internalUsers = []; setConnected(false); }
  legacyToken = null;
};
$("internal-user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget, submit = form.querySelector('[type="submit"]'), status = $("internal-user-status");
  submit.disabled = true; status.textContent = "Sending invitation…";
  const roles = Array.from($("internal-user-roles").selectedOptions, (option) => option.value);
  try {
    await api("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("internal-user-email").value.trim(), display_name: $("internal-user-name").value.trim(), roles }) });
    form.reset(); status.textContent = "Invitation sent."; internalUsers = normaliseList(await api("/users"), "data"); renderUsers();
  } catch (error) { status.textContent = error.message; }
  finally { submit.disabled = false; }
});
$("internal-users-table").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-resend-invitation]");
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/users/${encodeURIComponent(button.dataset.resendInvitation)}/resend`, { method: "POST" });
    toast("Verification invitation resent.");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$("menu-toggle").onclick = () => { const open = document.body.classList.toggle("menu-open"); $("menu-toggle").setAttribute("aria-expanded", String(open)); };
window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));
document.querySelectorAll("[data-route-link]").forEach((link) => link.onclick = () => showPage(link.dataset.routeLink));
document.querySelectorAll("[data-refresh]").forEach((button) => button.onclick = () => loadAll().catch((error) => toast(error.message)));
document.querySelectorAll("[data-dialog-open]").forEach((button) => button.onclick = () => $(button.dataset.dialogOpen).showModal());
document.querySelectorAll("[data-dialog-close]").forEach((button) => button.onclick = () => button.closest("dialog").close());
$("dataset-filter").addEventListener("input", renderDatasets);
$("frame-set-filter").addEventListener("input", renderFrameSets);
$("sampling-table").addEventListener("click", (event) => {
  const inspect = event.target.closest("[data-job-inspect]");
  if (inspect) { inspectJob(inspect.dataset.jobInspect); return; }
  const button = event.target.closest("[data-job-action]");
  if (button) runJobAction(button);
});
$("frame-sets-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-frame-set-id]");
  if (button) inspectFrameSet(button.dataset.frameSetId);
});
$("frame-set-detail").addEventListener("click", (event) => {
  const button = event.target.closest("[data-manifest-download]");
  if (button) downloadManifest(button.dataset.manifestDownload);
});
$("frame-set-dialog").addEventListener("close", clearEvidenceUrls);
$("ground-truth-dialog").addEventListener("close", () => { groundTruthRequest++; groundTruthDetail = undefined; });
$("ground-truth-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-ground-truth-inspect]"); if (button) inspectGroundTruth(button.dataset.groundTruthInspect);
});
$("ground-truth-detail").addEventListener("click", (event) => {
  const button = event.target.closest("[data-ground-truth-action], [data-ground-truth-report], [data-ground-truth-download], [data-ground-truth-policy]"); if (button) groundTruthAction(button);
});
$("ground-truth-decision-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  const data = Object.fromEntries(new FormData(form)), { id, revision, action } = form.dataset;
  if (action === "approve") { data.scope = "diagnostic"; data.attestations = { policy_reviewed: $("ground-truth-attest").checked, independent_humans_confirmed: $("ground-truth-attest").checked, predictions_unseen_confirmed: $("ground-truth-attest").checked, licensing_scope_confirmed: $("ground-truth-attest").checked }; }
  if (action === "supersede") data.replacement_id = $("ground-truth-replacement").value;
  try {
    await api(`/ground-truth/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json", "if-match": revision }, body: JSON.stringify(data) });
    form.closest("dialog").close(); await inspectGroundTruth(id); await loadAll(); toast("Decision recorded.");
  } catch (error) { form.querySelector(".form-status").textContent = error.message; }
  finally { submit.disabled = false; }
});
$("invitations-dialog").addEventListener("close", () => $("invitation-links").replaceChildren());
$("campaigns-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-campaign-inspect]"); if (button) inspectCampaign(button.dataset.campaignInspect);
});
$("pipelines-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-pipeline-inspect]");
  if (button) inspectPipeline(button.dataset.pipelineInspect);
});
$("overview-pipelines").addEventListener("click", (event) => {
  const button = event.target.closest("[data-overview-pipeline]");
  if (button) inspectPipeline(button.dataset.overviewPipeline);
});
$("pipeline-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget, submit = form.querySelector('[type="submit"]'), status = form.querySelector(".form-status");
  submit.disabled = true; status.textContent = "Creating pipeline…";
  try {
    const payload = await api("/pipelines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.closest("dialog").close(); form.reset(); await loadAll(); showPage("pipelines"); renderPipelineDetail(payload.data);
    toast("Pipeline created.");
  } catch (error) { status.textContent = error.message; }
  finally { submit.disabled = false; }
});
$("pipeline-detail").addEventListener("submit", async (event) => {
  if (event.target.id !== "pipeline-resource-form") return;
  event.preventDefault();
  const form = event.target, submit = form.querySelector('[type="submit"]'), status = form.querySelector(".form-status");
  submit.disabled = true; status.textContent = "Linking resource…";
  try {
    const payload = await api(`/pipelines/${encodeURIComponent(selectedPipelineId)}/resources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    pipelines = pipelines.map((pipeline) => pipeline.id === selectedPipelineId ? payload.data : pipeline);
    renderPipelines(); renderPipelineDetail(payload.data); toast("Resource linked.");
  } catch (error) { status.textContent = error.message; }
  finally { submit.disabled = false; }
});
$("pipeline-detail").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-pipeline-unlink-type]");
  if (!button) return;
  button.disabled = true;
  try {
    const path = `/pipelines/${encodeURIComponent(selectedPipelineId)}/resources/${encodeURIComponent(button.dataset.pipelineUnlinkType)}/${encodeURIComponent(button.dataset.pipelineUnlinkId)}`;
    const payload = await api(path, { method: "DELETE" });
    pipelines = pipelines.map((pipeline) => pipeline.id === selectedPipelineId ? payload.data : pipeline);
    renderPipelines(); renderPipelineDetail(payload.data); toast("Resource unlinked.");
  } catch (error) { toast(error.message); button.disabled = false; }
});
$("campaign-detail").addEventListener("click", (event) => {
  const button = event.target.closest("[data-assignment-action], [data-campaign-cancel], [data-campaign-result]"); if (button) campaignAction(button);
});
$("campaign-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('[type="submit"]'), status = form.querySelector(".form-status");
  submit.disabled = true; status.textContent = "Creating campaign…";
  try {
    const data = Object.fromEntries(new FormData(form)); data.expires_in_hours = Number(data.expires_in_hours); data.issue_tokens = false;
    const fingerprint = JSON.stringify(data);
    if (!form.dataset.requestKey || form.dataset.requestFingerprint !== fingerprint) { form.dataset.requestKey = crypto.randomUUID(); form.dataset.requestFingerprint = fingerprint; }
    data.idempotency_key = form.dataset.requestKey;
    const payload = await api("/review-campaigns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    delete form.dataset.requestKey; delete form.dataset.requestFingerprint; form.closest("dialog").close(); form.reset();
    await loadAll();
    await inspectCampaign(payload.data.id);
    toast(payload.meta?.deduplicated ? payload.warning : "Campaign created. Generate job tokens from the assignment section.");
  } catch (error) { status.textContent = error.message; }
  finally { submit.disabled = !$("campaign-template").value; }
});
$("policies-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-policy-inspect]");
  if (button) inspectRegistry("policies", button.dataset.policyInspect);
});
$("templates-table").addEventListener("click", (event) => {
  const inspect = event.target.closest("[data-template-inspect]");
  if (inspect) inspectRegistry("templates", inspect.dataset.templateInspect);
  const download = event.target.closest("[data-template-download]");
  if (download) downloadTemplate(download.dataset.templateDownload);
});
$("policy-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = { ...Object.fromEntries(new FormData(event.currentTarget)), annotation_schema_version: "object-annotations.v1" };
  const rules = {};
  for (const [id, key] of [["policy-labels", "allowed_labels"], ["policy-subsets", "allowed_subsets"]]) if ($(id).value.trim()) rules[key] = $(id).value.split(",").map((value) => value.trim()).filter(Boolean);
  if ($("policy-object-limit").value) rules.max_objects_per_frame = Number($("policy-object-limit").value);
  if (Object.keys(rules).length) data.annotation_rules = rules;
  if ($("policy-validation").value) data.validation_profile = { id: $("policy-validation").value, source_sha256: $("policy-profile-sources").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) };
  submitForm(event.currentTarget, "/policies", data);
});
function syncPolicyProfile() { const selected = Boolean($("policy-validation").value); $("policy-profile-fields").hidden = !selected; $("policy-profile-sources").disabled = !selected; $("policy-profile-sources").required = selected; }
$("policy-validation").addEventListener("change", syncPolicyProfile);
$("policy-form").addEventListener("reset", () => queueMicrotask(syncPolicyProfile));
$("policy-corpus-frame-set").addEventListener("change", async () => {
  const id = $("policy-corpus-frame-set").value; if (!id) return;
  try { const manifest = await api(`/frame-sets/${encodeURIComponent(id)}/manifest`); if (manifest.sources?.length !== 5) throw new Error("This profile requires five distinct source videos."); $("policy-profile-sources").value = manifest.sources.map((source) => source.source_sha256).join("\n"); }
  catch (error) { $("policy-form").querySelector(".form-status").textContent = error.message; }
});
$("template-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, "/templates", { ...Object.fromEntries(new FormData(event.currentTarget)), annotation_schema_version: "object-annotations.v1" });
});
$("dataset-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try { data.sources = parseSourceUrls(data.sources); }
  catch (error) { form.querySelector(".form-status").textContent = error.message; return; }
  submitForm(form, "/datasets", data);
});
$("sampling-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  data.scene_threshold = Number(data.scene_threshold); data.interval_seconds = Number(data.interval_seconds); data.max_frames = Number(data.max_frames); data.include_final_frame = data.include_final_frame === "true";
  if (data.method === "scene") delete data.interval_seconds;
  if (data.method === "interval") delete data.scene_threshold;
  submitForm(event.currentTarget, "/sampling-jobs", data);
});

showPage(location.hash.slice(1));
setConnected(false);
initialiseAuth().catch((error) => {
  $("login-status").textContent = error.message;
  setConnected(false);
});
