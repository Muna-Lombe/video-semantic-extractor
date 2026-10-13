/** @type schema @purpose Define bindings for the control-plane and hosted review Worker. */
export interface AdjudicationEnv {
  REVIEW_BUCKET: R2Bucket;
  INTERNAL_ARTIFACTS_BUCKET: R2Bucket;
  CONTROL_DB: D1Database;
  DATASET_DB: D1Database;
  ADMIN_TOKEN: string;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  PUBLIC_BASE_URL?: string;
  INTERNAL_AUTH_MODE?: "legacy" | "sessions";
  RUNNER_TOKEN?: string;
  ASSETS: Fetcher;
}
