/** @type test @purpose Verify the canonical frame-set manifest contract and invariants. */
import { describe, expect, it } from "vitest";
import { validateFrameSetManifest } from "./frame-set-manifest";

const sha = "a".repeat(64);
const manifest = () => ({
  schema_version: "frame-set-manifest.v1",
  frame_set_id: "frameset_123",
  sampling_job_id: "job_123",
  dataset_version_id: "dsv_123",
  created_at: "2026-10-03T12:00:00.000Z",
  engine: { name: "ffmpeg-sampler", version: "1.0.0", configuration_sha256: sha },
  source_count: 1,
  frame_count: 2,
  sources: [{
    dataset_source_id: "src_123",
    source_sha256: sha,
    size_bytes: 1024,
    duration_seconds: 20,
    frames: [
      { id: "frame_001", timestamp_seconds: 0, reasons: ["interval"], width: 1280, height: 720, artifact: { artifact_id: "artifact_001", sha256: sha, size_bytes: 512, media_type: "image/jpeg" } },
      { id: "frame_002", timestamp_seconds: 20, reasons: ["final_frame"], width: 1280, height: 720, artifact: { artifact_id: "artifact_002", sha256: sha, size_bytes: 510, media_type: "image/jpeg" } },
    ],
  }],
});

describe("frame-set-manifest.v1", () => {
  it("accepts a checksum-bound manifest with exact dataset coverage", () => {
    expect(validateFrameSetManifest(manifest(), { frameSetId: "frameset_123", samplingJobId: "job_123", datasetVersionId: "dsv_123", datasetSourceIds: ["src_123"] })).toEqual({ valid: true, errors: [] });
  });

  it("rejects count drift, unknown fields, unsupported media, and incomplete coverage", () => {
    const candidate = manifest() as any;
    candidate.frame_count = 3;
    candidate.sources[0].frames[0].artifact.media_type = "text/html";
    candidate.sources[0].frames[1].unexpected = true;
    const result = validateFrameSetManifest(candidate, { datasetSourceIds: ["src_123", "src_456"] });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "manifest.frame_count does not match the number of frames",
      "manifest.sources[0].frames[0].artifact.media_type is not a supported frame media type",
      "manifest.sources[0].frames[1].unexpected is not allowed",
      "manifest sources do not exactly cover the dataset version sources",
    ]));
  });

  it("rejects duplicate artifact identities and out-of-order timestamps", () => {
    const candidate = manifest();
    candidate.sources[0].frames[1].artifact.artifact_id = "artifact_001";
    candidate.sources[0].frames[1].timestamp_seconds = 0;
    candidate.sources[0].frames[0].timestamp_seconds = 1;
    const result = validateFrameSetManifest(candidate);
    expect(result.errors).toContain("manifest.sources[0].frames[1].artifact.artifact_id must be unique");
    expect(result.errors).toContain("manifest.sources[0].frames[1].timestamp_seconds must be ordered within its source");
  });
});
