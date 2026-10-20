<!-- @type documentation @purpose Describe backend test scope and execution. -->
# Backend tests

Run `python -m pytest`. Tests cover schema strictness, deterministic transcript
compression, frame timestamp and sampling behavior, URL safety, and API health
without downloading model weights.

Product integration tests require FFmpeg, FFprobe, Tesseract and the DejaVu Sans
font available in CI. They render a real silent video and verify early/late OCR
facts and timestamped evidence. Governed-execution tests reject changed inputs and
missing releases. Question-scorer tests keep unanswered runs unscored and reject
mismatched source/capsule/question identities. Real ONNX parity and sample-video
integration are recorded separately in the dated verification report.
