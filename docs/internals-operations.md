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

The scheduled retention task runs every six hours. Operations exposes a dry-run
preview, reclaimable byte counts, archival history, pins, grace-period cancellation
and configurable stale/grace ages. Defaults are 30 unused days and a seven-day
grace period. Changes apply to new archives; an existing deletion deadline stays
immutable.

- Keep compact source/frame manifests, policy definitions, annotation and submission
  JSON, comparisons, ground truth, validation/evaluation reports, licensing records,
  decisions and append-only audit history. Their original artifact identities remain
  registered even after a bulk payload is removed.
- A stale frame set can retire only when every consumer is inactive: no unexpired
  review, pending/approved ground truth, retained evaluation/release evidence or
  explicit pin. Expired abandoned assignments are cancelled when archival wins.
  Rejected/superseded ground truth does not free inputs used by a retained run.
  Shared frame artifacts are conservatively protected.
- Rejected/retired model binaries can retire after the stale age only when no
  retained evaluation/release or explicit pin needs them. Model identity, provenance,
  license and decisions remain readable. Pin reusable frame sets/model versions
  before they become inactive; unpin them when reuse is no longer intended.
- Archive creation verifies payload bytes against registered SHA-256 digests, writes
  and verifies an immutable R2 JSON record, then atomically records its digest and
  fences new references in D1. Automatic archival verifies at most 500 payloads
  across at most five resources per pass. A racing pin or consumer aborts archival. The record
  contains resource identity, source lineage, payload checksums/ETags/sizes and the
  retained metadata references. Payloads above the current 16 MiB per-object
  verification budget remain protected for investigation.
- Scheduled archives may be cancelled before reclamation starts. After the grace
  period, one leased sweeper removes at most 25 payloads per pass, rechecks archive
  bytes and object ETags, and records deletion. A five-minute lease allows recovery
  after a crashed sweeper. Database constraints prevent new consumers or retried
  evaluations from adopting retiring inputs. Missing/corrupt archives or replaced
  payloads stop deletion. Interrupted R2/DB operations resume without losing history.
- Archived manifests and records remain downloadable. Frame evidence returns `410`
  with the archive reference. An archived record preserves audit history, not a
  promise that removed media can be replayed. Restore requires verified originals.
- Old unregistered objects retain the seven-day orphan policy. Only owned Internals
  prefixes are scanned; active uploads, finalized registrations, validation reports,
  REVIEW_BUCKET and unknown prefixes remain excluded. The scheduled bounded scan
  persists its cursor. Manual preview/apply remains available. Deletion intent is
  audited before R2 removal; tombstones fence racing artifact registration.
- Expired identity sessions and challenges are pruned in transactional batches of
  100 after seven days. Compact identifying timestamps/state are archived as audit
  events; token hashes are removed. Active sessions remain protected.
- Public sample URLs are external references. This task removes application-owned
  payloads and caches; it does not delete the supplied public media library.

Local sampling still limits intermediate extraction to 2,000 candidates per pass
and a 512 MiB JPEG budget, with no silently truncated successful frame sets. Source
limits remain 900 seconds and 3840×2160 pixels by default. Evaluation input storage
is bounded at 512 MiB and frame sets at 500 frames. Temporary source files are
removed after verified upload.

New APIs under `/api/internal/v1/operations/retention`:
`GET /` (preview), `GET /archives`, `GET /archives/<id>`, `POST /archive`,
`POST /archives/<id>/cancel`, `GET/POST/DELETE /pins`, and `PUT /settings`.
All use existing owner/operator authorization. The Worker cron executes the same
retention implementation; it does not bypass the dependency or integrity checks.

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
and optional annotation restrictions. Supported restrictions select labels from the pinned COCO or `coco-extended.v1`
taxonomy, live/composited/screen subsets, and a 1–200 object limit; they cannot
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
