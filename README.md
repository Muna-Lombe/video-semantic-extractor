<!--
@type documentation
@purpose Explain the Video Semantic Extractor architecture, setup, and usage.
-->


# Video Semantic Extractor

Video Semantic Extractor reduces a video to an LLM-friendly **VideoCapsule**: sparse
visual observations, a dense timestamped transcript, and structured metadata. The
result is deterministic JSON that can be stored, searched, or supplied to a small
language model without sending the source video.

## Architecture

```text
video URL -> Cloudflare Worker -> FastAPI -> extractor -> VideoCapsule JSON
                                         |-> ffprobe/ffmpeg metadata + audio
                                         |-> hybrid scene/interval frames + CV features
                                         `-> Whisper transcript
```

The initial implementation intentionally keeps visual inference local and cheap:
keyframes contain brightness and edge-density measurements. Object detection,
OCR, embeddings, and an external summarizer are represented by stable schema
fields and extension points rather than pretend model output.

The project is now separating this production extraction path from an internal
**model-evaluation and pipeline-development control plane**. The human-facing
foundation is `/internals`, with APIs under `/api/internal/v1`. Internals will manage the
dataset -> sampling job -> frame set -> template -> review campaign -> ground truth
-> evaluation -> governed model/pipeline-release chain. An initial `/internals`
status shell, authenticated overview API, and D1 schema now establish that boundary;
the managed pipeline resources remain incremental work rather than complete features.
See [`docs/internals-roadmap.md`](docs/internals-roadmap.md) for the implemented/planned
boundary, priorities, and migration policy.

## Repository layout

```text
backend/   Python extraction library, CLI, API, and tests
workers/   Unified Cloudflare project: Worker sources, configs, assets, and tests
examples/  A compact, canonical VideoCapsule
docs/      Workflows, investigation evidence, and the Internals roadmap
```

## Backend quick start

System prerequisites are `ffmpeg` and `ffprobe`.

```bash
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -e '.[dev,models]'
video-capsule ./video.mp4 --output capsule.json
uvicorn video_semantic_extractor.api:app --host 0.0.0.0 --port 8000
```

The API accepts `POST /capsule` with `{"video_url":"https://example/video.mp4"}`.
Configure download limits with `CAPSULE_MAX_DOWNLOAD_BYTES` and
`CAPSULE_DOWNLOAD_TIMEOUT_SEC`. Private and loopback destinations are rejected by
default to limit server-side request forgery; set `CAPSULE_ALLOW_PRIVATE_URLS=1`
only for a trusted private deployment.

## Human object annotation review

The multi-video object fixture is intentionally initialized with empty annotation
lists. The preferred deployed workflow creates a hosted review as described below.
For an offline fallback, create a reviewer-specific copy and start the local review
SPA from the repository root:

```bash
cp /tmp/video-sample-diagnostics/multi-video-object-ground-truth.json \
    /tmp/video-sample-diagnostics/reviewer-a.json
python scripts/annotation-review/server.py \
    /tmp/video-sample-diagnostics \
    /tmp/video-sample-diagnostics/reviewer-a.json
```

For deployed reviews, an administrator creates a hosted review through
`POST /api/v1/admin/reviews` and securely shares the three unique invitation URLs
returned for Reviewer A, Reviewer B, and Adjudicator C. Reviewers need only a
browser; assignment-scoped tokens prevent either reviewer from accessing the
other's workspace. `GET /api/v1` and `GET /openapi.json` document the human- and
agent-accessible API without disclosing active assignments.

The local application remains available as an offline fallback. Open
`http://127.0.0.1:8765/`. The reviewer draws source-pixel boxes, selects the
COCO class and `live`/`composited`/`screen` subset, records out-of-taxonomy notes,
marks each frame reviewed, and saves JSON metadata. The server reads images from the checksum-bound sampling
directory and never embeds or copies image data into the annotation file. Repeat
with `reviewer-b.json` for the independent second pass, then compare both files
with `scripts/diagnostics/compare-object-reviews.py` before adjudication. The
hosted Cloudflare review service unlocks the third-reviewer UI, persists work in
R2, and serves completed merged JSON privately at
`GET /api/v1/reviews/<review-id>/result`.

See [`docs/annotation-review-workflow.md`](docs/annotation-review-workflow.md) for
the complete SPA, browser-assistance, agent-bundle, JSONC import, comparison, and
validation workflow.

The focused Reviewer A, Reviewer B, and Adjudicator C invitation experiences will
remain focused rather than becoming pages in the full Internals navigation. Review
coordination and progress belong in Internals; an assignee's invitation should open
only that assignee's scoped task.

## Internal development roadmap

The next productization track is an authenticated `/internals` workspace for
dataset preparation, durable sampling and evaluation jobs, registered templates,
review coordination, ground-truth governance, model registration, and pipeline
release governance. Existing diagnostic commands remain supported as a legacy
fallback and reproducibility interface after managed jobs are introduced; managed
jobs should invoke the same versioned engines rather than replace them with a
second implementation.

The first vertical slice is dataset -> sampling job -> immutable frame set ->
registered template, followed by template-referenced review campaigns. Its current
increment registers HTTPS source URLs in a dedicated dataset D1 database, marks
the dataset `ready`, freezes its initial version, and records durable `queued` sampling-job
metadata in the control-plane D1 database. The control plane also exposes a
runner-authenticated claim/lease protocol, heartbeats, attempt history, completion
and failure reporting, requeue behavior, and administrator cancel/retry operations.
The separately deployed sampling-runner Worker and Container now execute that
protocol with the shared engine and register verified frame-set outputs. Remote
Cloudflare rollout and real-media verification remain open, so the existing CLI
remains the operational fallback until that verification is complete. Cross-database
references are validated by the application because separate D1 databases cannot
provide foreign keys or atomic transactions across that boundary. Large immutable
media and reports belong in object storage. See the
[`Internals implementation roadmap`](docs/internals-roadmap.md) for priorities and
current status.

The provisioned bindings are `CONTROL_DB` (`video-semantic-extractor`) for job and
governance state and `DATASET_DB` (`video-semantic-extractor-dataset`) for dataset,
version, and source-registration metadata. Deployment IDs and migration commands
are documented in [`workers/README.md`](workers/README.md).

## Worker quick start

```bash
cd workers
npm install
npm test
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Create the R2 buckets named in `workers/wrangler.toml` before deployment. The Worker
hosts reviewer and adjudicator workspaces, assignment-scoped APIs, and private
results. See [`workers/README.md`](workers/README.md) for initialization, invitation,
API-discovery, and result-retrieval examples.

## Capsule contract

The contract is versioned as `1.0`. Times are seconds from the beginning of the
video. Visual observations clearly identify the analyzer that generated them;
empty `objects`, `actions`, or `text_in_frame` values mean “not analyzed,” not
“confirmed absent.” Keyframes also record whether they were selected as the first
frame, a scene change, an interval sample, or near-final evidence. See
[`examples/sample_capsule.json`](examples/sample_capsule.json).

Recommended ingestion prompt:

```text
Analyze this VideoCapsule using only supported evidence. Merge transcript segments
and visual observations by timestamp. Report: (1) concise summary, (2) event
timeline, (3) entities/actions, and (4) uncertainties. Never interpret embedding
coordinates directly and never invent objects, speakers, or events for empty fields.
```

## Development

```bash
cd backend && python -m pytest
cd workers && npm test && npm run typecheck
```

Large model weights and generated media are not committed. Whisper is loaded only
when extraction runs, while API/schema tests remain fast and deterministic.
