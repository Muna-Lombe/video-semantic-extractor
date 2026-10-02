<!-- @type documentation @purpose Document the Cloudflare gateway. -->
# Worker gateway

The Worker validates `POST /capsule`, applies a 2 KiB request-body limit, and
forwards the request to `UPSTREAM_API_URL`. Set the optional secret
`CAPSULE_API_TOKEN` when the backend requires bearer authentication.

The gateway is deliberately not a video upload proxy; clients send a public video
URL and the backend performs the bounded download.

## Hosted review service

`src/adjudication.ts` hosts the complete three-person workflow: two isolated,
prediction-blind reviewer assignments followed by an adjudicator assignment. The
shared UI is in `adjudication-web/`, and R2 persists review state, token indexes,
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

Create the buckets and administrator secret before deploying. The checked-in
configuration binds two provisioned D1 databases with deliberately different
responsibilities:

| Binding | Database | Database ID | Responsibility |
| --- | --- | --- | --- |
| `CONTROL_DB` | `video-semantic-extractor` | `627b7ce9-4af7-4909-a1e6-8b310a28ac5a` | jobs, reviews, governance, and other mutable control-plane state |
| `DATASET_DB` | `video-semantic-extractor-dataset` | `77adb815-acc2-47b2-a671-52df5f78e388` | dataset, immutable version, and source-registration metadata |

Apply each database's checked-in migrations to its matching binding/database.
Do not recreate the databases or substitute one ID for the other:

```bash
npx wrangler r2 bucket create video-annotation-reviews
npx wrangler r2 bucket create video-annotation-reviews-preview
npx wrangler d1 migrations apply video-semantic-extractor --remote --config wrangler.toml
npx wrangler d1 migrations apply video-semantic-extractor-dataset --remote --config wrangler.toml
npx wrangler secret put ADMIN_TOKEN --config wrangler.toml
npm run deploy:adjudication
```

`GET /internals` serves the interactive dataset and sampling workspace, while
`GET /api/internal/v1/overview` returns its administrator-authenticated capability
report. The current executable slice registers datasets in D1 and stores sampling-job
requests as durable `queued` metadata. Queuing does not execute sampling: there is
currently no job consumer or sampling runner, so the existing diagnostic CLI
remains the operational legacy/fallback path. Frame-set artifacts, template
registration, managed evaluation, and governance remain incremental work. See
`../docs/internals-architecture.md` and `../docs/internals-roadmap.md`.

The current administrator-protected control-plane slice exposes:

```text
GET  /api/internal/v1/datasets
POST /api/internal/v1/datasets
GET  /api/internal/v1/datasets/<dataset-id>
GET  /api/internal/v1/sampling-jobs
POST /api/internal/v1/sampling-jobs
GET  /api/internal/v1/sampling-jobs/<job-id>
```

Creating a dataset also creates its initial immutable version. Creating a sampling
job references that dataset version plus a sampling strategy/configuration and
only persists a `queued` record. Listing a queued job confirms durable scheduling
metadata; it is not evidence that sampling has started or produced artifacts.

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
