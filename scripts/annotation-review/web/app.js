const COCO_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog",
  "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
  "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
  "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
  "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich",
  "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
  "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
  "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book",
  "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
];

const state = { payload: null, sourceIndex: 0, frameIndex: 0, image: new Image(), drawing: false, start: null, detector: null, suggestions: [] };
const $ = (id) => document.getElementById(id);

function currentSource() { return state.payload.sources[state.sourceIndex]; }
function currentFrame() { return currentSource().frames[state.frameIndex]; }
function frameKey() { return `${currentSource().source}/${currentFrame().filename}`; }
function reviewedFrames() { return state.payload.review.reviewed_frames || (state.payload.review.reviewed_frames = []); }
function assistedReview() {
  return state.payload.review.assisted_review || (state.payload.review.assisted_review = {
    reviewed_frames: [], completed_passes: 0, status: "not_started"
  });
}
function assistedReviewedFrames() { return assistedReview().reviewed_frames; }
function setStatus(text, error = false) { $("save-status").textContent = text; $("save-status").style.color = error ? "#a94025" : ""; }
function setMode(mode) {
  const browser = mode === "browser";
  $("browser-panel").hidden = !browser;
  $("agent-panel").hidden = browser;
  $("browser-tab").classList.toggle("active", browser);
  $("agent-tab").classList.toggle("active", !browser);
  $("browser-tab").setAttribute("aria-selected", String(browser));
  $("agent-tab").setAttribute("aria-selected", String(!browser));
}
function setLayout(layout) {
  const assisted = layout === "assisted";
  $("workspace").classList.toggle("assisted", assisted);
  $("assisted-switcher").hidden = !assisted;
  $("manual-tab").classList.toggle("active", !assisted);
  $("assisted-tab").classList.toggle("active", assisted);
  $("manual-tab").setAttribute("aria-selected", String(!assisted));
  $("assisted-tab").setAttribute("aria-selected", String(assisted));
  document.querySelectorAll(".manual-only").forEach((element) => { element.hidden = assisted; });
  document.querySelectorAll(".assisted-only").forEach((element) => { element.hidden = !assisted; });
  $("manual-review").hidden = !assisted;
  $("assisted-mark-reviewed").hidden = !assisted;
  $("complete-assisted-pass").hidden = !assisted;
  if (assisted) setMode("browser");
}
async function loadBundles() {
  const response = await fetch("/api/bundles");
  const result = await response.json();
  $("bundle-list").innerHTML = result.bundles.length
    ? result.bundles.map((bundle) => `<div class="bundle-link"><span>${bundle.name}</span><a href="${bundle.url}">Download ZIP</a></div>`).join("")
    : `<span class="muted">No bundles yet. Generate them from this panel.</span>`;
}
function recordAssistedDecision(decision, suggestion) {
  const review = state.payload.review;
  review.assisted_review = review.assisted_review || { model: $("model-id").value, decisions: [] };
  review.assisted_review.model = $("model-id").value;
  review.assisted_review.decisions.push({ source: currentSource().source, filename: currentFrame().filename, decision, suggestion });
}

function populateLabels() {
  $("label").innerHTML = COCO_CLASSES.map((label) => `<option>${label}</option>`).join("");
}

function populateSources() {
  $("source").innerHTML = state.payload.sources.map((source, index) => `<option value="${index}">${source.source}</option>`).join("");
  $("source").value = state.sourceIndex;
  populateFrames();
}

function populateFrames() {
  const source = currentSource();
  $("frame").innerHTML = source.frames.map((frame, index) => `<option value="${index}">${String(index + 1).padStart(2, "0")} · ${frame.filename}</option>`).join("");
  $("frame").value = state.frameIndex;
  loadFrame();
}

function loadFrame() {
  const frame = currentFrame();
  const source = currentSource();
  state.image = new Image();
  state.image.onload = () => { drawCanvas(); renderFrameDetails(); };
  state.image.onerror = () => setStatus("Could not load frame", true);
  state.image.src = `/api/frame?source=${encodeURIComponent(source.source)}&filename=${encodeURIComponent(frame.filename)}`;
  renderFrameDetails();
}

function renderFrameDetails() {
  const frame = currentFrame();
  const total = state.payload.sources.reduce((sum, source) => sum + source.frames.length, 0);
  const position = state.payload.sources.slice(0, state.sourceIndex).reduce((sum, source) => sum + source.frames.length, 0) + state.frameIndex + 1;
  $("frame-title").textContent = frame.filename;
  $("timestamp").textContent = `${Number(frame.timestamp_sec).toFixed(3)} sec`;
  $("frame-status").textContent = `${position} of ${total} frames · ${frame.objects.length} objects recorded`;
  $("progress-bar").style.width = `${position / total * 100}%`;
  $("mark-reviewed").textContent = reviewedFrames().includes(frameKey()) ? "Frame reviewed" : "Mark frame reviewed";
  $("assisted-mark-reviewed").textContent = assistedReviewedFrames().includes(frameKey()) ? "Assisted frame reviewed" : "Mark assisted frame reviewed";
  $("out-of-taxonomy").value = (frame.out_of_taxonomy || []).join("\n");
  $("pass-state").textContent = `${state.payload.review.independent_passes} / 2`;
  renderObjectList();
}

