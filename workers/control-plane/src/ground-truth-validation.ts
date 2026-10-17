/** @type contract @purpose Apply frozen COCO diagnostic rules to managed adjudicated candidates. */
import type { JsonRecord } from "./review-comparison";
import { assertManagedCoverage, validateManagedSubmission, COCO_CLASSES } from "./managed-annotations";

export const VALIDATOR_VERSION = "managed-ground-truth.v1";
export const DIAGNOSTIC_PROFILE = "coco-object-diagnostic.v1";
export const VIDEO_PROFILE = "video-object-diagnostic.v2";
export interface ValidationProfile { id: typeof DIAGNOSTIC_PROFILE | typeof VIDEO_PROFILE; source_sha256: string[]; }

/** No arbitrary gate overrides: changing a profile means implementing a new version. */
export function parseValidationProfile(value: unknown): ValidationProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("validation_profile must be an object");
  const profile = value as JsonRecord;
  if (Object.keys(profile).some((key) => !["id", "source_sha256"].includes(key)) || ![DIAGNOSTIC_PROFILE, VIDEO_PROFILE].includes(profile.id) || !Array.isArray(profile.source_sha256) || (profile.id === DIAGNOSTIC_PROFILE ? profile.source_sha256.length !== 5 : profile.source_sha256.length < 5 || profile.source_sha256.length > 100) || profile.source_sha256.some((sha: unknown) => typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha)) || new Set(profile.source_sha256).size !== profile.source_sha256.length) throw new Error("validation_profile requires five distinct frozen source SHA-256 digests for coco-object-diagnostic.v1, or 5-100 for video-object-diagnostic.v2");
  return { id: profile.id, source_sha256: [...profile.source_sha256].sort() };
}

export function validateGroundTruthContent(template: JsonRecord, candidate: JsonRecord, profile?: ValidationProfile) {
  const errors: string[] = [];
  try { assertManagedCoverage(validateManagedSubmission(template, candidate)); }
  catch (cause) { errors.push(cause instanceof Error ? cause.message : "invalid annotation structure"); }
  const reviewComplete = candidate.review?.independent_passes === 2 && candidate.review?.adjudication_status === "complete" && candidate.review?.predictions_reviewed_before_freeze === false && Array.isArray(candidate.review?.adjudication_log);
  if (!reviewComplete) errors.push("two completed independent passes and completed prediction-blind adjudication are required");
  const classes: Record<string, number> = {}, subsets = { live: 0, screen: 0, composited: 0 }, areas = { small: 0, medium: 0, large: 0 }, sources: Record<string, number> = {};
  const extendedClasses: Record<string, number> = {};
  let cocoObjects = 0;
  let frames = 0, objects = 0;
  // Only valid shapes reach counting; malformed annotations remain an invalid report.
  if (errors.length === 0) {
    for (const source of candidate.sources) {
      sources[source.source] = 0;
      for (const frame of source.frames) {
        frames++;
        for (const annotation of frame.objects) {
          const box = annotation.region as number[];
          if (profile && (box.some((coordinate) => !Number.isInteger(coordinate)) || box[2] < 8 || box[3] < 8)) errors.push(`${source.source}/${frame.filename}/${annotation.id}: diagnostic boxes require integer coordinates and at least 8x8 pixels`);
          classes[annotation.label] = (classes[annotation.label] ?? 0) + 1;
          objects++;
          if (!COCO_CLASSES.has(annotation.label)) { extendedClasses[annotation.label] = (extendedClasses[annotation.label] ?? 0) + 1; continue; }
          subsets[annotation.subset as keyof typeof subsets]++;
          const fraction = box[2] * box[3] / (frame.width * frame.height);
          areas[fraction < 0.02 ? "small" : fraction > 0.20 ? "large" : "medium"]++;
          sources[source.source]++; cocoObjects++;
        }
      }
    }
  }
  const nonPerson = cocoObjects - (classes.person ?? 0), nonPersonClasses = Object.keys(classes).filter((label) => label !== "person" && COCO_CLASSES.has(label)).length;
  const maximumFraction = cocoObjects ? Math.max(0, ...Object.values(sources)) / cocoObjects : null;
  const actualSources = Array.isArray(candidate.sources) ? candidate.sources.map((source: JsonRecord) => source?.source_sha256).sort() : [];
  const gates = {
    review_complete: reviewComplete && errors.length === 0,
    [profile?.id === VIDEO_PROFILE ? "frozen_sources" : "frozen_five_sources"]: Boolean(profile) && JSON.stringify(actualSources) === JSON.stringify(profile?.source_sha256),
    fifty_non_person_instances: nonPerson >= 50,
    five_non_person_classes: nonPersonClasses >= 5,
    subset_minimums: subsets.live >= 20 && subsets.screen >= 20 && subsets.composited >= 10,
    scale_minimums: areas.small >= 15 && areas.large >= 15,
    source_concentration: maximumFraction !== null && maximumFraction <= 0.60,
  };
  if (!profile) errors.push("a frozen compatible validation profile is required for diagnostic approval");
  return {
    valid: errors.length === 0,
    adequate: errors.length === 0 && Object.values(gates).every(Boolean),
    errors,
    counts: { sources: actualSources.length, frames, objects, coco_objects: cocoObjects, extended_classes: extendedClasses, non_person_objects: nonPerson, non_person_classes: nonPersonClasses, classes, subsets, area_bands: areas, sources_with_objects: sources },
    corpus_adequacy_gates: gates,
    corpus_adequacy_shortfalls: {
      non_person_instances: { required: 50, actual: nonPerson, remaining: Math.max(0, 50 - nonPerson) },
      non_person_classes: { required: 5, actual: nonPersonClasses, remaining: Math.max(0, 5 - nonPersonClasses) },
      subsets: Object.fromEntries(Object.entries({ live: 20, screen: 20, composited: 10 }).map(([key, required]) => [key, { required, actual: subsets[key as keyof typeof subsets], remaining: Math.max(0, required - subsets[key as keyof typeof subsets]) }])),
      area_bands: { small: { required: 15, actual: areas.small, remaining: Math.max(0, 15 - areas.small) }, large: { required: 15, actual: areas.large, remaining: Math.max(0, 15 - areas.large) } },
      source_concentration: { maximum: 0.60, actual: maximumFraction },
      frozen_sources: { expected: profile?.source_sha256 ?? null, actual: actualSources },
    },
  };
}
