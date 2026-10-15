/** @type implementation @purpose Drive hosted reviewer and adjudicator assignments. */
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("review-token") || "";
let identity;
let state;
let selected;
let reviewImage;
let reviewImageUrl;
let detector;
let suggestions = [];
let drawMode = false;
let drawingStart;
const COCO_CLASSES = "person|bicycle|car|motorcycle|airplane|bus|train|truck|boat|traffic light|fire hydrant|stop sign|parking meter|bench|bird|cat|dog|horse|sheep|cow|elephant|bear|zebra|giraffe|backpack|umbrella|handbag|tie|suitcase|frisbee|skis|snowboard|sports ball|kite|baseball bat|baseball glove|skateboard|surfboard|tennis racket|bottle|wine glass|cup|fork|knife|spoon|bowl|banana|apple|sandwich|orange|broccoli|carrot|hot dog|pizza|donut|cake|chair|couch|potted plant|bed|dining table|toilet|tv|laptop|mouse|remote|keyboard|cell phone|microwave|oven|toaster|sink|refrigerator|book|clock|vase|scissors|teddy bear|hair drier|toothbrush".split("|");

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
  if (!response.ok) { const error = new Error(result.error?.message || result.error || "Request failed"); error.status = response.status; throw error; }
  return result;
}
const frameKey = (source, frame) => `${source.source}/${frame.filename}`;
const frameOf = (payload, source, filename) => payload.sources.find((item) => item.source === source)?.frames.find((frame) => frame.filename === filename);
const assignmentFrameUrl = (source, filename) => `/api/v1/assignments/${encodeURIComponent(identity.assignment_id)}/frames/${encodeURIComponent(source)}/${encodeURIComponent(filename)}`;
const mutationHeaders = () => ({ "content-type": "application/json", ...(Number.isSafeInteger(state?.revision) ? { "if-match": String(state.revision) } : {}) });
function renderPolicy(policy) {
  $("assignment-policy").hidden = !policy;
  if (!policy) return;
  $("policy-heading").textContent = `${policy.name} · ${policy.version}`;
  const rules = policy.annotation_rules;
  $("policy-instructions").textContent = policy.document + (rules ? `\n\nAllowed labels: ${rules.allowed_labels?.join(", ") || "all COCO labels"}. Allowed subsets: ${rules.allowed_subsets?.join(", ") || "live, composited, screen"}. Maximum objects per frame: ${rules.max_objects_per_frame || 200}.` : "");
}

async function login() {
  token = $("token").value || token;
  if (!token) throw new Error("An assignment token is required");
  try {
    identity = await api("/api/v1/me");
  } catch (error) {
    if (error.message.includes("verified assigned-user sign-in") || error.message.includes("bound to a different verified user")) {
      $("login").hidden = true;
      $("assigned-identity").hidden = false;
      $("assigned-login-status").textContent = error.message.includes("different verified user")
        ? "This assignment is linked to another account. Use the assigned user's verified email."
        : "Sign in with the verified account assigned by your coordinator.";
      return;
    }
    throw error;
  }
  $("assigned-identity").hidden = true;
  if (!identity.assignment_id) throw new Error("Use a reviewer or adjudicator assignment token, not the administrator token");
  sessionStorage.setItem("review-token", token);
  if (identity.links.policy) renderPolicy((await api(identity.links.policy)).policy);
  if (identity.actor.role === "adjudicator") await loadAdjudication();
  else await loadReviewer();
  $("login").hidden = true;
}