function drawCanvas() {
  const canvas = $("canvas");
  if (!state.image.naturalWidth) return;
  canvas.width = state.image.naturalWidth;
  canvas.height = state.image.naturalHeight;
  const context = canvas.getContext("2d");
  context.drawImage(state.image, 0, 0);
  context.font = "bold 16px sans-serif";
  currentFrame().objects.forEach((object, index) => {
    const [x, y, width, height] = object.region;
    context.strokeStyle = index % 2 ? "#f2c14e" : "#e2643b";
    context.lineWidth = Math.max(3, canvas.width / 500);
    context.strokeRect(x, y, width, height);
    context.fillStyle = context.strokeStyle;
    context.fillRect(x, Math.max(0, y - 22), context.measureText(object.label).width + 12, 22);
    context.fillStyle = "#fff";
    context.fillText(object.label, x + 6, Math.max(16, y - 6));
  });
  state.suggestions.forEach((suggestion) => {
    const [x, y, width, height] = suggestion.region;
    context.strokeStyle = "#3dc3d5";
    context.setLineDash([8, 5]);
    context.lineWidth = Math.max(3, canvas.width / 500);
    context.strokeRect(x, y, width, height);
    context.setLineDash([]);
  });
}

function renderObjectList() {
  $("object-list").innerHTML = currentFrame().objects.map((object, index) => `
    <div class="object-row"><span><strong>${index + 1}.</strong> ${object.label} · ${object.subset} · [${object.region.join(", ")}]</span>
    <button data-remove="${index}" title="Remove this object">Remove</button></div>`).join("") || `<span class="muted">No objects recorded. Inspect the image before leaving this empty.</span>`;
  $("object-list").querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
    currentFrame().objects.splice(Number(button.dataset.remove), 1);
    drawCanvas(); renderFrameDetails();
  }));
  $("suggestion-list").innerHTML = state.suggestions.map((suggestion, index) => `
    <div class="suggestion-row"><span>Suggestion: ${suggestion.label} · ${(suggestion.score * 100).toFixed(0)}%</span>
    <span><button data-accept="${index}">Confirm</button><button data-reject="${index}">Reject</button></span></div>`).join("");
  $("suggestion-list").querySelectorAll("[data-accept]").forEach((button) => button.addEventListener("click", () => acceptSuggestion(Number(button.dataset.accept))));
  $("suggestion-list").querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", () => rejectSuggestion(Number(button.dataset.reject))));
}

function acceptSuggestion(index) {
  const suggestion = state.suggestions[index];
  currentFrame().objects.push({ id: `assisted-${Date.now()}-${currentFrame().objects.length + 1}`, label: suggestion.label, subset: $("subset").value, region: suggestion.region });
  recordAssistedDecision("accepted", suggestion);
  state.suggestions.splice(index, 1); drawCanvas(); renderFrameDetails(); setStatus("Suggestion confirmed; save metadata");
}

function rejectSuggestion(index) {
  const suggestion = state.suggestions[index];
  recordAssistedDecision("rejected", suggestion);
  state.suggestions.splice(index, 1); drawCanvas(); renderFrameDetails(); setStatus("Suggestion rejected; save metadata");
}

function markAssistedFrameReviewed() {
  if (state.suggestions.length) {
    setStatus("Confirm or reject every suggestion first", true);
    return;
  }
  if (!assistedReviewedFrames().includes(frameKey())) assistedReviewedFrames().push(frameKey());
  assistedReview().status = "in_progress";
  renderFrameDetails(); setStatus("Assisted frame reviewed; save metadata");
}

function completeAssistedPass() {
  const total = state.payload.sources.reduce((sum, source) => sum + source.frames.length, 0);
  if (assistedReviewedFrames().length !== total) {
    setStatus(`Review all ${total} assisted frames before completing the pass`, true);
    return;
  }
  assistedReview().completed_passes = 1;
  assistedReview().status = "complete";
  renderFrameDetails(); setStatus("Assisted pass complete; save metadata");
}

function canvasPoint(event) {
  const bounds = $("canvas").getBoundingClientRect();
  return {
    x: Math.round((event.clientX - bounds.left) * $("canvas").width / bounds.width),
    y: Math.round((event.clientY - bounds.top) * $("canvas").height / bounds.height)
  };
}

$("canvas").addEventListener("pointerdown", (event) => {
  if (!state.image.naturalWidth) return;
  state.drawing = true; state.start = canvasPoint(event); $("canvas").setPointerCapture(event.pointerId);
});
$("canvas").addEventListener("pointerup", (event) => {
  if (!state.drawing) return;
  state.drawing = false;
  const end = canvasPoint(event);
  const x = Math.min(state.start.x, end.x); const y = Math.min(state.start.y, end.y);
  const width = Math.abs(end.x - state.start.x); const height = Math.abs(end.y - state.start.y);
  if (width >= 8 && height >= 8) {
    currentFrame().objects.push({ id: `review-${Date.now()}-${currentFrame().objects.length + 1}`, label: $("label").value, subset: $("subset").value, region: [x, y, width, height] });
  }
  drawCanvas(); renderFrameDetails();
});

