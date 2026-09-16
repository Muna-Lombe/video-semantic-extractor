<!--
@type documentation
@purpose Record accepted visual-capsule requirements, diagnostic gates, and investigation results.
-->

# Visual content investigation

## Phase 0: accepted requirements

The first stable visual analyzer must identify broad objects. It must also expose an
explicit extension point for a future visual-description model rather than claiming
that object labels constitute a scene description.

On-screen text is required. Website and user-interface understanding is required in
the eventual product, but the first implementation may expose a clearly identified
stub. Human actions, brands, products, and logos are required capabilities and must
be measured independently because a generic object detector does not cover all of
them.

Images remain essential downstream evidence. A capsule is an index and semantic
companion to its source frames, not a replacement from which an LLM must reconstruct
the complete video without images.

Development runs locally. Production deployment follows the container configuration
under `deployments/`, with GPU acceleration treated as an optional future execution
provider. There is no fixed CPU target or processing-time target during stabilization.
Optimization follows correctness and repeatability.

The working resource constraints are:

- peak memory must remain below 75% of available system RAM;
- downloaded model artifacts must total no more than 4 GB;
- capsule output must remain within ordinary structured-data file limits, with a
  chunked representation introduced before a single JSON document becomes unwieldy;
- probabilistic visual observations are permitted and must carry their confidence
  and analyzer provenance;
- the schema must retain an extension point for directly verifiable evidence, such
  as a source-frame reference, region, checksum, or retained image artifact.

## Capability stages

### Initial implementation

1. Correct, monotonic frame timestamps.
2. Representative frame selection across the full duration.
3. Retained image evidence or stable image references.
4. Broad object detection.
5. OCR with confidence and regions.
6. Human-action, brand, product, and logo evaluation with unsupported capabilities
   reported explicitly rather than represented as empty confirmed results.

### Explicit extension points

- natural-language descriptions of what visibly occurs;
- website and user-interface understanding;
- direct-verifiability metadata and evidence integrity;
- GPU inference providers;
- chunked capsule storage and retrieval.

## Investigation gates

### Gate 1: reproducibility

- Acquire the original source video and record its checksum.
- Record FFmpeg, FFprobe, Python, OpenCV, Whisper, operating-system, and hardware
  versions.
- Reproduce the current capsule through the local equivalent of the production
  container.

### Gate 2: timestamp root cause

- Preserve extracted image filenames.
- Record `showinfo` PTS and `pts_time` for every selected frame.
- Compare source timestamps, filter timestamps, filename tokens, and decoded capsule
  timestamps.
- Test constant-frame-rate, variable-frame-rate, non-zero-start, portrait, and
  no-scene-change inputs.

### Gate 3: sampling quality

- Compare scene-only, fixed-interval, and hybrid selection.
- Measure temporal coverage, maximum gaps, duplicates, OCR changes, and transcript
  proximity.
- Produce labeled contact sheets for human review.

### Gate 4: lightweight semantics

- Evaluate OCR before or alongside object detection because screen recordings and
  promotional videos carry substantial meaning in text.
- Benchmark a compact ONNX object detector through OpenCV DNN.
- Measure actions, brands, products, and logos as separate tasks.
- Escalate to a small captioning or vision-language model only if the lightweight
  stack cannot satisfy the accepted rubric.

## Current evidence and blockers

The existing capsule has usable transcript segments but all visual timestamps occur
within the first few milliseconds. Its visual observations contain brightness and
edge density only. Object, action, OCR, embedding, entity, and relation outputs are
empty.

The original source was temporarily recovered from the upload commit for local
diagnostics, but it is intentionally not included in this change pending a correct
GitHub upload. Its SHA-256 digest is
`bc14db678d642d02ae769c92a234ddd53c611a6bdf88ca93da97fb166bbfaa1b`.
The source is a 74.138-second, 720 by 1280 H.264 video with AAC audio.

The environment initially lacked FFmpeg, FFprobe, and Docker. Repository scripts
under `scripts/` are the canonical entry points for installing prerequisites,
creating a local Python 3.12 environment, generating fixtures, and collecting
diagnostic artifacts.

## Initial diagnostic results

The host-local setup now matches the container's Python 3.12 baseline and has FFmpeg
6.1.1, FFprobe 6.1.1, and OpenCV 4.14. A nine-second portrait diagnostic video was
generated with an audio stream, three full-frame color scenes, and the visible text
`WELCOME`, `SHOP NOW`, and `15 OFF`.

The timestamp collapse was reproduced and its immediate cause isolated. With the
original command, `showinfo` reported selected filter timestamps of 0, 3, and 6
seconds (PTS values 0, 3,000,000, and 6,000,000 after `settb=AVTB`), while the image
muxer generated filename tokens 0, 30, and 60. The encoder had rescaled timestamps
to its 1/10-second output time base before expanding `-frame_pts` in the filename;
the Python code then incorrectly treated those tokens as microseconds.

Adding `-enc_time_base filter` preserves the AVTB filter time base through encoding.
The same diagnostic then generated tokens 0, 3,000,000, and 6,000,000. Decoding those
tokens as microseconds produced the correct capsule timestamps 0.0, 3.0, and 6.0
seconds. A regression test now checks both the FFmpeg option and decoded timestamps.

The complete probe, frame extraction, audio extraction, injected transcription, and
capsule assembly path succeeded on the fixture. The resulting capsule contained
three transcript segments and three monotonic keyframes with a maximum gap of three
seconds. As expected, it contained no objects, actions, OCR, embeddings, entities,
or relations because those analyzers have not yet been implemented.

Production Whisper execution remains unverified in this environment. The egress
proxy returns HTTP 403 for the CPU-only PyTorch wheel index used by the production
Dockerfile. Installing the default PyPI GPU build would pull CUDA dependencies and
is not an acceptable substitute for the CPU deployment or the 4 GB model-artifact
budget. The deterministic fixture transcriber verifies that audio is extracted and
passed through capsule assembly without representing itself as a Whisper benchmark.

Docker is also unavailable on this host, so Compose image construction remains an
environment-limited validation. Host-local setup follows the Dockerfile's Python
version, package metadata, and system-media dependencies, but must not be described
as a successful container build.

## Source-video diagnostic results

The scene-change extractor selected 13 frames from the supplied source at 0.0,
1.633333, 16.166667, 20.533333, 37.066667, 37.766667, 39.1, 40.666667,
44.433333, 47.966667, 50.566667, 57.466667, and 69.3 seconds. These timestamps
confirm that preserving the filter time base fixes the earlier millisecond-scale
collapse on the real video as well as on the generated fixture.

The source also exposed a second timestamp defect. FFmpeg's numeric format width is
a minimum, so filenames for timestamps of ten seconds or more have a longer first
numeric token. Lexicographic path sorting consequently placed 16.166667 seconds
before 1.633333 seconds. Keyframes are now sorted by the parsed microsecond token,
and the regression test includes both sides of that field-width boundary.

Scene-only sampling leaves a 16.533334-second maximum gap and does not retain a
frame from the final 4.838458 seconds. The next sampling-quality iteration should
compare fixed-interval and hybrid selection against these baseline results before
adding OCR or object models.
