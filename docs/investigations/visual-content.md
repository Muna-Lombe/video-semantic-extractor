<!--
@type documentation
@purpose Record accepted visual-capsule requirements, diagnostic gates, and investigation results.
-->

# Visual content investigation

## Investigation recap (2026-09-17)

### Executive conclusion

Timestamp extraction and representative frame sampling are ready to remain in the
production pipeline. The visual-semantic analyzers are not ready for production:
full-frame Tesseract misses most annotated source text, and the NanoDet evidence is
limited to one person-dominated video. Object detection remains a viable experiment,
not a validated broad-object capability. Actions, brands, products, logos, website
understanding, and natural-language visual descriptions remain explicitly
unsupported.

The investigation should therefore continue as evaluation work rather than by
adding OCR or object output to the capsule schema. No model default should be chosen
from the current single-video evidence.

### Current readiness

| Capability | Status | Evidence | Decision |
| --- | --- | --- | --- |
| Frame timestamps | Ready | Filter-time-base preservation fixes the reproduced timestamp collapse; numeric sorting fixes the ten-second filename boundary | Keep the production fix and regression coverage |
| Frame sampling | Ready | Hybrid selection guarantees first, interval, scene, and near-final candidates with a five-second maximum gap on the source | Keep hybrid sampling and fail when the frame cap cannot preserve coverage |
| Evidence provenance | Ready for current diagnostics | Manifests retain resolvable relative paths; sampling reports and annotation fixtures enforce source SHA-256 identity | Preserve these checks in every subsequent evaluator |
| OCR | Blocked | Best expanded full-frame result is 0.2448 macro F1; fixed caption-band proposals regress below that baseline | Evaluate a genuine multi-region text detector, split caption and UI subsets, and do not integrate Tesseract yet |
| Broad object detection | Blocked | NanoDet is compact and fast locally, but the exhaustive fixture contains 24 people and no unambiguous non-person objects | Build a checksum-bound multi-video corpus before selecting a confidence threshold or integrating the detector |
| Actions, brands, products, and logos | Not evaluated | COCO object labels do not measure these required capabilities | Create separate tasks, labels, and acceptance criteria |
| Whisper in the production-equivalent environment | Unverified | Fixture transcription exercises assembly, but the CPU PyTorch wheel was unavailable and Docker is absent on this host | Verify independently in the production container environment |

### Decisions that should not be reopened without new evidence

1. Use source timestamps, not image-muxer filename assumptions. Preserve the FFmpeg
   filter time base and sort parsed numeric timestamp tokens.
2. Keep scene, interval, and near-final frame candidates independent until they are
   merged with provenance. Do not replace them with a single combined filter.
3. Treat emitted OCR words or object labels as observations, not accuracy. Accuracy
   claims require exhaustive, checksum-bound annotations with a declared scope.
4. Do not select OCR preprocessing or page-segmentation defaults from the original
   three-frame fixture. The expanded 13-frame benchmark reversed those conclusions.
5. Keep live-scene objects distinct from people or products depicted inside screens,
   thumbnails, illustrations, and logos.
6. Match object predictions one-to-one by class and minimum IoU using
   maximum-cardinality matching so a local pairing choice cannot discard a valid
   true positive.

### Evidence limitations

- The source benchmark is one 74.138-second portrait promotional video. It cannot
  establish performance across camera footage, screen recordings, landscapes,
  animation, low light, motion blur, or varied resolutions.
- The OCR fixture has 13 exhaustively annotated hybrid frames. It is adequate to
  reject the tested Tesseract configurations, but not to estimate general OCR
  performance.
- The object fixture labels all 28 hybrid frames under a live-scene scope, but its
  positive class distribution is exclusively `person`. It cannot validate broad
  COCO detection.
- The confidence table below predates the matching-integrity correction. The source
  reports must be regenerated before those values are treated as current; the
  correction does not itself provide new model evidence.
