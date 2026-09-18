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

## Repository layout

```text
backend/   Python extraction library, CLI, API, and tests
worker/    Cloudflare Worker gateway and tests
examples/  A compact, canonical VideoCapsule
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
lists. To perform one prediction-blind human pass, create a reviewer-specific copy
and start the local review SPA from the repository root:

```bash
cp /tmp/video-sample-diagnostics/multi-video-object-ground-truth.json \
    /tmp/video-sample-diagnostics/reviewer-a.json
python scripts/annotation-review/server.py \
    /tmp/video-sample-diagnostics \
    /tmp/video-sample-diagnostics/reviewer-a.json
```

Open `http://127.0.0.1:8765/`. The reviewer draws source-pixel boxes, selects the
COCO class and `live`/`composited`/`screen` subset, records out-of-taxonomy notes,
marks each frame reviewed, and saves JSON metadata. The server reads images from the checksum-bound sampling
directory and never embeds or copies image data into the annotation file. Repeat
with `reviewer-b.json` for the independent second pass, then compare both files
with `scripts/diagnostics/compare-object-reviews.py` before adjudication.

See [`docs/annotation-review-workflow.md`](docs/annotation-review-workflow.md) for
the complete SPA, browser-assistance, agent-bundle, JSONC import, comparison, and
validation workflow.

## Worker quick start

```bash
cd worker
npm install
npm test
npx wrangler secret put CAPSULE_API_TOKEN # optional
npx wrangler deploy
```

Set `UPSTREAM_API_URL` in `worker/wrangler.toml` to the deployed backend. The
worker accepts only JSON requests, validates URLs, and forwards a request ID and
optional bearer token.

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
cd worker && npm test && npm run typecheck
```

Large model weights and generated media are not committed. Whisper is loaded only
when extraction runs, while API/schema tests remain fast and deterministic.
