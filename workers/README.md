<!-- @type documentation @purpose Document the Cloudflare gateway. -->
# Worker gateway

## Project and deployment layout

This directory is the unified Cloudflare project root. Wrangler TOML files stay at
the root because Cloudflare selects them as deployment entry points. Each Worker's
code and Worker-specific resources are nested under the Worker's name:

| Configuration | Deployment |
| --- | --- |
| `wrangler.toml` | Internals control plane and hosted review service |
| `wrangler.capsule-container.toml` | Optional Product capsule API Container |
| `wrangler.sampling-runner.toml` | Managed sampling-runner Container |

```text
workers/
├── control-plane/      review/Internals code, static assets, and D1 migrations
├── capsule-container/  Product capsule Container adapter
├── capsule-gateway/    optional external-backend gateway
└── sampling-runner/    sampling Container scheduler and private proxy
```

Configure `workers` as the root directory in Cloudflare Workers Builds. A build
whose root is this directory cannot read a configuration stored in
`deployments/cloudflare`, which is why Wrangler configuration is colocated here.
Dockerfiles and Compose definitions stay in `../deployments` because their build
context is the whole repository; build and push those images separately before
deploying either Container Worker.

The Worker validates `POST /capsule`, applies a 2 KiB request-body limit, and
forwards the request to `UPSTREAM_API_URL`. Set the optional secret
`CAPSULE_API_TOKEN` when the backend requires bearer authentication.

The gateway is deliberately not a video upload proxy; clients send a public video
URL and the backend performs the bounded download.

## Hosted review service

`control-plane/src/adjudication.ts` hosts the complete three-person workflow: two isolated,
prediction-blind reviewer assignments followed by an adjudicator assignment. The
shared UI is in `control-plane/adjudication-web/`, and R2 persists review state, token indexes,
and completed results. Reviewers need only a browser and their unique invitation
URL; they do not need the repository or a local Python server.

Set `ADMIN_TOKEN` to a long random secret. The administrator creates reviews and
lists their status, while generated reviewer and adjudicator tokens are scoped to
one assignment and expire after seven days by default (configurable from one to
720 hours with `expires_in_hours`). Raw invitation secrets are returned only by
the create response; the administrator list never returns them. Administrators can
revoke an assignment through
`POST /api/v1/admin/reviews/<id>/assignments/<role>/revoke`. Completed results are private by
default and are available only to the administrator or matching adjudicator.

### Production release order

The root URL is the operator entry point and redirects to `/internals/`. Reviewer
and adjudicator invitations remain focused on `/review/` and `/adjudicate/`; do
not send reviewers to the root URL.

Do **not** put provisioning or remote migration commands in the `[build]` section
of `wrangler.toml`. A Wrangler custom build is for compilation and can also run
during local development. Resource mutation belongs in an explicit, authenticated
production release step. The R2 and D1 declarations in `wrangler.toml` describe
bindings; they do not replace applying the checked-in D1 migrations.

The checked-in configuration binds two D1 databases with deliberately different
responsibilities:

| Binding | Database | Database ID | Responsibility |
| --- | --- | --- | --- |
| `CONTROL_DB` | `video-semantic-extractor` | `627b7ce9-4af7-4909-a1e6-8b310a28ac5a` | jobs, reviews, governance, and other mutable control-plane state |
| `DATASET_DB` | `video-semantic-extractor-dataset` | `77adb815-acc2-47b2-a671-52df5f78e388` | dataset, immutable version, and source-registration metadata |

For a new environment, provision the named R2 buckets once and set both secrets.
Treat bucket creation as bootstrap, not as a command to repeat on every build.
Apply each database's checked-in migrations to its matching binding and then
deploy the Worker. Do not recreate the databases or substitute one ID for the
other:

```bash
npx wrangler r2 bucket create video-annotation-reviews
npx wrangler r2 bucket create video-annotation-reviews-preview
npx wrangler r2 bucket create video-semantic-extractor-internal-artifacts
npx wrangler r2 bucket create video-semantic-extractor-internal-artifacts-preview
npx wrangler secret put ADMIN_TOKEN --config wrangler.toml
npx wrangler secret put RUNNER_TOKEN --config wrangler.toml
npm run deploy:production
```

`deploy:production` runs `wrangler d1 migrations apply` for `CONTROL_DB` and
`DATASET_DB` before `wrangler deploy`. In Cloudflare Workers Builds, set that npm
script as the **deploy command**, not the build command. Migrations and Worker
publication are separate remote operations and cannot be made atomic, so schema
changes must remain backward-compatible with the currently deployed Worker until
the new Worker is live. A migration failure stops the script before publication.

