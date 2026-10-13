<!-- @type documentation @purpose Record verification and the deployment sequence for managed review and ground-truth governance. -->
# Managed review and ground-truth release

Prepared on 2026-10-13. This release adds immutable policy/template registration, managed independent
review and adjudication campaigns, recorded diagnostic ground-truth validation and
decisions, and separate role-scoped job tokens for each reviewer/adjudicator
assignment. Existing legacy review routes remain available. Named-user identity
code is present, but production remains in administrator-token compatibility mode
until Cloudflare Email Sending is enabled for the selected sender domain. Managed
evaluation runners remain future work.

## Verification and current delivery state

- 111 Worker tests pass using actual SQLite migrations.
- TypeScript checking, JavaScript syntax checks, and Git whitespace checks pass.
- Wrangler 4.150.0 production dry-run bundles the Worker and seven asset files
  successfully (249.46 KiB Worker upload, 50.37 KiB compressed).
- Control migrations `0008_internal_identity.sql` and
  `0009_campaign_assignment_tokens.sql` are applied; both D1 databases report no
  pending migrations.
- Worker version `210a108f-3e29-4dc5-b1f5-5fb41f64942d` is deployed.
- `/health` returns `ok`; the Internals overview returns `401` without
  administrator credentials. Cloudflare Access protects the Internals browser URL.
- Email Sending onboarding for `katundu.org` is absent, so the deployment
  deliberately retains administrator-token authentication.

## Deployment sequence

Use an authenticated Cloudflare environment authorized to update this Worker's D1
databases, R2 bindings, Worker, and assets. From `workers/`:

```sh
npm run migrate:control:remote
npm run migrate:dataset:remote
npm run deploy:adjudication
```

Control migrations 0005–0009 have been applied in order. The dataset migration
command reports no pending changes. Future schema changes must remain compatible
with the deployed Worker until publication. Do not delete registered evidence or
revert database tables during rollback.

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
