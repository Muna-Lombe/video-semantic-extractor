<!--
@type documentation
@purpose Track the approved Internals direction, implementation boundary, priorities, and migration plan.
-->

# Internals implementation roadmap

## Direction

The project is incrementally building an authenticated **Internals** workspace for
internal model evaluation and pipeline development:

```text
/internals                    human-facing control plane
/api/internal/v1              internal control-plane API
/review and /adjudicate       focused invitation experiences
```

The production video-to-`VideoCapsule` path remains outside Internals. Internals is
where operators prepare datasets, run sampling, generate governed annotation
templates, coordinate reviews, freeze ground truth, evaluate candidates, and govern
model and pipeline releases.

The companion [`Internals architecture`](internals-architecture.md) defines the
target resource contracts, storage split, authorization model, and route map. This
document tracks sequencing and the implemented-versus-planned boundary.

A route prefix is not a security boundary. Production intentionally keeps the
administrator token as its primary owner-level credential. Named-user email-link
sessions, operation-level role checks, verified assignment binding, and
session-derived named approval are available as an additional path. Cloudflare
Email Sending is not configured for the sender domain, so named-user sign-in and
those identity-bound workflows cannot yet be exercised in production. Do not
switch `INTERNAL_AUTH_MODE` to `sessions` until email delivery and recovery are
verified.

## Product principles

1. **Sampling precedes review.** A successful sampling job produces an immutable
   frame set and manifest. Template generation consumes that frame set; review
   creation does not generate or mutate it.
2. **References replace pasted artifacts.** A review campaign will select a
   schema-validated registered template by ID rather than accept arbitrary template
   JSON and a hand-built frame URL map.
3. **Mutable state is transactional.** D1 stores job state, assignments, approvals,
   roles, and audit events. Durable Objects may serialize concurrency-sensitive
   workflows; neither is interchangeable with R2 object storage.
   Dataset catalog data is isolated in `DATASET_DB`; job and governance data is in
   `CONTROL_DB`. Transactions and foreign keys stop at each database boundary.
4. **Large artifacts are immutable.** Source media, sampled frames, manifests,
   templates, submissions, ground-truth documents, model files, and reports belong
   in object storage with stable IDs and checksums.
5. **Managed work is durable.** Sampling and evaluation runs need durable state,
   idempotency, retries, progress, cancellation, failure detail, and artifact
   provenance. A long-running browser request is not a job system.
6. **CLI support remains.** Current diagnostic commands remain a supported legacy
   fallback and reproducibility surface. Managed jobs should call the same versioned
   engines so CLI and hosted results do not diverge.
7. **Invitations stay focused.** Reviewer and adjudicator links continue to open
   assignment-scoped interfaces. Internal coordinators get campaign and progress
   views; assignees do not need the full Internals application.
8. **Evaluation is not training.** Current diagnostics evaluate models and pipeline
   configurations. “Training” will be used only after datasets, splits, training
   runners, checkpoints, metrics, and model artifacts are actually implemented.

## Resource and artifact chain

```text
Dataset -> Dataset version -> Sampling job -> Frame set
                                             |
                                             v
Policy version --------------------------> Template
                                             |
                                             v
                                      Review campaign
                                    /        |         \
                           Reviewer A   Reviewer B   Adjudicator
                                             |
                                             v
                                      Ground-truth version
                                             |
                                             v
                                      Evaluation run
                                      /            \
                              Model version   Pipeline version
                                             |
                                             v
                                      Pipeline release
```

Every downstream resource must retain references and checksums sufficient to
reproduce its inputs. Active policies, generated templates, frame sets, approved
ground truth, and releases are immutable; changes create new versions.

## Implemented today

The following are working foundations, not the complete Internals control plane:

- Local and backend frame-sampling logic plus diagnostic comparison scripts.
- Deterministic, prediction-blind object-annotation template initialization from
  checksum-bound sampling manifests.
- CLI diagnostics for sampling, OCR, object evaluation, review comparison,
  annotation validation, and reporting.
