<!-- @type documentation @purpose Record verification and the deployment sequence for managed review and ground-truth governance. -->
# Managed review and ground-truth release

Prepared on 2026-10-13. This slice adds immutable policy/template registration,
managed independent review and adjudication campaigns, and recorded diagnostic
ground-truth validation, decisions, and eligibility checks. Existing legacy review
routes remain available. Named-user authentication and managed evaluation runners
remain separate work.

## Verification and current delivery state

- 108 Worker tests pass using actual SQLite migrations.
- TypeScript checking, JavaScript syntax checks, and Git whitespace checks pass.
- Wrangler 4.150.0 production dry-run bundles the Worker and seven asset files
  successfully (219.33 KiB Worker upload, 44.58 KiB compressed).
- Browser smoke checks against mock local APIs cover the new forms and revision
  handling. Production migrations, deployment, and authenticated smoke checks have
  not been performed for this slice.
- Wrangler reports no authenticated Cloudflare account in the current environment.
  The application administrator token does not grant Cloudflare deployment access.

## Deployment sequence

Use an authenticated Cloudflare environment authorized to update this Worker's D1
databases, R2 bindings, Worker, and assets. From `workers/`:

```sh
npm run migrate:control:remote
npm run migrate:dataset:remote
npm run deploy:adjudication
```

Control migrations 0005, 0006, and 0007 must run in order before the new Worker:
template registry, managed campaigns, then ground-truth governance. The dataset
migration command also verifies the existing dataset schema is current. Record the
deployed Worker version and migration output. These are additive schema changes;
do not delete registered evidence or revert database tables during rollback.

## Post-deployment checks

With the existing administrator authentication, load Internals and verify the
Policies, Templates, Campaigns, and Ground truth lists. Confirm the legacy review
interface still loads and unauthenticated requests cannot read private artifacts.
Exercise a dedicated review fixture through template registration, reviewer
submissions, comparison, adjudication, and recorded validation; check stale
`If-Match` writes fail and revoked invitations cannot submit. Validate a deliberately
inadequate candidate produces an immutable failing report and is ineligible.

Actual corpus approval requires the operator's explicit evidence review and all
four attestations. Smoke testing does not establish independent human review,
licensing permission, or approval. No real corpus has been approved by this release.

See [template registry](template-registry.md),
[managed campaigns](managed-review-campaigns.md), and
[ground-truth governance](ground-truth-governance.md) for route contracts, limits,
integrity checks, and remaining operational qualifications.
