/** @type implementation @purpose Drive the internal control-plane workspace. */
const $ = (id) => document.getElementById(id);
const API = "/api/internal/v1";
let token = sessionStorage.getItem("internals-admin-token") || "";
let datasets = [];
let samplingJobs = [];
let frameSets = [];
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
  return fetch(`${API}${path}`, {
    ...options,
    headers: { accept: "application/json", ...options.headers, authorization: `Bearer ${token}` },
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
  $("connection").innerHTML = `<span></span>${connected ? " Administrator session" : " Not connected"}`;
}

function showPage(name) {
  const valid = ["overview", "datasets", "sampling", "frame-sets"];
  if (!valid.includes(name)) name = "overview";
  document.querySelectorAll(".page").forEach((page) => { page.hidden = page.dataset.page !== name; });
  document.querySelectorAll("nav [data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === name));
  $("page-title").textContent = { overview: "Overview", datasets: "Datasets", sampling: "Sampling jobs", "frame-sets": "Frame sets" }[name];
  document.body.classList.remove("menu-open");
  $("menu-toggle").setAttribute("aria-expanded", "false");
}

function renderOverview(payload = {}) {
  const metrics = payload.metrics || payload.counts || {};
  const values = [
    ["Datasets", metrics.datasets ?? datasets.length, "Registered source collections"],
    ["Sampling jobs", metrics.sampling_jobs ?? samplingJobs.length, "Durable scheduling records"],
    ["Frame sets", metrics.frame_sets ?? frameSets.length, "Immutable sampling outputs"],
    ["Active reviews", metrics.active_reviews ?? metrics.reviews ?? "—", "Focused assignments"],
  ];
  $("overview-cards").innerHTML = values.map(([label, value, detail]) => `<article class="metric"><small>${label}</small><strong>${escapeHtml(value)}</strong><small>${detail}</small></article>`).join("");
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
    return `<tr><td><strong>${escapeHtml(item.name || item.id)}</strong><small>${escapeHtml(item.id || "")}</small></td><td><strong>${escapeHtml(item.input?.dataset_version_id || "—")}</strong><small>${escapeHtml(item.input?.method || "—")}</small></td><td>${statusBadge(status)}<small>${attemptLabel}</small></td><td><strong>${escapeHtml(runner || "Unassigned")}</strong><small>${leaseUntil ? `Lease until ${escapeHtml(formatDate(leaseUntil))}` : "No active lease"}</small></td><td>${escapeHtml(formatDate(item.created_at))}</td><td class="actions">${action}</td></tr>`;
  }).join("")}</tbody></table>`;
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
  const results = await Promise.allSettled([api("/overview"), api("/datasets"), api("/sampling-jobs"), api("/frame-sets")]);
  if (results[0].status === "rejected" && results[0].reason.message.match(/401|403|unauth|forbid/i)) throw results[0].reason;
  datasets = results[1].status === "fulfilled" ? normaliseList(results[1].value, "data", "datasets", "items") : [];
  samplingJobs = results[2].status === "fulfilled" ? normaliseList(results[2].value, "data", "sampling_jobs", "jobs", "items") : [];
  frameSets = results[3].status === "fulfilled" ? normaliseList(results[3].value, "data", "frame_sets", "items") : [];
  renderOverview(results[0].status === "fulfilled" ? results[0].value : {});
  renderDatasets(); renderSampling(); renderFrameSets(); populateDatasetSelect();
  const unavailable = results.filter((item) => item.status === "rejected").length;
  if (unavailable) toast(`${unavailable} control-plane resource${unavailable === 1 ? " is" : "s are"} not available yet.`);
}

async function connect() {
  token = $("admin-token").value.trim() || token;
  if (!token) throw new Error("An administrator token is required.");
  $("login-status").textContent = "Connecting…";
  await api("/overview");
  sessionStorage.setItem("internals-admin-token", token);
  setConnected(true);
  await loadAll();
}

async function submitForm(form, path, body) {
  const status = form.querySelector(".form-status");
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true; status.textContent = "Saving…";
  try {
    await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    form.closest("dialog").close(); form.reset(); toast("Saved successfully."); await loadAll();
  } catch (error) { status.textContent = error.message; }
  finally { submit.disabled = form.id === "sampling-form" && $("sampling-dataset").disabled; }
}

$("login-form").addEventListener("submit", (event) => { event.preventDefault(); connect().catch((error) => { $("login-status").textContent = error.message; setConnected(false); }); });
$("sign-out").onclick = () => { sessionStorage.removeItem("internals-admin-token"); token = ""; $("admin-token").value = ""; setConnected(false); };
$("menu-toggle").onclick = () => { const open = document.body.classList.toggle("menu-open"); $("menu-toggle").setAttribute("aria-expanded", String(open)); };
window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));
document.querySelectorAll("[data-route-link]").forEach((link) => link.onclick = () => showPage(link.dataset.routeLink));
document.querySelectorAll("[data-refresh]").forEach((button) => button.onclick = () => loadAll().catch((error) => toast(error.message)));
document.querySelectorAll("[data-dialog-open]").forEach((button) => button.onclick = () => $(button.dataset.dialogOpen).showModal());
document.querySelectorAll("[data-dialog-close]").forEach((button) => button.onclick = () => button.closest("dialog").close());
$("dataset-filter").addEventListener("input", renderDatasets);
$("frame-set-filter").addEventListener("input", renderFrameSets);
$("sampling-table").addEventListener("click", (event) => {
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
$("admin-token").value = token;
if (token) connect().catch((error) => { $("login-status").textContent = error.message; setConnected(false); });
else setConnected(false);