`INTERNAL_ARTIFACTS_BUCKET` is a private storage boundary for immutable Internals
artifacts. It is intentionally separate from `REVIEW_BUCKET`, which contains the
hosted review workflow's mutable records. Do not attach a public development URL
or custom domain to the Internals bucket. The canonical sampling output contract
is implemented by `control-plane/src/frame-set-manifest.ts`: `frame-set-manifest.v1` binds every
frame to one registered dataset source, timestamp, sampling reason, media type,
byte size, and SHA-256 digest. Structural validation alone does not prove that an
object exists; finalization must also compare these declarations with R2 object
metadata and bytes.

`GET /` redirects operators to `/internals/`. `GET /internals` serves the
interactive dataset, sampling, and Frame Sets workspace, while
`GET /api/internal/v1/overview` returns its administrator-authenticated capability
report. The current executable slice registers datasets in D1, stores sampling-job
requests as durable `queued` metadata, and provides a runner protocol for claiming
and reporting work. The separately deployed sampling-runner Worker and Container
consume that protocol; the control-plane Worker itself never executes FFmpeg.
Until that deployment is remotely verified, the diagnostic CLI remains the
operational fallback. Template registration, managed evaluation, and governance remain incremental work. See
`../docs/internals-architecture.md` and `../docs/internals-roadmap.md`.

The current administrator-protected control-plane slice exposes:

```text
GET  /api/internal/v1/datasets
POST /api/internal/v1/datasets
GET  /api/internal/v1/datasets/<dataset-id>
GET  /api/internal/v1/sampling-jobs
POST /api/internal/v1/sampling-jobs
GET  /api/internal/v1/sampling-jobs/<job-id>
POST /api/internal/v1/sampling-jobs/<job-id>/cancel
POST /api/internal/v1/sampling-jobs/<job-id>/retry
GET  /api/internal/v1/frame-sets
GET  /api/internal/v1/frame-sets/<frame-set-id>
GET  /api/internal/v1/frame-sets/<frame-set-id>/manifest
GET  /api/internal/v1/frame-sets/<frame-set-id>/frames/<frame-id>/evidence

POST /api/internal/v1/runner/sampling-jobs/claim
GET  /api/internal/v1/runner/dataset-versions/<dataset-version-id>/sources
POST /api/internal/v1/runner/sampling-jobs/<job-id>/heartbeat
POST /api/internal/v1/runner/sampling-jobs/<job-id>/artifacts
PUT  /api/internal/v1/runner/sampling-jobs/<job-id>/artifacts/<artifact-id>
POST /api/internal/v1/runner/sampling-jobs/<job-id>/finalize
POST /api/internal/v1/runner/sampling-jobs/<job-id>/fail
```

Creating a dataset also creates its initial immutable version. Creating a sampling
job references that dataset version plus a sampling strategy/configuration and
only persists a `queued` record. Listing a queued job confirms durable scheduling
metadata; it is not evidence that sampling has started or produced artifacts.

The runner endpoints use `Authorization: Bearer $RUNNER_TOKEN`, independently of
the administrator token. A runner claims work with a stable `runner_id` and an
optional bounded `lease_seconds`. An atomic claim returns either `data: null` when
no job is eligible, or one job plus a one-time lease token. Heartbeat, completion,
and failure calls must send that credential in `X-Job-Lease-Token`; stale,
expired, or superseded leases cannot mutate the job. Each claim creates an attempt
record, and the job stores its attempt count, current runner, and lease expiry.
Heartbeats extend ownership. Failure may end the job or atomically requeue it;
administrators may cancel eligible work or retry a failed/cancelled job.

The runner-only dataset-version route returns the ordered registered HTTPS sources
needed by a claimed execution. It never returns source data to administrator or
assignment credentials. The separate sampling-runner Worker reaches this route
through its `CONTROL_PLANE` Service binding and injects the runner credential in a
Container outbound handler.

Expired leases are reconciled during the next claim: abandoned cancellation
requests become `cancelled`, exhausted jobs become `failed`, and eligible jobs may
be reclaimed. Heartbeat and terminal mutations recheck the active lease and
expected state in the same D1 transaction used to update attempt history; a failed
attempt-record insert compensates by releasing the newly claimed job.

Sampling creation optionally accepts an `idempotency_key`. Repeating the same
request returns the original job, while reusing that key with a different dataset,
configuration, or retry limit returns `409 idempotency_conflict`.