- Local latency excludes decoding, preprocessing, and postprocessing and is not a
  deployment service-level objective.

### Prioritized next investigation

1. Acquire a small, redistributable multi-video corpus and record each source's
   license, SHA-256, duration, dimensions, and content category.
2. Exhaustively label non-person COCO objects at varied scales and explicitly tag
   live, composited, and screen-depicted subsets.
3. Re-run the pinned NanoDet model at fixed confidence thresholds with the corrected
   matcher, then report both aggregate and per-subset precision, recall, and F1.
4. In parallel, benchmark a true text-region proposal on separate caption and UI
   subsets; retain full-frame Tesseract mode 11 as the comparison baseline only.
5. Define independent fixtures and metrics for actions, brands, products, and logos
   before evaluating models for those requirements.
6. Revisit production integration only after a candidate passes a predeclared gate
   on the broader corpus. Until then, preserve unsupported capabilities explicitly.

### Reproducible artifact map

- `scripts/diagnostics/compare-frame-sampling.py` produces frame manifests, coverage
  metrics, and contact sheets.
- `scripts/diagnostics/evaluate-frame-ocr.py` records OCR observations and scores
  checksum-bound text annotations.
- `scripts/diagnostics/evaluate-frame-objects.py` records NanoDet observations,
  latency, provenance, and checksum-bound object scores.
- `scripts/fixtures/source-ocr-ground-truth.json` and
  `scripts/fixtures/source-object-ground-truth.json` define the current exhaustive
  annotation scopes.
- `scripts/README.md` contains the commands needed to reproduce each diagnostic.

The remaining sections are the chronological evidence log supporting this recap.

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

## Sampling-quality results

The reproducible sampling comparison uses a five-second interval and the existing
0.3 scene threshold. Coverage metrics include the leading and trailing boundaries,
not only gaps between selected frames. Transcript proximity is measured from each
of the 24 existing segment midpoints to its nearest selected frame. Exact SHA-256
and adjacent 64-bit difference-hash comparisons provide duplicate triage, while OCR
change detection is explicitly reported as unavailable until an OCR analyzer exists.

| Strategy | Frames | Maximum gap | Mean transcript distance | Maximum transcript distance | Adjacent near-duplicates |
| --- | ---: | ---: | ---: | ---: | ---: |
| Scene only | 13 | 16.533334 s | 3.015278 s | 8.016667 s | 0 |
| Fixed interval | 15 | 5.000000 s | 1.312500 s | 2.500000 s | 0 |
| Hybrid | 28 | 5.000000 s | 1.136111 s | 2.500000 s | 1 |

Contact-sheet review shows why the numeric coverage improvement alone is not enough:
fixed sampling captures the video's progression but can miss short application-screen
transitions. Scene sampling retains those transitions but undersamples long talking-head
sections. Hybrid sampling retains every scene-selected transition, the independent
five-second interval sequence, and a frame at 74.0 seconds near the end. It therefore
provides the best evidence set of the three, at a cost of 13 frames over fixed sampling
and 15 over scene-only. The single perceptual near-duplicate is retained because it
comes from distinct timestamps and may contain changing speech text.

The production extractor now merges three independently extracted candidate sets:
scene changes, fixed intervals, and the final decoded frame in a short tail window.
Candidates within one millisecond are deduplicated and their sampling reasons are
combined. Source timestamps are normalized with `PTS-STARTPTS`, and all candidates
are sorted numerically. The interval is configurable on `CapsuleBuilder`.

The existing 80-frame cap is applied only after coverage candidates have been
established. Optional scene frames are reduced first. If the cap is too small to
retain the first, interval, and near-final frames, extraction fails explicitly rather
than silently violating the requested coverage bound.

This supersedes the first hybrid prototype, which used a single scene-or-elapsed-time
expression. That prototype happened to leave only a 4.838458-second tail on this
sample, but it did not guarantee near-final evidence, preserve sampling provenance,
or prevent `max_keyframes` reduction from reopening temporal gaps.

