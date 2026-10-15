<!-- @type documentation @purpose Define implemented model registration and evidence-backed release operations. -->
# Model and release governance

All routes below are under /api/internal/v1. Read operations require an operator,
researcher, release approver, or owner. Researchers register candidates. Only
release approvers or the owner override may decide, activate, roll back, or retire.
Cookie-authenticated writes require same-origin requests. New implementation is
build-tested on this branch; deployment occurs after merge.

## Models

POST /models registers a candidate with these fields:

```json
{
  "name": "Diagnostic NanoDet",
  "version": "1.0",
  "license": "Apache-2.0; reviewed for the intended use",
  "provenance": {
    "source": "Pinned upstream repository/export reference",
    "implementation_version": "Exporter or implementation revision"
  },
  "configuration": { "architecture": "nanodet-plus-1.5x-416" },
  "model_base64": "BASE64_ONNX_BYTES"
}
```

Names identify model families; a family/version pair is unique. The decoded ONNX
binary is limited to 16 MiB. It is stored privately with a checksum, size, and media
type. Configuration, provenance, license, binary identity, and version are immutable.
The Models screen accepts a file and performs the encoding. Registration does not
prove compatibility: a real evaluation must succeed before a decision.

GET /models and /models/{id} return registrations and decision history.
GET /models/{id}/artifact verifies the stored bytes before returning the binary.
POST /models/{id}/approve or /reject requires If-Match: <revision> and:

```json
{ "reason": "Reviewed diagnostic evidence and permitted use", "evaluation_run_id": "evaluation_REPLACE" }
```

Evidence must be a successful run for that model with a verified immutable report,
matching input/model checksums, and currently eligible ground truth. Poor or null
scores can support rejection; approval requires complete numerical metrics.
POST /models/{id}/retire requires a reason and revision and refuses a model used by
the active release. Rejected or retired versions require a new registered version.

## Pipeline releases

POST /releases requires an approved model and explicitly pinned inputs:

```json
{
  "version": "diagnostic-1",
  "model_version_id": "mv_REPLACE",
  "components": {
    "sampler": "SAMPLER_IMPLEMENTATION_FROM_OVERVIEW",
    "annotation_schema": "object-annotations.v1",
    "evaluator": "EVALUATOR_IMPLEMENTATION_FROM_OVERVIEW"
  },
  "thresholds": { "minimum_confidence": 0.35, "nms_threshold": 0.6, "minimum_iou": 0.5 },
  "acceptance": { "minimum_f1": 0.8, "maximum_p95_inference_ms": 400 }
}
```

Use GET /api/internal/v1/overview and copy engines.sampler and engines.evaluator
verbatim into the two implementation fields; the UI prepopulates them. These
identifiers include source SHA-256 digests and are checked by the build and runner.

These example gates are not a recommendation or an approval. The operator chooses
appropriate acceptance values before evaluation; changing them requires another
release version. Only the implemented component contracts are accepted.

Queue an evaluation with this pipeline_release_id and the exact thresholds.
POST /releases/{id}/approve or /reject requires a revision, reason, and matching
successful evaluation_run_id. Approval enforces the frozen F1 and p95 gates.
Rejection records approval_status=rejected and removes the candidate from the
promotable lifecycle. A rejected configuration needs a new version.

POST /releases/{id}/activate requires an approved candidate's revision and a reason.
It rechecks report integrity, current truth eligibility, acceptance gates, and model
approval. In one transaction it supersedes the active release and activates the
chosen target. A unique index enforces a single active release.

POST /releases/{id}/rollback acts on the current active release and requires its
revision, a reason, and target_release_id naming a previously approved superseded
release. Its evidence and model must still qualify. The current release becomes
rolled_back and the selected target becomes active atomically. Rollback does not
undo D1 migrations, delete artifacts, or silently select a target.

All decisions append authenticated actor IDs where available, state transitions,
reasons, and evidence references. Stale requests fail without creating a second
winning decision. The active registry is an Internals governance resource; wiring
Product execution to it is a separate Product integration project.
