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

A route prefix is not a security boundary. `/internals` requires authenticated
identities, authorization, and auditability before it can be treated as private.

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

A separate cron-driven sampling-runner Worker and Container now ship. They claim
leased work, resolve registered sources through a private Service binding, perform
bounded downloads, invoke FFmpeg/the shared sampler, heartbeat, upload verified
frames, and finalize immutable frame sets. Remote Cloudflare rollout and real-media
verification remain open; the control-plane Worker intentionally does not execute
sampling itself.

The existing hosted review API still accepts embedded template JSON and frame URLs,
uses a shared administrator token, and stores mutable review records as objects.
Those are prototype constraints to migrate, not the target control-plane model.

## Planned Internals surfaces

| Area | Purpose | Status |
| --- | --- | --- |
| Overview | Current capability status and implementation maturity | Foundation implemented; operational metrics planned |
| Datasets | Versioned source-media collections and provenance | Dedicated D1 registry accepts HTTPS source URLs, marks the dataset ready, and freezes its initial version |
| Sampling | Create, monitor, retry, and inspect durable sampling jobs | Runner, claims, leases, attempts, verified upload/finalization, failure/requeue, cancel, and retry implemented; remote rollout remains unverified |
| Frame sets | Browse immutable manifests, evidence, coverage, and checksums | Registration, relational membership, administrator UI, and private evidence retrieval implemented |
| Policies | Version annotation rules, schemas, taxonomy, and lifecycle | Policy document exists; registry planned |
| Templates | Generate, validate, register, and version templates | CLI generation exists; registry planned |
| Reviews | Create template-referenced campaigns and monitor progress | Hosted workflow exists; Internals integration planned |
| Ground truth | Validate, approve, version, and supersede adjudicated artifacts | Result artifact exists; governance planned |
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
- [ ] Define identity, RBAC, and audit-event contracts.

### Phase 1 — Control-plane foundation (in progress, 80%)

- Add authenticated internal users and explicit roles.
- [x] Add the initial D1-backed dataset registry and durable queued sampling-job
  metadata.
- [x] Bind the provisioned dataset and control-plane D1 databases and document
  their ownership boundary and cross-database consistency constraints.
- Evolve the D1 migrations for versions, attempts, progress, approvals, and audit
  events as each vertical slice becomes executable.
- [x] Add durable sampling-job claims, expiring leases, attempt records,
  heartbeat, failure/requeue, and administrator cancellation/retry.
- [x] Add a separate cron-driven sampling-runner Worker and Container with bounded
  source download, shared-engine invocation, heartbeats, and verified finalization.
- Verify the runner against real remote media and tune Container resources.
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

This phase is a prerequisite for presenting later phases as reliable hosted
workflows. A shared `ADMIN_TOKEN` may remain as a development bootstrap but is not
the final authorization design.

### Phase 2 — Dataset-to-template vertical slice (in progress, 65%)

The reusable sampling and initializer engines exist. Dataset records, queued
sampling metadata, and a separately deployable sampling executor are implemented;
remote rollout and template registration remain open.

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
- Register versioned policies and annotation schemas.
- Generate and validate a template from a frame-set ID plus policy-version ID.
- Retain equivalent CLI commands as supported fallback entry points.

### Phase 3 — Template-to-ground-truth vertical slice (partially implemented, 45%)

- Create campaigns from registered template references.
- Preserve the two blind reviewer assignments and independent focused UIs.
- Preserve the separately scoped adjudicator UI and its completion gate.
- Add coordinator progress and audit views without exposing one reviewer's labels to
  the other.
- Produce a versioned ground-truth candidate from completed adjudication.
- Validate and explicitly approve or reject the candidate.
- Keep compatibility aliases for current review APIs during migration.

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
2. Deploy and verify the implemented sampling-runner Worker and Container against
   real media. Its `CONTROL_PLANE` Service binding and periodic claims are present;
   remote resource sizing, rollout behavior, and crash-recovery exercises remain.
3. Define internal identities and the initial role matrix: operator/researcher,
   review coordinator, reviewer, adjudicator, and release approver.
4. Define artifact retention, deletion, licensing, and access policies.
5. Version schemas for datasets, frame sets, policies, templates, ground truth,
   evaluations, models, and releases before exposing creation APIs.

## Current problems and their disposition

| Problem | Decision | Planned phase |
| --- | --- | --- |
| Sampling execution is still manual outside the service | The API now persists requests and exposes leased claims/attempts; ship an external runner while retaining CLI execution/import | 1-2 |
| Templates are files rather than registered artifacts | Store transactional metadata separately from immutable template content in object storage | 1-2 |
| Review creation accepts raw templates and URL maps | Accept validated template references after registry migration; preserve compatibility temporarily | 2-3 |
| Diagnostics are not durable jobs | Wrap the existing engines with durable scheduling and provenance | 1, 4 |
| Transactional metadata spans two provisioned D1 databases | Keep dataset ownership in `DATASET_DB` and orchestration in `CONTROL_DB`; explicitly validate references because cross-D1 foreign keys and transactions do not exist | 1 |
| There is no internal-user authentication or RBAC | Required before Internals is considered private or multi-user ready | 1 |
| Ground truth, models, and pipeline releases are not governed | Add versioned lifecycle resources and explicit approval transitions | 3, 5 |
| There is no complete `/internals` UI | Expand the status shell with each guarded vertical slice | 1-5 |

## Near-term definition of done

The first meaningful Internals milestone is complete only when an authorized
operator can:

1. register a versioned dataset;
2. schedule and observe a durable sampling job;
3. inspect its immutable frame-set manifest and evidence; **implemented**
4. generate a schema-valid registered template from that frame set and an active
   policy version; and
5. create a review campaign by template ID without pasting JSON or per-frame URLs.

The milestone must also leave the equivalent CLI diagnostics documented and usable.
It does not claim that model training, model approval, or production promotion is
complete.

### Current slice boundary

The current slice stops at verified artifact registration: a dataset can be
registered from HTTPS source URLs, the dataset is marked `ready`, its initial
version is `frozen`, and a sampling request can be stored as `queued`. An
authenticated external runner can claim it atomically, heartbeat its lease, upload
checksum-verified frame images, and finalize a schema-valid immutable manifest;
attempts are audited, failure may requeue the job, and an administrator can cancel
or retry eligible work. URL registration still does not fetch or validate source
media bytes.

The repository now ships the cron-triggered Worker, sampling Container, bounded
source downloader, FFmpeg executor, heartbeat loop, verified artifact upload, and
manifest finalization path. This is not yet an operationally verified hosted
pipeline: the runner image and Service binding have not been deployed in an
authenticated Cloudflare account or exercised against real remote media. The
existing command-line workflow therefore remains the supported fallback.