## OCR diagnostic results

The first lightweight-semantic diagnostic uses the system Tesseract 5.3.4 CLI and
its English data rather than adding a Python model runtime. The installed language
data occupies approximately 15 MB and the shared OCR library approximately 3.1 MB,
well below the 4 GB model-artifact constraint. Word-level TSV output preserves a
confidence score and pixel-space region for every accepted observation.

The generated fixture now has three timestamped ground-truth labels. At the default
0.5 confidence threshold, original images, two-times grayscale images, and two-times
Otsu-thresholded images each achieved 1.0 mean expected-word recall on sampled
frames. Preprocessing therefore showed no benefit on this intentionally clean input.
The more important distinction was sampling coverage: scene and hybrid sampling
each detected all three labels at least once, while five-second fixed sampling saw
only two of three. OCR evaluation must consequently report both recognition quality
on sampled frames and ground-truth label coverage; perfect per-frame recall does not
prove that the sampler retained every text state.

On the supplied source, original-image OCR produced text above the same confidence
threshold in 9 of 13 scene frames, 13 of 15 fixed frames, and 23 of 28 hybrid frames.
The corresponding adjacent OCR-change counts were 11, 14, and 26. These are useful
evidence that on-screen text changes frequently, but there is no source-video ground
truth yet, so they are not accuracy measurements and do not justify production OCR
integration on their own. The next OCR iteration should label representative source
frames, score false positives as well as recall, and test small and stylized text.

The diagnostic also exposed an artifact-integrity defect: hybrid manifests stored
only basenames even though production candidates live in `scene`, `interval`, and
`near-final` subdirectories. Manifests now preserve paths relative to the strategy's
frame root so downstream diagnostics can reopen the exact retained image.

## OCR scoring integrity results

The next diagnostic pass added word precision and F1 alongside recall so exhaustive
labels can expose unsupported OCR output rather than rewarding detection alone.
Precision remains undefined for unlabeled frames and for labeled frames where the
engine returned no words; this avoids treating incomplete source-video annotations
as evidence of false positives.

On the generated fixture, original-image OCR achieved 1.0 mean word precision,
recall, and F1 for all three strategies. Scene and hybrid sampling again covered all
three ground-truth text states, while fixed sampling covered two of three. These
perfect recognition scores apply only to sampled, labeled frames; the 0.6667 fixed
label-coverage score remains the evidence that recognition quality cannot recover a
text state the sampler omitted.

Running the source diagnostic also exposed a parser defect on the 40.666667-second
frame. Tesseract recognized a literal leading quote in `"coloring`, but its TSV is
not CSV-escaped. Python's default CSV quote handling consequently joined multiple
physical word rows and leaked raw TSV fields into the observed text. The parser now
disables quote semantics and a regression test preserves each physical TSV row.

Source-video OCR precision is still intentionally unreported because there is not
yet exhaustive text ground truth for representative frames. The next annotation
pass must record all visible words in each scored frame, including captions, user
interface labels, and clothing text; partial labels are suitable for recall but
would make precision misleading.

## Source OCR annotation results

Three retained source frames at 69.3, 70.0, and 74.0 seconds now have exhaustive
word annotations. Narrow timestamp windows prevent rapidly changing captions from
sharing a label. The annotation file is tied to the recorded source SHA-256 so it
cannot silently be treated as truth for another upload.

At the default 0.5 confidence threshold, Tesseract recognized none of the two words
at 69.3 seconds, none of the three at 70.0 seconds, and 11 of 12 at 74.0 seconds.
The final frame had 0.8462 precision, 0.9167 recall, and 0.88 F1; its unsupported
tokens came from punctuation and low-quality glyph interpretation after normalized
word scoring. Hybrid sampling retained all three annotated frames, fixed sampling
retained only 70.0 seconds, and scene sampling retained only 69.3 seconds.