- Focused local and hosted reviewer/adjudicator experiences.
- Hosted creation of three assignment-scoped invitations, save/complete lifecycle,
  comparison, adjudication, revocation, and private result retrieval.
- A versioned object-annotation policy and investigation evidence.
- A two-D1 dataset and scheduling foundation: authorized administrators can
  register/list datasets with HTTPS source URLs in `DATASET_DB`, while sampling
  requests are recorded in `CONTROL_DB`. Dataset creation atomically records the
  sources, marks the dataset `ready`, and freezes the initial version. New sampling requests remain
  `queued` until claimed.
- A durable sampling-job orchestration protocol: a separately authenticated
  external runner can atomically claim work with an expiring lease, heartbeat it,
  and report completion or failure. Attempts are audited; failure can requeue work;
  administrators can cancel or retry eligible jobs.
- Immutable active policy-version registration and a fixed `object-annotations.v1`
  contract; idempotent template generation from verified frame sets and policies;
  private artifacts, embedded validation reports, audit events, and Internals
  policy/template screens. Migrations 0005–0009 and the current managed Internals
  deployment are applied; operation-specific qualification and broader policy
  lifecycle remain open. See [`template registry`](template-registry.md).
- Template-referenced D1 campaigns with isolated versioned submissions, scoped
  evidence and instructions, coordinator progress/audit views, recoverable
  invitations, and immutable ground-truth candidates. Per-role reviewer/adjudicator
  tokens can be issued, rotated, revoked, and optionally bound to verified,
  role-eligible named users. Bound assignments require both the named user's
  session and the assignment token. Session-based release-approver decisions
  record the authenticated user ID; the existing administrator token remains an
  owner override. Email delivery and identity-bound production qualification remain
  blocked on sender onboarding. See [`managed review campaigns`](managed-review-campaigns.md).
- Local pipeline tracking now groups validated dataset, dataset-version,
  sampling-job, frame-set, template, review-campaign, evaluation-run, model-version,
  and pipeline-release references in `CONTROL_DB`. Pipeline progress is derived
  from linked resource states; evaluation lineage exposes its ground-truth,
  campaign, template, frame-set, and dataset-version inputs. Migration 0010 and
  its Internals screen/API were reported deployed in the previous implementation
  session; production state has not been reverified in this review.
- Checksum-bound diagnostic validation reports, explicit approval/rejection and
  approved supersession, decision/audit history, and a current evidence eligibility
  gate. Implemented and deployed; named-session decisions are role-checked and
  attributed to their authenticated user, while the current administrator token
  remains an owner override. See
  [`ground-truth governance`](ground-truth-governance.md).

A separate cron-driven sampling-runner Worker and Container now ship. They claim
leased work, resolve registered sources through a private Service binding, perform
bounded downloads, invoke FFmpeg/the shared sampler, heartbeat, upload verified
frames, and finalize immutable frame sets. The runner and control-plane Workers
are deployed, and a production sampling run completed through frame-set
finalization. Crash recovery, cancellation races, and Container resource sizing
remain to be qualified; the control-plane Worker does not execute sampling itself.

The legacy hosted review API still accepts embedded template JSON and frame URLs,
uses administrator-token compatibility, and stores mutable review records as
objects. Keep those endpoints for compatibility until replacement workflows and
legacy import tooling are verified.

## Planned Internals surfaces

