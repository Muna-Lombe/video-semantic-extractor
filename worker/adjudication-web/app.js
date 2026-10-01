/** @type implementation @purpose Drive hosted reviewer and adjudicator assignments. */
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("review-token") || "";
let identity;
let state;
let selected;

function consumeInvitation() {
  const match = location.hash.match(/(?:^#|&)token=([^&]+)/);
  if (!match) return;
  token = decodeURIComponent(match[1]);
  sessionStorage.setItem("review-token", token);
  history.replaceState({}, "", location.pathname);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...options.headers, authorization: `Bearer ${token}` } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
const frameKey = (source, frame) => `${source.source}/${frame.filename}`;
const frameOf = (payload, source, filename) => payload.sources.find((item) => item.source === source)?.frames.find((frame) => frame.filename === filename);
const assignmentFrameUrl = (source, filename) => `/api/v1/assignments/${encodeURIComponent(identity.assignment_id)}/frames/${encodeURIComponent(source)}/${encodeURIComponent(filename)}`;
async function showEvidence(element, source, filename) {
  const response = await fetch(assignmentFrameUrl(source, filename), { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("Could not load frame evidence");
  const previous = element.dataset.objectUrl;
  if (previous) URL.revokeObjectURL(previous);
  const objectUrl = URL.createObjectURL(await response.blob());
  element.dataset.objectUrl = objectUrl;
  element.src = objectUrl;
}

async function login() {
  token = $("token").value || token;
  if (!token) throw new Error("An assignment token is required");
  identity = await api("/api/v1/me");
  if (!identity.assignment_id) throw new Error("Use a reviewer or adjudicator assignment token, not the administrator token");
  sessionStorage.setItem("review-token", token);
  $("login").hidden = true;
  if (identity.actor.role === "adjudicator") await loadAdjudication();
  else await loadReviewer();
}

async function loadReviewer() {
  state = await api(identity.links.state);
  $("reviewer").hidden = false;
  $("reviewer-role").textContent = identity.actor.role === "reviewer-a" ? "Reviewer A" : "Reviewer B";
  const reviewed = new Set(state.annotations.review.reviewed_frames || []);
  const buttons = [];
  for (const source of state.annotations.sources) for (const frame of source.frames) {
    const button = document.createElement("button");
    button.className = `frame ${reviewed.has(frameKey(source, frame)) ? "resolved" : ""}`;
    button.textContent = frameKey(source, frame);
    button.onclick = () => selectReviewFrame(source, frame);
    buttons.push(button);
  }
  $("review-frames").replaceChildren(...buttons);
  $("review-progress").textContent = `${reviewed.size}/${state.frame_count} frames reviewed`;
  $("complete-review").disabled = state.assignment.status === "complete";
  if (!selected && state.annotations.sources[0]?.frames[0]) selectReviewFrame(state.annotations.sources[0], state.annotations.sources[0].frames[0]);
}
function selectReviewFrame(source, frame) {
  selected = { source: source.source, filename: frame.filename };
  $("review-title").textContent = frameKey(source, frame);
  showEvidence($("review-image"), source.source, frame.filename).catch((error) => alert(error.message));
  $("objects").value = JSON.stringify(frame.objects || [], null, 2);
  $("out-of-taxonomy").value = (frame.out_of_taxonomy || []).join("\n");
}
function updateSelected(markReviewed = false) {
  if (!selected) throw new Error("Select a frame first");
  const frame = frameOf(state.annotations, selected.source, selected.filename);
  const objects = JSON.parse($("objects").value);
  if (!Array.isArray(objects)) throw new Error("Objects JSON must be an array");
  frame.objects = objects;
  frame.out_of_taxonomy = $("out-of-taxonomy").value.split("\n").map((value) => value.trim()).filter(Boolean);
  if (markReviewed) {
    const reviewed = state.annotations.review.reviewed_frames || (state.annotations.review.reviewed_frames = []);
    const key = `${selected.source}/${selected.filename}`;
    if (!reviewed.includes(key)) reviewed.push(key);
  }
}
async function saveReview(markReviewed = false) {
  updateSelected(markReviewed);
  await api(identity.links.state, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(state.annotations) });
  selected = null;
  await loadReviewer();
}

async function loadAdjudication() {
  state = await api(identity.links.state);
  $("adjudicator").hidden = false;
  const grouped = new Map();
  for (const item of state.comparison.disagreements) if (item.source && item.filename) grouped.set(`${item.source}/${item.filename}`, item);
  const resolved = new Set(state.merged.review.adjudication_log.map((item) => `${item.source}/${item.filename}`));
  $("disagreement-frames").replaceChildren(...[...grouped.values()].map((item) => {
    const button = document.createElement("button");
    button.className = `frame ${resolved.has(`${item.source}/${item.filename}`) ? "resolved" : ""}`;
    button.textContent = `${item.source}/${item.filename}`;
    button.onclick = () => selectAdjudicationFrame(item);
    return button;
  }));
  $("adjudication-status").textContent = state.assignment.status === "complete" ? `Complete — ${state.result_url}` : `${resolved.size}/${grouped.size} disagreement frames resolved`;
  $("complete-adjudication").disabled = state.assignment.status === "complete";
}
function selectAdjudicationFrame(item) {
  selected = item;
  $("adjudication-title").textContent = `${item.source}/${item.filename}`;
  showEvidence($("adjudication-image"), item.source, item.filename).catch((error) => alert(error.message));
  $("left").textContent = JSON.stringify(frameOf(state.reviewer_a, item.source, item.filename), null, 2);
  $("right").textContent = JSON.stringify(frameOf(state.reviewer_b, item.source, item.filename), null, 2);
  $("merged").value = JSON.stringify(frameOf(state.merged, item.source, item.filename), null, 2);
}
async function resolve(frame, resolution) {
  if (!selected) throw new Error("Select a disagreement frame first");
  const path = `${identity.links.state}/frames/${encodeURIComponent(selected.source)}/${encodeURIComponent(selected.filename)}`;
  await api(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ frame, resolution }) });
  selected = null;
  await loadAdjudication();
}

$("open").onclick = () => login().catch((error) => { $("login-status").textContent = error.message; });
$("save-review").onclick = () => saveReview(false).catch((error) => alert(error.message));
$("mark-reviewed").onclick = () => saveReview(true).catch((error) => alert(error.message));
$("complete-review").onclick = async () => {
  try { await saveReview(false); await api(`${identity.links.state}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await loadReviewer(); }
  catch (error) { alert(error.message); }
};
$("use-a").onclick = () => selected && resolve(frameOf(state.reviewer_a, selected.source, selected.filename), "reviewer_a").catch((error) => alert(error.message));
$("use-b").onclick = () => selected && resolve(frameOf(state.reviewer_b, selected.source, selected.filename), "reviewer_b").catch((error) => alert(error.message));
$("save-resolution").onclick = () => { try { resolve(JSON.parse($("merged").value), "edited").catch((error) => alert(error.message)); } catch { alert("Merged decision must be valid JSON"); } };
$("complete-adjudication").onclick = async () => { try { await api(`${identity.links.state}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await loadAdjudication(); } catch (error) { alert(error.message); } };

consumeInvitation();
$("token").value = token;
if (token) login().catch((error) => { $("login-status").textContent = error.message; });
