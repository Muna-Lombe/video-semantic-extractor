<!-- @type documentation @purpose Define managed campaign, invitation, review, and candidate-result contracts. -->
# Managed review campaigns

The repository implements dataset → sampling → frame set → template → independent
review → adjudicated candidate. Apply all pending control migrations before
deploying the control-plane Worker and its updated assets.

## Campaign creation and coordination

Use the Internals Review campaigns screen or `POST /api/internal/v1/review-campaigns`:

```json
{
  "name": "Independent diagnostic review",
  "template_id": "tpl_0123456789abcdef0123456789abcdef",
  "expires_in_hours": 168,
  "issue_tokens": false,
  "idempotency_key": "review-request-1"
}
```

Creation requires a ready, checksum-verified registered template and an active
compatible pinned policy. Embedded JSON and frame URL maps are rejected. One D1
transaction creates the campaign, three assignments, and an audit event. The
campaign pins the template digest. Internals creates assignments without issuing
their tokens, then an administrator issues each role-scoped job token separately
from the assignment details. `issue_tokens: false` opts into this behavior. The API
keeps its compatibility default (`true`) for existing callers and returns the three
one-time invitation links on initial creation when that option is omitted.

The optional idempotency key deduplicates retries without replaying secrets; different
inputs with the same key return `409`. Issuing or regenerating a job token preserves
assignment work and invalidates the previous token. Each raw token is returned only
once, alongside its focused assignment link; only its hash is stored. Lifetimes range
from 1 to 720 hours.

Administrator routes under `/api/internal/v1/review-campaigns`:

| Method and suffix | Behavior |
| --- | --- |
| GET collection | Paginated safe progress; no secrets, hashes, or submissions |
| GET `/<id>` | Pinned inputs, progress, audit history, result URL |
| POST `/<id>/cancel` | Cancel a nonterminal campaign and revoke all assignments |
| POST `/<id>/assignments/<role>/assign` | Bind an unstarted assignment to an active, email-verified user with the matching reviewer/adjudicator role |
| POST `/<id>/assignments/<role>/issue` | Generate a new role-scoped job token for an unfinished assignment |
| POST `/<id>/assignments/<role>/revoke` | Invalidate the assignment token |
| POST `/<id>/assignments/<role>/reissue` | Backward-compatible alias for issuing/rotating a token |

Lists use `limit` (1–100) and non-negative `offset`; creation bodies are limited to
64 KiB. Cancellation retains saved work. Completed campaigns cannot be changed.
Audits omit secrets and annotations. A coordinator can bind a pending assignment
before issuing its token. A bound assignment requires both that verified user's
email-link session and the separate job token, and the account must retain its
reviewer or adjudicator role. Assignment identity and token rotation are audited.
Unbound pre-existing assignments retain job-token-only compatibility.

The production primary remains `INTERNAL_AUTH_MODE = "legacy"`: the administrator
token keeps owner-level access and can manage named accounts and roles. Verified
named-user sessions are an additional, role-limited path; they do not replace or
disable the administrator token. Ground-truth decisions made by a named
release-approver session derive the actor from that session and persist its user ID.
The legacy administrator path remains an explicit owner override and still accepts
an operator-supplied actor reference for compatibility. Cloudflare Email Sending
is not yet configured for the sender domain, so named-user verification, assignment
binding, and named approval are implemented but unavailable in production until
email delivery is onboarded. Do not switch `INTERNAL_AUTH_MODE` to `sessions` before
verification and recovery are operational.

## Assignment workflow

The focused `/review/` and `/adjudicate/` screens support both managed and legacy
invitations. `GET /api/v1/me` resolves an invitation's assignment and links.
In Internals, a coordinator opens a campaign and uses the Assignments section to
bind an active, verified named user and issue each reviewer's or adjudicator's job
token. The focused link carries that token in its URL fragment; the API also
returns the token separately for a system that calls the assignment endpoints
directly. For a bound assignment the reviewer signs in to the same browser with the
assigned verified account, and both that session and the job token are required.
Unbound assignments remain available for compatibility. Send either token value
only to the intended assignee. Token revocation and regeneration invalidate
previously issued values.

- `/api/v1/assignments/<id>` exposes only that reviewer's submission. PUT saves;
  POST `/complete` requires exhaustive unique frame coverage.
- GET `/api/v1/assignments/<id>/policy` returns the pinned instructions as plain text.
  Existing campaigns retain their instructions even if the policy is later retired.
- GET `/api/v1/assignments/<id>/frames/<source>/<filename>` serves registered private
  R2 evidence after membership and byte-checksum verification. Caller URLs are never
  accepted. Adjudicator evidence is gated on both completed reviewer passes.
- The hosted reviewer UI draws and tags object regions in source-pixel coordinates,
  and supports optional in-browser object suggestions. Suggestions are never saved
  automatically: the reviewer must confirm or reject each one before marking a
  frame reviewed. Model code and weights are downloaded by the browser from jsDelivr
  and the Hugging Face model repository; inference runs locally on the reviewer device.
- `/api/v1/adjudications/<id>` exposes both frozen submissions only after both
  complete. PUT `/frames/<source>/<filename>` saves a decision; POST `/complete`
  requires resolution of every disagreement. Adjudicators can inspect and correct
  any registered frame, including agreed empty frames with shared omissions. The
  UI lists all frames and filters agreement, disagreement and saved decisions.
  Agreement needs no artificial entry; correcting it still records an audited
  decision without changing either frozen reviewer submission.

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
