<!-- @type documentation @purpose Document the Python backend package. -->
# Backend

The backend probes local video files, merges scene-change, fixed-interval, and
near-final frame candidates, extracts mono audio, transcribes speech with Whisper,
and validates output against the canonical Pydantic schema. Keyframes retain their
sampling provenance. `pipeline.py` exposes dependency injection points for a
different transcriber or visual analyzer.

API and CLI execution read `CAPSULE_VISUAL_MODE=basic|ocr|governed` from the server
environment. Basic mode remains the compatibility default. OCR requires Tesseract;
governed mode additionally resolves a currently eligible active release and verifies
its engine/configuration/model checksums before downloading source media. The Product
image includes Tesseract and the evaluator source. See
[`docs/product-capsule-roadmap.md`](../docs/product-capsule-roadmap.md) for setup,
question-based acceptance and the remaining limitations.

Errors from invalid media become extraction errors. API downloads are streamed,
size-limited, timeout-limited, and restricted to public HTTP(S) destinations.