$("source").addEventListener("change", (event) => { state.sourceIndex = Number(event.target.value); state.frameIndex = 0; populateFrames(); });
$("frame").addEventListener("change", (event) => { state.frameIndex = Number(event.target.value); loadFrame(); });
$("load-model").addEventListener("click", async () => {
  const modelStatus = $("model-status");
  modelStatus.textContent = "Downloading model...";
  try {
    const { env, pipeline } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm");
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    state.detector = await pipeline("object-detection", $("model-id").value, { device: "webgpu" });
    $("suggest-frame").disabled = false;
    modelStatus.textContent = "Ready in browser";
  } catch (error) {
    modelStatus.textContent = `Model failed: ${error.message}`;
    setStatus("Browser model could not load", true);
  }
});
$("suggest-frame").addEventListener("click", async () => {
  if (!state.detector) return;
  $("suggest-frame").disabled = true;
  $("model-status").textContent = "Inspecting frame locally...";
  try {
    const detections = await state.detector(state.image, { threshold: 0.35 });
    state.suggestions = detections.filter((item) => COCO_CLASSES.includes(item.label)).map((item) => ({
      label: item.label, score: item.score, region: [Math.round(item.box.xmin), Math.round(item.box.ymin), Math.round(item.box.xmax - item.box.xmin), Math.round(item.box.ymax - item.box.ymin)]
    }));
    $("model-status").textContent = `${state.suggestions.length} suggestions; confirm or reject each`;
    drawCanvas(); renderFrameDetails();
  } catch (error) {
    $("model-status").textContent = `Inference failed: ${error.message}`;
  } finally { $("suggest-frame").disabled = false; }
});
$("clear-frame").addEventListener("click", () => { currentFrame().objects = []; drawCanvas(); renderFrameDetails(); });
$("mark-reviewed").addEventListener("click", () => {
  if (!reviewedFrames().includes(frameKey())) reviewedFrames().push(frameKey());
  renderFrameDetails(); setStatus("Frame marked reviewed; save metadata");
});
$("complete-pass").addEventListener("click", () => {
  const total = state.payload.sources.reduce((sum, source) => sum + source.frames.length, 0);
  if (reviewedFrames().length !== total) {
    setStatus(`Review all ${total} frames before completing the pass`, true);
    return;
  }
  state.payload.review.independent_passes = 1;
  state.payload.review.adjudication_status = "in_progress";
  renderFrameDetails(); setStatus("Pass marked complete; save metadata", false);
});
$("out-of-taxonomy").addEventListener("input", (event) => { currentFrame().out_of_taxonomy = event.target.value.split("\n").map((value) => value.trim()).filter(Boolean); });
$("save").addEventListener("click", async () => {
  setStatus("Saving...");
  const response = await fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.payload) });
  const result = await response.json();
  setStatus(response.ok ? `Saved ${new Date().toLocaleTimeString()}` : result.error, !response.ok);
});
$("browser-tab").addEventListener("click", () => setMode("browser"));
$("agent-tab").addEventListener("click", async () => {
  setMode("agent");
  await loadBundles();
});
$("generate-bundles").addEventListener("click", async () => {
  $("generate-bundles").disabled = true;
  setStatus("Generating agent bundles...");
  const response = await fetch("/api/bundles/generate", { method: "POST" });
  const result = await response.json();
  if (!response.ok) setStatus(result.error, true);
  else { await loadBundles(); setStatus("Bundles ready to download"); }
  $("generate-bundles").disabled = false;
});
$("manual-tab").addEventListener("click", () => setLayout("manual"));
$("assisted-tab").addEventListener("click", () => setLayout("assisted"));
$("manual-review").addEventListener("click", () => setLayout("manual"));
$("assisted-mark-reviewed").addEventListener("click", markAssistedFrameReviewed);
$("complete-assisted-pass").addEventListener("click", completeAssistedPass);
$("import-agent").addEventListener("click", async () => {
  const file = $("agent-file").files[0];
  if (!file) { setStatus("Choose an agent JSONC response first", true); return; }
  setStatus("Importing agent response...");
  const response = await fetch("/api/import-agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: await file.text() }) });
  const result = await response.json();
  if (!response.ok) { setStatus(result.error, true); return; }
  state.payload = result.annotations || state.payload;
  const refreshed = await fetch("/api/state");
  state.payload = (await refreshed.json()).annotations;
  loadFrame(); setStatus("Agent response imported; human review status unchanged");
});

fetch("/api/state").then((response) => response.json()).then((result) => {
  state.payload = result.annotations; populateLabels(); populateSources(); setLayout("manual"); setStatus("Unsaved changes");
}).catch(() => setStatus("Could not load annotation file", true));