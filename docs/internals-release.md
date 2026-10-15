<!-- @type documentation @purpose Record build acceptance and the merge-time release sequence for Internals. -->
# Internals release acceptance

As of 2026-10-15, this branch completes the supported v1 implementation for roadmap
phases 0–5, excluding email onboarding. The user requested build/testing only;
deployment occurs on branch merge. This document does not claim the branch is live.

## Changes to deploy

- Durable evaluations, verified reports/comparisons, bounded runner inputs and
  intermediate sampling output, cancellation, queue fairness, and CLI reproduction.
- Immutable licensed model registration; evidence-backed model/release decisions;
  component/threshold pinning; revision-safe activation, supersession, and rollback.
- Policy lifecycle/configurable restrictions, append-only audit, operational health,
  and previewed, reference-safe orphan cleanup.
- Evaluations, Models, Releases, and Operations screens, plus public static routing
  for the new governance module. All private APIs remain authenticated.

## Build evidence

Final local verification: **135 Worker tests and 98 backend tests pass**. TypeScript,
JavaScript syntax, Python static checks, engine fingerprint verification, and Git
whitespace checks pass. The Worker dry-run bundle is 352.14 KiB (71.17 KiB gzip),
and the runner image builds successfully.

The local verification includes Worker tests against real SQLite migrations,
TypeScript and browser JavaScript checks, backend tests with actual FFmpeg timing
fixtures, a Wrangler dry-run bundle, successful local D1 migration application,
a browser smoke test with real ONNX upload, and CLI inference reproduction.
The checked-in [runner qualification report](verification/2026-10-15-runner-qualification.json)
records the constrained synthetic Container workload. Test fixtures exercise
review/ground-truth/evaluation/model/release/rollback, stale revisions, permissions,
lease takeover/cancellation, checksums, and cleanup reference races.

The GitHub workflow runs backend/Worker tests, TypeScript/JavaScript checks,
Wrangler bundling, and the runner image build on pull requests and main updates.
It does not deploy or approve real artifacts.

## Deployment after merge

From workers/ in the authenticated deployment environment:

```sh
npm run migrate:remote
npm run deploy:adjudication
npm run deploy:sampling-runner
```

Apply all outstanding CONTROL_DB migrations, particularly 0012–0014, and pending
DATASET_DB migrations before the new Worker. 0013 adds immutable model/release inputs,
revision assertions, append-only audit, and a unique active release. 0014 adds
cleanup tombstones and policy revisions. Migrations are additive/compatible with
the previously deployed resource code. Publication and D1 migrations cannot be one
transaction; a migration failure must stop publication. Do not roll back by dropping
tables or deleting registered evidence.

Rebuild the sampling-runner image: an older Container does not implement all new
evaluation, queue fairness, bounds, and cancellation behavior. Preserve RUNNER_TOKEN,
private service/bucket bindings, and INTERNAL_AUTH_MODE=legacy. Email sender
onboarding and switching authentication modes remain excluded.

## Hosted acceptance

Use dedicated licensed fixtures and retain deployment versions, resource IDs,
input/report checksums, attempt histories, and measurements:

1. Verify unauthenticated/incorrect-role requests cannot access private APIs,
   artifacts, reports, decisions, or cleanup. Check browser pages load and static
   modules are accessible while their resource APIs remain protected.
2. Exercise dataset → sampling → registered template → independent human review →
   adjudication → diagnostic validation. Human approval must be a real evidence
   review with licensing and independence attestations, not an automated smoke step.
3. Kill a runner after claim, wait for lease expiry, verify takeover and rejection
   of the stale runner. Exercise retry exhaustion and cancellation during download,
   FFmpeg, artifact upload, evaluation, and finalization. Check no winning artifact
   is removed by a losing completion.
4. Measure actual Cloudflare Container memory/storage/cold starts and representative
   input extremes. Local resource measurements do not establish production sizing.
5. Register and evaluate a compatible licensed model, make an explicit evidence-backed
   decision, evaluate the exact release configuration, approve/activate, supersede,
   and roll back to an explicitly selected still-eligible target.
6. Preview cleanup before selecting any old orphan objects. Verify references,
   active upload ownership, etags, tombstones, and audit entries remain correct.

Identity-bound production acceptance stays gated on the separately excluded email
onboarding. No real corpus, model, or production release is approved by these builds.
