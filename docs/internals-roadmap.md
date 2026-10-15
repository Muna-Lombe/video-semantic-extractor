<!-- @type documentation @purpose Track Internals implementation and separate build acceptance from production acceptance. -->
# Internals implementation roadmap

## Delivery boundary

The version-one implementation now covers:

```text
Dataset -> Sampling job -> Immutable frame set -> Policy-bound template
  -> Independent reviews -> Adjudication -> Approved diagnostic ground truth
  -> Candidate model evaluation -> Model decision -> Pinned release evaluation
  -> Release decision -> Activation -> Supersession / rollback
```

`/internals` is the operator workspace; `/api/internal/v1` is its guarded API.
`/review` and `/adjudicate` remain assignment-scoped experiences. The Product
video-to-VideoCapsule path stays separate. Evaluation does not imply training.

**Scope agreed on 2026-10-15:** complete implementation and build/testing. Email
sender onboarding is excluded. Deployment is deferred to branch merge; no new
production deployment or production acceptance is claimed by this branch.

All six phases below are implemented for the supported v1 contracts. Production
crash injection, cancellation races, load sizing, and verification of new migrations
remain release acceptance tasks. Local synthetic tests are evidence for the local
build, not substitutes for measurements on deployed Cloudflare Containers.
See [release acceptance](internals-release.md) and
[operational decisions](internals-operations.md).

## Phase 0 — Contracts and architecture

- [x] Separate Product, Internals, and focused invitations; retain CLI support.
- [x] Version resources, provenance, schemas, state machines, and job protocols.
- [x] Use DATASET_DB for the catalog, CONTROL_DB for orchestration/governance,
  and private R2 for large immutable artifacts. Cross-D1 references are validated
  explicitly; there are no cross-database transactions or foreign keys.
- [x] Define roles, named sessions, verified assignment binding, and accountable
  approval. Administrator-token compatibility remains the current owner override.
- [x] Decide concurrency: conditional D1 writes, transactions, revision assertions,
  and uniqueness constraints serialize domain transitions. No additional workflow
  Durable Object is required for the bounded v1 workflows. The Container already
  uses a Durable Object and a process execution lock.
- [x] Preserve append-only audit events and immutable artifact/model/release inputs.

Email delivery, session-only activation, and production identity-bound checks are
excluded/deferred. Do not change INTERNAL_AUTH_MODE as part of this branch.

## Phase 1 — Control-plane foundation

- [x] Versioned datasets, queued jobs, idempotency, leases, heartbeats, attempts,
  cancellation, retry, terminal failure, and expired-lease recovery.
- [x] Separately deployed runner architecture with private Service binding;
  bounded downloads, shared FFmpeg engine, verified uploads, immutable finalization.
- [x] Cap frame sets at 500 frames and release each source's temporary files.
- [x] Bound evaluation downloads and total local input storage; stop inference
  between frames when cancellation or lease loss is observed.
- [x] Alternate queue preference to prevent evaluations starving behind sampling.
- [x] Pipeline lineage/progress, resource screens, job health, storage accounting,
  recent audit events, and operator controls.
- [x] Define retention, deletion, licensing, and access policy; implement previewed,
  audited orphan reclamation with transactional registration tombstones.
- [x] Verify local lifecycle recovery/cancellation and a constrained Container
  workload. Measurements are recorded in
  [the qualification report](verification/2026-10-15-runner-qualification.json).

## Phase 2 — Dataset-to-template

- [x] Register HTTPS sources and freeze the initial dataset version.
- [x] Bind sampling to dataset-version IDs; schedule, execute, and inspect attempts.
- [x] Validate frame-set manifests, source/frame membership, sizes, and checksums.
- [x] Register immutable policy definitions; generate and validate templates.
- [x] Deprecate/retire policies with revision checks and audit reasons; preserve
  pinned instructions for existing campaigns.
- [x] Configure allowed labels, subsets, and per-frame object limits within
  object-annotations.v1. Rules are checksum-bound, carried into templates, and
  enforced in review, adjudication, and ground-truth validation.
