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
  /tmp/video-sample-diagnostics/reviewer-a.json \
  --workspace-role reviewer-a
```

Open `http://127.0.0.1:8765/`. The SPA provides source and frame navigation, native
source-pixel box drawing, COCO class and `live`/`composited`/`screen` selection,
explicit reviewed-frame markers, out-of-taxonomy notes, and atomic JSON metadata
saves. A pass cannot be marked complete until every manifest frame is marked
reviewed, including negative frames.

When the final frame is reviewed, **Complete pass** records a UTC completion time
under `review.manual_pass`, sets `review.independent_passes` to at least `1`, and
saves the reviewer JSON immediately. It leaves `review.adjudication_status` as
`not_started`, because adjudication cannot begin until two independently completed
reviewer files have been compared. This is one reviewer pass only; it is not the
final merged diagnostic fixture. The second reviewer completes a separate copy.

The server serves only images already referenced by the checksum-bound manifest and
rejects path traversal, unknown frames, source identity changes, checksum changes,
and policy-version changes on save. Image bytes are never embedded in annotation
JSON.

### Remote review through Cloudflare Tunnel

Do not expose the writable review server without an access token. Install
`cloudflared`, generate a long random token, and run the server/tunnel supervisor
from a persistent shell, VM, or named-tunnel host:

```bash
export PATH="/path/to/cloudflared-directory:$PATH"
export ANNOTATION_REVIEW_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
scripts/annotation-review/run-tunneled-review.sh \
  /tmp/video-sample-diagnostics \
  /tmp/video-sample-diagnostics/reviewer-a.json \
  8765
```

For its default quick-tunnel mode, copy the generated `https://...trycloudflare.com`
URL and open `HTTPS_URL/?token=$ANNOTATION_REVIEW_TOKEN` once. The server exchanges
the query token for an HTTP-only, same-site cookie and redirects to a clean URL.
Keep the supervisor process running for the entire download, external annotation,
upload, manual review, and save cycle. Stopping the process invalidates the quick
tunnel URL but does not delete the reviewer JSON or generated bundles.

A quick tunnel is suitable for a temporary supervised session, not a durable
service-level guarantee. For a stable hostname, authenticate `cloudflared`, create
and route a named tunnel in the Cloudflare account, then supply its normal run
arguments without secrets in the repository:

```bash
export CLOUDFLARED_TUNNEL_ARGS="tunnel --no-autoupdate run annotation-review"
scripts/annotation-review/run-tunneled-review.sh \
  /persistent/evidence /persistent/reviewer-a.json 8765
```

Put the evidence and reviewer JSON on persistent storage. Cloudflare Tunnel keeps
the origin private, but the application token is still required unless an equivalent
Cloudflare Access policy is configured and tested. Runtime logs are written beneath
`review-runtime/` next to the annotation file by default.

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
an assisted completion time and saves immediately without changing
`review.independent_passes`. MiniCPM-V 2.6 is not the default because it is a general multimodal
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

The importer also rejects duplicate frame entries, even when their unique filename
set appears complete. Manual and assisted coverage are displayed independently in
the workspace: reviewing an assisted suggestion cannot make a frame appear manually
reviewed. These controls prevent a convenient model handoff from accidentally
masquerading as the human pass that remains required by the policy.

## Independent review and adjudication

Use separate initialized copies for reviewer A and reviewer B. Keep candidate model
predictions hidden during both independent passes. After both passes, compare them:

Reviewer B must use a separate JSON file and must not inspect reviewer A's file or
comparison report first. Run a second server on another port/tunnel, or stop the
first supervisor after reviewer A saves and restart it with `reviewer-b.json`.
Generated handoff bundles are isolated by reviewer filename so simultaneous review
servers cannot overwrite one another's ZIPs.

Use separate browser sessions, ports, output files, and access tokens for the two
reviewer workspaces. Reviewer A uses the ordinary review UI backed only by
`reviewer-a.json`; Reviewer B uses another instance backed only by `reviewer-b.json`.
Do not share either review URL or token with the other reviewer.

```bash
ANNOTATION_REVIEW_TOKEN="$REVIEWER_A_TOKEN" \
  .venv/bin/python scripts/annotation-review/server.py \
    /tmp/video-sample-diagnostics \
    /tmp/video-sample-diagnostics/reviewer-a.json \
    --workspace-role reviewer-a --port 8765

ANNOTATION_REVIEW_TOKEN="$REVIEWER_B_TOKEN" \
  .venv/bin/python scripts/annotation-review/server.py \
    /tmp/video-sample-diagnostics \
    /tmp/video-sample-diagnostics/reviewer-b.json \
    --workspace-role reviewer-b --port 8766
```

The role banner prevents accidental window confusion; server-side file isolation is
the actual control. A reviewer workspace exposes only its configured annotation
file and cannot load the other review through the UI.

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

Both inputs to this comparison are human reviewer files. NanoDet and other candidate
detectors are deliberately excluded: they are scored only after adjudication,
validation, and fixture freezing. Their predictions may not replace Reviewer B.
Automation may generate the comparison and organize its evidence, but a human
adjudicator makes and owns every resolution recorded in the final fixture.

Start the separate adjudication UI only after both manual passes are complete:

```bash
.venv/bin/python scripts/annotation-review/adjudication-server.py \
  /tmp/video-sample-diagnostics \
  /tmp/video-sample-diagnostics/reviewer-a.json \
  /tmp/video-sample-diagnostics/reviewer-b.json \
  /tmp/video-sample-diagnostics/source-object-ground-truth.json
```

The adjudication server refuses the same file in both reviewer positions, requires
both manual passes to be complete, reads both reviewer files without modifying them,
and writes decisions only to the merged output. Its UI lists disagreement frames,
shows Reviewer A and Reviewer B data beside the source image, and lets Adjudicator C
choose either review or edit the merged frame JSON. Completion remains blocked until
every disagreement frame has a logged resolution.

After adjudication, write the merged result to the diagnostic fixture path, set
`review.independent_passes` to `2`, set `review.adjudication_status` to `complete`,
and preserve the adjudication log. Then run the validator without
`--allow-incomplete`. The resulting validation report and frozen fixture are the
artifacts to reference from the investigation record; reviewer-specific files and
assisted completion records remain provenance for how the fixture was produced.

Generate those artifacts reproducibly with
`generate-object-annotation-report.py`. It writes JSON for diagnostics and Markdown
for the investigation, including SHA-256 hashes, reviewer completion summaries,
reviewer-to-reviewer disagreement comparison, adjudication entries, validation
errors, object counts, and all adequacy gates. A report with invalid annotations or
failed gates is still useful as a reproducible draft, but cannot be used to claim a
frozen diagnostic fixture.

The report separately audits each reviewer file against the sampling evidence. A
scoring-ready report requires exactly two distinct files, one complete manual pass
in each file, exact reviewed-frame coverage without duplicates, and structurally
valid annotations. Passing the merged-fixture adequacy gates alone is insufficient;
the command exits nonzero unless both fixture adequacy and reviewer provenance pass.
Use `--allow-incomplete` to generate an explicit draft while either condition is
still open.

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
