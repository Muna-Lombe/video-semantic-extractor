<!--
@type documentation
@purpose Document reproducible setup, execution, fixture, and diagnostic scripts.
-->

# Repository scripts

Run scripts from the repository root. Generated environments and diagnostic outputs
are ignored or should be written below `/tmp`; media and model artifacts must not be
committed.

## Setup

```bash
./scripts/setup/install-system-dependencies.sh
./scripts/setup/create-local-environment.sh
```

The local environment uses Python 3.12 to match `deployments/Dockerfile`.
Set `INSTALL_MODELS=0` when preparing only the media and CV diagnostic environment;
normal full extraction installs the CPU PyTorch and Whisper dependencies.

## Diagnostic fixture and full extraction

```bash
./scripts/fixtures/create-diagnostic-video.sh /tmp/video-capsule-diagnostic.mp4
./scripts/run/generate-capsule.sh \
  /tmp/video-capsule-diagnostic.mp4 \
  /tmp/video-capsule-diagnostic.json
./scripts/diagnostics/evaluate-capsule.py /tmp/video-capsule-diagnostic.json
```

If the development network blocks the production CPU PyTorch wheel index, exercise
the complete media/audio/capsule assembly with the deterministic fixture transcriber:

```bash
./scripts/diagnostics/generate-fixture-capsule.py \
  /tmp/video-capsule-diagnostic.mp4 \
  /tmp/video-capsule-diagnostic.json
```

This verifies that audio is extracted and passed to a transcriber, but it does not
benchmark Whisper or transcription accuracy.

## Timestamp evidence

```bash
./scripts/diagnostics/probe-media.sh video.mp4 /tmp/video-probe
./scripts/diagnostics/extract-keyframes-debug.sh video.mp4 /tmp/keyframe-debug
```

The debug extractor retains images, FFmpeg logs, and a CSV manifest mapping filename
tokens to `showinfo` timestamps.

## Frame-sampling comparison

Compare scene-only, five-second fixed-interval, and hybrid selection against the
source video and an existing capsule transcript:

```bash
./scripts/diagnostics/compare-frame-sampling.py \
  sample_video.mp4 \
  /tmp/frame-sampling \
  --capsule backend/capsule.json
```

The output includes a JSON metrics report, timestamp manifests, extracted frames,
and a labeled contact sheet for each strategy. The hybrid manifest records whether
each frame came from first-frame, scene-change, interval, or near-final selection.
Temporal gaps include the unsampled tail of the video. Near-duplicate counts use
adjacent 64-bit difference hashes with a Hamming-distance threshold of four; they
are a review aid, not a semantic-quality score. OCR change measurement is reported
as unavailable until an OCR analyzer is introduced rather than inferred from image
differences.

To compare every supplied read-only sample without writing generated artifacts next
to the inputs:

```bash
for video in sample-input-media/videos/*.mp4; do
  sample="$(basename "$video" .mp4)"
  ./scripts/diagnostics/compare-frame-sampling.py \
    "$video" "/tmp/video-sample-diagnostics/$sample"
done
```

The samples are sourced from `youtube.com`; their supplied license permits sharing
but prohibits commercial use. Individual source URLs are not recorded, and no
separate license information has been supplied for derived artifacts. Preserve the
non-commercial restriction for the source videos and do not infer missing
provenance or licensing terms. Never edit or overwrite the source videos; all
frames, manifests, and reports belong outside the input directory.

## OCR evaluation

Evaluate the retained frames from every sampling strategy with word confidence and
pixel-space regions. The generated fixture has timestamped ground truth so the
report also includes expected-word precision, recall, and F1:

```bash
./scripts/diagnostics/evaluate-frame-ocr.py \
  /tmp/frame-sampling \
  /tmp/frame-sampling/ocr-report.json \
  --ground-truth scripts/fixtures/diagnostic-ocr-ground-truth.json
```

The diagnostic calls the system `tesseract` executable installed by the setup
script. `--preprocess upscale`, `--preprocess grayscale`, and `--preprocess
threshold` provide repeatable alternatives for investigation; each non-original
mode doubles the image dimensions, while `upscale` preserves color so scale can be
tested independently from grayscale conversion. The original retained images remain
unchanged.
Run these modes as separate reports rather than selecting a winner from a single
frame. A confidence threshold filters reported words, while raw frame-level results
remain auditable in the JSON report. Precision is scored only on labeled frames
whose expected text is treated as exhaustive; unlabeled source frames must not be
used to make false-positive claims.

The source-video annotation fixture covers three manually reviewed retained frames
and is bound to the source checksum recorded in the investigation:

```bash
./scripts/diagnostics/evaluate-frame-ocr.py \
  /tmp/frame-sampling \
  /tmp/frame-sampling/source-ocr-report.json \
  --ground-truth scripts/fixtures/source-ocr-ground-truth.json
```

Its timestamp windows are deliberately narrow so nearby frames with changing
captions are not assigned text that was not manually reviewed. The evaluator
compares the annotation's `source_sha256` with the checksum in the sampling report
and refuses to score mismatched or unverifiable artifacts.

The source fixture covers 13 exhaustively reviewed frames spanning captions,
advertising, application UI, and platform labels. Its declared scope includes all
fully legible intentional digital text, while excluding incidental garment text and
words that are clipped or occluded. Keep that scope explicit when adding labels so
precision remains meaningful.

Tesseract's layout assumption is also an experimental variable. Compare page
segmentation modes in separate reports so the selected mode and its raw observations
remain auditable; mode 11 remains the default sparse-text baseline:

```bash
for psm in 3 6 11 12; do
  ./scripts/diagnostics/evaluate-frame-ocr.py \
    /tmp/frame-sampling \
    "/tmp/frame-sampling/source-ocr-psm${psm}.json" \
    --ground-truth scripts/fixtures/source-ocr-ground-truth.json \
    --page-segmentation-mode "$psm"
done
```

Targeted text regions are an independent experimental variable. The first proposal
crops the lower 45 percent of each frame, where this source usually places its
outlined captions, and maps returned boxes back to original-frame coordinates:

```bash
./scripts/diagnostics/evaluate-frame-ocr.py \
  /tmp/frame-sampling \
  /tmp/frame-sampling/source-ocr-caption-band.json \
  --ground-truth scripts/fixtures/source-ocr-ground-truth.json \
  --page-segmentation-mode 11 \
  --text-region caption-band
```

Use `--text-region full-frame` for the default baseline. A caption-region report
still scores every word in an exhaustively labeled frame, including UI text outside
the crop; this is intentional because it exposes the evidence lost by the proposal.

## Object-detection evaluation

Download the pinned 3.8 MB OpenCV Zoo NanoDet-Plus ONNX export outside the
repository and verify its published Git LFS digest before running the benchmark:

```bash
mkdir -p /tmp/video-semantic-models
curl --fail --location \
  --output /tmp/video-semantic-models/nanodet.onnx \
  https://media.githubusercontent.com/media/opencv/opencv_zoo/510899a2a0adb8c25957915fd030d66dbd553919/models/object_detection_nanodet/object_detection_nanodet_2022nov.onnx
echo '4b82da9944b88577175ee23a459dce2e26e6e4be573def65b1055dc2d9720186  /tmp/video-semantic-models/nanodet.onnx' \
  | sha256sum --check
```

Benchmark the hybrid retained frames through OpenCV DNN's CPU backend:

```bash
./scripts/diagnostics/evaluate-frame-objects.py \
  /tmp/frame-sampling \
  /tmp/video-semantic-models/nanodet.onnx \
  /tmp/frame-sampling/object-report.json \
  --strategy hybrid \
  --ground-truth scripts/fixtures/source-object-ground-truth.json
```

Omit `--strategy` to evaluate every manifest or repeat it to select several. The
report preserves the model checksum and size, runtime versions, inference latency,
and every confidence-scored COCO label and source-pixel region. Latency is measured
around `net.forward` only and is host-specific. Detection counts are not accuracy
scores; use exhaustive object annotations before making precision or recall claims.

The source fixture exhaustively labels primary live-action people on all 28 hybrid
frames. Its declared scope excludes people and products that appear only inside
application screenshots, thumbnails, illustrations, icons, and logos. Predictions
are true positives only when the COCO class matches and the source-coordinate box
reaches the default 0.5 intersection-over-union threshold. The evaluator verifies
the fixture's source checksum against the sampling report before scoring it.

Compare detector confidence independently while keeping NMS and matching fixed:

```bash
for confidence in 0.20 0.35 0.50 0.65; do
  ./scripts/diagnostics/evaluate-frame-objects.py \
    /tmp/frame-sampling \
    /tmp/video-semantic-models/nanodet.onnx \
    "/tmp/frame-sampling/object-${confidence}.json" \
    --strategy hybrid \
    --ground-truth scripts/fixtures/source-object-ground-truth.json \
    --minimum-confidence "$confidence"
done
```

### Multi-video annotation validation

Initialize a prediction-blind annotation fixture directly from the checksum-bound
hybrid manifests. The command deliberately records zero completed review passes and
refuses to overwrite annotation work unless `--force` is explicitly supplied:

```bash
./scripts/diagnostics/initialize-object-annotations.py \
  /tmp/video-sample-diagnostics \
  /tmp/video-sample-diagnostics/multi-video-object-ground-truth.json
```

The initializer imports no detector report and creates an explicit empty `objects`
and `out_of_taxonomy` list for every retained frame. Those empty lists are a review
template, **not** verified negative labels. Two independent reviewers must replace
them under the frozen policy before the review declaration can be advanced.

Before exposing the frozen multi-video ground truth to detector predictions, validate
its review declaration, checksum identity, exact hybrid-manifest coverage, labels,
subsets, annotation identifiers, timestamps, minimum object size, and source-image
box bounds. The validator also reports each predeclared corpus-adequacy gate:

```bash
./scripts/diagnostics/validate-object-annotations.py \
  scripts/fixtures/multi-video-object-ground-truth.json \
  /tmp/video-sample-diagnostics \
  /tmp/video-sample-diagnostics/object-annotation-validation.json
```

The sampling root must contain `sample_1` through `sample_5`, each with the
`report.json` and `hybrid/manifest.csv` produced by `compare-frame-sampling.py`.
Every fixture frame records `filename`, `timestamp_sec`, `objects`, and an
`out_of_taxonomy` list. Each object records a globally unique `id`, a COCO `label`,
one of the `live`, `composited`, or `screen` subsets, and an integer
`[x, y, width, height]` region. The fixture root declares policy version
`2026-09-18`, all five sources and checksums, and this completed-review record:

```json
{
  "review": {
    "independent_passes": 2,
    "predictions_reviewed_before_freeze": false,
    "adjudication_status": "complete",
    "adjudication_log": []
  }
}
```

During annotation, use zero through two `independent_passes`, an adjudication status
of `not_started`, `in_progress`, or `complete`, and pass `--allow-incomplete` to
distinguish a structurally valid draft from a corpus whose review or diversity gates
are not yet complete. That option never permits checksum, coverage, geometry,
taxonomy, or review-metadata errors. Omit it for the final frozen-fixture check; the
command then fails unless both validity and corpus adequacy pass.
