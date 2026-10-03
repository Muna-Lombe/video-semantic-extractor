/** @type schema @purpose Define bindings for the control-plane and hosted review Worker. */
export interface AdjudicationEnv {
  REVIEW_BUCKET: R2Bucket;
  INTERNAL_ARTIFACTS_BUCKET: R2Bucket;
  CONTROL_DB: D1Database;
  DATASET_DB: D1Database;
  ADMIN_TOKEN: string;
  RUNNER_TOKEN?: string;
  ASSETS: Fetcher;
}
