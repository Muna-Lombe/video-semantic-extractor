/** @type implementation @purpose Expose draft coverage blockers without completing review or approving evidence. */
import type { AdjudicationEnv } from "./types";
import type { JsonRecord } from "./review-comparison";
import { diagnosticReadiness } from "./diagnostic-readiness";
import { parseValidationProfile, previewGroundTruthContent } from "./ground-truth-validation";

export async function reviewPreflight(env: AdjudicationEnv, campaign: JsonRecord, template: JsonRecord, definition: JsonRecord) {
  const readiness = diagnosticReadiness(definition, template.sources);
  const draft = await env.CONTROL_DB.prepare("SELECT merged_json, revision FROM campaign_adjudications WHERE campaign_id = ?").bind(campaign.id).first<JsonRecord>();
  let profile;
  try { profile = parseValidationProfile(definition.validation_profile); } catch { /* Readiness reports the exact configuration blocker. */ }
  const annotations = draft ? previewGroundTruthContent(template, JSON.parse(draft.merged_json), profile) : null;
  return {
    schema_version: "review-preflight.v1",
    campaign_id: campaign.id,
    campaign_status: campaign.status,
    template_sha256: campaign.template_sha256,
    draft_revision: draft?.revision ?? null,
    readiness,
    annotations,
    failed_gates: annotations ? Object.entries(annotations.corpus_adequacy_gates).filter(([, passed]) => !passed).map(([gate]) => gate) : [],
    eligibility_assessed: false,
    notice: "Read-only preview of saved adjudication annotations. No draft means coverage is unmeasured. Assignment completion does not prove reviewer independence. Preview does not verify image semantics, licensing or current frame integrity, record validation, or grant evaluation eligibility.",
  };
}
