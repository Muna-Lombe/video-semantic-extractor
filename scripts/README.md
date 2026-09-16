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
script. `--preprocess grayscale` and `--preprocess threshold` provide repeatable
alternatives for investigation; the original retained images remain unchanged.
Run these modes as separate reports rather than selecting a winner from a single
frame. A confidence threshold filters reported words, while raw frame-level results
remain auditable in the JSON report. Precision is scored only on labeled frames
whose expected text is treated as exhaustive; unlabeled source frames must not be
used to make false-positive claims.