This pass exposed an aggregation defect: precision is correctly undefined when OCR
emits no words, but F1 for an exhaustively labeled zero-recall frame is unequivocally
zero. Excluding those frames inflated hybrid macro F1 from the correct 0.2933 to
0.44. The diagnostic now retains silent OCR misses as zero in mean F1 while leaving
precision undefined. The evidence does not support production OCR integration yet;
the two stylized captions were total misses, and the small three-frame set is an
integrity check rather than a representative accuracy benchmark. The next OCR pass
should expand annotations across application screens and talking-head captions,
then compare page-segmentation modes or region proposals before integration.

## OCR page-segmentation results

The source diagnostic now records Tesseract's page-segmentation mode and compared
automatic layout (3), uniform text block (6), sparse text (11), and sparse text with
orientation detection (12), using original retained images and the same 0.5
confidence threshold. Hybrid macro results on the three exhaustively labeled frames
were:

| Page segmentation mode | Mean precision | Mean recall | Mean F1 |
| ---: | ---: | ---: | ---: |
| 3 | 1.0000 | 0.3611 | 0.4524 |
| 6 | 0.3675 | 0.3889 | 0.3778 |
| 11 | 0.4231 | 0.3056 | 0.2933 |
| 12 | 0.4546 | 0.2778 | 0.2899 |

Mode 3 improved macro F1 over the mode-11 baseline by recognizing `THIS` at 70.0
seconds and nine supported words at 74.0 seconds without an accepted unsupported
word. It still emitted no accepted words at 69.3 seconds, recognized only one of
three expected words at 70.0 seconds, and omitted three expected words at 74.0
seconds. No tested mode completely detected any annotated text state, so this small
comparison does not establish a production default or overturn the earlier OCR
integration blocker.

The checksum previously documented as binding the source annotations was not
enforced by the evaluator. Sampling reports now record the input video SHA-256, and
the OCR diagnostic refuses checksum-bound ground truth when that value is missing or
different. This prevents plausible-looking accuracy metrics from being produced
against frames from another upload.

The next pass should expand exhaustive annotations before tuning further. It should
then evaluate targeted caption or text-region proposals, since changing a global
layout mode improved aggregate scoring but did not recover the stylized 69.3-second
caption.

## OCR preprocessing isolation results

The earlier grayscale and threshold preprocessing options both enlarged frames by
two times, so their results could not distinguish the effect of scaling from the
effect of discarding color. The diagnostic now has an `upscale` mode that performs
the same cubic enlargement while retaining all three color channels.

At page-segmentation mode 11, hybrid macro results on the same three exhaustive
labels were:

| Preprocessing | Mean precision | Mean recall | Mean F1 |
| --- | ---: | ---: | ---: |
| Original | 0.4231 | 0.3056 | 0.2933 |
| Two-times color upscale | 0.4445 | 0.4445 | 0.4445 |
| Two-times grayscale | 0.4394 | 0.4167 | 0.4275 |
| Two-times Otsu threshold | 0.3077 | 0.2222 | 0.2133 |

Color upscaling produced the best mode-11 macro result and recovered two of three
expected words at 70.0 seconds, but it still accepted no supported word at 69.3
seconds and regressed the 74.0-second frame from 0.88 to 0.6667 F1. With automatic
layout mode 3, upscaling also reduced macro F1 from 0.4524 to 0.3651. Scaling is
therefore a meaningful experimental variable, not a uniformly beneficial default.

These results reinforce rather than remove the integration blocker: none of the
global preprocessing and layout combinations completely recognizes every labeled
text state. The next diagnostic should expand exhaustive labels and evaluate a
targeted caption-region proposal independently from full-frame OCR.

## Expanded OCR ground-truth results

