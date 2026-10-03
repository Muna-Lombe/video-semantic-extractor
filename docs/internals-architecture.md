<!--
@type documentation
@purpose Define the target architecture and delivery plan for the internal model-evaluation and pipeline-development workspace.
-->

# Internals architecture

## Status and scope

This document records the target direction for the internal development,
evaluation, annotation, and model-governance environment. It is an architecture
plan, not a claim that every resource or route described here is implemented.
The current hosted review service and command-line diagnostics remain operational
while this plan is delivered incrementally.

The application has two intentionally separate areas:

- **Product** turns user videos into versioned `VideoCapsule` results.
- **Internals** develops, evaluates, annotates, and governs the models and pipeline
  releases used by Product.

The human-facing internal workspace is rooted at `/internals`. Its canonical
control-plane API is rooted at `/api/internal/v1`. Product extraction routes stay
outside that namespace. A route prefix is not a security boundary: all Internals
routes require authenticated identities and explicit authorization.

## Guiding decisions

1. Sampling is a managed Internals pipeline. A successful sampling job produces
   an immutable frame set, rather than loose files that an administrator must
   assemble manually.
2. Templates are generated before review creation from a frame-set reference, a
   policy-version reference, and an annotation-schema version. Review creation
   selects a validated template; it does not generate one.
3. Existing diagnostic commands remain supported as a **legacy/offline CLI**.
   Managed jobs invoke the same underlying library behavior so the web workflow
   and CLI do not develop incompatible algorithms.
4. Reviewer and adjudicator invitation experiences remain focused. `/review/`
   and `/adjudicate/` do not expose the wider Internals navigation or unrelated
   data.
5. Mutable control-plane state is transactional. Large and immutable artifacts
   live in object storage.
6. Ground truth, model versions, evaluation runs, and pipeline releases are
   governed, versioned resources with provenance and audit history.
7. Experimental artifacts cannot enter Product implicitly. Promotion through an
   approved pipeline release is explicit and reversible.
8. Managed sampling runs in a dedicated **sampling-runner Worker and Container**,
   not in the control-plane Worker and not in the Product capsule Container. The
   runner reaches the control plane through a same-account Service binding; it
   does not require the control-plane API to be exposed as a public runner URL.
   This runner now ships in the repository; remote deployment remains to be verified.

## Product and Internals boundary

```text
Product                                  Internals
-------                                  ---------
video ingestion                          datasets and dataset versions
production processing jobs               sampling jobs and frame sets
capsule inspection and retrieval          policies and templates
production monitoring                     review campaigns and adjudication
customer exports and integrations         ground truth and evaluation runs
approved pipeline execution               models and pipeline releases
```

The current capsule extraction API belongs to Product. Sampling comparisons,
annotation initialization, review coordination, annotation validation, OCR and
object-model diagnostics, and release qualification belong to Internals.

## Resource graph

```text
Dataset
  `-- Dataset version
        `-- Sampling job
              `-- Frame set
                    |-- Sampling evaluation
                    `-- Template (frame set + policy version + schema version)
                          `-- Review campaign
                                |-- Reviewer A assignment/submission
                                |-- Reviewer B assignment/submission
                                `-- Adjudication
                                      `-- Ground-truth version
                                            `-- Evaluation run
                                                  |-- Model version
                                                  `-- Pipeline candidate
                                                        `-- Pipeline release
                                                              `-- Product
```

Every derived resource records its direct inputs, immutable artifact checksums,
implementation version, creator, timestamps, and relevant configuration. This
chain must make a production result traceable to the approved release and make an
evaluation reproducible from frozen inputs.

## Pipelines

### Dataset and sampling pipeline

An internal operator registers one or more source-media HTTPS URLs. Dataset
creation records those sources in an initial version, marks the dataset `ready`,
and freezes the version before it can be referenced by a sampling job. Frozen versions
are immutable: adding, removing, or replacing a source creates a new version.
Registration captures source identity and provenance only; fetching, checksumming,
and validating the remote media belongs to managed execution. The operator then
schedules a sampling job with an explicit strategy and configuration. Job outputs
are:

- an immutable frame-set record;
- source checksums and a complete frame manifest;
- sampled frame artifacts;
- a sampling report and warnings;
- the implementation version and reproducibility configuration.

The durable lifecycle is:

```text
draft -> queued -> running -> succeeded
                  |
                  +---------> failed