async function loadReviewer() {
  state = await api(identity.links.state);
  renderPolicy(state.policy);
  $("reviewer").hidden = false;
  $("reviewer-role").textContent = identity.actor.role === "reviewer-a" ? "Reviewer A" : "Reviewer B";
  $("object-label").replaceChildren(...(state.policy?.annotation_rules?.allowed_labels || COCO_CLASSES).map((label) => {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    return option;
  }));
  $("object-subset").replaceChildren(...(state.policy?.annotation_rules?.allowed_subsets || ["live", "composited", "screen"]).map((subset) => { const option = document.createElement("option"); option.value = subset; option.textContent = subset; return option; }));
  const reviewed = new Set(state.annotations.review.reviewed_frames || []);
  const buttons = [];
  for (const source of state.annotations.sources) for (const frame of source.frames) {
    const button = document.createElement("button");
    button.className = `frame ${reviewed.has(frameKey(source, frame)) ? "resolved" : ""}`;
    button.textContent = frameKey(source, frame);
    button.title = frameKey(source, frame);
    button.setAttribute("aria-label", `${frameKey(source, frame)}${reviewed.has(frameKey(source, frame)) ? ", reviewed" : ""}`);
    button.setAttribute("aria-current", selected?.source === source.source && selected?.filename === frame.filename ? "true" : "false");
    button.onclick = () => selectReviewFrame(source, frame);
    buttons.push(button);
  }
  $("review-frames").replaceChildren(...buttons);
  $("review-progress").textContent = `${reviewed.size}/${state.frame_count} frames reviewed`;
  $("complete-review").disabled = state.assignment.status === "complete";
  $("save-review").disabled = state.assignment.status === "complete";
  $("mark-reviewed").disabled = state.assignment.status === "complete";
  ["object-label", "object-subset", "draw-box", "suggest-objects", "out-of-taxonomy"].forEach((id) => { $(id).disabled = state.assignment.status === "complete"; });
  const current = selected && frameOf(state.annotations, selected.source, selected.filename);
  if (current) renderReviewFrame(current);
  else if (state.annotations.sources[0]?.frames[0]) selectReviewFrame(state.annotations.sources[0], state.annotations.sources[0].frames[0]);
}
function selectReviewFrame(source, frame) {
  if (suggestions.length && !window.confirm("Discard unconfirmed object suggestions for the current frame?")) return;
  selected = { source: source.source, filename: frame.filename };
  suggestions = [];
  drawingStart = undefined;
  setDrawMode(false);
  if (reviewImageUrl) URL.revokeObjectURL(reviewImageUrl);
  reviewImageUrl = undefined;
  reviewImage = undefined;
  $("review-title").textContent = frameKey(source, frame);
  $("review-title").title = frameKey(source, frame);
  $("out-of-taxonomy").value = (frame.out_of_taxonomy || []).join("\n");
  $("canvas-status").textContent = "Loading frame evidence...";
  $("canvas-status").classList.remove("error");
  $("review-canvas").width = 0;
  $("review-canvas").height = 0;
  $("review-frames").querySelectorAll(".frame").forEach((button) => {
    button.setAttribute("aria-current", String(button.textContent === frameKey(source, frame)));
  });
  renderReviewAnnotations(frame);
  loadReviewImage(source.source, frame.filename, frame).catch((error) => {
    $("canvas-status").textContent = error.message;
    $("canvas-status").classList.add("error");
  });
}
function currentReviewFrame() {
  if (!selected) throw new Error("Select a frame first");
  const frame = frameOf(state.annotations, selected.source, selected.filename);
  if (!frame) throw new Error("The selected frame is not part of this assignment");
  return frame;
}
function renderReviewFrame(frame) {
  $("review-title").textContent = `${selected.source}/${selected.filename}`;
  $("review-title").title = `${selected.source}/${selected.filename}`;
  $("out-of-taxonomy").value = (frame.out_of_taxonomy || []).join("\n");
  renderReviewAnnotations(frame);
  drawReviewCanvas();
}
async function loadReviewImage(source, filename, frame) {
  const response = await fetch(assignmentFrameUrl(source, filename), { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("Could not load frame evidence");
  const url = URL.createObjectURL(await response.blob());
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    if (selected?.source !== source || selected?.filename !== filename) {
      URL.revokeObjectURL(url);
      return;
    }
    if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) throw new Error("Evidence dimensions do not match the registered frame");
    if (reviewImageUrl) URL.revokeObjectURL(reviewImageUrl);
    reviewImageUrl = url;
    reviewImage = image;
    $("canvas-status").textContent = `${image.naturalWidth} × ${image.naturalHeight} source pixels`;
    $("canvas-status").classList.remove("error");
    drawReviewCanvas();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
function drawReviewCanvas() {
  const canvas = $("review-canvas");
  if (!reviewImage?.naturalWidth || !selected) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  const frame = currentReviewFrame();
  canvas.width = reviewImage.naturalWidth;
  canvas.height = reviewImage.naturalHeight;
  const context = canvas.getContext("2d");
  context.drawImage(reviewImage, 0, 0);
  context.font = `bold ${Math.max(16, canvas.width / 80)}px sans-serif`;
  context.lineWidth = Math.max(3, canvas.width / 500);
  frame.objects.forEach((object, index) => {
    const [x, y, width, height] = object.region;
    context.strokeStyle = index % 2 ? "#f2c14e" : "#e2643b";
    context.strokeRect(x, y, width, height);
    context.fillStyle = context.strokeStyle;
    const labelHeight = Math.max(24, canvas.width / 60);
    const labelY = Math.max(0, y - labelHeight);
    context.fillRect(x, labelY, context.measureText(object.label).width + 14, labelHeight);
    context.fillStyle = "#fff";
    context.fillText(object.label, x + 7, labelY + labelHeight * 0.72);
  });
  suggestions.forEach((suggestion) => {
    const [x, y, width, height] = suggestion.region;
    context.strokeStyle = "#1cb7c9";
    context.setLineDash([8, 5]);
    context.strokeRect(x, y, width, height);
    context.setLineDash([]);
  });
}
function renderReviewAnnotations(frame) {
  const rows = frame.objects.map((object, index) => {
    const row = document.createElement("div");
    row.className = "object-row";
    const description = document.createElement("span");
    description.textContent = `${index + 1}. ${object.label} · ${object.subset} · [${object.region.join(", ")}]`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.title = `Remove ${object.label} annotation`;
    remove.disabled = state.assignment.status === "complete";
    remove.onclick = () => {
      frame.objects.splice(index, 1);
      renderReviewAnnotations(frame);
      drawReviewCanvas();
    };
    row.append(description, remove);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No objects recorded. Inspect the frame before leaving it empty.";
    rows.push(empty);
  }
  $("object-list").replaceChildren(...rows);
  const suggestionRows = suggestions.map((suggestion, index) => {
    const row = document.createElement("div");
    row.className = "object-row suggestion-row";
    const description = document.createElement("span");
    description.textContent = `${suggestion.label} · ${Math.round(suggestion.score * 100)}%`;
    const actions = document.createElement("span");
    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "Confirm";
    accept.disabled = state.assignment.status === "complete";
    accept.onclick = () => acceptSuggestion(index);
    const reject = document.createElement("button");
    reject.type = "button";
    reject.textContent = "Reject";
    reject.className = "secondary";
    reject.disabled = state.assignment.status === "complete";
    reject.onclick = () => rejectSuggestion(index);
    actions.append(accept, reject);
    row.append(description, actions);
    return row;
  });
  if (!suggestionRows.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No pending suggestions.";
    suggestionRows.push(empty);
  }
  $("suggestion-list").replaceChildren(...suggestionRows);
}
function acceptSuggestion(index) {
  const suggestion = suggestions[index];
  if (!suggestion) return;
  const frame = currentReviewFrame();
  if (frame.objects.length >= 200) {
    $("canvas-status").textContent = "This frame already has the maximum of 200 object annotations.";
    $("canvas-status").classList.add("error");
    return;
  }
  frame.objects.push({
    id: `review-${crypto.randomUUID()}`,
    label: suggestion.label,
    subset: $("object-subset").value,
    region: suggestion.region,
  });
  suggestions.splice(index, 1);
  renderReviewAnnotations(frame);
  drawReviewCanvas();
}
function rejectSuggestion(index) {
  if (index < 0 || index >= suggestions.length) return;
  suggestions.splice(index, 1);
  renderReviewAnnotations(currentReviewFrame());
  drawReviewCanvas();
}
function setDrawMode(enabled) {
  drawMode = enabled;
  $("draw-box").setAttribute("aria-pressed", String(enabled));
  $("draw-box").textContent = enabled ? "Cancel drawing" : "Draw box";
  $("review-canvas").classList.toggle("drawing", enabled);
  if (enabled) $("canvas-status").textContent = "Drag on the frame to draw a box.";
}
function updateSelected(markReviewed = false) {
  if (!selected) throw new Error("Select a frame first");
  const frame = currentReviewFrame();
  frame.out_of_taxonomy = $("out-of-taxonomy").value.split("\n").map((value) => value.trim()).filter(Boolean);
  if (markReviewed) {
    const reviewed = state.annotations.review.reviewed_frames || (state.annotations.review.reviewed_frames = []);
    const key = `${selected.source}/${selected.filename}`;
    if (suggestions.length) throw new Error("Confirm or reject all object suggestions before marking this frame reviewed");
    if (!reviewed.includes(key)) reviewed.push(key);
  }
}
async function saveReview(markReviewed = false) {
  updateSelected(markReviewed);
  const result = await api(identity.links.state, { method: "PUT", headers: mutationHeaders(), body: JSON.stringify(state.annotations) });
  state.revision = result.revision;
  await loadReviewer();
}

function canvasPoint(event) {
  const canvas = $("review-canvas");
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, Math.round((event.clientX - bounds.left) * canvas.width / bounds.width))),
    y: Math.max(0, Math.min(canvas.height, Math.round((event.clientY - bounds.top) * canvas.height / bounds.height))),
  };
}
async function suggestObjects() {
  const button = $("suggest-objects");
  if (suggestions.length) {
    $("canvas-status").textContent = "Confirm or reject the pending suggestions before running detection again.";
    return;
  }
  if (!selected || !reviewImage) {
    $("canvas-status").textContent = "Load a frame before requesting suggestions.";
    return;
  }
  const requestedFrame = { ...selected };
  button.disabled = true;
  try {
    if (!detector) {
      $("canvas-status").textContent = "Loading the optional object-detection model in your browser...";
      const { env, pipeline } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm");
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      detector = await pipeline("object-detection", "Xenova/yolos-tiny", { device: navigator.gpu ? "webgpu" : "wasm" });
    }
    if (selected?.source !== requestedFrame.source || selected?.filename !== requestedFrame.filename || !reviewImage) return;
    const image = reviewImage;
    $("canvas-status").textContent = "Inspecting this frame locally in your browser...";
    const detections = await detector(image, { threshold: 0.35 });
    if (selected?.source !== requestedFrame.source || selected?.filename !== requestedFrame.filename) return;
    suggestions = detections.filter((item) => COCO_CLASSES.includes(item.label)).map((item) => {
      const left = Math.max(0, Math.min(image.naturalWidth, Math.round(item.box.xmin)));
      const top = Math.max(0, Math.min(image.naturalHeight, Math.round(item.box.ymin)));
      const right = Math.max(left, Math.min(image.naturalWidth, Math.round(item.box.xmax)));
      const bottom = Math.max(top, Math.min(image.naturalHeight, Math.round(item.box.ymax)));
      return { label: item.label, score: item.score, region: [left, top, right - left, bottom - top] };
    }).filter((item) => item.region[2] > 0 && item.region[3] > 0);
    $("canvas-status").textContent = suggestions.length
      ? `${suggestions.length} optional suggestions. Confirm or reject each; they are not saved automatically.`
      : "No matching objects suggested. Inspect the frame manually.";
    $("canvas-status").classList.remove("error");
    renderReviewAnnotations(currentReviewFrame());
    drawReviewCanvas();
  } catch (error) {
    if (selected?.source === requestedFrame.source && selected?.filename === requestedFrame.filename) {
      $("canvas-status").textContent = `Object suggestions unavailable: ${error.message}`;
      $("canvas-status").classList.add("error");
    }
  } finally {
    button.disabled = state.assignment.status === "complete";
  }
}

