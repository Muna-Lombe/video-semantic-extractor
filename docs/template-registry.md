<!-- @type documentation @purpose Describe the implemented policy and frame-set-to-template registry contract. -->
# Registered policies and templates

The repository now implements policy registration and template generation with
Internals screens. The original registry is recorded as deployed. This branch adds
revision-safe deprecation/retirement, configurable annotation restrictions, immutable
definition guards, and per-attempt template storage. Apply pending migrations
through 0014 when deploying after merge.

## Policy registration

`POST /api/internal/v1/policies` accepts:

```json
{
  "name": "Diagnostic object annotation",
  "version": "2026-09-18",
  "annotation_schema_version": "object-annotations.v1",
  "document": "The complete frozen reviewer instructions go here."
}
```

Use the complete [existing policy](investigations/object-annotation-policy.md) to
register that diagnostic version, including its corpus and license restrictions.
Administrator registration activates an immutable version; there is no separate
approval workflow yet. Identical registration is idempotent; different instructions
for the same name/version return `409` and require a new version. Definitions live
in D1, with a SHA-256 over canonical JSON containing the schema and trimmed
instructions. Registration and activation are audited atomically. The bootstrap
administrator token cannot establish a named human actor.

`GET /policies` lists versions and `GET /policies/<version-id>` includes instructions
(all paths use the `/api/internal/v1` prefix). Bodies are limited to 64 KiB, names
to 120 characters, versions to 80 safe characters, and instructions to 48,000
characters. Lifecycle transitions and configurable restrictions within the supported
object-annotations.v1 contract are implemented; see below.

The optional fixed [`diagnostic validation profile`](ground-truth-governance.md)
adds frozen corpus digests to a new policy version and its definition checksum.
The profile ID is `coco-object-diagnostic.v1`; `source_sha256` must list exactly
five distinct lowercase source-video digests. Arbitrary threshold overrides are
rejected. Unprofiled versions remain usable for review but cannot establish
diagnostic evaluation approval.

## Template generation

`POST /api/internal/v1/templates` accepts:

```json
{
  "frame_set_id": "fs_example",
  "policy_version_id": "pv_example",
  "annotation_schema_version": "object-annotations.v1"
}
```

Generation requires ready frame sets and active compatible policies. It verifies
the policy definition checksum and manifest bytes against registered digests;
validates `frame-set-manifest.v1`; compares source checksums, sizes, durations,
frame membership, ordinals, timestamps, dimensions, sampling reasons, and artifact
declarations with D1; and checks private R2 evidence size, media type, and checksum
metadata. Sampling upload already verified image bytes; generation checks their
metadata rather than downloading each image again.

This bounded synchronous operation supports up to 500 frames and 5 MiB manifests.
Larger inputs need a future durable runner or smaller frame sets. No predictions
are consulted. Identical inputs, including concurrent requests, return the same
template. Artifact metadata, template registration, and audit events commit in one
D1 transaction; immutable content lives in private R2. Failed metadata transactions
may leave orphan objects; retention and cleanup remain outstanding.

`GET /templates` lists metadata; `GET /templates/<id>` inspects registration;
`GET /templates/<id>/artifact` downloads JSON after byte-length and checksum checks.
All registry routes require the administrator token and return `no-store`. Lists
use `limit` (1–100) and non-negative `offset`.

## Initial annotation contract

`object-annotations.v1` is a fixed versioned contract, not an arbitrary schema
registry. It preserves the legacy source/frame annotation shape. Sources use stable
dataset-source IDs and SHA-256 digests; safe filenames derive from globally unique
frame IDs and media types. Frames retain timestamps, dimensions, and artifact
references. Object and out-of-taxonomy lists start empty. Review metadata starts
with zero independent passes, predictions unseen, adjudication not started, and
empty reviewed-frame, assisted-review, and adjudication records.

Provenance pins the frame set, dataset version, manifest digest, policy-version ID
and digest, and generator `object-template.v1`. The successful mechanical validation
report is embedded in the same immutable template artifact. It does not assert
completed review, adequate corpus coverage, or approved ground truth. The annotation
format supports COCO classes, live/composited/screen subsets, and source-pixel boxes
under the registered instructions.

The existing CLI initializer and stricter ground-truth validator remain supported
for the original five-video corpus. Managed manifests now have hosted/CLI parity:
`scripts/diagnostics/initialize-managed-annotations.py` validates a downloaded
`frame-set-manifest.v1`, verifies local frame evidence by size and SHA-256, and
emits the same prediction-blind `object-annotations.v1` template as the hosted
generator. Empty template lists do not certify negative ground truth.

[`Managed review campaigns`](managed-review-campaigns.md) now implement review
creation by `template_id`, scoped private evidence, and pinned policy instructions.
This slice is locally tested; migration/deployment are pending. The legacy API
still accepts embedded JSON and frame URLs. Registering a template alone does not
create a campaign or grant access to frames.

## Configurable rules and policy lifecycle

Registration optionally accepts annotation_rules with allowed_labels (a unique
non-empty subset of COCO labels), allowed_subsets (a unique non-empty subset of
live/composited/screen), and max_objects_per_frame (1–200). Restrictions are frozen
in the policy checksum and template validation metadata. Hosted review, adjudication,
and ground-truth validation enforce them. Focused reviewer choices follow the
registered taxonomy. The annotation geometry remains object-annotations.v1; new
task shapes require a new supported engine contract.

POST /policies/{id}/deprecate or /retire requires If-Match with the policy revision
and a reason. Deprecated/retired policies cannot create new templates or campaigns;
existing campaigns retain their pinned instructions. Policy definitions cannot be
updated in place. CLI initialization accepts --annotation-rules with the exported
rules JSON to retain hosted/local parity. Include --validation-profile with the
exported profile JSON when verifying a profiled policy document checksum.
