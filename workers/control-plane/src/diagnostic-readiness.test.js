/** @type test @purpose Prevent unusable diagnostic campaigns without weakening annotation-only compatibility. */
import { describe, expect, it } from "vitest";
import { diagnosticReadiness } from "./diagnostic-readiness";
import { fixture, call } from "./campaign-test-support";

describe("diagnostic review readiness", () => {
  it("blocks missing profiles before campaign creation and retains explicit annotation-only review", async () => {
    const { env, template } = await fixture({ sourceCount: 5 });
    const readiness = await call(env, `/api/internal/v1/templates/${template.id}/readiness`);
    expect(readiness.status).toBe(200);
    expect((await readiness.json()).data).toMatchObject({ diagnostic_ready: false, effective_taxonomy: "coco-80", validation_profile: null });
    const input = { name: "Diagnostic", template_id: template.id, issue_tokens: false, purpose: "diagnostic" };
    const blocked = await call(env, "/api/internal/v1/review-campaigns", "POST", input);
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).error.code).toBe("diagnostic_not_ready");
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM review_campaigns").get().n).toBe(0);
    expect((await call(env, "/api/internal/v1/review-campaigns", "POST", { ...input, purpose: "annotation", idempotency_key: "purpose-test" })).status).toBe(201);
    expect((await call(env, "/api/internal/v1/review-campaigns", "POST", { ...input, idempotency_key: "purpose-test" })).status).toBe(409);
  });
  it("accepts a compatible profile and reports the effective pinned taxonomy", async () => {
    const { env, template } = await fixture({ sourceCount: 5, profile: true });
    const ready = (await (await call(env, `/api/internal/v1/templates/${template.id}/readiness`)).json()).data;
    expect(ready).toMatchObject({ diagnostic_ready: true, source_count: 5, validation_profile: "coco-object-diagnostic.v1" });
    expect((await call(env, "/api/internal/v1/review-campaigns", "POST", { name: "Diagnostic", template_id: template.id, issue_tokens: false, purpose: "diagnostic" })).status).toBe(201);
  });
  it("rejects impossible class/subset scope and mismatched frozen digests", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ source_sha256: String(i + 1).repeat(64) }));
    const definition = { validation_profile: { id: "coco-object-diagnostic.v1", source_sha256: sources.map((s) => s.source_sha256) }, annotation_rules: { taxonomy_version: "coco-extended.v1", allowed_subsets: ["live"], allowed_labels: ["person", "other", "microphone"] } };
    const result = diagnosticReadiness(definition, sources);
    expect(result.effective_taxonomy).toBe("coco-extended.v1"); expect(result.blockers).toHaveLength(2);
    definition.annotation_rules = {};
    expect(diagnosticReadiness(definition, sources.slice(1)).blockers.join(" ")).toContain("do not match");
  });
});
