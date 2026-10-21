<!-- @type documentation @purpose Separate Product integration from measured semantic and hosted acceptance. -->
# Product VideoCapsule delivery and acceptance

The Product goal is compact, trustworthy video evidence that helps an LLM answer
questions without receiving the complete video. Annotation counts and passing
software tests do not establish that goal.

## Implemented in this branch

- API and CLI support `CAPSULE_VISUAL_MODE=basic|ocr|governed`. Basic remains the
  compatibility default and marks visual semantics unknown. OCR uses Tesseract PSM
  11 with confidence >=0.5, frame dimension limits, a per-frame timeout and output
  limits. Recognized text remains a model observation.
- New v1.2 capsules retain source SHA-256, OCR confidence/boxes, analyzed-frame
  dimensions/hashes and visual timeline entries with evidence paths. Object
  observations retain source-pixel boxes. Old v1.0/v1.1 inputs remain readable.
- Transcript summaries now select whole sentences across early, middle and late
  source units, then fill the character budget by lexical novelty. Sentence
  fragments across ASR segments stay together, including negation. Each excerpt
  cites its original segment and timestamps; untimed speech keeps its source text
  and null timestamps. Oversized units are omitted, never clipped. Omission counts,
  the budget and implementation digest are retained. Quoting ASR does not establish
  that the ASR recognized the video correctly.
- Governed mode resolves `/api/internal/v1/releases/active/execution` per extraction.
  Internals rechecks approved active state, model approval, eligible ground truth,
  exact release evaluation/acceptance and artifact integrity. Product verifies
  configuration, engine identity and model SHA/size before fetching source media.
  Failure returns 503 without a silent model/basic fallback. Capsule execution
  metadata records the release/revision, configuration/model digests, evaluation
  ID, thresholds and OCR/OpenCV versions.
- NanoDet is shared with diagnostics. The evaluator fingerprint now includes the
  imported detector and fingerprint implementation. New engine identities require
  matching new evaluation/release evidence; historical artifacts remain frozen.
- Diagnostic campaign creation supports `purpose: "diagnostic"`. Readiness requires
  exact frozen sources and policy scope capable of meeting unchanged gates.
  Template generation rejects incompatible explicit profiles. The UI defaults to
  diagnostic review and displays the effective taxonomy. Annotation-only work
  remains possible; omitted API purpose preserves legacy annotation behavior.
  Purpose is audited and protected against idempotency-key reuse. Existing
  campaigns, annotations and approvals are not rewritten.
- A source-bound question scorer reports normalized short-answer correctness and
  timestamped evidence separately. Missing model answers produce null scores and
  usage. The harness does not call an LLM or fabricate a completed run.

## Configure Product execution

Install FFmpeg, FFprobe and Tesseract for local OCR:

```sh
CAPSULE_VISUAL_MODE=ocr video-capsule video.mp4 --output work/capsule.json
```

For governed local/server execution, configure `CAPSULE_CONTROL_PLANE_URL` as the
HTTPS Internals origin and supply `CAPSULE_CONTROL_PLANE_TOKEN` through the service
environment. An installed wheel outside this checkout also needs
`CAPSULE_EVALUATOR_PATH` pointing to `scripts/diagnostics/evaluate-frame-objects.py`.
The Product image sets its own evaluator path and includes Tesseract.

The optional Product Cloudflare Container has a `CONTROL_PLANE` Service binding.
Its Worker intercepts `product-control.internal` and injects the
`CAPSULE_CONTROL_TOKEN` Worker secret. The long-lived credential never enters the
Container; its placeholder only selects the private transport. Only GET of the
active snapshot or a model artifact is forwarded. Writes, unrelated resources,
query strings and redirects are excluded. Configure the Worker's
`CAPSULE_VISUAL_MODE` explicitly; its checked-in setting remains `basic`.
Standalone external control-plane requests require HTTPS.

Product remains a separate optional deployment from the hosted Internals Worker.
`/capsule` on the Internals origin returns 404. The probed Product URLs returned
403, so hosted Product acceptance is unverified. Deploy through branch merge and
retain existing Product access/cost controls. This task changed no production
configuration.

## Question-based acceptance

Freeze independently authored questions before examining candidate outputs. A
`capsule-question-set.v1` file contains `source_sha256` and a nonempty `questions`
array. Each question has a unique `id`, `question`, predeclared `accepted_answers`,
`start_sec`, `end_sec`, and `modality` (`speech`, `text`, or `object`). Include
early/middle/late facts, short appearances, speech-only facts and screen text.
Declare legitimate aliases before runs; exact normalized short-answer scoring is
conservative and does not judge general reasoning or negation.

