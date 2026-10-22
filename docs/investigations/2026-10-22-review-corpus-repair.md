<!-- @type documentation @purpose Explain hosted validation failures, preserve assisted work and record the concrete corpus repair. -->
# Review corpus audit and repair — 2026-10-22

Hosted reads succeeded with the configured administrator credential. Four completed
campaigns have invalid candidates and no managed model evaluation is registered.
The refreshed read also shows sample-review-8 completed adjudication at
2026-10-22 11:44 Moscow time and created a fifth candidate, not yet validated.
The coordinator confirmed that completed review/adjudication assignments were
AI/automated sessions. Completion flags therefore do not establish independent
human review. The approval API requires an explicit independent-human attestation;
that cannot honestly be supplied for these passes. Their annotation work remains
useful as assisted/reference material.

The audit verified four candidate SHA-256 digests and their stored validation
report digests, then downloaded and checked the SHA-256 and size of 433 frame
files across campaigns 2, 6, 7 and 8 (377 distinct image digests; several campaigns
reuse evidence). All contact-sheet thumbnails were inspected, with selected
native-frame checks. This is a coordinator audit, not a complete pixel-level box
audit, another independent pass, a licensing review or approval.

## Concrete causes

| Campaign | Recorded blockers | Additional audit findings |
| --- | --- | --- |
| sample-review-2 diagnostic | Screen objects 0/20; other numeric gates passed | Cartoon owl and illustrated sandwich/cup tiles were counted as composited COCO objects. Profile photographs inside a webpage were marked composited and need individual screen/identity checks. A phone UI mockup also needs eligibility review. Numeric validity does not establish image semantics. |
| sample-review-6 | Two non-person classes instead of five; screen 0/20; composited 0/10; large objects 2/15; one source supplies 98% of counted objects | Visible drinkware was left unboxed while correction notes were appended. A large person box covers isolated hands. All 23 presenter-source frames have empty object lists. This is incomplete annotation content as well as unsuitable coverage. |
| sample-review-7 | Four of five policy source digests differ; screen 0/20; composited 0/10 | Its desk displays mostly show abstract wallpaper, not photographic screen objects. Reflections and graphics cannot be relabeled to meet quotas. The pinned document also names the older frame set. |
| sample-review-8 | Refreshed state: adjudication complete, candidate unvalidated; missing diagnostic profile. Local content analysis records screen 13/20. | The 13 recorded screen labels are ten physical monitors, two game cars and a sticker graphic. Monitors belong to live; game/sticker eligibility is not photographic. Actual photographs of desks/cups inside the display are not individually boxed. The policy advertises extended labels but registered rules default to COCO-80. Perfume rendering remains unresolved. |
| Review1 | Missing diagnostic profile and insufficient corpus coverage | Keep as historical assisted annotation material; its one-source corpus cannot satisfy this diagnostic profile. |

The [checksum-bound audit](../verification/2026-10-22-review-corpus-audit.json)
retains exact counts and source identities. The
[correction queue](../verification/2026-10-22-review-correction-queue.json)
identifies eleven specific findings with frame IDs, timestamps, evidence digests and
authenticated evidence paths. These are proposed review tasks, not applied labels.

## Repair completed in the hosted registry

A new immutable policy and blank template reuse the current 62-frame evidence:

- Frame set: `frameset_5e6b3d08c73f4488a16e84f5396f28d5`.
- Policy: `pv_45a90738af2a83283ec63d771d8e0d8e`, version
  `2026-10-22-repair-v1`, named “Mixed-video diagnostic repair 2026-10-22”.
- Template: `tpl_a1c5fff668687c6533df550a2b7503af`.
- Profile: `video-object-diagnostic.v2`, bound to the exact five source digests.
- Rules explicitly enable `coco-extended.v1` and all three subsets.
- Hosted readiness: `diagnostic_ready: true`, no configuration blockers.

The [policy registration body](../verification/2026-10-22-repair-policy.request.json)
preserves photographic inclusion rules and numeric gates, and explicitly records
the automated origin of earlier work. The replacement starts with empty object
lists, zero reviewed frames and zero independent passes. It does not inherit old
completion credit. No old policy, template, campaign or candidate was rewritten;
the original four candidate records remain byte-for-byte unchanged in the metadata
comparison. The campaign-8 completion was observed on refresh, not performed by
this repair. No invitations, new review passes, adjudication completion, validation approval,
model evaluation, release decision or deployment was performed.

Configuration readiness is not corpus adequacy. Source 19's perfume imagery needs
a photographic/rendered eligibility decision. Source 21's game screens are not
automatically photographic cars. Fresh review should inspect the desk photograph
and cup photographs inside source 24's display, and depicted phones in source 26.
Measure the actual screen count and all other gates after annotations are saved.
Do not promise that the 62 frames will meet every gate.

## Prevent another late discovery

The follow-up implementation adds
`GET /api/internal/v1/review-campaigns/{id}/preflight` for coordinators and a saved
coverage section in the campaign inspector. The endpoint verifies the pinned
template and policy, reads an existing adjudication draft without initializing or
writing one, and reports policy blockers, the effective taxonomy, counts and unmet
requirements. No draft produces unmeasured coverage, not zero-score ground truth.

Draft analysis preserves actual completion metadata; it never stamps a pass or
adjudication complete. Invalid annotation structure still fails. Normal ground-truth
validation continues to require completion. The preview explicitly does not verify
independence, image semantics, licensing or current frame integrity and does not
grant eligibility or create validation/approval records. This UI/API change needs
the normal merge deployment before it is available on the hosted service.

## Next execution steps

1. Retain campaigns 2/6/7 and the current campaign-8 draft as assisted history.
   Treat the correction queue as coordinator reference material; keep blind review
   inputs separate from old annotations and candidate predictions.
2. Use the registered replacement template for actual independent review. The
   existing approval contract requires independent humans; automated sessions must
   not be presented as satisfying it. An AI-only benchmark needs a separately
   specified exploratory workflow and cannot silently inherit approved-gold or
   release claims.
3. Inspect coverage while adjudication is still a draft. If the corrected corpus
   is genuinely short, add suitable sources in a new frozen corpus. Catalog
   samples 20 (photographic people on filmed displays) and 22 (presenter inset)
   are targeted candidates. Register the expanded exact source list under the
   5–100-source profile, respect the 500-frame limit and group related footage
   before freezing a holdout. Do not infer reviewed counts from preview tags.
4. Complete real adjudication, validate the immutable result and approve only with
   truthful independence, prediction-blindness and licensing attestations. Then
   queue the pinned managed model evaluation. Evaluation and release acceptance
   remain subsequent measured decisions.

Validation of the implementation: 170 Worker tests, TypeScript, engine fingerprints
and 522 browser/layout cases pass. Provider/backend code was not changed.
