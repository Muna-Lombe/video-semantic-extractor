<!-- @type documentation @purpose Document the Cloudflare gateway. -->
# Worker gateway

The Worker validates `POST /capsule`, applies a 2 KiB request-body limit, and
forwards the request to `UPSTREAM_API_URL`. Set the optional secret
`CAPSULE_API_TOKEN` when the backend requires bearer authentication.

The gateway is deliberately not a video upload proxy; clients send a public video
URL and the backend performs the bounded download.

## Adjudication Worker

`src/adjudication.ts` is a separate Worker entry point for the third-reviewer
workflow. The actual UI is in `adjudication-web/index.html`, with its behavior in
`adjudication-web/app.js` and styling in `adjudication-web/style.css`; Cloudflare's
static-assets binding serves that directory at the Worker root. The Worker ports the reviewer comparison and completion
gates to the Worker runtime, and persists working sessions and immutable completed
results in an R2 bucket. Mutable API routes require `ADJUDICATION_TOKEN`; completed
results are intentionally readable with `GET /results/<review-id>.json`.

Create the buckets and secret, then deploy:

```bash
npx wrangler r2 bucket create video-annotation-reviews
npx wrangler r2 bucket create video-annotation-reviews-preview
npx wrangler secret put ADJUDICATION_TOKEN --config wrangler.adjudication.toml
npm run deploy:adjudication
```

Initialize a review with two completed reviewer payloads and an optional map of
evidence-frame URLs. Frame URLs must be HTTPS and the map keys use
`<source>/<filename>`:

```bash
curl -X POST "https://<worker>/api/reviews" \
  -H "Authorization: Bearer $ADJUDICATION_TOKEN" \
  -H "Content-Type: application/json" \
  --data @- <<JSON
{"id":"corpus-v1","reviewer_a":$(cat reviewer-a.json),"reviewer_b":$(cat reviewer-b.json),"frame_urls":{}}
JSON
```

Open **`https://<worker>/?review=corpus-v1`** to use the UI, enter the token, and adjudicate each
disagreement. On completion, the Worker copies the merged annotation to the R2
`results/` prefix. Fetch it without authentication:

```bash
curl "https://<worker>/results/corpus-v1.json"
```

R2 is object storage rather than a filesystem; the `results/` object-key prefix is
the deployable equivalent of the previous local output directory. Do not put
sensitive reviewer information in a completed result when public GET access is
enabled. A single adjudicator should edit a review at a time because R2 does not
provide transactional multi-writer session updates.
