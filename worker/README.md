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

Create the buckets and secret, then deploy:

```bash
npx wrangler r2 bucket create video-annotation-reviews
npx wrangler r2 bucket create video-annotation-reviews-preview
npx wrangler secret put ADMIN_TOKEN --config wrangler.toml
npm run deploy:adjudication
```

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