queued/running --------------> cancelled
failed/cancelled ------------> queued (explicit administrator retry)
```

An external runner authenticates with a dedicated runner credential and atomically
claims one eligible queued job. The claim creates a durable attempt record,
associates a stable runner identity, moves the job to `running`, and returns a
one-time lease token with a bounded expiry. Only the holder of the current lease
may heartbeat, report completion, or report failure. Heartbeats extend the lease;
an expired or superseded lease cannot mutate the job. A failed attempt may be
requeued within the configured retry policy, while administrator cancel and retry
operations remain separately authorized and durably recorded. General audit-event
coverage is still planned.

Every state mutation rechecks the current job state, lease hash, and lease expiry;
stale callers receive a conflict instead of a false success response. Claim-time
reconciliation closes expired attempts, converts abandoned cancellation requests
to `cancelled`, converts exhausted jobs to `failed`, and leaves retry-eligible jobs
available for a new attempt. Idempotency keys identify the complete canonical
sampling request, so the same key cannot silently alias different inputs.

The application, not the administrator, resolves frame artifacts to protected
evidence URLs. A frame set can be validated, inspected, compared with another
frame set, and used by more than one downstream template without mutation.

The existing sampling commands remain available for offline and recovery use.
Their output format should stay importable into Internals so legacy work can be
registered without rerunning expensive jobs.

The first executable slice deliberately separates **control-plane orchestration**
from **job execution**. It registers datasets, ready/frozen versions, and HTTPS
sources in `DATASET_DB`, and persists sampling-job metadata in `CONTROL_DB` with
an initial `queued` state. Runner-authenticated endpoints provide atomic claims
with expiring leases, heartbeats, verified frame uploads, manifest finalization,
failure/requeue behavior, and attempt audit records; administrator endpoints
provide cancellation and retry. That makes the request, artifact-registration,
    and orchestration surfaces durable and queryable. A separate sampling executor
    now ships, while the CLI remains the offline/recovery path. Until the runner is
    deployed and verified, hosted jobs will still remain queued.

### Sampling-runner deployment topology

The selected managed-execution topology is:

```text
scheduled trigger or queue
          |
          v
sampling-runner Worker ---- Durable Object binding ----> sampling Container
          |
          +---- CONTROL_PLANE Service binding ----------> Internals Worker
                                                               |-- CONTROL_DB
                                                               |-- DATASET_DB
                                                               `-- private R2
```

The runner is a separate deployment with a separate failure, scaling, secret, and
cost boundary. It reuses the shared Python sampling engine but does not reuse the
Product `/capsule` Container: capsule extraction and managed dataset sampling have
different API contracts, authentication, lifecycle, and resource profiles.

The runner Worker owns orchestration. A scheduled trigger or queue wakes it; it
claims one eligible job through its `CONTROL_PLANE` Service binding, starts or
contacts the sampling Container through its Durable Object binding, maintains the
lease heartbeat, and forwards verified frames and the final manifest back through
the Service binding. The Container performs bounded source download, checksum
calculation, `ffprobe`/FFmpeg execution, and shared-engine sampling. It must not
receive D1 or R2 bindings directly or mutate control-plane state independently.

The Container can call a virtual internal hostname handled by the runner
Container class's outbound handler. That handler forwards only the allowlisted
runner API paths to `env.CONTROL_PLANE.fetch()`. It injects the runner service
credential; the Container never receives that long-lived credential. The
one-time job lease token may be scoped into an individual execution because it is
required for heartbeat, upload, finalize, and failure calls. A Service binding
provides private routing but does not replace application authorization.

The control-plane Worker does not bind to or synchronously wait for the runner.
Job creation commits `queued` state and returns. A queue producer may be added as
an optimization for prompt wake-up, but claims remain the source of truth so a
lost notification cannot lose work. A periodic scheduled sweep is required as a
backstop. Runner deployment is not complete until crash recovery, cancellation,
download safety, heartbeat concurrency, idempotent uploads, and end-to-end tests
have been demonstrated.

