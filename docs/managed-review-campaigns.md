<!-- @type documentation @purpose Define managed campaign, invitation, review, and candidate-result contracts. -->
# Managed review campaigns

The repository now implements dataset → sampling → frame set → template → independent
review → adjudicated candidate. The policy/template/campaign additions are locally
tested, not deployed or remotely verified. Apply control migrations
`0005_template_registry.sql` and `0006_managed_campaigns.sql` before deploying the
control-plane Worker and its updated assets.

## Campaign creation and coordination

Use the Internals Review campaigns screen or `POST /api/internal/v1/review-campaigns`:

```json
{
  "name": "Independent diagnostic review",
  "template_id": "tpl_0123456789abcdef0123456789abcdef",
  "expires_in_hours": 168,
  "idempotency_key": "review-request-1"
}
```

Creation requires a ready, checksum-verified registered template and an active
compatible pinned policy. Embedded JSON and frame URL maps are rejected. One D1
transaction creates the campaign, three assignments, and an audit event. The
campaign pins the template digest. Two reviewer invitations and one adjudicator
invitation are returned once; only hashes are stored. Nothing is sent automatically.

The optional idempotency key deduplicates retries without replaying secrets; different
inputs with the same key return `409`. Reissuing a lost invitation preserves work
and invalidates the previous token. Lifetimes range from 1 to 720 hours.

Administrator routes under `/api/internal/v1/review-campaigns`:

| Method and suffix | Behavior |
| --- | --- |
| GET collection | Paginated safe progress; no secrets, hashes, or submissions |
| GET `/<id>` | Pinned inputs, progress, audit history, result URL |
| POST `/<id>/cancel` | Cancel a nonterminal campaign and revoke all assignments |
| POST `/<id>/assignments/<role>/revoke` | Invalidate an invitation |
| POST `/<id>/assignments/<role>/reissue` | Return a new secret for an unfinished assignment |

Lists use `limit` (1–100) and non-negative `offset`; creation bodies are limited to
64 KiB. Cancellation retains saved work. Completed campaigns cannot be changed.
Audits omit secrets and annotations. Bootstrap tokens cannot establish named actors
or prove that three distinct humans performed the three roles; identity/RBAC remains
planned.

## Assignment workflow

The focused `/review/` and `/adjudicate/` screens support both managed and legacy
invitations. `GET /api/v1/me` resolves an invitation's assignment and links.

- `/api/v1/assignments/<id>` exposes only that reviewer's submission. PUT saves;
  POST `/complete` requires exhaustive unique frame coverage.
- GET `/api/v1/assignments/<id>/policy` returns the pinned instructions as plain text.
  Existing campaigns retain their instructions even if the policy is later retired.
- GET `/api/v1/assignments/<id>/frames/<source>/<filename>` serves registered private
  R2 evidence after membership and byte-checksum verification. Caller URLs are never
  accepted. Adjudicator evidence is gated on both completed reviewer passes.
- `/api/v1/adjudications/<id>` exposes both frozen submissions only after both
  complete. PUT `/frames/<source>/<filename>` saves a decision; POST `/complete`
  requires resolution of every disagreement. Agreement needs no artificial entry.

Managed edits and completion require `If-Match` with the state endpoint's `revision`,
for example `If-Match: 0`. Missing revisions return `428`; stale edits or revoked
access during a write return `412`. The focused UI sends these headers. Separate
reviewer rows prevent cross-review overwrites. Submission changes, campaign state,
and audit events commit together; SQL rechecks current token, expiry, revocation,
revision, completion, and cancellation at write time.

Validation preserves policy/schema, provenance, checksums, source/frame coverage,
timestamps, dimensions, and artifact identity. Objects need unique IDs, COCO labels,
valid subsets, and positive in-bounds pixel boxes. The server normalizes pass claims
and requires predictions declared unseen; this cannot attest human conduct or
replace the policy's adequacy gates. Initial limits are 512 KiB per submission or
merged result, 200 object/audit entries per frame, and 1 MiB per comparison. Templates
inherit the 500-frame registry limit. Larger comparisons need smaller frame sets;
a durable large-corpus runner remains planned.

## Candidate results and compatibility

Finalization writes private immutable R2 JSON, then atomically registers its digest,
a `ground_truth_versions` record with `candidate` status, completed assignment and
campaign states, and an audit event. Version checks permit one winning finalization;
failed/stale attempts clean up their own result object. General orphan cleanup remains
open. GET `/api/v1/campaigns/<id>/result` verifies bytes and permits only the
administrator or the same campaign's valid adjudicator token. State, instructions,
evidence, and results all use `Cache-Control: no-store`.

The candidate retains template provenance, two passes, and the adjudication log.
[`Ground-truth governance`](ground-truth-governance.md) now implements recorded
validation, corpus adequacy, diagnostic approval/rejection, supersession, and
eligibility in the locally tested repository. Deployment remains pending. A
completed campaign alone does not establish approved ground truth.

The legacy raw-template API, mutable R2 reviews, and `/api/v1/reviews/<id>/result`
remain available and are not migrated. New campaigns use D1 and the managed result
route. SQLite tests execute the real migrations and cover isolation, concurrent
saves/finalization, stale revisions, expiry, reissue, revocation during writes,
cancellation, private evidence/results, and atomic rollback. Node 22.13+ is required.