- [x] Retain managed-manifest CLI initialization, including configured rules.

The supported annotation geometry remains source-pixel COCO boxes. New task types,
coordinate systems, or arbitrary annotation shapes require another versioned
engine contract; arbitrary JSON cannot override validation or adequacy gates.

## Phase 3 — Template-to-ground-truth

- [x] Create campaigns from registered template IDs without pasted artifacts.
- [x] Isolate two blind reviewer assignments and independent focused interfaces.
- [x] Gate adjudication on both completed reviews; preserve immutable candidates.
- [x] Provide coordinator progress/audit views, scoped evidence, and issue/rotate/
  revoke operations for reviewer/adjudicator tokens.
- [x] Optionally bind assignments to verified, role-eligible named users.
- [x] Validate, approve/reject, supersede, and recheck diagnostic eligibility.
- [x] Attribute named decisions to the authenticated approver and retain legacy APIs.

No software smoke test attests that real humans reviewed a corpus, that licensing
is permitted, or that a real corpus should be approved.

## Phase 4 — Managed evaluations

- [x] Register durable, idempotent evaluation jobs using eligible ground truth,
  checksum-bound candidate models, optional pipeline releases, frozen thresholds,
  and implementation versions. Candidates can be evaluated before approval.
- [x] Claim, heartbeat, retry/recover, cancel, and execute evaluations through the
  same runner protocol; lease-scoped input downloads enforce membership.
- [x] Persist checksum-bound reports, execution events, aggregate/source metrics,
  per-frame errors, model/runtime identity, and attempt/failure detail.
- [x] Validate report identity, exact frame/checksum coverage, numerical metrics,
  and aggregate agreement with per-frame counts before finalization.
- [x] Retrieve reports privately; compare successful runs with matching truth and
  thresholds without altering their frozen inputs.
- [x] Export private input plans/artifacts and reproduce inference through the same
  versioned engine using evaluate-managed-objects.py.
- [x] Add Internals scheduling, inspection, cancellation/retry, and comparisons.

The supported runner is the CPU OpenCV NanoDet Plus 1.5x 416 ONNX engine. Registering
a model is not evidence that its binary is compatible or accurate: inference and
an explicit, evidence-backed decision still have to succeed.

## Phase 5 — Model and release governance

- [x] Register immutable model families/versions, binaries, checksums, licenses,
  provenance, implementation references, and configuration.
- [x] Require matching successful evaluation evidence and current ground-truth
  eligibility for model decisions; permit rejection of poor candidates.
- [x] Pin model version, sampler/schema/evaluator versions, inference thresholds,
  and explicit acceptance gates in immutable release candidates.
- [x] Evaluate the exact release configuration before approval; enforce F1 and
  p95-latency acceptance thresholds on approval and activation.
- [x] Restrict decisions, activation, retirement, and rollback to release approvers
  or the owner override. Require reasons and revisions; retain decision history.
- [x] Atomically activate/supersede releases with one active release at a time;
  rollback requires a named, previously approved superseded target and fresh
  evidence checks. Protect the active model from retirement.
- [x] Add Models and Releases screens; candidate artifacts cannot activate directly.

## Acceptance after branch merge

1. Apply all pending CONTROL_DB migrations, including 0012–0014, and any pending
   DATASET_DB migrations before publishing the compatible control-plane Worker.
2. Rebuild/publish the runner image and sampling-runner Worker; the new runner is
   required for evaluation scheduling, bounded inputs, and queue fairness.
3. Run hosted smoke tests with dedicated licensed fixtures. Exercise expired-lease
   takeover after a killed runner, stale completion, cancellation during upload/
   inference/finalization, exhausted attempts, and deployment resource limits.
4. Verify private evidence/report access, identity/role enforcement where available,
   and the full approved model/release/rollback path with appropriate human review.
5. Keep email onboarding and session-only activation outside this release scope.
