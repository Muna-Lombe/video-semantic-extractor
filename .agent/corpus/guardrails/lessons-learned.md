<!--
@type documentation
@purpose Preserve non-trivial media-extraction lessons discovered during development.
-->

# Lessons learned

### Measure sampling gaps against video boundaries

**Date learned:** 2026-09-16
**Category:** Video sampling

⚠️ **Problem:** Scene-only selection preserved abrupt transitions in the diagnostic
video but left a 16.533334-second gap. Measuring only adjacent selected timestamps
can also hide an uncovered tail after the final frame.

✓ **Solution:** Compare scene-only, fixed-interval, and hybrid strategies using the
video start and duration as coverage boundaries. Merge independent scene, interval,
and near-final candidates, retaining provenance when candidates are deduplicated.

📄 **Affected files:** `backend/video_semantic_extractor/pipeline.py`,
`scripts/diagnostics/compare-frame-sampling.py`

💡 **Prevention:** Report leading and trailing gaps, preserve labeled contact sheets
for human review, and reject a global frame cap that cannot retain all required
coverage candidates.

### Keep diagnostic manifests resolvable

**Date learned:** 2026-09-16
**Category:** Diagnostic artifacts

⚠️ **Problem:** Hybrid frame candidates are stored in provenance-specific
subdirectories, but a basename-only CSV manifest pointed downstream OCR diagnostics
at nonexistent files and discarded the path needed to audit the evidence.

✓ **Solution:** Store POSIX paths relative to the strategy frame root. This keeps
artifacts relocatable without flattening distinct candidate directories.

📄 **Affected files:** `scripts/diagnostics/compare-frame-sampling.py`,
`scripts/diagnostics/evaluate-frame-ocr.py`

💡 **Prevention:** Exercise every generated manifest by reopening its referenced
files in an independent downstream diagnostic.

### Treat Tesseract TSV as unquoted tabular output

**Date learned:** 2026-09-16
**Category:** OCR diagnostics

⚠️ **Problem:** Tesseract can recognize a literal quote at the beginning of a word,
but its TSV output does not escape that quote as CSV. Default CSV parsing then joins
unrelated physical rows and reports embedded TSV fields as recognized text.

✓ **Solution:** Parse with tab delimiters and `csv.QUOTE_NONE`, preserving each
physical Tesseract row independently.

📄 **Affected files:** `scripts/diagnostics/evaluate-frame-ocr.py`,
`backend/tests/test_ocr_diagnostics.py`

💡 **Prevention:** Include punctuation-led OCR words in parser fixtures and retain
raw frame-level observations in diagnostic reports.

### Enforce source identity before scoring annotations

**Date learned:** 2026-09-17
**Category:** Diagnostic integrity

⚠️ **Problem:** A ground-truth file recorded the source-video checksum, but the OCR
evaluator ignored it. The labels could therefore produce credible-looking metrics
for retained frames from a different upload.

✓ **Solution:** Record the input SHA-256 in the sampling report and require an exact
match before loading checksum-bound ground truth.

📄 **Affected files:** `scripts/diagnostics/compare-frame-sampling.py`,
`scripts/diagnostics/evaluate-frame-ocr.py`

💡 **Prevention:** Treat provenance fields as enforceable invariants, not descriptive
metadata, and add a rejection test for mismatched artifacts.

### Isolate OCR preprocessing variables

**Date learned:** 2026-09-17
**Category:** OCR diagnostics

⚠️ **Problem:** Grayscale and threshold experiments also enlarged every input, so
their results could not attribute a score change to color conversion, binarization,
or scale.

✓ **Solution:** Add a color-preserving upscale mode with the same dimensions and
interpolation as the other preprocessing modes, then compare each mode against the
unchanged originals.

📄 **Affected files:** `scripts/diagnostics/evaluate-frame-ocr.py`,
`backend/tests/test_ocr_diagnostics.py`

💡 **Prevention:** Change one image-processing variable at a time and record every
selected transformation in the generated report.

### Expand ground truth before selecting OCR defaults

**Date learned:** 2026-09-17
**Category:** OCR evaluation

