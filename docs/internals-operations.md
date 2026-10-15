<!-- @type documentation @purpose Resolve Internals concurrency, retention, licensing, and operational qualification decisions. -->
# Internals operational decisions

## Concurrency and failure recovery

CONTROL_DB conditional writes and transactions are the serialization boundary for
claims, attempts, review revisions, decisions, and release activation. Decision
batches assert the expected revision before changing state or appending audit
records. A partial unique index permits one active pipeline release. D1 CHECK
failures roll back the complete batch. No additional workflow Durable Object is
needed for the bounded v1 domain; the runner's Container Durable Object and process
lock serialize Container execution.

R2 and D1 cannot commit together. Writers use immutable per-attempt objects, then
register metadata transactionally; losing attempts remove only objects they own.
A process crash can leave an unregistered object. Old objects are eligible for
cleanup only under the rules below. Cross-D1 references point to frozen catalog
versions and are validated explicitly.

Sampling and evaluation jobs retain every attempt. Expired leases cannot download
inputs, heartbeat, or complete work. Claiming sweeps expired cancelled/exhausted
jobs to terminal states and can reclaim eligible expired work. Cancellation is
cooperative while a process is alive; after a crash, the lease expiry enforces the
terminal outcome. Evaluation checks cancellation between frames. Sampling checks cancellation during FFmpeg execution; its
cancelled lease still cannot finalize artifacts. Queues alternate preference.

## Retention and deletion

- Retain all registered evidence, manifests, templates, submissions, ground truth,
  model binaries, evaluation reports, decisions, and audit events. Supersession,
  rejection, retirement, or cancellation does not authorize deleting lineage.
- Audit events reject UPDATE/DELETE. Artifact identity and model/release inputs
  reject mutation; changed inputs require another version.
- Local media and frame files are temporary. Sampling candidates are limited to
  2,000 per extraction pass and monitored against a 512 MiB intermediate JPEG
  budget every 100 ms; exceeding it terminates FFmpeg and fails the attempt, with
  no silently truncated successful frame set. Sources default to at most 900 seconds
  and 3840×2160 pixels. Cancellation can terminate FFmpeg while it is running. Sampling deletes each source after
  upload. Evaluation input storage is capped at 512 MiB by default, individually
  streamed downloads at 16 MiB, and frame sets at 500 frames.
- Only objects in the private Internals bucket, in owned artifact prefixes, older
  than seven days, and unreferenced by artifact/validation metadata are eligible
  for orphan cleanup. Queued/running upload owners and finalized uploads are kept.
  REVIEW_BUCKET and unknown prefixes are excluded.
- GET /api/internal/v1/operations/orphans is a paginated preview. POST requires
  selected key/etag pairs and a reason. Age, etag, and references are rechecked.
  A D1 tombstone prevents artifact registration racing deletion. Failed storage
  deletion is safe to retry; tombstones remain as registration fences.
- Registered lineage deletion requires a separate owner-reviewed retention/legal
  process with a dependency inventory and export. The orphan API refuses it.
  Do not cascade-delete production evidence to reclaim space.

## Access and licensing

Private R2 has no public evidence URL. Access flows through named roles or the
current owner-level administrator-token compatibility path. Focused tokens grant
one assignment; bound assignments also require the matching verified session.
Cookie-authenticated Internals mutations require same-origin requests.

Operators must have permission to fetch dataset source media. Ground-truth approval
retains explicit policy, independent-review, prediction-blindness, and diagnostic
licensing attestations. Model registration requires a license, source provenance,
and implementation version, all immutable. These declarations are retained for
human review; software cannot grant rights or verify the truth of an attestation.
Release decisions must review the model's permitted deployment use. No test
fixture or synthetic benchmark constitutes real-corpus or production approval.

## Versioned contracts

The executable contracts are frame-set-manifest.v1, object-annotations.v1,
managed-ground-truth.v1, managed-evaluation-inputs.v1,
managed-evaluation-report.v1, and pipeline-release.v1. Dataset versions are frozen
in DATASET_DB. Policy versions freeze schema, instructions, validation profile,
and optional annotation restrictions. Supported restrictions select subsets of
COCO labels, live/composited/screen subsets, and a 1–200 object limit; they cannot
weaken evidence integrity or diagnostic adequacy gates. Entirely new task shapes
require a new supported contract, rather than arbitrary schema JSON.

## Local qualification and production acceptance

Run scripts/operations/qualify-internals-runner.py with the pinned model documented
in scripts/README.md. It generates synthetic media, executes actual FFmpeg and
OpenCV inference, checks temporal coverage and cooperative evaluation cancellation,
and records memory, storage, latency, and cgroup limits. It makes no accuracy claim.

The 2026-10-15 local run used 1 GiB memory and 0.25 CPU limits: 13 sampled frames,
17.486 seconds wall time, 123,031,552 bytes peak cgroup memory, 1,333,219 bytes local
media/frame storage, and 304.228 ms p95 inference. These figures describe one small
synthetic workload; they do not qualify production concurrency, worst-case inputs,
Cloudflare cold starts, or release-specific latency gates.

Production acceptance after merge must separately run a dedicated licensed dataset
through sampling, template generation, independent review, adjudication, validation,
real approval, model evaluation, release decision/activation, and rollback. Kill a
runner while it owns a lease, verify expiry/takeover and stale-write rejection,
cancel during artifact upload and inference, exhaust retries, and measure the
actual Container limits and input extremes. Preserve job IDs, attempts, manifests,
reports, deployment/image versions, limits, and measurements as release evidence.
