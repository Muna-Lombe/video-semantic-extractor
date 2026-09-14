<!-- @type documentation @purpose Document the Python backend package. -->
# Backend

The backend probes local video files, extracts scene-change frames and mono audio,
transcribes speech with Whisper, and validates output against the canonical
Pydantic schema. `pipeline.py` exposes dependency injection points for a different
transcriber or visual analyzer.

Errors from invalid media become extraction errors. API downloads are streamed,
size-limited, timeout-limited, and restricted to public HTTP(S) destinations.

