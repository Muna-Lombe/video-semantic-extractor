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

Summary tests cover source-linked quotes, temporal coverage, fixed character
budgets, sentence fragments spanning ASR segments, negation, untimed evidence and
reproducibility across Python hash seeds. Comparison tests freeze inputs without
gold answers, reject changed sources/settings/quotes, restrict supported-answer
credit to visible evidence, and preserve missing results as pending. Synthetic
answer fixtures test scoring mechanics; they are not LLM evaluation results.