⚠️ **Problem:** Automatic page layout and color upscaling appeared strongest on
only three exhaustively labeled end-of-video frames. After labels were expanded
across captions, UI, advertisements, and platform names, sparse-text mode produced
the best macro F1 and upscaling no longer improved its tested full-frame baseline.

✓ **Solution:** Expand checksum-bound exhaustive labels across content types and
video sections before selecting layout, preprocessing, or region-proposal defaults.
Treat fixed-region proposals as evidence-preserving experiments by mapping their OCR
boxes back to source-frame coordinates.

📄 **Affected files:** `scripts/fixtures/source-ocr-ground-truth.json`,
`scripts/diagnostics/evaluate-frame-ocr.py`

💡 **Prevention:** Do not promote a configuration from a small integrity fixture.
Report zero-recall frames, compare against the unchanged full-frame baseline, and
document the annotation inclusion and exclusion rules.

### Separate detector activity from detector accuracy

**Date learned:** 2026-09-17
**Category:** Object detection

⚠️ **Problem:** A compact COCO detector emitted observations for 26 of 28 retained
frames, but several application screens and product images received plausible yet
unsupported labels. Treating frames-with-results as recall would turn detector
activity into a misleading accuracy claim.

✓ **Solution:** Preserve raw confidence-scored labels and source-coordinate boxes,
record the exact model digest and runtime, and report output distributions separately
from metrics that require exhaustive annotations.

📄 **Affected files:** `scripts/diagnostics/evaluate-frame-objects.py`,
`docs/investigations/visual-content.md`

💡 **Prevention:** Define object annotation scope and checksum-bind ground truth
before selecting confidence thresholds or promoting a detector into production.

### Separate live objects from depicted media in annotations

**Date learned:** 2026-09-17
**Category:** Object detection

⚠️ **Problem:** COCO detections inside application screenshots can be technically
correct image classifications while being irrelevant to a live-scene object scope.
Without an explicit rule, the same prediction can be counted as either a true or
false positive after results are known.

✓ **Solution:** Declare the treatment of screenshots, thumbnails, illustrations,
icons, occlusion, and composited presenters before scoring. Match same-class boxes
one-to-one at a fixed IoU and report threshold comparisons against unchanged labels.

📄 **Affected files:** `scripts/fixtures/source-object-ground-truth.json`,
`scripts/diagnostics/evaluate-frame-objects.py`

💡 **Prevention:** Freeze annotation scope and source identity before detector
threshold selection, and do not generalize from a single-class-dominated fixture.

### Maximize valid one-to-one detection matches

**Date learned:** 2026-09-17
**Category:** Object detection

⚠️ **Problem:** Globally consuming the highest-IoU label/prediction pair can leave
another prediction unmatched even when a different pairing would satisfy the class
and IoU rules for both. The resulting TP, FP, and FN counts then depend on a greedy
pairing artifact.

✓ **Solution:** Build the same-class, minimum-IoU eligibility graph and use
augmenting paths to find a maximum-cardinality one-to-one matching, ordering eligible
labels by IoU only as a deterministic preference.

📄 **Affected files:** `scripts/diagnostics/evaluate-frame-objects.py`,
`backend/tests/test_object_diagnostics.py`

💡 **Prevention:** Include an adversarial matching fixture where the strongest
individual overlap must be displaced to preserve two valid true positives.

### Unannotated diversity is not a benchmark

**Date learned:** 2026-09-17
**Category:** Diagnostic integrity

⚠️ **Problem:** Additional videos broaden visible content and detector output, but
without source licenses and exhaustive annotations they cannot support accuracy,
threshold, or redistribution claims. Plausible class distributions can obscure
unsupported labels and requirements outside a detector's taxonomy.

✓ **Solution:** Record checksums and media properties, keep generated artifacts
outside the read-only input directory, and report unannotated predictions strictly
as detector activity. Require documented provenance and checksum-bound labels before
scoring or selecting defaults.

📄 **Affected files:** `sample-input-media/videos/Readme.md`,
`docs/investigations/visual-content.md`, `scripts/README.md`

💡 **Prevention:** Audit license, annotation scope, and class-taxonomy coverage as
separate gates before calling a collection an evaluation corpus.
