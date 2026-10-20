/** @type implementation @purpose Check diagnostic policy compatibility before assigning human review. */
import { parseValidationProfile } from "./ground-truth-validation";
import { COCO_CLASSES, parseAnnotationRules } from "./managed-annotations";

export function diagnosticReadiness(definition: Record<string, unknown>, sources: { source_sha256: string }[]) {
  const blockers: string[] = [];
  let profile;
  try { profile = parseValidationProfile(definition.validation_profile); }
  catch { blockers.push("Register a diagnostic validation profile with the exact frame-set source SHA-256 digests."); }
  const actual = sources.map((source) => source.source_sha256).sort();
  if (profile && JSON.stringify(actual) !== JSON.stringify(profile.source_sha256)) blockers.push("The policy's frozen source digests do not match this frame set; register a new policy version.");
  let rules;
  try { rules = definition.annotation_rules ? parseAnnotationRules(definition.annotation_rules) : {}; }
  catch { blockers.push("The policy annotation rules are invalid."); rules = {}; }
  if (rules.allowed_subsets && ["live", "screen", "composited"].some((subset) => !rules.allowed_subsets!.includes(subset))) blockers.push("Diagnostic coverage requires live, screen and composited annotations; the policy excludes a required subset.");
  if (rules.allowed_labels && rules.allowed_labels.filter((label) => label !== "person" && COCO_CLASSES.has(label)).length < 5) blockers.push("The policy must allow at least five non-person COCO classes to meet diagnostic coverage.");
  return {
    diagnostic_ready: blockers.length === 0,
    blockers,
    effective_taxonomy: rules.taxonomy_version ?? "coco-80",
    validation_profile: profile?.id ?? null,
    source_count: actual.length,
    notice: "Readiness checks policy configuration only. Independent review, photographic eligibility, actual coverage and approval remain required.",
  };
}
