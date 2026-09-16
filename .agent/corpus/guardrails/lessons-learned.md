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
