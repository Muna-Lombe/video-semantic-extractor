/** @type validation @purpose Preserve registered evidence identity and validate managed human annotations. */
import type { JsonRecord } from "./review-comparison";

const CLASSES = new Set("person|bicycle|car|motorcycle|airplane|bus|train|truck|boat|traffic light|fire hydrant|stop sign|parking meter|bench|bird|cat|dog|horse|sheep|cow|elephant|bear|zebra|giraffe|backpack|umbrella|handbag|tie|suitcase|frisbee|skis|snowboard|sports ball|kite|baseball bat|baseball glove|skateboard|surfboard|tennis racket|bottle|wine glass|cup|fork|knife|spoon|bowl|banana|apple|sandwich|orange|broccoli|carrot|hot dog|pizza|donut|cake|chair|couch|potted plant|bed|dining table|toilet|tv|laptop|mouse|remote|keyboard|cell phone|microwave|oven|toaster|sink|refrigerator|book|clock|vase|scissors|teddy bear|hair drier|toothbrush".split("|"));
const SUBSETS = new Set(["live", "composited", "screen"]);
const object = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function fixedFrame(frame: JsonRecord) {
  const { objects: _objects, out_of_taxonomy: _audit, ...identity } = frame;
  return identity;
}

export function validateFrameAnnotations(frame: JsonRecord, expected: JsonRecord, ids = new Set<string>()): void {
  if (!object(frame) || canonical(fixedFrame(frame)) !== canonical(fixedFrame(expected))) throw new Error("frame evidence identity cannot change");
  if (!Array.isArray(frame.objects) || frame.objects.length > 200 || !Array.isArray(frame.out_of_taxonomy) || frame.out_of_taxonomy.length > 200 || frame.out_of_taxonomy.some((entry: unknown) => typeof entry !== "string" || entry.length < 1 || entry.length > 1000)) throw new Error("objects and out_of_taxonomy must be valid annotation lists with at most 200 entries per frame");
  for (const annotation of frame.objects) {
    if (!object(annotation) || Object.keys(annotation).some((key) => !["id", "label", "subset", "region"].includes(key)) || typeof annotation.id !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(annotation.id) || ids.has(annotation.id) || !CLASSES.has(annotation.label) || !SUBSETS.has(annotation.subset)) throw new Error("objects require unique IDs, COCO labels, and live/composited/screen subsets");
    const box = annotation.region;
    if (!Array.isArray(box) || box.length !== 4 || box.some((coordinate: unknown) => typeof coordinate !== "number" || !Number.isFinite(coordinate)) || box[0] < 0 || box[1] < 0 || box[2] <= 0 || box[3] <= 0 || box[0] + box[2] > expected.width || box[1] + box[3] > expected.height) throw new Error("object regions must be positive source-pixel boxes within the frame");
    ids.add(annotation.id);
  }
}

/** Normalize human-editable fields from a submission without trusting provenance or pass claims. */
export function validateManagedSubmission(template: JsonRecord, candidate: JsonRecord): JsonRecord {
  if (!object(candidate) || candidate.policy_version !== template.policy_version || candidate.schema_version !== template.schema_version || canonical(candidate.provenance) !== canonical(template.provenance) || canonical(candidate.validation) !== canonical(template.validation)) throw new Error("submission must retain registered policy, schema, and provenance");
  if (!Array.isArray(candidate.sources) || candidate.sources.length !== template.sources.length) throw new Error("submission must retain the exact registered sources");
  if (!object(candidate.review) || candidate.review.predictions_reviewed_before_freeze !== false) throw new Error("candidate predictions must remain unseen before freeze");
  const result = clone(template), ids = new Set<string>(), frameKeys = new Set<string>();
  template.sources.forEach((source: JsonRecord, sourceIndex: number) => {
    const supplied = candidate.sources[sourceIndex];
    if (!object(supplied) || supplied.source !== source.source || supplied.source_sha256 !== source.source_sha256 || !Array.isArray(supplied.frames) || supplied.frames.length !== source.frames.length || Object.keys(supplied).some((key) => !["source", "source_sha256", "frames"].includes(key))) throw new Error("source identity and coverage cannot change");
    source.frames.forEach((frame: JsonRecord, frameIndex: number) => {
      const submitted = supplied.frames[frameIndex];
      validateFrameAnnotations(submitted, frame, ids);
      result.sources[sourceIndex].frames[frameIndex].objects = clone(submitted.objects);
      result.sources[sourceIndex].frames[frameIndex].out_of_taxonomy = clone(submitted.out_of_taxonomy);
      frameKeys.add(`${source.source}/${frame.filename}`);
    });
  });
  const reviewed = candidate.review.reviewed_frames;
  if (!Array.isArray(reviewed) || new Set(reviewed).size !== reviewed.length || reviewed.some((key: unknown) => typeof key !== "string" || !frameKeys.has(key))) throw new Error("reviewed_frames must contain unique registered frame keys");
  result.review.reviewed_frames = clone(reviewed);
  return result;
}

export function assertManagedCoverage(submission: JsonRecord): void {
  const count = submission.sources.reduce((total: number, source: JsonRecord) => total + source.frames.length, 0);
  if (submission.review.reviewed_frames.length !== count) throw new Error("every registered frame must be reviewed before completion");
}
