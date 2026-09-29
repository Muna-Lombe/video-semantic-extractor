/** @type implementation @purpose Drive the Cloudflare-hosted adjudication workspace. */
const $ = (id) => document.getElementById(id);
let state;
let selected;
let reviewId;
let token;

const keyOf = (item) => `${item.source}/${item.filename}`;
const frameOf = (payload, source, filename) => payload.sources
  .find((item) => item.source === source).frames
  .find((frame) => frame.filename === filename);

async function api(path, options = {}) {
  const response = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}${path}`, {
    ...options,
    headers: { ...options.headers, authorization: `Bearer ${token}` },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

async function load() {
  state = await api("/state");
  render();
}

function render() {
  const grouped = new Map();
  for (const item of state.comparison.disagreements) {
    if (item.source && item.filename) grouped.set(keyOf(item), item);
  }
  const resolved = new Set(state.merged.review.adjudication_log.map(keyOf));
  $("frames").replaceChildren(...[...grouped.values()].map((item) => {
    const button = document.createElement("button");
    button.className = `frame ${resolved.has(keyOf(item)) ? "resolved" : ""}`;
    button.textContent = keyOf(item);
    button.onclick = () => select(item);
    return button;
  }));
  $("message").textContent = state.merged.review.adjudication_status === "complete"
    ? `Complete — GET ${state.result_url}`
    : `${resolved.size}/${grouped.size} disagreement frames resolved`;
  $("complete").disabled = state.merged.review.adjudication_status === "complete";
}

function select(item) {
  selected = item;
  const { source, filename } = item;
  $("title").textContent = keyOf(item);
  $("image").src = `/api/reviews/${encodeURIComponent(reviewId)}/frame?source=${encodeURIComponent(source)}&filename=${encodeURIComponent(filename)}&token=${encodeURIComponent(token)}`;
  $("left").textContent = JSON.stringify(frameOf(state.reviewer_a, source, filename), null, 2);
  $("right").textContent = JSON.stringify(frameOf(state.reviewer_b, source, filename), null, 2);
  $("merged").value = JSON.stringify(frameOf(state.merged, source, filename), null, 2);
}

async function resolve(frame, resolution) {
  if (!selected) return;
  try {
    await api("/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: selected.source, filename: selected.filename, frame, resolution }) });
    await load();
    select(selected);
  } catch (error) {
    alert(error.message);
  }
}

$("open").onclick = async () => {
  reviewId = $("review-id").value.trim();
  token = $("token").value;
  try {
    await load();
    $("login").hidden = true;
    $("app").hidden = false;
    history.replaceState({}, "", `${location.pathname}?review=${encodeURIComponent(reviewId)}`);
  } catch (error) {
    alert(error.message);
  }
};
$("use-a").onclick = () => selected && resolve(frameOf(state.reviewer_a, selected.source, selected.filename), "reviewer_a");
$("use-b").onclick = () => selected && resolve(frameOf(state.reviewer_b, selected.source, selected.filename), "reviewer_b");
$("save").onclick = () => {
  try { resolve(JSON.parse($("merged").value), "edited"); }
  catch { alert("Merged decision must be valid JSON"); }
};
$("complete").onclick = async () => {
  try { await api("/complete", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await load(); }
  catch (error) { alert(error.message); }
};
$("review-id").value = new URLSearchParams(location.search).get("review") || "";
