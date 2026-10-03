/** @type implementation @purpose Drive the internal control-plane workspace. */
const $ = (id) => document.getElementById(id);
const API = "/api/internal/v1";
let token = sessionStorage.getItem("internals-admin-token") || "";
let datasets = [];
let samplingJobs = [];

function normaliseList(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { accept: "application/json", ...options.headers, authorization: `Bearer ${token}` },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || result.error || `Request failed (${response.status})`);
  return result;
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
  const valid = ["overview", "datasets", "sampling"];
  if (!valid.includes(name)) name = "overview";
  document.querySelectorAll(".page").forEach((page) => { page.hidden = page.dataset.page !== name; });
  document.querySelectorAll("nav [data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === name));
  $("page-title").textContent = { overview: "Overview", datasets: "Datasets", sampling: "Sampling jobs" }[name];
  document.body.classList.remove("menu-open");
  $("menu-toggle").setAttribute("aria-expanded", "false");
}

function renderOverview(payload = {}) {
  const metrics = payload.metrics || payload.counts || {};
  const values = [
    ["Datasets", metrics.datasets ?? datasets.length, "Registered source collections"],
    ["Sampling jobs", metrics.sampling_jobs ?? samplingJobs.length, "Durable scheduling records"],
    ["Active reviews", metrics.active_reviews ?? metrics.reviews ?? "—", "Focused assignments"],
    ["Pipeline releases", metrics.pipeline_releases ?? metrics.releases ?? "—", "Governed configurations"],
  ];
  $("overview-cards").innerHTML = values.map(([label, value, detail]) => `<article class="metric"><small>${label}</small><strong>${escapeHtml(value)}</strong><small>${detail}</small></article>`).join("");
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
  const results = await Promise.allSettled([api("/overview"), api("/datasets"), api("/sampling-jobs")]);
  if (results[0].status === "rejected" && results[0].reason.message.match(/401|403|unauth|forbid/i)) throw results[0].reason;
  datasets = results[1].status === "fulfilled" ? normaliseList(results[1].value, "data", "datasets", "items") : [];
  samplingJobs = results[2].status === "fulfilled" ? normaliseList(results[2].value, "data", "sampling_jobs", "jobs", "items") : [];
  renderOverview(results[0].status === "fulfilled" ? results[0].value : {});
  renderDatasets(); renderSampling(); populateDatasetSelect();
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
$("sampling-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-job-action]");
  if (button) runJobAction(button);
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
$("admin-token").value = token;
if (token) connect().catch((error) => { $("login-status").textContent = error.message; setConnected(false); });
else setConnected(false);