| Area | Purpose | Status |
| --- | --- | --- |
| Overview | Current capability status and implementation maturity | Foundation implemented; operational metrics planned |
| Pipelines | Group resource lineage and show end-to-end progress | Local D1 registry, validated links, derived progress, evaluation lineage, API, and Internals screen implemented; migration/deployment pending |
| Datasets | Versioned source-media collections and provenance | Dedicated D1 registry accepts HTTPS source URLs, marks the dataset ready, and freezes its initial version |
| Sampling | Create, monitor, retry, and inspect durable sampling jobs | Deployed runner and control plane; one production run verified through frame-set finalization; further crash-recovery, cancellation-race, and resource-sizing exercises remain |
| Frame sets | Browse immutable manifests, evidence, coverage, and checksums | Registration, relational membership, administrator UI, and private evidence retrieval implemented |
| Policies | Version annotation rules, schemas, taxonomy, and lifecycle | Immutable active policy-version registration deployed; broader lifecycle and configurable schemas planned |
| Templates | Generate, validate, register, and version templates | Verified generation, private artifacts, and Internals inspection deployed |
| Reviews | Create template-referenced campaigns and monitor progress | D1 assignments, private evidence, Internals coordination, and on-demand role-scoped tokens deployed |
| Ground truth | Validate, approve, version, and supersede adjudicated artifacts | Diagnostic validation, explicit decisions, supersession, and eligibility deployed; named session decisions are role-checked and actor IDs are recorded, while the legacy administrator remains an owner override |
| Evaluations | Run diagnostics durably and compare reproducible results | CLI engines exist; managed jobs planned |
| Models | Register immutable model versions and evidence | Planned |
| Releases | Approve, activate, supersede, and roll back pipeline configurations | Planned |

## Prioritized implementation phases

Percentages below measure delivery of the named phase only. They are planning
estimates, not model accuracy or whole-product completion.

### Phase 0 — Contracts and architecture (in progress, 90%)

- [x] Establish the Product versus Internals boundary.
- [x] Preserve focused invitation experiences.
- [x] Commit to retaining CLI diagnostics as a legacy/reproducibility option.
- [x] Define the initial resource schema, IDs, provenance, and state machines.
- [x] Select D1 for transactional metadata and R2 for immutable artifacts; retain
  Durable Objects as an option for serialized coordination.
- [x] Define the durable job orchestration contract: runner authentication,
  atomic claim, leases, heartbeat, terminal reporting, cancellation, and retry.
- [x] Define `frame-set-manifest.v1`, including multi-source provenance, engine
  configuration, frame timestamps/reasons, media types, sizes, and checksums.
- [x] Select a separate sampling-runner Worker and Container connected to the
  Internals Worker through a private Service binding.
- [x] Define initial identity, RBAC, and audit-event contracts in code and migrations.
- [ ] Configure and verify Cloudflare Email Sending for `katundu.org`; retain the
  administrator token as the primary credential until the user explicitly approves
  an auth-mode change.
- [x] Enforce verified reviewer/adjudicator identity binding for bound assignments
  and derive named release-approver identity from authenticated sessions.
- [ ] Exercise identity-bound workflows in production after email delivery is
  available; legacy administrator-token access remains the current owner override.

### Phase 1 — Control-plane foundation (in progress, 80%)

- [x] Add named internal users, email-link challenges/sessions, role records, and
  operation-level permission checks (production currently retains legacy-token mode).
- [x] Add the initial D1-backed dataset registry and durable queued sampling-job
  metadata.
- [x] Bind the provisioned dataset and control-plane D1 databases and document
  their ownership boundary and cross-database consistency constraints.
- [x] Add cross-resource pipeline records and validated links for datasets,
  sampling jobs, frame sets, templates, reviews, evaluations, and registered
  versions; derive progress from source states without copying those states.
- Evolve the D1 migrations for versions, attempts, progress, approvals, and audit
  events as each vertical slice becomes executable.
- [x] Add durable sampling-job claims, expiring leases, attempt records,
  heartbeat, failure/requeue, and administrator cancellation/retry.
- [x] Add a separate cron-driven sampling-runner Worker and Container with bounded
  source download, shared-engine invocation, heartbeats, and verified finalization.
- [x] Deploy the runner and control plane and verify a production sampling run
  against remote media.
- Exercise crash recovery, cancellation races, and resource sizing under load.
- [x] Add lease-bound immutable frame uploads, byte/checksum/media verification,
  and idempotent frame-set finalization backed by private object storage.
- [x] Bind a dedicated private Internals R2 bucket separately from hosted review
  storage; retention and orphan cleanup remain open.
