/** @type implementation @purpose Operator forms for evaluation, model registration, releases, and operations. */
let context, models = [], releases = [], evaluations = [], truths = [], cleanupCandidates = [], cleanupCursor = null;
const $ = (id) => document.getElementById(id);
const jsonView = (value) => `<pre>${context.escapeHtml(context.prettyJson(value))}</pre>`;
const field = (name, label, type = "text", extra = "") => `<label>${label}<input name="${name}" type="${type}" required ${extra}></label>`;
const select = (name, label, items, filter = () => true) => `<label>${label}<select name="${name}" required><option value="">Select…</option>${items.filter(filter).map((item) => `<option value="${context.escapeHtml(item.id)}">${context.escapeHtml([item.name, item.version || item.id].filter(Boolean).join(" · "))} · ${context.escapeHtml(item.status || "")}</option>`).join("")}</select></label>`;
const form = (id, title, content, submit) => `<form id="${id}" class="panel"><h3>${title}</h3>${content}<p class="form-status" role="status"></p><button type="submit">${submit}</button></form>`;
async function all(path) {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await context.api(`${path}?limit=100&offset=${offset}`)).data;
    items.push(...page);
    if (page.length < 100) return items;
  }
}
const thresholds = field("minimum_confidence", "Minimum confidence", "number", 'min="0" max="1" step="0.01" value="0.35"') + field("nms_threshold", "NMS threshold", "number", 'min="0" max="1" step="0.01" value="0.6"') + field("minimum_iou", "Minimum overlap (IoU)", "number", 'min="0" max="1" step="0.01" value="0.5"');
function list(items, collection) {
  const e = context.escapeHtml;
  return `<div class="panel table-panel"><table><thead><tr><th>Reference</th><th>Status</th><th>Created</th><th>Inspect</th></tr></thead><tbody>${items.map((item) => `<tr><td>${e([item.name, item.version || item.id].filter(Boolean).join(" · "))}<small>${e(item.id)}</small></td><td>${e(item.approval_status === "rejected" ? "rejected" : item.status)}</td><td>${e(item.created_at || "")}</td><td><button type="button" data-governance-inspect="${collection}" data-id="${e(item.id)}">Details</button></td></tr>`).join("") || '<tr><td colspan="4">No records yet.</td></tr>'}</tbody></table></div><div id="${collection}-inspection"></div>`;
}
export async function loadGovernance(value) {
  context = value;
  const results = await Promise.allSettled([all("/models"), all("/releases"), all("/evaluations"), all("/ground-truth"), context.api("/operations"), context.api("/reference-benchmarks")]);
  [models, releases, evaluations, truths] = results.slice(0,4).map((result) => result.status === "fulfilled" ? result.value : []);
  const roles = context.user?.roles;
  const can = (role) => !Array.isArray(roles) || roles.includes("owner") || roles.includes(role);
  $("models-workspace").innerHTML = list(models, "models") + (can("researcher") ? form("model-register", "Register model version", field("name", "Model name", "text", 'maxlength="120"') + field("version", "Version", "text", 'maxlength="80"') + field("license", "License / permitted use", "text", 'maxlength="1000"') + field("source", "Source and provenance", "text", 'maxlength="2000"') + field("implementation_version", "Implementation version", "text", 'maxlength="200"') + field("model_file", "NanoDet Plus 1.5x 416 ONNX model (up to 16 MiB)", "file", 'accept=".onnx"'), "Register candidate") : "");
  $("evaluations-workspace").innerHTML = list(evaluations, "evaluations") + (can("researcher") || can("operator") ? form("evaluation-create", "Schedule diagnostic evaluation", select("ground_truth_version_id", "Approved ground truth", truths, (item) => item.status === "approved" && item.approval_status === "approved") + select("model_version_id", "Model version", models, (item) => ["candidate", "validated", "approved", "production"].includes(item.status)) + '<label>Pipeline release (optional)<select name="pipeline_release_id"><option value="">Model only</option>' + releases.filter((item) => ["candidate", "approved", "active"].includes(item.status)).map((item) => `<option value="${context.escapeHtml(item.id)}">${context.escapeHtml(item.version)}</option>`).join("") + '</select></label>' + thresholds, "Queue evaluation") : "") + form("evaluation-compare", "Compare successful evaluations", select("baseline_id", "Baseline", evaluations, (item) => item.status === "succeeded") + select("candidate_id", "Candidate", evaluations, (item) => item.status === "succeeded"), "Compare") + '<div id="evaluation-comparison"></div>';
  $("releases-workspace").innerHTML = list(releases, "releases") + (can("researcher") ? form("release-create", "Create release candidate", field("version", "Release version", "text", 'maxlength="80"') + select("model_version_id", "Approved model", models, (item) => ["approved", "production"].includes(item.status)) + field("sampler", "Sampler implementation", "text", `readonly value="${context.escapeHtml(context.engines?.sampler || "")}"`) + thresholds + field("minimum_f1", "Required minimum F1", "number", 'min="0" max="1" step="0.01" value="0.8"') + field("maximum_p95_inference_ms", "Maximum p95 inference time (ms)", "number", 'min="0.001" step="0.001" value="100"'), "Create candidate") : "");
  $("operations-workspace").innerHTML = results[4].status === "fulfilled" ? `<div class="panel"><h3>Job and artifact health</h3>${jsonView(results[4].value.data)}</div><div class="panel"><h3>Unregistered object cleanup</h3><p>Preview unregistered objects older than seven days. Referenced artifacts and active uploads are retained.</p><button type="button" data-cleanup-preview>Preview candidates</button><div id="cleanup-preview"></div></div>` : '<p role="status">Operations unavailable for this account or deployment.</p>';
  if (results[4].status === "fulfilled") {
    const retention = document.createElement("section"); retention.id = "retention-workspace"; retention.className = "panel";
    $("operations-workspace").append(retention); await loadRetention();
  }
  if (results[5].status === "fulfilled" && results[5].value.data?.coco) {
    const report = results[5].value.data, panel = document.createElement("section"); panel.className = "panel";
    const pct = (number) => typeof number === "number" ? `${(number * 100).toFixed(1)}%` : "Unavailable";
    panel.innerHTML = `<h3>Recorded reference benchmark · ${context.escapeHtml(report.recorded_date)}</h3><p>${report.coco.selection.count} COCO validation images. Coverage-selected diagnostic subset. These local results do not approve a production model.</p><div class="table-scroll" role="region" tabindex="0" aria-label="Reference model comparison"><table><thead><tr><th>Model</th><th>mAP 50–95</th><th>Precision</th><th>Recall</th><th>F1</th><th>CPU p95</th><th>Peak process memory</th></tr></thead><tbody>${report.coco.models.map((model) => `<tr><td>${context.escapeHtml(model.engine)}</td><td>${pct(model.metrics.map_50_95)}</td><td>${pct(model.metrics.precision_at_035)}</td><td>${pct(model.metrics.recall_at_035)}</td><td>${pct(model.metrics.f1_at_035)}</td><td>${model.timing.p95_ms.toFixed(1)} ms</td><td>${model.timing.peak_process_rss_mib.toFixed(0)} MiB</td></tr>`).join("")}</tbody></table></div><p>Precision, recall and F1 use confidence 0.35 and IoU 0.5. Timing uses AP confidence 0.001 and includes preprocessing and postprocessing on the recorded CPU environment.</p><p>Video benchmark: ${report.video.sources.length} sources, ${report.video.frame_count} frames; independent review pending. Extended-class accuracy is not established.</p><button type="button" data-governance-download="/reference-benchmarks">Download provenance and class-level results</button>`;
    $("evaluations-workspace").append(panel);
  }
  for (const [index, collection] of ["models", "releases", "evaluations"].entries()) if (results[index].status === "rejected") $(`${collection}-workspace`).prepend(Object.assign(document.createElement("p"), { textContent: `Could not load ${collection}: ${results[index].reason.message}` }));
}
async function loadRetention() {
  const target = $("retention-workspace"), e = context.escapeHtml;
  try {
    const [preview, archives, pins] = await Promise.all([context.api("/operations/retention"), context.api("/operations/retention/archives"), context.api("/operations/retention/pins")]);
    const policy = preview.data.policy;
    target.innerHTML = `<h3>Archive and reclaim unused media</h3><p>Checked every six hours. Compact annotations and history remain available; deleted media requires verified originals to replay. Active work, approved ground truth and retained evaluation evidence are protected.</p>`
      + form("retention-settings", "Retention policy", field("stale_days", "Unused age (days)", "number", `min="7" max="365" value="${policy.stale_days}"`) + field("grace_days", "Archive grace period (days)", "number", `min="1" max="90" value="${policy.grace_days}"`), "Save policy")
      + form("retention-pin", "Keep a benchmark or model", '<label>Resource type<select name="resource_type"><option value="frame_set">Frame set</option><option value="model_version">Model version</option></select></label>' + field("resource_id", "Resource ID", "text", 'maxlength="100"') + field("reason", "Why keep it?", "text", 'maxlength="2000"'), "Pin resource")
      + `<h4>Protected resources</h4>${pins.data.map((pin) => `<p>${e(pin.resource_id)} · ${e(pin.reason)} <button type="button" data-retention-unpin="${e(pin.resource_id)}" data-kind="${e(pin.resource_type)}">Remove pin</button></p>`).join("") || '<p>No explicit pins. Required dependencies remain protected.</p>'}`
      + '<h4>Eligible unused resources</h4><label>Archival reason<input id="retention-reason" maxlength="2000" value="Unused resource; preserve audit record and reclaim media."></label>'
      + `<div class="table-scroll" tabindex="0" role="region" aria-label="Retention candidates"><table><thead><tr><th>Resource</th><th>Reclaimable bytes</th><th>Action</th></tr></thead><tbody>${preview.data.candidates.map((item) => `<tr><td>${e(item.id)}<small>${e(item.resource_type)}</small></td><td>${item.reclaimable_bytes}</td><td><button type="button" data-retention-archive="${e(item.id)}" data-kind="${e(item.resource_type)}">Archive and schedule removal</button></td></tr>`).join("") || '<tr><td colspan="3">No eligible resources in this bounded scan.</td></tr>'}</tbody></table></div>`
      + `<h4>Archival history</h4><div class="table-scroll" tabindex="0" role="region" aria-label="Archival history"><table><thead><tr><th>Resource</th><th>State</th><th>Deletion after</th><th>Record</th></tr></thead><tbody>${archives.data.map((item) => `<tr><td>${e(item.resource_id)}<small>${e(item.last_error || item.reason)}</small></td><td>${e(item.state)}</td><td>${e(item.delete_after)}</td><td><button type="button" data-governance-download="/operations/retention/archives/${e(item.id)}">Download archive record</button>${item.state === "scheduled" ? `<button type="button" data-retention-cancel="${e(item.id)}">Cancel removal</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="4">No archived resources.</td></tr>'}</tbody></table></div><p class="field-help">Up to 20 candidates per resource type and the latest 100 archives are shown. Scheduled processing continues in bounded batches.</p>`;
  } catch (error) { target.textContent = `Retention information unavailable: ${error.message}`; }
}
async function inspect(collection, id) {
  const item = (await context.api(`/${collection}/${encodeURIComponent(id)}`)).data;
  const target = $(`${collection}-inspection`), e = context.escapeHtml;
  let controls = "";
  if (collection === "evaluations") {
    if (item.status === "succeeded") controls = `<button type="button" data-governance-download="/evaluations/${e(id)}/report">Download immutable report</button>`;
    else if (["queued", "running", "failed", "cancelled"].includes(item.status)) controls = `<button type="button" data-evaluation-action="${["queued", "running"].includes(item.status) ? "cancel" : "retry"}" data-id="${e(id)}">${["queued", "running"].includes(item.status) ? "Cancel" : "Retry"}</button>`;
  } else {
    const roles = context.user?.roles;
    const canDecide = !Array.isArray(roles) || roles.includes("owner") || roles.includes("release_approver");
    if (canDecide) {
      const options = collection === "models" ? (item.status === "candidate" ? ["approve", "reject"] : ["approved", "production"].includes(item.status) ? ["retire"] : []) : item.status === "candidate" ? ["approve", "reject"] : item.status === "approved" ? ["activate"] : item.status === "active" ? ["rollback"] : [];
      if (options.length) controls += form("governance-decision", "Record decision", `<input name="collection" value="${collection}" type="hidden"><input name="id" value="${e(id)}" type="hidden"><input name="revision" value="${item.revision}" type="hidden"><label>Action<select name="action">${options.map((action) => `<option>${action}</option>`).join("")}</select></label>` + (item.status === "candidate" ? select("evaluation_run_id", "Successful evaluation evidence", evaluations, (run) => run.status === "succeeded" && (collection === "models" ? run.model_version_id === id : run.pipeline_release_id === id)) : "") + (item.status === "active" ? select("target_release_id", "Previously approved rollback target", releases, (release) => release.status === "superseded") : "") + '<label>Reason<textarea name="reason" maxlength="2000" required></textarea></label>', "Record decision");
    }
  }
  target.innerHTML = `<article class="panel"><h3>${e([item.name, item.version || item.id].filter(Boolean).join(" · "))}</h3>${jsonView(item)}${controls}</article>`;
  target.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
document.addEventListener("submit", async (event) => {
  const form = event.target;
  // Named controls (including the resource's hidden "id") shadow form properties.
  const formId = form.getAttribute("id");
  if (!["model-register", "evaluation-create", "evaluation-compare", "release-create", "governance-decision", "retention-settings", "retention-pin"].includes(formId)) return;
  event.preventDefault();
  const status = form.querySelector(".form-status"), button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const value = Object.fromEntries(new FormData(form));
    if (formId.startsWith("retention-")) {
      const isSettings = formId === "retention-settings";
      const payload = isSettings ? { stale_days: Number(value.stale_days), grace_days: Number(value.grace_days) } : value;
      await context.api(`/operations/retention/${isSettings ? "settings" : "pins"}`, { method: isSettings ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      context.toast("Retention updated."); await loadRetention(); return;
    }
    if (formId === "evaluation-compare") {
      const result = await context.api(`/evaluations/compare?${new URLSearchParams(value)}`);
      $("evaluation-comparison").innerHTML = jsonView(result.data);
      return;
    }
    let path, payload, headers = { "content-type": "application/json" };
    if (formId === "model-register") {
      const file = form.querySelector('[type="file"]').files[0];
      if (!file || !file.size || file.size > 16 * 1024 * 1024) throw new Error("Choose an ONNX model up to 16 MiB.");
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      payload = { name: value.name, version: value.version, license: value.license, provenance: { source: value.source, implementation_version: value.implementation_version }, configuration: { architecture: "nanodet-plus-1.5x-416" }, model_base64: btoa(binary) }; path = "/models";
    } else if (formId === "evaluation-create") {
      payload = { ground_truth_version_id: value.ground_truth_version_id, model_version_id: value.model_version_id, ...(value.pipeline_release_id ? { pipeline_release_id: value.pipeline_release_id } : {}), configuration: Object.fromEntries(["minimum_confidence", "nms_threshold", "minimum_iou"].map((key) => [key, Number(value[key])])), idempotency_key: form.dataset.operationId || crypto.randomUUID() }; form.dataset.operationId = payload.idempotency_key; path = "/evaluations";
    } else if (formId === "release-create") {
      payload = { version: value.version, model_version_id: value.model_version_id, components: { sampler: value.sampler, annotation_schema: "object-annotations.v1", evaluator: context.engines.evaluator }, thresholds: Object.fromEntries(["minimum_confidence", "nms_threshold", "minimum_iou"].map((key) => [key, Number(value[key])])), acceptance: { minimum_f1: Number(value.minimum_f1), maximum_p95_inference_ms: Number(value.maximum_p95_inference_ms) } }; path = "/releases";
    } else {
      path = `/${value.collection}/${value.id}/${value.action}`; headers["if-match"] = value.revision;
      payload = { reason: value.reason, ...(value.evaluation_run_id ? { evaluation_run_id: value.evaluation_run_id } : {}), ...(value.target_release_id ? { target_release_id: value.target_release_id } : {}) };
    }
    await context.api(path, { method: "POST", headers, body: JSON.stringify(payload) });
    context.toast("Saved."); await context.refresh();
  } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-governance-inspect], [data-governance-download], [data-evaluation-action], [data-cleanup-preview], [data-cleanup-apply], [data-cleanup-next], [data-retention-archive], [data-retention-cancel], [data-retention-unpin]");
  if (!button || !context) return;
  button.disabled = true;
  try {
    if (button.dataset.retentionArchive || button.dataset.retentionCancel || button.dataset.retentionUnpin) {
      const path = button.dataset.retentionCancel ? `/archives/${button.dataset.retentionCancel}/cancel` : button.dataset.retentionUnpin ? "/pins" : "/archive";
      const payload = button.dataset.retentionCancel ? {} : { resource_type: button.dataset.kind, resource_id: button.dataset.retentionArchive || button.dataset.retentionUnpin, ...(button.dataset.retentionArchive ? { reason: $("retention-reason").value } : {}) };
      await context.api(`/operations/retention${path}`, { method: button.dataset.retentionUnpin ? "DELETE" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      context.toast("Retention updated."); await loadRetention();
    } else if (button.dataset.governanceInspect) await inspect(button.dataset.governanceInspect, button.dataset.id);
    else if (button.dataset.governanceDownload) {
      const response = await context.apiResponse(button.dataset.governanceDownload);
      if (!response.ok) throw new Error("Report could not be downloaded.");
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a"); link.href = url; link.download = button.dataset.governanceDownload.includes("/retention/") ? "resource-archive.json" : button.dataset.governanceDownload === "/reference-benchmarks" ? "reference-benchmarks.json" : "evaluation-report.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (button.dataset.evaluationAction) { await context.api(`/evaluations/${button.dataset.id}/${button.dataset.evaluationAction}`, { method: "POST" }); await context.refresh(); }
    else if (button.hasAttribute("data-cleanup-apply")) {
      const reason = $("cleanup-reason").value.trim(); if (!reason) throw new Error("Enter a cleanup reason.");
      const objects = [...document.querySelectorAll("[data-cleanup-object]:checked")].map((input) => cleanupCandidates[Number(input.value)]);
      if (!objects.length) throw new Error("Select objects from the preview.");
      const result = await context.api("/operations/orphans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objects, reason }) });
      context.toast(`Deleted ${result.data.deleted.length}; skipped ${result.data.skipped.length}.`); await context.refresh();
    } else {
      if (button.hasAttribute("data-cleanup-preview")) cleanupCursor = null;
      const result = await context.api(`/operations/orphans${cleanupCursor ? `?cursor=${encodeURIComponent(cleanupCursor)}` : ""}`); cleanupCandidates = result.data; cleanupCursor = result.pagination.cursor;
      $("cleanup-preview").innerHTML = cleanupCandidates.length ? cleanupCandidates.map((item, index) => `<label><input type="checkbox" data-cleanup-object value="${index}"> ${context.escapeHtml(item.key)} · ${item.size} bytes</label>`).join("") + '<label>Cleanup reason<textarea id="cleanup-reason" maxlength="2000" required></textarea></label><button type="button" data-cleanup-apply>Delete selected orphan objects</button>' : '<p>No eligible orphans in this page.</p>';
      if (result.pagination.has_more) { const next = document.createElement("button"); next.type = "button"; next.dataset.cleanupNext = ""; next.textContent = "Scan next page"; $("cleanup-preview").append(next); }
    }
  } catch (error) { context.toast(error.message); } finally { button.disabled = false; }
});
