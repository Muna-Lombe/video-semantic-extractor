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
  const results = await Promise.allSettled([all("/models"), all("/releases"), all("/evaluations"), all("/ground-truth"), context.api("/operations")]);
  [models, releases, evaluations, truths] = results.slice(0,4).map((result) => result.status === "fulfilled" ? result.value : []);
  const roles = context.user?.roles;
  const can = (role) => !Array.isArray(roles) || roles.includes("owner") || roles.includes(role);
  $("models-workspace").innerHTML = list(models, "models") + (can("researcher") ? form("model-register", "Register model version", field("name", "Model name", "text", 'maxlength="120"') + field("version", "Version", "text", 'maxlength="80"') + field("license", "License / permitted use", "text", 'maxlength="1000"') + field("source", "Source and provenance", "text", 'maxlength="2000"') + field("implementation_version", "Implementation version", "text", 'maxlength="200"') + field("model_file", "NanoDet Plus 1.5x 416 ONNX model (up to 16 MiB)", "file", 'accept=".onnx"'), "Register candidate") : "");
  $("evaluations-workspace").innerHTML = list(evaluations, "evaluations") + (can("researcher") || can("operator") ? form("evaluation-create", "Schedule diagnostic evaluation", select("ground_truth_version_id", "Approved ground truth", truths, (item) => item.status === "approved" && item.approval_status === "approved") + select("model_version_id", "Model version", models, (item) => ["candidate", "validated", "approved", "production"].includes(item.status)) + '<label>Pipeline release (optional)<select name="pipeline_release_id"><option value="">Model only</option>' + releases.filter((item) => ["candidate", "approved", "active"].includes(item.status)).map((item) => `<option value="${context.escapeHtml(item.id)}">${context.escapeHtml(item.version)}</option>`).join("") + '</select></label>' + thresholds, "Queue evaluation") : "") + form("evaluation-compare", "Compare successful evaluations", select("baseline_id", "Baseline", evaluations, (item) => item.status === "succeeded") + select("candidate_id", "Candidate", evaluations, (item) => item.status === "succeeded"), "Compare") + '<div id="evaluation-comparison"></div>';
  $("releases-workspace").innerHTML = list(releases, "releases") + (can("researcher") ? form("release-create", "Create release candidate", field("version", "Release version", "text", 'maxlength="80"') + select("model_version_id", "Approved model", models, (item) => ["approved", "production"].includes(item.status)) + field("sampler", "Sampler implementation", "text", `readonly value="${context.escapeHtml(context.engines?.sampler || "")}"`) + thresholds + field("minimum_f1", "Required minimum F1", "number", 'min="0" max="1" step="0.01" value="0.8"') + field("maximum_p95_inference_ms", "Maximum p95 inference time (ms)", "number", 'min="0.001" step="0.001" value="100"'), "Create candidate") : "");
  $("operations-workspace").innerHTML = results[4].status === "fulfilled" ? `<div class="panel"><h3>Job and artifact health</h3>${jsonView(results[4].value.data)}</div><div class="panel"><h3>Unregistered object cleanup</h3><p>Preview unregistered objects older than seven days. Referenced artifacts and active uploads are retained.</p><button type="button" data-cleanup-preview>Preview candidates</button><div id="cleanup-preview"></div></div>` : '<p role="status">Operations unavailable for this account or deployment.</p>';
  for (const [index, collection] of ["models", "releases", "evaluations"].entries()) if (results[index].status === "rejected") $(`${collection}-workspace`).prepend(Object.assign(document.createElement("p"), { textContent: `Could not load ${collection}: ${results[index].reason.message}` }));
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
  if (!["model-register", "evaluation-create", "evaluation-compare", "release-create", "governance-decision"].includes(form.id)) return;
  event.preventDefault();
  const status = form.querySelector(".form-status"), button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const value = Object.fromEntries(new FormData(form));
    if (form.id === "evaluation-compare") {
      const result = await context.api(`/evaluations/compare?${new URLSearchParams(value)}`);
      $("evaluation-comparison").innerHTML = jsonView(result.data);
      return;
    }
    let path, payload, headers = { "content-type": "application/json" };
    if (form.id === "model-register") {
      const file = form.querySelector('[type="file"]').files[0];
      if (!file || !file.size || file.size > 16 * 1024 * 1024) throw new Error("Choose an ONNX model up to 16 MiB.");
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      payload = { name: value.name, version: value.version, license: value.license, provenance: { source: value.source, implementation_version: value.implementation_version }, configuration: { architecture: "nanodet-plus-1.5x-416" }, model_base64: btoa(binary) }; path = "/models";
    } else if (form.id === "evaluation-create") {
      payload = { ground_truth_version_id: value.ground_truth_version_id, model_version_id: value.model_version_id, ...(value.pipeline_release_id ? { pipeline_release_id: value.pipeline_release_id } : {}), configuration: Object.fromEntries(["minimum_confidence", "nms_threshold", "minimum_iou"].map((key) => [key, Number(value[key])])), idempotency_key: form.dataset.operationId || crypto.randomUUID() }; form.dataset.operationId = payload.idempotency_key; path = "/evaluations";
    } else if (form.id === "release-create") {
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
  const button = event.target.closest("[data-governance-inspect], [data-governance-download], [data-evaluation-action], [data-cleanup-preview], [data-cleanup-apply], [data-cleanup-next]");
  if (!button || !context) return;
  button.disabled = true;
  try {
    if (button.dataset.governanceInspect) await inspect(button.dataset.governanceInspect, button.dataset.id);
    else if (button.dataset.governanceDownload) {
      const response = await context.apiResponse(button.dataset.governanceDownload);
      if (!response.ok) throw new Error("Report could not be downloaded.");
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a"); link.href = url; link.download = "evaluation-report.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
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