- [x] Expand the initial `/internals` status shell with dataset and sampling
  screens backed by administrator-guarded resource APIs.
- [x] Add a dedicated Frame Sets screen for browsing manifests, provenance,
  checksums, and authenticated private frame evidence.
- Continue adding resource-specific screens and operations for later pipeline
  stages.

This phase remains a prerequisite for presenting later phases as reliable hosted
workflows. `ADMIN_TOKEN` is retained in production compatibility mode until the
email sender domain is onboarded and verified. Session-only mode must not be
enabled before verified sign-in and bootstrap recovery are operational.

### Phase 2 — Dataset-to-template vertical slice (in progress, 65%)

The reusable sampling and initializer engines exist. Dataset records, queued
sampling metadata, and a separately deployable sampling executor are implemented.
The runner and control plane are deployed, and a production sampling run completed
through verified frame-set finalization. Policy-version registration, the initial annotation contract, and bounded template
generation are implemented and deployed. The local CLI now reproduces managed
template initialization from downloaded manifests and evidence, preserving
hosted/CLI parity. Operational qualification for the sampling runner remains
open.

- [x] Register HTTPS source URLs with an initial ready/frozen dataset version.
- [x] Bind each sampling request to a dataset-version ID rather than mutable
  dataset state.
- [x] Schedule sampling requests and persist their initial `queued` lifecycle
  state.
- [x] Add the control-plane protocol that claims queued work and persists leases,
  attempts, terminal reports, cancellation, and retries.
- [x] Ship an executor that fetches bounded public inputs, invokes the shared
  sampling engine, heartbeats its lease, and registers verified artifacts.
- [x] Define the strict `frame-set-manifest.v1` validation contract.
- [x] Register immutable frame sets, manifests, checksums, source membership, and
  frame evidence artifacts with administrator inspection and private retrieval.
- [x] Register immutable policy versions and pin the initial object annotation schema.
- [x] Generate and validate a template from a frame-set ID plus policy-version ID.
- [x] Deploy the registry slice.
- [x] Extend CLI support to managed manifests: `initialize-managed-annotations.py`
  validates a downloaded `frame-set-manifest.v1`, verifies local frame evidence,
  and reproduces the hosted `object-annotations.v1` template without predictions.
- [x] Retain equivalent CLI commands as supported fallback entry points.

### Phase 3 — Template-to-ground-truth vertical slice (in progress, 90%)

- [x] Create campaigns from registered template references.
- [x] Preserve the two blind reviewer assignments and independent focused UIs.
- [x] Preserve the separately scoped adjudicator UI and its completion gate.
- [x] Add coordinator progress and audit views without exposing one reviewer's labels to
  the other.
- [x] Produce a versioned ground-truth candidate from completed adjudication.
- [x] Validate and explicitly approve or reject the candidate for diagnostic evaluation.
- [x] Retain immutable validation/decision history and supersede approval with a compatible approved replacement.
- [x] Keep current legacy review APIs available during migration.
- [x] Deploy and verify managed campaigns remotely.
- [x] Add administrator issue/rotate/revoke operations for separate assignment
  tokens; retain token independence from Internals login.

### Phase 4 — Managed evaluations (planned, 15%)

The diagnostic engines exist; durable scheduling and registered outputs do not.

- Wrap current diagnostics as managed, versioned job runners.
- Pin ground-truth, model/pipeline, configuration, and implementation versions.
- Persist logs, aggregate metrics, slice metrics, per-frame errors, and checksums.
- Compare evaluation runs without changing their frozen inputs.
- Continue supporting direct CLI execution for recovery and reproduction.

### Phase 5 — Model and release governance (planned, 0%)

- Register immutable model versions, provenance, license, configuration, and
  artifacts.
- Require evaluation evidence for approval or rejection.
- Define governed pipeline versions that pin every component and threshold.
- Add candidate, approved, active, superseded, and rollback release transitions.
- Keep experimental artifacts unable to enter production without explicit approval.