const reviewCanvas = $("review-canvas");
reviewCanvas.addEventListener("pointerdown", (event) => {
  if (!drawMode || !reviewImage || state.assignment.status === "complete") return;
  drawingStart = canvasPoint(event);
  reviewCanvas.setPointerCapture(event.pointerId);
});
reviewCanvas.addEventListener("pointerup", (event) => {
  if (!drawingStart) return;
  const start = drawingStart;
  drawingStart = undefined;
  const end = canvasPoint(event);
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (currentReviewFrame().objects.length >= 200) {
    $("canvas-status").textContent = "This frame already has the maximum of 200 object annotations.";
    $("canvas-status").classList.add("error");
    return;
  }
  if (width < 4 || height < 4) {
    $("canvas-status").textContent = "Box too small. Drag at least 4 source pixels in each direction.";
    return;
  }
  currentReviewFrame().objects.push({
    id: `review-${crypto.randomUUID()}`,
    label: $("object-label").value,
    subset: $("object-subset").value,
    region: [x, y, width, height],
  });
  renderReviewAnnotations(currentReviewFrame());
  drawReviewCanvas();
  $("canvas-status").textContent = "Box added. Continue drawing or save your review.";
  $("canvas-status").classList.remove("error");
});
reviewCanvas.addEventListener("pointercancel", () => { drawingStart = undefined; });
$("draw-box").onclick = () => setDrawMode(!drawMode);
$("suggest-objects").onclick = () => suggestObjects();
$("out-of-taxonomy").addEventListener("input", () => {
  if (selected && state?.annotations) currentReviewFrame().out_of_taxonomy = $("out-of-taxonomy").value.split("\n").map((value) => value.trim()).filter(Boolean);
});

