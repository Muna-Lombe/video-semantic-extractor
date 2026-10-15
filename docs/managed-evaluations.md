<!-- @type documentation @purpose Describe durable evaluations, report retrieval, comparisons, and CLI reproduction. -->
# Managed diagnostic evaluations

The branch implements queued object-detection evaluation jobs, frozen input lineage,
authenticated runner execution, reports, comparisons, and Internals operator forms.
Apply CONTROL_DB migrations through 0014 and rebuild both Workers after merge.
The same runner Container handles sampling and evaluations, alternating preference.

## Schedule and inspect

POST /api/internal/v1/evaluations accepts:

```json
{
  "ground_truth_version_id": "gt_REPLACE",
  "model_version_id": "mv_REPLACE",
  "configuration": { "minimum_confidence": 0.35, "nms_threshold": 0.6, "minimum_iou": 0.5 },
  "idempotency_key": "operator-chosen-request-key"
}
```

The selected ground truth must pass the existing diagnostic eligibility check.
Models can be candidates so evaluation can precede approval. Rejected/retired
models cannot start new runs. Optional pipeline_release_id must identify a
candidate or approved/active release pinning that model and the same thresholds.
Inputs retain the model bytes/configuration, ground-truth evidence, thresholds,
implementation source SHA-256, and a checksum. The runner refuses an engine whose
source hash differs from the frozen implementation. CI verifies generated control-
plane version constants against the Python sources. Reusing an idempotency key with different
inputs returns 409. Scheduling persists a queued job; execution depends on a runner.

GET /evaluations and /evaluations/{id} show status, provenance, output summary,
attempt history, and failure detail. POST /evaluations/{id}/cancel or /retry uses
the durable state machine. Cancelling running work sets a cancellation request;
heartbeats and lease expiry fence late results. Successful runs cannot be retried
or overwritten. A different evaluation creates another immutable run.

## Execution and outputs

Runner routes under /api/internal/v1/runner/evaluation-jobs expose claim,
heartbeat, inputs, input artifacts, completion, and failure. They require the
separate runner credential; job-specific operations additionally require a current
lease token. Downloads are limited to the model, truth, and frames in that run.
The runner verifies each downloaded size/checksum and runs the shared versioned
NanoDet engine. Ground-truth taxonomy restrictions are included in the frozen
scope and constrain evaluated prediction classes.

Reports contain model/runtime identity, thresholds, execution events, aggregate
precision/recall/F1 and latency, source slices, every registered frame, expected
objects, observations, and false-positive/false-negative details. Completion verifies
run identity, pinned checksums, exact source/frame coverage, finite scores/timing,
and agreement of aggregate metrics with frame counts. Reports are limited to 8 MiB.
Reports are written under unique attempt-owned keys; stale completion cannot delete
a winner's report. Attempts retain failures, and leases recover after a crash.

GET /evaluations/{id}/report verifies and privately serves the immutable report.
GET /evaluations/compare?baseline_id=...&candidate_id=... requires successful runs
with the same ground truth and thresholds. It reads verified reports and returns
metric deltas and source slices without modifying either run.

## Offline reproduction

GET /evaluations/{id}/inputs exports the run plan with private artifact download
paths. It remains usable after completion or later supersession for reproduction;
it does not renew approval or authorize promotion. Download each artifact to an
inputs directory with its artifact ID as the filename, then run:

```sh
python scripts/diagnostics/evaluate-managed-objects.py \
  --plan exported-plan.json --inputs-dir downloaded-inputs \
  --output reproduced-report.json
```

The CLI rejects missing, changed, or path-escaping artifacts, runs the same engine,
and preserves run/input/model/truth identities. It refuses to overwrite an existing
output. Inference latency varies by hardware and runtime; checksum and input parity
do not imply bitwise identical timing. Existing diagnostic CLIs remain supported.