### Template pipeline

A template is generated from:

```text
frame_set_id + policy_version_id + annotation_schema_version
```

Generation validates frame identity, source checksums, policy compatibility,
duplicate paths, timestamps, and evidence availability. The resulting template
and validation report are immutable artifacts. Template lifecycle states are
`generating`, `ready`, `invalid`, `superseded`, and `archived`.

The review API ultimately accepts a `template_id`, not an embedded arbitrary JSON
document and manually assembled frame URL map. During migration, the current raw
template endpoint remains as a compatibility path and must continue applying its
existing schema and exact-frame-set validation.

### Review and ground-truth pipeline

A review campaign references exactly one ready template and creates two isolated
review assignments followed by one adjudication assignment. The administrator or
review coordinator manages the campaign from `/internals/reviews`, while each
participant receives a narrow invitation experience:

- Reviewer A and Reviewer B open `/review/#token=...`.
- The adjudicator opens `/adjudicate/#token=...`.
- Each assignment credential authorizes only its assignment and permitted result.
- Adjudication remains locked until both independent reviews are complete.
- Invitation secrets remain short-lived, revocable, and stored only as hashes.

Focused invitation pages are a deliberate boundary, not temporary duplicate UI.
They minimize accidental disclosure, preserve reviewer independence, and avoid
requiring occasional reviewers to learn the complete Internals control plane.

Completing adjudication creates a candidate ground-truth version. Validation and
approval are separate state transitions; completion alone does not make an
artifact approved evaluation truth. Ground-truth records retain the template,
policy version, reviewer submissions, comparison, adjudication log, validation
report, checksums, and approval history.

### Evaluation pipeline

Current diagnostics become durable evaluation jobs rather than synchronous page
actions. An evaluation pins:

- ground-truth or frame-set version;
- model version or pipeline candidate;
- configuration and thresholds;
- implementation and runtime versions;
- dataset split, when applicable.

Evaluation job states are `draft`, `queued`, `running`, `succeeded`, `failed`, and
`cancelled`. Outputs include aggregate and per-category metrics, per-frame errors,
logs, warnings, checksums, and reproducibility metadata. Retries create auditable
attempts and never overwrite successful artifacts.

This phase is **model evaluation and pipeline development**, not model training.
If weight training is added later, it requires separate training-run resources for
datasets and splits, hyperparameters, checkpoints, compute allocation, and model
artifacts.

### Model and release governance

A model version records its task, artifact location, checksum, format, provenance,
license, preprocessing contract, compatibility, and evaluation history. Suggested
states are `registered`, `candidate`, `validated`, `approved`, `production`,
`retired`, and `rejected`.

A pipeline release pins every production-relevant component and configuration,
including sampling behavior, transcription/OCR/object models, preprocessing,
thresholds, and output schema. Suggested states are `draft`, `candidate`,
`approved`, `active`, `superseded`, and `rolled_back`.

Only an authorized release approver can activate or roll back a release. Promotion
records the evaluation evidence and audit event. Product resolves an active,
approved release; it never consumes a draft model or evaluation artifact directly.

## Durable job contract

Sampling, template generation, validation, evaluation, and future training are
asynchronous jobs. Every managed job requires:

- a durable ID and idempotency key;
- immutable input references and configuration;
- explicit state transitions with timestamps;
- queued execution separated from HTTP request lifetimes;
- progress and attempt records;
- authenticated runners and atomic claim semantics;
- exclusive, expiring leases renewed by heartbeat;
- bounded retries and clear terminal failure details;
- cancellation semantics;
- output artifact references and checksums;
- structured logs and audit events;
- retention and orphan-artifact cleanup rules.

For the sampling slice, runner authentication uses a service bearer credential in
addition to private Service-binding routing, while each successful claim returns a
separate one-time lease token. The lease token, not the general runner credential,
authorizes heartbeat, artifact upload, finalization, and failure operations for
that attempt. Attempt history is retained as audit evidence; requeueing or
administrator retry creates a new attempt rather than erasing a prior one.