let adjudicationItems = [];
let decisionDraft, decisionMode = "edited";
let adjudicationDirty = false, rawDecisionDirty = false, adjudicationBusy = false, adjudicationNeedsReload = false;
let adjudicationImage, adjudicationImageUrl, evidenceRequest;
let decisionDrawing = false, decisionDrawingStart;
const cloneDecision = (value) => structuredClone(value);
const adjudicationKey = (item) => `${item.source}/${item.filename}`;
const resolvedDecisions = () => new Map((state?.merged?.review?.adjudication_log || []).map((item) => [adjudicationKey(item), item]));
const remainingDecisions = () => adjudicationItems.filter((item) => !resolvedDecisions().has(adjudicationKey(item)));
const decisionEditable = () => Boolean(selected && state?.assignment.status !== "complete" && !adjudicationBusy);
function resolutionMessage(message, error = false) {
  $("resolution-status").textContent = message;
  $("resolution-status").classList.toggle("error", error);
}
function updateAdjudicationControls() {
  const complete = state?.assignment.status === "complete", editable = decisionEditable();
  const pending = remainingDecisions().length;
  $("complete-adjudication").disabled = !state?.merged || complete || adjudicationBusy || pending > 0 || adjudicationDirty || adjudicationNeedsReload;
  $("confirm-complete").disabled = $("complete-adjudication").disabled;
  $("save-resolution").disabled = !editable || !adjudicationImage || adjudicationNeedsReload;
  ["use-a", "use-b"].forEach((id) => { $(id).disabled = !editable || !adjudicationImage; });
  $("add-decision-object").disabled = !editable || rawDecisionDirty || !adjudicationImage;
  $("draw-decision-box").disabled = !editable || rawDecisionDirty || !adjudicationImage;
  $("decision-taxonomy").disabled = !editable || rawDecisionDirty;
  $("merged").disabled = !editable;
  $("apply-decision-json").disabled = !editable || !rawDecisionDirty;
  $("decision-objects").querySelectorAll("input, select, button").forEach((input) => { input.disabled = !editable || rawDecisionDirty; });
  $("reload-adjudication").disabled = adjudicationBusy;
  $("refresh-adjudication").disabled = adjudicationBusy;
  $("download-result").hidden = !complete || !state?.result_url;
  const index = adjudicationItems.findIndex((item) => selected && adjudicationKey(item) === adjudicationKey(selected));
  $("previous-frame").disabled = adjudicationBusy || index <= 0;
  $("next-frame").disabled = adjudicationBusy || index < 0 || index >= adjudicationItems.length - 1;
  $("next-unresolved").disabled = adjudicationBusy || !remainingDecisions().some((item) => !selected || adjudicationKey(item) !== adjudicationKey(selected));
  $("decision-state").textContent = complete ? "Read only" : adjudicationDirty ? "Unsaved" : selected && resolvedDecisions().has(adjudicationKey(selected)) ? "Saved" : "Needs decision";
  $("decision-origin").textContent = { reviewer_a: "Based on reviewer A", reviewer_b: "Based on reviewer B", edited: "Custom decision", ambiguous: "Recorded as ambiguous" }[decisionMode] || "Custom decision";
}
function renderAdjudicationSidebar() {
  const resolved = resolvedDecisions(), filter = $("disagreement-filter").value, query = $("disagreement-search").value.trim().toLowerCase();
  const visible = adjudicationItems.filter((item) => {
    const saved = resolved.has(adjudicationKey(item));
    return (filter === "all" || (filter === "resolved" ? saved : !saved)) && adjudicationKey(item).toLowerCase().includes(query);
  });
  $("disagreement-frames").replaceChildren(...visible.map((item) => {
    const saved = resolved.has(adjudicationKey(item)), button = document.createElement("button");
    button.type = "button"; button.className = `frame${saved ? " resolved" : ""}`;
    button.title = adjudicationKey(item);
    button.setAttribute("aria-current", String(Boolean(selected && adjudicationKey(item) === adjudicationKey(selected))));
    button.disabled = adjudicationBusy;
    const title = document.createElement("strong"), detail = document.createElement("small");
    title.textContent = item.filename; detail.textContent = `${saved ? "Resolved" : "Needs decision"} · ${item.source}`;
    button.append(title, detail); button.onclick = () => selectAdjudicationFrame(item);
    return button;
  }));
  $("disagreement-count").textContent = `${visible.length} shown · ${adjudicationItems.length} total`;
  $("no-matching-frames").hidden = visible.length > 0 || adjudicationItems.length === 0;
}
async function loadAdjudication(preferred = selected, advance = false) {
  document.querySelector(".skip-link").href = "#adjudication-content";
  let loaded;
  try { loaded = await api(identity.links.state); }
  catch (error) {
    if (error.status !== 409 || !error.message.includes("both independent reviewer passes")) throw error;
    state = undefined; selected = null; adjudicationItems = [];
    $("adjudicator").hidden = false; $("adjudication-frame").hidden = true; $("adjudication-empty").hidden = false;
    $("adjudication-empty").querySelector("h2").textContent = "Waiting for both reviewer passes";
    $("adjudication-empty").querySelector("p").textContent = "You can compare and resolve annotations once both independent reviews are complete. Refresh this assignment to check again.";
    $("adjudication-status").textContent = "The reviewers are still working. No adjudication decisions are available yet.";
    $("adjudication-progress").textContent = "Waiting for reviews";
    $("adjudication-progress-bar").value = 0;
    renderAdjudicationSidebar(); updateAdjudicationControls(); return;
  }
  state = loaded; adjudicationNeedsReload = false;
  $("adjudication-empty").querySelector("h2").textContent = "No disagreements to resolve";
  $("adjudication-empty").querySelector("p").textContent = "Both reviewers agree on every frame. You can complete adjudication after checking the instructions.";
  renderPolicy(state.policy);
  $("reviewer").hidden = true; $("adjudicator").hidden = false;
  const grouped = new Map();
  for (const item of state.comparison.disagreements) {
    if (!item.source || !item.filename) continue;
    const key = adjudicationKey(item);
    if (!grouped.has(key)) grouped.set(key, { ...item, types: new Set() });
    grouped.get(key).types.add(item.type);
  }
  adjudicationItems = [...grouped.values()];
  const pending = remainingDecisions(), complete = state.assignment.status === "complete";
  $("adjudication-progress").textContent = `${adjudicationItems.length - pending.length} of ${adjudicationItems.length} resolved`;
  $("adjudication-progress-bar").max = adjudicationItems.length || 1;
  $("adjudication-progress-bar").value = adjudicationItems.length ? adjudicationItems.length - pending.length : 1;
  $("adjudication-status").textContent = complete ? "Adjudication complete. Your decisions have been saved." : pending.length ? `${pending.length} disagreement frame${pending.length === 1 ? " needs" : "s need"} a decision before you can complete adjudication.` : "All decisions are saved. Review them or complete adjudication.";
  $("adjudication-status").classList.remove("error");
  $("adjudication-empty").hidden = adjudicationItems.length > 0;
  $("adjudication-frame").hidden = !adjudicationItems.length;
  let target = preferred && adjudicationItems.find((item) => adjudicationKey(item) === adjudicationKey(preferred));
  if (advance && target) {
    const index = adjudicationItems.indexOf(target);
    target = [...adjudicationItems.slice(index + 1), ...adjudicationItems.slice(0, index)].find((item) => !resolvedDecisions().has(adjudicationKey(item))) || target;
  }
  target ||= pending[0] || adjudicationItems[0];
  adjudicationDirty = false; rawDecisionDirty = false;
  if (target) selectAdjudicationFrame(target, true);
  else { selected = null; renderAdjudicationSidebar(); updateAdjudicationControls(); }
}
function selectAdjudicationFrame(item, force = false) {
  if (adjudicationBusy && !force) return;
  if (!force && adjudicationDirty && !confirm("Discard the unsaved decision for this frame?")) return;
  setDecisionDrawing(false);
  selected = item; adjudicationDirty = false; rawDecisionDirty = false;
  decisionDraft = cloneDecision(frameOf(state.merged, item.source, item.filename));
  decisionMode = resolvedDecisions().get(adjudicationKey(item))?.resolution || "edited";
  $("adjudication-title").textContent = item.filename; $("adjudication-title").title = adjudicationKey(item);
  $("adjudication-position").textContent = `Frame ${adjudicationItems.indexOf(item) + 1} of ${adjudicationItems.length}`;
  const reasons = { left_unmatched: "Objects differ in reviewer A", right_unmatched: "Objects differ in reviewer B", out_of_taxonomy: "Out-of-taxonomy concepts differ", frame_coverage: "Frame coverage differs" };
  $("disagreement-summary").textContent = [...item.types].map((type) => reasons[type] || "Review annotations differ").join(" · ");
  $("advanced-decision").open = false;
  renderComparisonObjects("left", frameOf(state.reviewer_a, item.source, item.filename));
  renderComparisonObjects("right", frameOf(state.reviewer_b, item.source, item.filename));
  renderDecisionEditor(); renderAdjudicationSidebar();
  resolutionMessage(resolvedDecisions().has(adjudicationKey(item)) ? "Saved decision loaded. You can revise it before completing." : "Choose a reviewer’s annotations or edit your decision, then save.");
  loadAdjudicationEvidence(item).catch((error) => {
    if (error.name === "AbortError" || adjudicationKey(selected) !== adjudicationKey(item)) return;
    $("adjudication-evidence-status").textContent = error.message;
    $("adjudication-evidence-status").classList.add("error");
  });
}
function renderComparisonObjects(id, frame) {
  $(id + "-count").textContent = `${frame.objects.length} object${frame.objects.length === 1 ? "" : "s"}`;
  const entries = frame.objects.map((object, index) => {
    const row = document.createElement("p"), detail = document.createElement("small");
    row.textContent = `${index + 1}. ${object.label}`;
    detail.textContent = `${object.subset} · x ${object.region[0]}, y ${object.region[1]}, w ${object.region[2]}, h ${object.region[3]}`;
    row.append(detail); return row;
  });
  const audit = document.createElement("p");
  audit.textContent = frame.out_of_taxonomy.length ? `Out of taxonomy: ${frame.out_of_taxonomy.join(", ")}` : "No out-of-taxonomy concepts.";
  if (!entries.length) { const empty = document.createElement("p"); empty.textContent = "No objects annotated."; entries.push(empty); }
  $(id).replaceChildren(...entries, audit);
}
async function loadAdjudicationEvidence(item) {
  evidenceRequest?.abort(); evidenceRequest = new AbortController();
  adjudicationImage = undefined;
  if (adjudicationImageUrl) { URL.revokeObjectURL(adjudicationImageUrl); adjudicationImageUrl = undefined; }
  ["left-canvas", "right-canvas", "decision-canvas"].forEach((id) => { $(id).width = 0; $(id).height = 0; });
  $("adjudication-evidence-status").textContent = "Loading evidence…";
  $("adjudication-evidence-status").classList.remove("error");
  updateAdjudicationControls();
  const response = await fetch(assignmentFrameUrl(item.source, item.filename), { headers: { authorization: `Bearer ${token}` }, signal: evidenceRequest.signal });
  if (!response.ok) throw new Error("Evidence could not be loaded. Use Reload saved decisions to retry.");
  const url = URL.createObjectURL(await response.blob()), image = new Image(); image.src = url;
  try {
    await image.decode();
    if (adjudicationKey(selected) !== adjudicationKey(item)) { URL.revokeObjectURL(url); return; }
    if (image.naturalWidth !== decisionDraft.width || image.naturalHeight !== decisionDraft.height) throw new Error("Evidence dimensions do not match this frame.");
    adjudicationImageUrl = url; adjudicationImage = image;
    $("adjudication-evidence-status").textContent = `${image.naturalWidth} × ${image.naturalHeight} source pixels`;
    drawAdjudicationCanvases(); updateAdjudicationControls();
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}
function drawAdjudicationCanvases() {
  if (!adjudicationImage || !selected) return;
  for (const [id, frame, color] of [["left-canvas", frameOf(state.reviewer_a, selected.source, selected.filename), "#ffcc66"], ["right-canvas", frameOf(state.reviewer_b, selected.source, selected.filename), "#67d7ff"], ["decision-canvas", decisionDraft, "#85efb0"]]) {
    const canvas = $(id); canvas.width = adjudicationImage.naturalWidth; canvas.height = adjudicationImage.naturalHeight;
    const context = canvas.getContext("2d"); context.drawImage(adjudicationImage, 0, 0);
    if (!$("show-regions").checked) continue;
    const font = Math.max(14, canvas.width / Math.max(160, canvas.clientWidth) * 12); context.font = `600 ${font}px system-ui`; context.lineWidth = Math.max(2, canvas.width / 300);
    frame.objects.forEach((object, index) => {
      if (!object.region.every(Number.isFinite)) return;
      const [x, y, width, height] = object.region; context.strokeStyle = color; context.strokeRect(x, y, width, height);
      const label = `${index + 1}. ${object.label}`, labelY = Math.max(font + 5, y);
      const labelWidth = Math.min(canvas.width, context.measureText(label).width + 10), labelX = Math.max(0, Math.min(x, canvas.width - labelWidth));
      context.fillStyle = "#101914e8"; context.fillRect(labelX, labelY - font - 5, labelWidth, font + 8);
      context.fillStyle = color; context.fillText(label, labelX + 5, labelY);
    });
  }
}
function syncDecisionJson() { $("merged").value = JSON.stringify({ objects: decisionDraft.objects, out_of_taxonomy: decisionDraft.out_of_taxonomy }, null, 2); rawDecisionDirty = false; }
function changedDecision() {
  adjudicationDirty = true; decisionMode = "edited"; syncDecisionJson(); updateAdjudicationControls(); drawAdjudicationCanvases();
  resolutionMessage("Unsaved changes. Save this decision before moving on.");
}
function renderDecisionEditor() {
  const rules = state.policy?.annotation_rules || {};
  $("decision-objects").replaceChildren(...decisionDraft.objects.map((object, index) => {
    const row = document.createElement("div"); row.className = "decision-object";
    const fields = document.createElement("div"); fields.className = "object-fields";
    for (const [field, values] of [["label", rules.allowed_labels || COCO_CLASSES], ["subset", rules.allowed_subsets || ["live", "composited", "screen"]]]) {
      const label = document.createElement("label"), select = document.createElement("select");
      label.textContent = field === "label" ? `Object ${index + 1} label` : "Subset";
      for (const value of values) { const option = document.createElement("option"); option.value = value; option.textContent = value; select.append(option); }
      select.value = object[field]; select.onchange = () => { object[field] = select.value; changedDecision(); };
      label.append(select); fields.append(label);
    }
    const coordinates = document.createElement("div"); coordinates.className = "coordinates";
    ["X", "Y", "Width", "Height"].forEach((name, coordinate) => {
      const label = document.createElement("label"), input = document.createElement("input");
      label.textContent = name; input.type = "number"; input.min = coordinate < 2 ? "0" : "0.01"; input.step = "any";
      input.value = object.region[coordinate]; input.setAttribute("aria-label", `Object ${index + 1} ${name}`);
      input.oninput = () => { object.region[coordinate] = input.value === "" ? NaN : Number(input.value); changedDecision(); };
      label.append(input); coordinates.append(label);
    });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary"; remove.textContent = "Remove object";
    remove.setAttribute("aria-label", `Remove object ${index + 1}`);
    remove.onclick = () => { decisionDraft.objects.splice(index, 1); changedDecision(); renderDecisionEditor(); };
    row.append(fields, coordinates, remove); return row;
  }));
  if (!decisionDraft.objects.length) { const text = document.createElement("p"); text.className = "hint"; text.textContent = "No objects in this decision. Check the evidence before saving an empty frame."; $("decision-objects").append(text); }
  $("decision-taxonomy").value = decisionDraft.out_of_taxonomy.join("\n");
  syncDecisionJson(); updateAdjudicationControls(); drawAdjudicationCanvases();
}
function validateDecision(frame) {
  const rules = state.policy?.annotation_rules || {}, labels = rules.allowed_labels || COCO_CLASSES, subsets = rules.allowed_subsets || ["live", "composited", "screen"];
  if (!Array.isArray(frame.objects) || frame.objects.length > (rules.max_objects_per_frame || 200)) throw new Error(`Use at most ${rules.max_objects_per_frame || 200} objects for this frame.`);
  const ids = new Set();
  for (const source of state.merged.sources) for (const other of source.frames) {
    if (source.source === selected.source && other.filename === selected.filename) continue;
    other.objects.forEach((object) => ids.add(object.id));
  }
  for (const object of frame.objects) {
    if (!object || Object.keys(object).some((key) => !["id", "label", "subset", "region"].includes(key)) || typeof object.id !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(object.id) || ids.has(object.id)) throw new Error("Every object needs a unique ID; check for duplicates in the decision.");
    ids.add(object.id);
    if (!labels.includes(object.label) || !subsets.includes(object.subset)) throw new Error("Use the labels and subsets allowed by the instructions.");
    const box = object.region;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || box[0] < 0 || box[1] < 0 || box[2] <= 0 || box[3] <= 0 || box[0] + box[2] > frame.width || box[1] + box[3] > frame.height) throw new Error("Object boxes must have a positive size and stay within the source image.");
  }
  if (!Array.isArray(frame.out_of_taxonomy) || frame.out_of_taxonomy.length > 200 || frame.out_of_taxonomy.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 1000)) throw new Error("Use up to 200 out-of-taxonomy concepts, one non-empty concept per line (1,000 characters each).");
}
function applyDecisionJson() {
  let value;
  try { value = JSON.parse($("merged").value); } catch { throw new Error("Annotation JSON is invalid. Fix its syntax or choose a reviewer to replace the draft."); }
  if (!value || Array.isArray(value) || Object.keys(value).some((key) => !["objects", "out_of_taxonomy"].includes(key))) throw new Error("Annotation JSON accepts only objects and out_of_taxonomy. Frame identity cannot change.");
  const draft = { ...decisionDraft, objects: value.objects, out_of_taxonomy: value.out_of_taxonomy };
  validateDecision(draft); decisionDraft = draft; changedDecision(); renderDecisionEditor();
}
function chooseReviewer(side) {
  if (!decisionEditable() || !adjudicationImage) return;
  if (adjudicationDirty && !confirm("Replace the unsaved decision with this reviewer’s annotations?")) return;
  setDecisionDrawing(false);
  decisionDraft = cloneDecision(frameOf(state[side === "a" ? "reviewer_a" : "reviewer_b"], selected.source, selected.filename));
  decisionMode = side === "a" ? "reviewer_a" : "reviewer_b"; adjudicationDirty = true;
  renderDecisionEditor(); resolutionMessage(`Reviewer ${side.toUpperCase()} copied to your draft. Save to record this decision.`);
}
async function saveAdjudicationDecision() {
  if (!decisionEditable() || !adjudicationImage || adjudicationNeedsReload) return;
  let saved = false;
  try {
    if (rawDecisionDirty) applyDecisionJson();
    validateDecision(decisionDraft);
    adjudicationBusy = true; updateAdjudicationControls(); renderAdjudicationSidebar(); resolutionMessage("Saving decision…");
    const current = { ...selected };
    const result = await api(`${identity.links.state}/frames/${encodeURIComponent(current.source)}/${encodeURIComponent(current.filename)}`, { method: "PUT", headers: mutationHeaders(), body: JSON.stringify({ frame: decisionDraft, resolution: decisionMode }) });
    state.revision = result.revision; adjudicationDirty = false; saved = true;
    await loadAdjudication(current, true);
    $("adjudication-title").focus();
    resolutionMessage(remainingDecisions().length ? "Decision saved. The next unresolved frame is ready." : "All disagreement frames have saved decisions. You can complete adjudication.");
  } catch (error) {
    if (saved || error.status === 412) adjudicationNeedsReload = true;
    resolutionMessage(saved ? "Decision saved, but the latest state could not be loaded. Reload saved decisions before continuing." : `${error.message}${error.status === 412 ? " Reload saved decisions before trying again." : ""}`, true);
  } finally { adjudicationBusy = false; updateAdjudicationControls(); renderAdjudicationSidebar(); }
}
$("disagreement-filter").onchange = renderAdjudicationSidebar;
$("disagreement-search").oninput = renderAdjudicationSidebar;
$("show-regions").onchange = drawAdjudicationCanvases;
addEventListener("resize", () => requestAnimationFrame(drawAdjudicationCanvases));
$("previous-frame").onclick = () => { const index = adjudicationItems.indexOf(selected); if (index > 0) selectAdjudicationFrame(adjudicationItems[index - 1]); };
$("next-frame").onclick = () => { const index = adjudicationItems.indexOf(selected); if (index >= 0 && index < adjudicationItems.length - 1) selectAdjudicationFrame(adjudicationItems[index + 1]); };
$("next-unresolved").onclick = () => {
  const index = adjudicationItems.indexOf(selected);
  const next = [...adjudicationItems.slice(index + 1), ...adjudicationItems.slice(0, index)].find((item) => !resolvedDecisions().has(adjudicationKey(item)));
  if (next) selectAdjudicationFrame(next);
};
$("use-a").onclick = () => chooseReviewer("a");
$("use-b").onclick = () => chooseReviewer("b");
function addDecisionObject(region) {
  if (!decisionEditable() || rawDecisionDirty || !adjudicationImage) return;
  const rules = state.policy?.annotation_rules || {};
  if (decisionDraft.objects.length >= (rules.max_objects_per_frame || 200)) { resolutionMessage("This frame has reached the object limit in the instructions.", true); return; }
  decisionDraft.objects.push({ id: `decision-${crypto.randomUUID()}`, label: (rules.allowed_labels || COCO_CLASSES)[0], subset: (rules.allowed_subsets || ["live"])[0], region });
  changedDecision(); renderDecisionEditor();
}
function setDecisionDrawing(enabled) {
  decisionDrawing = enabled; decisionDrawingStart = undefined;
  $("draw-decision-box").setAttribute("aria-pressed", String(enabled));
  $("draw-decision-box").textContent = enabled ? "Cancel drawing" : "Draw object box";
  $("decision-canvas").classList.toggle("drawing", enabled);
}
$("draw-decision-box").onclick = () => {
  setDecisionDrawing(!decisionDrawing);
  resolutionMessage(decisionDrawing ? "Drag on your decision image to add an object, then choose its label and subset." : "Drawing cancelled.");
  drawAdjudicationCanvases();
};
const decisionCanvas = $("decision-canvas");
function decisionPoint(event) {
  const bounds = decisionCanvas.getBoundingClientRect();
  return [Math.max(0, Math.min(decisionCanvas.width, Math.round((event.clientX - bounds.left) * decisionCanvas.width / bounds.width))), Math.max(0, Math.min(decisionCanvas.height, Math.round((event.clientY - bounds.top) * decisionCanvas.height / bounds.height)))];
}
decisionCanvas.addEventListener("pointerdown", (event) => {
  if (!decisionDrawing || !decisionEditable() || !adjudicationImage || rawDecisionDirty) return;
  decisionDrawingStart = decisionPoint(event); decisionCanvas.setPointerCapture(event.pointerId);
});
decisionCanvas.addEventListener("pointermove", (event) => {
  if (!decisionDrawingStart) return;
  const point = decisionPoint(event), context = decisionCanvas.getContext("2d"); drawAdjudicationCanvases();
  context.strokeStyle = "#ffe08a"; context.setLineDash([8, 5]);
  context.strokeRect(decisionDrawingStart[0], decisionDrawingStart[1], point[0] - decisionDrawingStart[0], point[1] - decisionDrawingStart[1]); context.setLineDash([]);
});
decisionCanvas.addEventListener("pointerup", (event) => {
  if (!decisionDrawingStart) return;
  const start = decisionDrawingStart, end = decisionPoint(event); setDecisionDrawing(false);
  const region = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1])];
  if (region[2] < 4 || region[3] < 4) { resolutionMessage("Drag a box at least 4 source pixels wide and high.", true); drawAdjudicationCanvases(); return; }
  addDecisionObject(region);
});
decisionCanvas.addEventListener("pointercancel", () => { setDecisionDrawing(false); drawAdjudicationCanvases(); });
$("add-decision-object").onclick = () => addDecisionObject([0, 0, Math.min(100, decisionDraft.width), Math.min(100, decisionDraft.height)]);
$("decision-taxonomy").oninput = () => { decisionDraft.out_of_taxonomy = $("decision-taxonomy").value.split("\n").map((value) => value.trim()).filter(Boolean); changedDecision(); };
$("merged").oninput = () => { rawDecisionDirty = true; adjudicationDirty = true; updateAdjudicationControls(); resolutionMessage("Apply the annotation JSON to update the draft and its preview."); };
$("apply-decision-json").onclick = () => { try { applyDecisionJson(); } catch (error) { resolutionMessage(error.message, true); } };
$("save-resolution").onclick = saveAdjudicationDecision;
$("refresh-adjudication").onclick = $("reload-adjudication").onclick = async () => {
  if (adjudicationBusy || (adjudicationDirty && !confirm("Discard unsaved changes and reload the saved decisions?"))) return;
  adjudicationBusy = true; updateAdjudicationControls();
  try { await loadAdjudication(); } catch (error) { resolutionMessage(error.message, true); $("adjudication-status").textContent = error.message; $("adjudication-status").classList.add("error"); }
  finally { adjudicationBusy = false; updateAdjudicationControls(); renderAdjudicationSidebar(); }
};
$("complete-adjudication").onclick = () => { if (!$("complete-adjudication").disabled) $("complete-dialog").showModal(); };
$("confirm-complete").onclick = async () => {
  if ($("confirm-complete").disabled) return;
  adjudicationBusy = true; updateAdjudicationControls();
  try {
    const result = await api(`${identity.links.state}/complete`, { method: "POST", headers: mutationHeaders(), body: "{}" });
    state.revision = result.revision; state.assignment.status = "complete"; state.result_url = result.result_url;
    $("complete-dialog").close(); await loadAdjudication();
  } catch (error) {
    $("complete-dialog").close(); $("adjudication-status").textContent = error.message; $("adjudication-status").classList.add("error");
  } finally { adjudicationBusy = false; updateAdjudicationControls(); renderAdjudicationSidebar(); }
};
$("download-result").onclick = async () => {
  try {
    const response = await fetch(state.result_url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("The result could not be downloaded. Try again.");
    const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
    link.href = url; link.download = "adjudicated-annotations.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { $("adjudication-status").textContent = error.message; }
};
addEventListener("beforeunload", (event) => { if (adjudicationDirty) { event.preventDefault(); event.returnValue = ""; } });

$("open").onclick = () => login().catch((error) => { $("login-status").textContent = error.message; });
$("assigned-login-form").onsubmit = async (event) => {
  event.preventDefault();
  const submit = $("assigned-login-form").querySelector("[type=submit]");
  submit.disabled = true;
  $("assigned-login-status").textContent = "Requesting a sign-in link...";
  try {
    const response = await fetch("/api/internal/v1/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: $("assigned-email").value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || "Could not request a sign-in link");
    $("assigned-login-status").textContent = "If the address is assigned and verified, a sign-in link has been sent. Open it in this browser, then return here.";
  } catch (error) {
    $("assigned-login-status").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
$("retry-assignment").onclick = () => login().catch((error) => { $("assigned-login-status").textContent = error.message; });
$("save-review").onclick = () => saveReview(false).catch((error) => alert(error.message));
$("mark-reviewed").onclick = () => saveReview(true).catch((error) => alert(error.message));
$("complete-review").onclick = async () => {
  try { await saveReview(false); await api(`${identity.links.state}/complete`, { method: "POST", headers: mutationHeaders(), body: "{}" }); await loadReviewer(); }
  catch (error) { alert(error.message); }
};

consumeInvitation();
$("token").value = token;
if (token) login().catch((error) => { $("login-status").textContent = error.message; });
