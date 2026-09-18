<!--
@type documentation
@purpose Describe the end-to-end prediction-blind object annotation workflow and review tooling.
-->

# Object annotation review workflow

## Purpose

The repository provides a prediction-blind workflow for reviewing the five supplied
videos. It creates checksum-bound frame evidence, supports human annotation in a
local browser, supports optional assisted handoff to a multimodal agent, and keeps
review status separate from imported or model-generated suggestions.

An initialized template, an agent response, or a browser-model suggestion is not
human-reviewed ground truth. Detector scoring remains blocked until two independent
reviews, adjudication, validation, and the corpus adequacy gates are complete.

## Prepare evidence

Run from the repository root. The repository virtual environment is recommended
because the sampling tools require OpenCV:

```bash
mkdir -p /tmp/video-sample-diagnostics
for video in sample-input-media/videos/*.mp4; do
  sample="$(basename "$video" .mp4)"
  .venv/bin/python scripts/diagnostics/compare-frame-sampling.py \
    "$video" "/tmp/video-sample-diagnostics/$sample"
done
.venv/bin/python scripts/diagnostics/initialize-object-annotations.py \
  /tmp/video-sample-diagnostics \
  /tmp/video-sample-diagnostics/reviewer-a.json
```

The initializer imports every hybrid-manifest frame, binds each source to the
sampling report SHA-256, rejects unsafe or duplicate frame paths, and writes empty
`objects` and `out_of_taxonomy` lists. These lists are templates, not confirmed
negative labels. It refuses to overwrite an existing output unless `--force` is
provided.

## Local review SPA

Start one server per reviewer, using a separate output JSON path:

```bash
.venv/bin/python scripts/annotation-review/server.py \
  /tmp/video-sample-diagnostics \
  /tmp/video-sample-diagnostics/reviewer-a.json
```

Open `http://127.0.0.1:8765/`. The SPA provides source and frame navigation, native
source-pixel box drawing, COCO class and `live`/`composited`/`screen` selection,
explicit reviewed-frame markers, out-of-taxonomy notes, and atomic JSON metadata
saves. A pass cannot be marked complete until every manifest frame is marked
reviewed, including negative frames.

The server serves only images already referenced by the checksum-bound manifest and
rejects path traversal, unknown frames, source identity changes, checksum changes,
and policy-version changes on save. Image bytes are never embedded in annotation
JSON.

## Assistance modes

The sidebar switches between two mutually exclusive modes.

### Browser model

The browser-model tab can load a Transformers.js object-detection model and run
inference against the current image. The default model is `Xenova/yolos-tiny`; the
model ID is configurable in the UI. Suggestions are drawn with dashed boxes and
must be individually **Confirm**ed or **Reject**ed.

Confirmed suggestions become annotation objects, while every decision is recorded
under `review.assisted_review`. Browser suggestions never count as an independent
review pass. After resolving every suggestion on a frame, use **Mark assisted frame
reviewed**. Once all manifest frames are covered, **Complete assisted pass** records
an assisted completion without changing `review.independent_passes`. MiniCPM-V 2.6 is not the default because it is a general multimodal
model, not a small browser-native COCO box detector; a compatible browser model can
be substituted when its runtime supports object-detection output.

### Agent handoff

The Agent handoff tab generates and lists one ZIP per source video directly in the
SPA. Each ZIP contains:

- `frames/`: retained native-resolution images for one source video.
- `README.md`: the prediction-blind task, annotation rules, and response example.
- `schema.json`: handoff schema version `1.0`.
- `annotations.jsonc`: a response template with exact filenames and timestamps.

The same bundles can be generated from the command line:

```bash
.venv/bin/python scripts/annotation-review/export-agent-bundles.py \
  /tmp/video-sample-diagnostics/reviewer-a.json \
  /tmp/video-sample-diagnostics \
  /tmp/video-sample-diagnostics/agent-bundles
```

The agent response may contain `//` comments and trailing commas. The SPA importer
checks source name, source SHA-256, exact manifest frame set, timestamps, and
annotation list types before merging `objects` and `out_of_taxonomy`. It never
changes `reviewed_frames`, `independent_passes`, or adjudication status. Agent
output is assisted annotation, not an independent human review pass. Agent-imported
frames still require the same assisted frame-review and completion actions.

## Independent review and adjudication

Use separate initialized copies for reviewer A and reviewer B. Keep candidate model
predictions hidden during both independent passes. After both passes, compare them:

```bash
.venv/bin/python scripts/diagnostics/compare-object-reviews.py \
  /tmp/video-sample-diagnostics/reviewer-a.json \
  /tmp/video-sample-diagnostics/reviewer-b.json \
  /tmp/video-sample-diagnostics/review-comparison.json
```

The comparison is non-mutating. It reports missing frames, unmatched objects, and
out-of-taxonomy differences. Object agreement uses matching class, matching subset,
and at least 0.8 box IoU; reviewer-local IDs do not create false disagreements.
Every disagreement requires a third adjudication pass. Genuine ambiguity is excluded
from scored ground truth and recorded in `review.adjudication_log`.

## Validation gate

Validate the merged fixture before any detector report is inspected:

```bash
.venv/bin/python scripts/diagnostics/validate-object-annotations.py \
  /tmp/video-sample-diagnostics/reviewer-a.json \
  /tmp/video-sample-diagnostics \
  /tmp/video-sample-diagnostics/object-annotation-validation.json
```

The validator checks policy version, exact five-source identity, checksums, manifest
coverage, timestamps, decodable frames, unique IDs, allowed classes and subsets,
minimum box size, image bounds, explicit reviewed-frame coverage, and completed
review metadata. It reports validity separately from corpus adequacy. Use
`--allow-incomplete` only while accumulating a structurally valid draft; it does not
waive evidence or annotation errors.

## Tests and current status

Focused tests cover initializer safety, review comparison, local server save/import,
and agent ZIP export. JavaScript and Python syntax checks are also available:

```bash
node --check scripts/annotation-review/web/app.js
python -m py_compile scripts/annotation-review/server.py \
  scripts/annotation-review/export-agent-bundles.py
pytest -q backend/tests/test_annotation_agent_bundles.py \
  backend/tests/test_annotation_review_server.py \
  backend/tests/test_object_review_comparison.py \
  backend/tests/test_object_annotation_initialization.py
```

The OpenCV-dependent validator tests require the repository environment with `cv2`.
The human review state remains incomplete until two genuinely independent passes and
adjudication are performed; no implementation step in this workflow changes that.