Metadata-only completion is rejected. A runner must reserve server-named frame
artifacts, upload their raw bytes while its lease is active, and finalize the
server-assigned frame-set ID using `frame-set-manifest.v1`. Upload checks the
declared byte count, media type, and SHA-256 before writing to private R2.
Finalization verifies exact dataset-source coverage, every referenced upload, and
stored R2 metadata before registering the manifest, source membership, frames,
artifacts, successful attempt, and successful job in one D1 batch. Repeating a
successful finalization with the same lease is idempotent.

Administrator-authenticated Frame Sets routes list registered sets, expose their
source and frame membership, and stream manifests and frame evidence privately
from the Internals bucket. The upload endpoint buffers and hashes each frame and therefore limits individual
frame images to 10 MiB. It is not intended for source-video ingestion. An R2
manifest write necessarily occurs before the D1 transaction; failed transactions
delete that manifest best-effort, while a future reconciliation task must detect
any remaining orphan objects.

The runner request shapes are intentionally small:

```json
// POST /api/internal/v1/runner/sampling-jobs/claim
{"runner_id":"sampling-runner-1","lease_seconds":300}

// POST /api/internal/v1/runner/sampling-jobs/<job-id>/artifacts
{"sha256":"<64 lowercase hex characters>","size_bytes":12345,"media_type":"image/jpeg"}

// PUT the exact bytes to the upload_path returned above, then:
// POST /api/internal/v1/runner/sampling-jobs/<job-id>/finalize
{"manifest":{"schema_version":"frame-set-manifest.v1","frame_set_id":"<claim response frame_set_id>","sampling_job_id":"<job-id>","dataset_version_id":"<job input dataset_version_id>","created_at":"2026-10-03T12:00:00.000Z","engine":{"name":"sampler","version":"1.0.0","configuration_sha256":"<configuration sha256>"},"source_count":1,"frame_count":1,"sources":[{"dataset_source_id":"<registered source id>","source_sha256":"<source sha256>","size_bytes":1000000,"duration_seconds":10,"frames":[{"id":"frame_001","timestamp_seconds":5,"reasons":["interval"],"width":1280,"height":720,"artifact":{"artifact_id":"<reserved artifact id>","sha256":"<frame sha256>","size_bytes":12345,"media_type":"image/jpeg"}}]}]}}

// POST /api/internal/v1/runner/sampling-jobs/<job-id>/fail
{"error_message":"source download failed","requeue":true}
```

The heartbeat request accepts an empty JSON object (`{}`), or lease/progress
metadata. Send the claim response's lease token as
`X-Job-Lease-Token` on heartbeat, complete, and fail. Do not log or persist that
one-time token as ordinary job metadata.

Dataset creation accepts source media as HTTPS URL registrations. The service
creates the dataset and its initial version in `DATASET_DB`, records the sources,
marks the dataset `ready`, and freezes that version; subsequent source changes require a new
version rather than mutating the frozen input set. URL registration records
provenance—it does not upload, download, checksum, or validate the remote media.
Sampling records in `CONTROL_DB` refer to dataset-version IDs, but D1 cannot
enforce foreign keys or atomic transactions across the two databases. Handlers
must validate cross-database references explicitly and tolerate either database
being temporarily unavailable.

Create a review from one initialized annotation template and an exact map of
`<source>/<filename>` keys to HTTPS evidence URLs:

```bash
curl -X POST "https://<worker>/api/v1/admin/reviews" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data @- <<JSON
{"id":"corpus-v1","template":$(cat initialized-template.json),"frame_urls":{"sample_1/frame.jpg":"https://evidence.example/sample_1/frame.jpg"}}
JSON
```

The response contains three invitation URLs: `reviewer-a`, `reviewer-b`, and
`adjudicator`. Share each URL only with its assignee. Tokens are carried in the URL
fragment, stored in browser session storage, and sent to the API as bearer tokens;
fragments are not sent to the server in HTTP requests. Adjudication remains locked
until both reviewer passes are complete.

Discover the machine-readable API without exposing active assignments:

```bash
curl "https://<worker>/api/v1"
curl "https://<worker>/openapi.json"
```

An assignment token can discover only its own role and links:

```bash
curl "https://<worker>/api/v1/me" \
  -H "Authorization: Bearer $ASSIGNMENT_TOKEN"
```

After adjudication, fetch the private result with the administrator or matching
adjudicator token:

```bash
curl "https://<worker>/api/v1/reviews/corpus-v1/result" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

`GET /list` is a safe alias for the public API catalog, not a list of active work.
Only `GET /api/v1/admin/reviews` lists active reviews, and it requires the
administrator token. The service stores only hashes of assignment tokens.

R2 is object storage rather than a transactional database. Each reviewer has a
single-writer assignment, and only one adjudicator should edit a review at a time.
For multi-writer operation, move mutable state to Durable Objects or another store
with compare-and-swap semantics.