The exhaustive source benchmark now covers 13 hybrid-retained frames rather than
three. The frames span early, middle, and late video sections and include outlined
talking-head captions, an app-store advertisement, application navigation, a batch
editing promotion, platform labels, and the closing discount card. The annotation
scope is explicit: every fully legible intentional overlay, caption, advertisement,
and user-interface word is included, while incidental garment text and clipped or
occluded words are excluded. All labels remain bound to the recorded source SHA-256
and use narrow windows around the manually inspected frames.

Re-running the full-frame layout comparison on the expanded labels changed the
ranking and removed the apparent advantage of automatic layout mode 3:

| Page segmentation mode | Mean precision | Mean recall | Mean F1 |
| ---: | ---: | ---: | ---: |
| 3 | 0.7949 | 0.1644 | 0.2075 |
| 6 | 0.2507 | 0.1857 | 0.1949 |
| 11 | 0.3506 | 0.2282 | 0.2448 |
| 12 | 0.3535 | 0.2148 | 0.2373 |

Mode 11 now has the best macro F1, but it recalls fewer than one quarter of labeled
words on average. Mode 3 remains more conservative: its high macro precision comes
from the subset of frames where it emits accepted text, while eight of the 13
labeled frames have zero recall. No mode completely recognizes any of the 13 text
states at the 0.5 confidence threshold.

The earlier preprocessing conclusion also failed to generalize. At mode 3, color
upscaling scored 0.1928 macro F1, grayscale scored 0.1993, and Otsu thresholding
scored 0.2140, compared with 0.2075 for unchanged frames. Thresholding's small
aggregate increase comes with lower precision, and none of the transformations
meaningfully resolves outlined-caption recognition. There is still no justified
global preprocessing default.

## Targeted caption-region results

The first targeted proposal restricts OCR to the lower 45 percent of the frame,
where the video's outlined captions usually appear. Diagnostic boxes are translated
back to original-frame coordinates, including compensation for two-times
preprocessing, so retained evidence remains spatially comparable with full-frame
results.

The best tested caption-band result was mode 11 with Otsu thresholding: 0.2738 mean
precision, 0.1144 mean recall, and 0.1468 mean F1. Unchanged caption-band input at
mode 11 reached 0.1370 F1, and color upscaling reached 0.1451. All are materially
below the 0.2448 full-frame mode-11 baseline. Cropping removes useful UI and
advertisement evidence without reliably separating the outlined captions from the
speaker and clothing; thresholding also fragments outlined glyphs.

The expanded benchmark therefore completes the current ground-truth pass but keeps
production OCR blocked. Further global layout or preprocessing sweeps are not
justified by these results. A subsequent OCR iteration should use a genuine text
detection proposal that can return multiple localized regions, rather than another
fixed crop, and should evaluate caption and UI subsets independently. In parallel,
the investigation can now begin the compact ONNX object-detector benchmark without
representing OCR as production-ready.

## Compact ONNX object-detector results

The first object pass uses OpenCV Zoo's NanoDet-Plus-m 1.5x model at a 416-pixel
input size through the existing OpenCV DNN CPU runtime. The pinned float32 ONNX
artifact is 3,800,954 bytes with SHA-256
`4b82da9944b88577175ee23a459dce2e26e6e4be573def65b1055dc2d9720186`,
well below the 4 GB model-artifact limit. The diagnostic records the artifact
identity and runtime versions, letterboxes without distorting portrait frames, and
maps all accepted boxes back to source-frame pixel coordinates.

At the OpenCV Zoo defaults of 0.35 minimum confidence and 0.6 NMS IoU, the model
returned 39 observations across the 28 hybrid-retained frames. Twenty-six frames
had at least one result. On this host with OpenCV 4.14.0, `net.forward` took 98.655
ms per frame on average and 117.731 ms at the nearest-rank 95th percentile. These
numbers exclude image decoding, resizing, normalization, and postprocessing and are
environment measurements rather than deployment guarantees.

