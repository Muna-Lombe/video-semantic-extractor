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
