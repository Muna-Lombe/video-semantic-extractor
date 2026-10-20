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
- New v1.1 capsules retain source SHA-256, OCR confidence/boxes, analyzed-frame
  dimensions/hashes and visual timeline entries with evidence paths. Object
  observations retain source-pixel boxes. Old v1.0 inputs remain readable.
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
nonempty `evidence` paths. Supported paths are `transcript.segments[0]`,
`keyframes[0].objects[0]`, or `keyframes[0].text_observations[0]`. Multiple-word
answers may cite multiple words. Optional `usage` contains recorded `input_tokens`,
`output_tokens`, and `elapsed_ms` from the actual run. The scorer checks evidence
references, time/modality and answer-text presence; independent truth of underlying
OCR/detection still requires gold annotations and human review.

```sh
python scripts/diagnostics/evaluate-capsule-questions.py \
  work/capsule.json work/questions.json --answers work/answers.json \
  --output work/usefulness-report.json
```

Compare transcript-only, capsule and original-video baselines on the same frozen
questions with documented models/settings. Report factual and supported-answer
accuracy, actual token/cost/latency measurements and failures. Byte reduction is
not a token-saving or accuracy measurement.

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
- Improve the current extractive-prefix transcript summary. Actions, identities,
  tracking and relationships remain unimplemented; scene-graph fields stay empty.
  Wider source connectors and training follow Product usefulness evidence.
- Hosted crash/cancellation/load and scheduled retention acceptance remain open.
  Email sender onboarding stays excluded.
