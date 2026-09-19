/** @type implementation @purpose Drive isolated comparison and adjudication actions. */
const $ = (id) => document.getElementById(id);
let state;
let selected;
const frameOf = (payload, source, filename) => payload.sources.find((item) => item.source === source).frames.find((frame) => frame.filename === filename);
const keyOf = (item) => `${item.source}/${item.filename}`;
async function load() { state = await (await fetch("/api/state")).json(); renderList(); }
function renderList() {
  const grouped = new Map();
  for (const item of state.comparison.disagreements) if (item.source && item.filename) grouped.set(keyOf(item), item);
  const resolved = new Set(state.merged.review.adjudication_log.map(keyOf));
  $("frames").replaceChildren(...[...grouped.values()].map((item) => {
    const button = document.createElement("button"); button.className = `frame ${resolved.has(keyOf(item)) ? "resolved" : ""}`;
    button.textContent = keyOf(item); button.onclick = () => select(item); return button;
  }));
  $("status").textContent = `${resolved.size}/${grouped.size} disagreement frames resolved`;
}
function select(item) {
  selected = item; const {source, filename} = item; $("title").textContent = keyOf(item);
  $("image").src = `/api/frame?source=${encodeURIComponent(source)}&filename=${encodeURIComponent(filename)}`;
  const left = frameOf(state.reviewer_a, source, filename), right = frameOf(state.reviewer_b, source, filename), merged = frameOf(state.merged, source, filename);
  $("left").textContent = JSON.stringify(left, null, 2); $("right").textContent = JSON.stringify(right, null, 2); $("merged").value = JSON.stringify(merged, null, 2);
}
async function resolve(frame, resolution) {
  if (!selected) return; const response = await fetch("/api/resolve", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...selected,frame,resolution})});
  const result = await response.json(); if (!response.ok) return alert(result.error); await load(); select(selected);
}
$("use-a").onclick = () => resolve(frameOf(state.reviewer_a, selected.source, selected.filename), "reviewer_a");
$("use-b").onclick = () => resolve(frameOf(state.reviewer_b, selected.source, selected.filename), "reviewer_b");
$("save").onclick = () => { try { resolve(JSON.parse($("merged").value), "edited"); } catch { alert("Merged decision must be valid JSON"); } };
$("complete").onclick = async () => { const response = await fetch("/api/complete", {method:"POST",headers:{"content-type":"application/json"},body:"{}"}); const result = await response.json(); if (!response.ok) return alert(result.error); await load(); $("status").textContent = "Adjudication complete"; };
load();
