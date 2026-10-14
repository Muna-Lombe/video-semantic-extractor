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
  if (!response.ok) throw new Error(result.error?.message || result.error || "Request failed");
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
  $("policy-instructions").textContent = policy.document;
}
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
  $("object-label").replaceChildren(...COCO_CLASSES.map((label) => {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    return option;
  }));
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

async function loadAdjudication() {
  state = await api(identity.links.state);
  renderPolicy(state.policy);
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
  ["use-a", "use-b", "save-resolution"].forEach((id) => { $(id).disabled = state.assignment.status === "complete"; });
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
  await api(path, { method: "PUT", headers: mutationHeaders(), body: JSON.stringify({ frame, resolution }) });
  selected = null;
  await loadAdjudication();
}

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
$("use-a").onclick = () => selected && resolve(frameOf(state.reviewer_a, selected.source, selected.filename), "reviewer_a").catch((error) => alert(error.message));
$("use-b").onclick = () => selected && resolve(frameOf(state.reviewer_b, selected.source, selected.filename), "reviewer_b").catch((error) => alert(error.message));
$("save-resolution").onclick = () => { try { resolve(JSON.parse($("merged").value), "edited").catch((error) => alert(error.message)); } catch { alert("Merged decision must be valid JSON"); } };
$("complete-adjudication").onclick = async () => { try { await api(`${identity.links.state}/complete`, { method: "POST", headers: mutationHeaders(), body: "{}" }); await loadAdjudication(); } catch (error) { alert(error.message); } };

consumeInvitation();
$("token").value = token;
if (token) login().catch((error) => { $("login-status").textContent = error.message; });
