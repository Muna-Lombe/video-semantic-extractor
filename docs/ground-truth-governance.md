<!-- @type documentation @purpose Define diagnostic candidate validation, accountable decisions, and evaluation eligibility. -->
# Ground-truth validation and approval

This repository now implements recorded validation, diagnostic approval/rejection,
supersession, and an evidence-checked eligibility gate. The original slice is
recorded as deployed. This branch adds same-origin session write enforcement,
immutable policy guards, and configurable annotation restrictions. Apply pending
control migrations through 0014 before publishing after merge. The Internals Ground truth screen exposes the workflow.

## Frozen diagnostic profile

Policy registration optionally accepts `validation_profile` with ID
`coco-object-diagnostic.v1` and exactly five distinct source-video SHA-256 digests
in `source_sha256`. The UI can copy those digests from a five-source frame set.
Digests are sorted into the checksum-bound policy definition. A changed profile
requires a new policy version, template, and independent review campaign; existing
versions cannot be overwritten. Policies without this profile still support review
but cannot establish diagnostic evaluation approval from prose alone.

The fixed profile mirrors the existing diagnostic policy's machine-checkable gates:

- Every registered frame reviewed, two completed independent passes, completed
  adjudication, and candidate predictions declared unseen.
- Exactly the five frozen source digests. Managed source IDs replace the legacy
  fixture filenames; byte identity remains pinned, and duplicate media cannot count
  as five distinct sources.
- Valid COCO labels and source subsets, globally unique annotation IDs, integer
  source-pixel boxes within bounds, and minimum visible boxes of 8×8 pixels.
- At least 50 non-person instances and five non-person classes.
- At least 20 live, 20 screen, and 10 composited instances.
- At least 15 small instances (area below 2%) and 15 large instances (above 20%).
- No single source supplies more than 60% of positive instances.

Threshold overrides and unknown profiles are rejected. Inclusion judgments,
independence of actual people, unseen predictions, and licensing require accountable
human confirmation. These rules do not validate OCR, brands, actions, or excluded
capabilities. Approval scope is diagnostic evaluation only; commercial training or
production promotion is not authorized by this workflow.

## Recorded validation

`POST /api/internal/v1/ground-truth/<id>/validate` with `If-Match: <revision>` runs
bounded synchronous validation. It checks candidate/template/manifest bytes and
digests, policy compatibility, relational source/frame provenance, completed
assignments, immutable submissions, comparison reproducibility, exact adjudication
coverage, and current private frame metadata. Frame image bytes were checksum-verified
at upload; this validator checks their stored size, media type, and digest metadata,
using sampler-pinned dimensions rather than decoding each image in the Worker.
It then applies structural and frozen corpus gates and records counts/shortfalls.

Each run writes an immutable private R2 JSON report with
`ground-truth-validation-report.v1`, validator `managed-ground-truth.v1`, input
digests, reviewer/comparison/adjudication digests, profile, integrity result, and
annotation/adequacy results. A D1 transaction updates the candidate revision and
latest-report pointer, registers report metadata and an audited completed validation
job, and writes the audit event. A failed gate produces an `invalid` version and a
completed validator job: execution succeeded, while the candidate failed validation.
Passing all gates produces `valid`, which still means not approved.

Undecided versions can be revalidated; all reports remain available as history.
Approved, rejected, and superseded versions cannot be silently revalidated or
rewritten. Concurrency guards permit one winning run. Failed transactions/stale runs
clean their own unreferenced report objects; crashes may still require general
orphan cleanup. This is not a queued, retryable validation runner. Existing managed
limits of 500 frames, 512 KiB submissions, and 1 MiB comparisons remain.

## Decisions and replacement

All routes require administrator authorization. Mutation routes require `If-Match`
with the current candidate revision (`428` if absent, `412` if stale). Decision
bodies have a 64 KiB limit and require a non-empty `actor_reference` (up to 200
characters) and `reason` (up to 2,000 characters).

- POST `/<id>/approve` requires a current passing report, unchanged evidence,
  `scope: "diagnostic"`, and explicit true attestations for `policy_reviewed`,
  `independent_humans_confirmed`, `predictions_unseen_confirmed`, and
  `licensing_scope_confirmed`. These are inside an `attestations` object.
- POST `/<id>/reject` records a terminal rejection of an undecided candidate.
  Corrections require another reviewed candidate rather than reversing history.
- POST `/<id>/supersede` requires `replacement_id`: a different eligible approved
  version over exactly the same frozen template. The old version remains readable
  with its approval and replacement history, but loses evaluation eligibility.

Decisions, lifecycle changes, and audit entries are transactional and version-guarded.
Candidate bytes never change. The database's legacy `status` field uses `invalid`
for rejection; `approval_status: "rejected"` distinguishes rejection from a failed
validation. Supersession sets both statuses to `superseded` and retains the successor.

The accountable reference is declared under the bootstrap administrator token, not
verified named-user authentication. `approved_by` remains null; the decision record
retains the declared reference, reason, attestations, validation ID, candidate digest,
and timestamp. Internal user identities and approver RBAC remain planned. The agent
implements and tests this workflow; actual approval is an explicit operator action.

## Eligibility and evidence retrieval

GET `/api/internal/v1/ground-truth` lists versions. GET `/<id>` includes validation
and decision history; GET `/<id>/artifact` downloads checksum-verified candidate JSON;
GET `/<id>/validations/<validation-id>/report` retrieves a checksum-verified report
scoped to that version. Responses use `Cache-Control: no-store`.

GET `/<id>/eligibility?scope=diagnostic` rechecks approval scope, a matching approval
decision and attestations, the current validator/report, input digests, completed
review evidence, and private evidence metadata. Candidates, failed or rejected
versions, superseded versions, missing evidence, and unsupported scopes cannot pass.
Future evaluation runners must call the exported `getEligibleGroundTruth` helper
and then verify the actual image bytes they consume; a status label alone is not
authorization or input integrity. No evaluation runner is added by this slice.

Tests execute actual SQLite migrations and cover passing/failing corpus gates,
frozen checksum identity, profile immutability, minimum integer boxes, missing or
changed artifacts/review evidence, approval attestations, concurrent decisions and
validation, rejection during report upload, supersession compatibility, decision
history, eligibility, scoped reports, and rollback with no partial state.