## Decisions and implementation prerequisites

1. Decide which concurrency-sensitive workflows require Durable Object
   serialization in addition to D1 transactions.
2. Continue sampling-runner operational qualification: crash recovery,
   cancellation races, and Container resource sizing remain to be exercised.
3. Define internal identities and the initial role matrix: operator/researcher,
   review coordinator, reviewer, adjudicator, and release approver.
4. Define artifact retention, deletion, licensing, and access policies.
5. Version schemas for datasets, frame sets, policies, templates, ground truth,
   evaluations, models, and releases before exposing creation APIs.

## Current problems and their disposition

| Problem | Decision | Planned phase |
| --- | --- | --- |
| Sampling execution was previously manual outside the service | The API, deployed external runner, and verified production run now provide managed sampling through immutable frame-set registration; keep CLI execution/import for fallback and reproducibility | 1-2 |
| Templates were files rather than registered artifacts | D1 metadata and private immutable R2 artifacts are implemented and deployed | 1-2 |
| Legacy review creation accepts raw templates and URL maps | Managed campaigns accept template references and resolve private evidence; keep the legacy compatibility API | 2-3 |
| Diagnostics are not durable jobs | Wrap the existing engines with durable scheduling and provenance | 1, 4 |
| Transactional metadata spans two provisioned D1 databases | Keep dataset ownership in `DATASET_DB` and orchestration in `CONTROL_DB`; explicitly validate references because cross-D1 foreign keys and transactions do not exist | 1 |
| Named-user sign-in awaits sender onboarding; optional verified assignment binding and session-derived approver attribution are implemented | Verify email delivery and exercise identity-bound workflows; retain administrator-token access as primary | 1, 3, 5 |
| Ground truth now has diagnostic governance; models and pipeline releases remain ungoverned | Deploy the validation/approval slice and continue model/release lifecycle resources | 3, 5 |
| There is no complete `/internals` UI | Expand the status shell with each guarded vertical slice | 1-5 |

## Near-term definition of done

The first meaningful Internals milestone is complete only when an authorized
operator can:

1. register a versioned dataset; **implemented**
2. schedule and observe a durable sampling job; **implemented**
3. inspect its immutable frame-set manifest and evidence; **implemented**
4. generate a schema-valid registered template from that frame set and an active
   policy version; **implemented and deployed** and
5. create a review campaign by template ID without pasting JSON or per-frame URLs;
   **implemented and deployed**.

The milestone must also leave the equivalent CLI diagnostics documented and usable.
It does not claim that model training, model approval, or production promotion is
complete.

### Current slice boundary

The deployed sampling portion ends at verified frame-set registration: a dataset can
be registered from HTTPS source URLs, the dataset is marked `ready`, its initial
version is `frozen`, and a sampling request can be stored as `queued`. The deployed
authenticated runner has completed a production job through atomic claim, lease
heartbeats, checksum-verified frame uploads, and schema-valid immutable manifest
finalization. Attempts are retained, failure may requeue the job, and an
administrator can cancel or retry eligible work. URL registration itself still
does not fetch or validate source-media bytes.

The repository and production deployment include the cron-triggered Worker,
sampling Container, bounded source downloader, FFmpeg executor, heartbeat loop,
verified artifact upload, and manifest finalization path. The production run
demonstrates the happy path, not exhaustive operational qualification; crash
recovery, cancellation races, and resource sizing still need testing. The existing
command-line workflow remains the supported fallback and reproducibility path.

The deployed slice extends through policy/template registration, managed review
campaigns, assignment-scoped reviewer/adjudicator tokens, and immutable adjudicated
candidates with diagnostic validation and approval records. Control migrations 0008–0011 are applied. Named-user sign-in remains unavailable
until the chosen email sender domain is onboarded. Role checks, administrator-token
user management, optional verified assignment binding, and session-derived named
approver attribution are implemented; production exercise of the identity-bound
paths remains open. Managed evaluations, model/release governance, and the
operational qualifications listed above also remain open.