```sh
python scripts/diagnostics/evaluate-capsule-questions.py \
  work/capsule.json work/questions.json --output work/question-plan.json
```

The unanswered report records capsule and question-set digests. Real model answers
use `capsule-answers.v1`, those `capsule_sha256` and `question_set_sha256` values,
a `model` identifier and one answer per question: `question_id`, `answer`, and
`evidence` paths. Insufficient evidence can return `answer: "unknown"` with
`evidence: []`; this receives no supported-answer credit. Supported paths include
`transcript.segments[0]`, `transcript.summary.excerpts[0]`,
`transcript.unsegmented_text`, `keyframes[0].objects[0]`, and
`keyframes[0].text_observations[0]`. Untimed speech can support only whole-video
questions. Multiple-word
answers may cite multiple words. Optional `usage` contains recorded `input_tokens`,
`output_tokens`, and `elapsed_ms` from the actual run. The scorer checks evidence
references, time/modality and answer-text presence; independent truth of underlying
OCR/detection still requires gold annotations and human review.

```sh
python scripts/diagnostics/evaluate-capsule-questions.py \
  work/capsule.json work/questions.json --answers work/answers.json \
  --output work/usefulness-report.json
```

## Frozen comparison inputs

Prepare transcript-only, summary-only and full-capsule prompts from one capsule:

```sh
python scripts/diagnostics/compare-capsule-inputs.py prepare \
  work/capsule.json work/questions.json work/comparison
```

This creates `plan.json` and three `<variant>.input.json` files. Existing
directories are refused. Prompts contain question IDs and wording, without gold
answers, gold time windows or annotation provenance. Summary inputs include only
verified quotes. Plans bind exact capsule, questions and input bytes with SHA-256.

Run the three inputs separately using the same actual model and configuration.
Record each response in a `capsule-answers.v1` file as above, with its variant's
`input_sha256` and a nonempty `run_configuration` object (for example temperature,
seed and maximum output tokens). Collect actual provider usage when available.
Then score:

```sh
python scripts/diagnostics/compare-capsule-inputs.py score \
  work/capsule.json work/questions.json work/comparison \
  --answers transcript=work/transcript-answers.json \
  --answers summary=work/summary-answers.json \
  --answers capsule=work/capsule-answers.json --output work/comparison-report.json
```

Changed inputs or different model/configuration are rejected. Supported-answer
credit requires evidence visible in the respective prompt; a guessed correct
answer cannot cite withheld visual or transcript content. Running `score` without
all three answer files leaves the comparison pending. Missing token/latency
measurements remain null. Byte reduction can be negative and establishes neither
token savings nor accuracy. The tool records results; it does not call an LLM.
An independently assessed original-video baseline remains future acceptance work.

## Local real-media evidence

The [2026-10-21 verification](verification/2026-10-21-evidence-linked-summaries.json)
records actual Whisper-tiny runs on samples 27 and 1, preserving both outcomes.
Sample 27 returned only two occurrences of “you”; it does not demonstrate useful
speech summarization. The interview contrast produced 24 ASR segments and a
775-character summary with 10 cited excerpts. Its speech accuracy has not been
independently measured. The interview was selected for its existing speech tag
after sample 27's low-information result, rather than as a random benchmark.

Three visual-text questions for sample 27 were frozen from one original frame
before consulting candidate outputs. They are a limited diagnostic fixture, not
an approved corpus. Frozen inputs await actual LLM responses; no answer accuracy,
token saving or hosted acceptance is claimed.

## Remaining acceptance

- Correct current annotations and register a replacement policy/template with the
  intended taxonomy, compatible profile and exact frozen sources. Preserve the
  draft; independent passes and approval must be real.
- Obtain adequate reviewed ground truth. Hosted state has four invalid candidates,
  no approved model and no releases; governed execution should remain unavailable.
- Complete hosted Product extraction through its real access boundary; record
  resource limits/cold starts and exercise release changes/ineligible truth.
- Run real LLM comparisons. No semantic-benefit, token-saving or pass-rate claim
  follows from this implementation.
- Evaluate summary usefulness across independently labeled speech and visual
  cases. Actions, identities, tracking and relationships remain unimplemented;
  scene-graph fields stay empty.
  Wider source connectors and training follow Product usefulness evidence.
- Hosted crash/cancellation/load and scheduled retention acceptance remain open.
  Email sender onboarding stays excluded.
