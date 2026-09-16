<!-- @type documentation @purpose Document the Python backend package. -->
# Backend

The backend probes local video files, merges scene-change, fixed-interval, and
near-final frame candidates, extracts mono audio, transcribes speech with Whisper,
and validates output against the canonical Pydantic schema. Keyframes retain their
sampling provenance. `pipeline.py` exposes dependency injection points for a
different transcriber or visual analyzer.

Errors from invalid media become extraction errors. API downloads are streamed,
size-limited, timeout-limited, and restricted to public HTTP(S) destinations.