| Predicted COCO class | Observations |
| --- | ---: |
| person | 32 |
| teddy bear | 2 |
| clock | 1 |
| dining table | 1 |
| frisbee | 1 |
| laptop | 1 |
| tv | 1 |

Manual review supports the repeated `person` detections in talking-head frames, but
also exposes the limits of raw COCO output. Application screens at 20 seconds were
classified as `tv` and `laptop`; screen content around 40.7 seconds was classified
as `clock`; and product imagery around 48 to 51 seconds produced `teddy bear` and
`frisbee` labels. The benchmark has no exhaustive object annotations yet, so the
26-of-28 result is coverage of emitted predictions, not recall, and the table is a
prediction distribution rather than accuracy evidence.

NanoDet is small and fast enough to remain a viable candidate, but these results do
not justify production integration. The next object pass should checksum-bind an
exhaustive frame-level object fixture, define whether depicted products inside app
screens count as objects, and score box/class precision and recall. It should also
compare confidence thresholds against those labels before selecting defaults.

## Object ground-truth and confidence results

The follow-up fixture exhaustively annotates all 28 hybrid frames and is bound to
the source-video SHA-256. Its object scope distinguishes the live scene from media
depicted inside application interfaces: primary live-action people receive one
source-pixel box, while people, animals, and products visible only in screenshots,
thumbnails, illustrations, icons, and logos are excluded. A presenter is also
excluded at 37.066667 seconds because the overlay leaves only disconnected hair and
torso fragments, with neither a face nor contiguous head-and-upper-body region.
Under that scope the benchmark contains 24 expected `person` instances and no
fully and unambiguously visible non-person COCO objects.

Predictions are matched one-to-one to same-class labels at 0.5 box IoU. Keeping the
0.6 NMS IoU fixed produced this confidence comparison:

| Minimum confidence | TP | FP | FN | Precision | Recall | F1 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.20 | 23 | 151 | 1 | 0.1322 | 0.9583 | 0.2323 |
| 0.35 | 23 | 16 | 1 | 0.5897 | 0.9583 | 0.7302 |
| 0.50 | 21 | 1 | 3 | 0.9545 | 0.8750 | 0.9130 |
| 0.65 | 14 | 0 | 10 | 1.0000 | 0.5833 | 0.7368 |

The 0.5 threshold gives the best F1 on this fixture. Its only false positive is a
person depicted inside the Picsart advertisement at 37.066667 seconds. Its three
misses are the partially overlay-occluded presenter at 20 seconds, the small
composited presenter at 37.766667 seconds, and the small presenter below the batch
editing interface at 55 seconds. Lowering the threshold recovers two of those three
but admits duplicate person boxes and numerous unsupported UI-image labels. Raising
it to 0.65 removes all false positives but loses ten people.

This establishes a defensible threshold only for prominent people in this single
portrait promotional video; it does not validate broad object detection. Production
integration remains blocked until a checksum-bound multi-video fixture contains
exhaustive non-person objects at varied scales and separates live, composited, and
screen-depicted evaluation subsets. The next iteration should add that broader
corpus rather than tune NMS against this person-dominated source.

## Object matching integrity follow-up

Review of the scorer found that its original global highest-IoU greedy matching
could undercount true positives. When two predictions both overlap one label, but
only one also overlaps a second label, consuming the strongest individual pair can
leave only one match even though two valid one-to-one matches exist at the declared
IoU threshold. That makes aggregate precision, recall, and F1 depend on a local
pairing decision rather than solely on the accepted predictions and labels.

The scorer now uses augmenting-path bipartite matching within the same-class,
minimum-IoU eligibility graph. It still prefers higher-IoU candidates while finding
the maximum number of valid one-to-one matches. A synthetic regression fixture
covers the blocking geometry. This is an evaluation-integrity correction; it does
not add broader object evidence or remove the multi-video production blocker.