The CLI remains useful for local diagnosis, offline recovery, and automation. CLI
commands should call shared domain libraries, emit the same manifest/report schema,
and support registering or importing their outputs. They are legacy interfaces,
not an independent source of business rules.

## Storage architecture

The intended Cloudflare services are **D1** and **R2**. “D2” and “R1” are not the
products used by this architecture.

### D1: separated transactional metadata stores

The deployed bindings are:

| Binding | Database | Database ID | Boundary |
| --- | --- | --- | --- |
| `CONTROL_DB` | `video-semantic-extractor` | `627b7ce9-4af7-4909-a1e6-8b310a28ac5a` | mutable jobs, review coordination, governance, artifacts, and audit metadata |
| `DATASET_DB` | `video-semantic-extractor-dataset` | `77adb815-acc2-47b2-a671-52df5f78e388` | datasets, immutable versions, and registered source metadata |

The split keeps source-catalog ownership independent from orchestration and
governance state. Each database provides transactions and foreign keys only within
its own schema. D1 does not provide cross-database foreign keys or a transaction
that atomically commits to both bindings. A control-plane record may store a
dataset-version ID, but handlers must resolve and validate that reference through
`DATASET_DB`. Multi-database workflows must use idempotent steps, explicit failure
states, and reconciliation rather than assuming a distributed transaction.

#### `CONTROL_DB`: transactional control plane

D1 stores queryable operational metadata and state transitions, including:

- users, sessions, organizations, memberships, and roles;
- policies and templates plus references to dataset versions;
- jobs, attempts, progress, and state-transition records;
- review campaigns, assignments, deadlines, and revocations;
- ground-truth, model, evaluation, and release metadata;
- artifact references, idempotency records, and audit events.

Schema constraints and transactions enforce uniqueness and legal transitions.
Concurrency-sensitive workflows may additionally use Durable Objects for serialized
coordination; R2 objects must not be used as the sole mutable multi-writer record.

#### `DATASET_DB`: dataset catalog

`DATASET_DB` stores dataset identities, version lifecycle, and registered HTTPS
source URLs. A newly created dataset becomes `ready` and its initial version becomes
`frozen` only after all requested sources have been inserted in the same
dataset-database transaction; a frozen version cannot have its source membership edited. Source registration
does not prove that a URL is downloadable or that its bytes are stable. A sampling
executor must fetch each URL under the platform's network-safety rules, calculate
checksums, and report failures without mutating the frozen version.

### R2: immutable and large artifacts

R2 stores:

- source videos and sampled frames;
- frame manifests and reports;
- generated templates;
- reviewer submissions and comparison artifacts;
- adjudicated ground-truth documents and validation reports;
- model files, evaluation output, logs, and release manifests;
- generated capsules where artifact retention is required.

D1 records point to versioned R2 object keys and checksums. Artifacts are written
to new keys and promoted by metadata/reference changes rather than overwritten.
Private evidence is served through authenticated application routes or short-lived
signed access, never by permanent public URLs embedded in review creation payloads.

## Identity, authorization, and auditing

The current shared administrator token is acceptable only as a bootstrap and
development mechanism. The target system uses authenticated users and role-based
access control. Initial roles are:

| Role | Primary authority |
| --- | --- |
| Internal administrator | Identity, role, and workspace administration |
| Researcher | Datasets, sampling, templates, models, and evaluations |
| Review coordinator | Campaign creation, assignment, monitoring, and revocation |
| Reviewer | One assigned independent submission |
| Adjudicator | One unlocked adjudication and its permitted result |
| Release approver | Ground-truth approval and pipeline activation/rollback |
| Product operator | Production job monitoring without research mutation |

Users may hold multiple roles, but authorization is checked per operation and
workspace. Browser mutations require normal session protections, and sensitive
actions require audit records. Assignment invitations remain separately scoped and
revocable; possessing an internal session does not automatically grant access to
participant submissions.

## Route map

The initial human-facing navigation is:

```text
/internals
  /datasets
  /sampling
  /frame-sets
  /policies
  /templates
  /reviews
  /ground-truth
  /evaluations
  /models
  /releases
```

Canonical control-plane resources live under `/api/internal/v1`, for example:

```text
/api/internal/v1/datasets
/api/internal/v1/sampling-jobs
/api/internal/v1/frame-sets
/api/internal/v1/policies
/api/internal/v1/templates
/api/internal/v1/review-campaigns
/api/internal/v1/ground-truth
/api/internal/v1/evaluation-runs
/api/internal/v1/models
/api/internal/v1/pipeline-releases
```

Existing `/api/v1/admin/reviews`, assignment APIs, `/review/`, and `/adjudicate/`
remain compatible during migration. New internal review APIs initially delegate to
the same domain behavior. Old administrative creation routes are deprecated only
after template references, the Internals UI, and migration tooling are usable.

## Delivery plan and current work

Progress values are planning estimates, not measured completion claims.

| Phase | Scope | Status | Estimate |
| --- | --- | --- | ---: |
| 0. Architecture | Product/Internals boundary, resources, storage, security, migration | In progress; runner topology selected | 90% |
| 1. Control-plane foundation | D1 schema, migrations, identities/RBAC, jobs, artifacts, audit log | In progress; sampling execution ships, but RBAC and remote runner verification remain | 80% |
| 2. Dataset-to-template slice | Dataset import, sampling job, frame-set inspection, template generation | In progress; the sampling runner and frame-set inspection ship, but template registry does not | 65% |
| 3. Review integration | Template references, campaign UI, focused invitations, progress, ground truth | Partially implemented | 55% |
| 4. Durable evaluations | Managed diagnostic runners, metrics, comparisons, reproducibility | Planned; CLI engines exist | 20% |
| 5. Governance | Model registry, ground-truth approval, pipeline releases, rollback | Planned | 5% |
| 6. Product integration | Product jobs consume only active approved releases | Planned | 5% |

### Immediate implementation order

1. Define and migrate the D1 control-plane schema, resource IDs, state machines,
   artifact references, and audit events.
2. Add internal identity and RBAC before exposing mutating `/internals` routes.
3. Build the dataset -> sampling job -> frame set -> template vertical slice while
   retaining and testing the legacy CLI path.
4. Adapt hosted review creation to validated `template_id` references and retain
   focused reviewer/adjudicator invitation pages.
5. Promote completed, validated adjudications into versioned ground-truth records.
6. Wrap existing diagnostics as durable evaluation jobs.
7. Add model registration, evaluation evidence, release approval, activation, and
   rollback.

## Known gaps and disposition

| Current problem | Decision |
| --- | --- |
| Sampling runner is not remotely verified | Deploy the shipped sampling-runner Worker and Container, verify real-media execution through its `CONTROL_PLANE` Service binding, and retain CLI execution/import. |
| Templates are loose generated files | Register immutable template artifacts in D1 with content in R2. |
| Review creation accepts raw templates and URL maps | Migrate to validated template references and managed evidence resolution; keep a compatibility route temporarily. |
| Diagnostics are not durable jobs | Wrap shared diagnostic engines in queued, retryable, auditable jobs. |
| Metadata spans two provisioned D1 databases | Keep dataset ownership and orchestration separate; validate references explicitly and use reconciliation because no cross-D1 foreign keys or transactions exist. |
| No internal-user authentication or RBAC | Add identity and operation-level RBAC as a foundation, not route-prefix security. |
| Ground truth, models, and releases are not governed | Add versioned resources, approval states, provenance, and audit history. |
| No complete `/internals` UI | Expand the status shell with vertical-slice screens after resource/state contracts are defined. |

## Non-goals for the first slice

- Replacing the focused reviewer or adjudicator invitation experiences.
- Removing offline or command-line diagnostics.
- Implementing model-weight training before evaluation governance exists.
- Moving production capsule extraction beneath `/internals`.
- Building every Internals screen before one end-to-end vertical slice works.
- Treating R2 as a transactional database or treating `/internals` as security by
  obscurity.
