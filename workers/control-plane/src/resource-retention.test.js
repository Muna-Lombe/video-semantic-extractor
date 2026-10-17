/** @type test @purpose Exercise real SQLite archival fences, grace periods and interrupted deletion. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { environment, call, frameSet, policy, templateInput } from './registry-test-support';
import { archiveResource, purgeArchives, retentionPreview, runRetention } from './resource-retention';
import { sweepOrphans } from './operations';
import { candidate, approved } from './ground-truth-test-support';
const old = '2026-01-01T00:00:00.000Z';
afterEach(() => vi.useRealTimers());
async function aged() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
  const env = environment(); await frameSet(env);
  env.CONTROL_DB.db.prepare('UPDATE frame_sets SET created_at=?').run(old);
  return env;
}
function afterGrace() { vi.setSystemTime(new Date('2026-10-26T00:00:00Z')); }
describe('resource archival and retention', () => {
  it('archives verified lineage, keeps metadata, waits for grace, then removes only media', async () => {
    const env = await aged();
    expect((await retentionPreview(env)).candidates).toHaveLength(1);
    const archive = await archiveResource(env, 'frame_set', 'fs_test', 'Unused sampling output');
    expect(archive.payload_count).toBe(1);
    expect(env.CONTROL_DB.db.prepare('SELECT state FROM resource_archives').get().state).toBe('scheduled');
    expect((await purgeArchives(env)).deleted_objects).toBe(0);
    afterGrace(); const result = await purgeArchives(env);
    expect(result).toMatchObject({ deleted_objects: 1, reclaimed_bytes: 3, errors: [] });
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head('frame.jpg')).toBeNull();
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head('manifest.json')).not.toBeNull();
    expect(env.CONTROL_DB.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n).toBe(2);
    expect(env.CONTROL_DB.db.prepare('SELECT state FROM resource_archives').get().state).toBe('deleted');
    expect((await call(env,'/frame-sets/fs_test/manifest')).status).toBe(200);
    expect((await call(env,'/frame-sets/fs_test/frames/frame_test/evidence')).status).toBe(410);
    expect((await (await call(env,'/frame-sets/fs_test')).json()).data.retention.state).toBe('deleted');
    expect((await call(env, `/operations/retention/archives/${archive.id}`)).status).toBe(200);
    await sweepOrphans(env);
    const retainedArchive=env.CONTROL_DB.db.prepare('SELECT storage_key FROM resource_archives WHERE id=?').get(archive.id);
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head(retainedArchive.storage_key)).not.toBeNull();
    expect((await purgeArchives(env)).deleted_objects).toBe(0);
  });
  it('protects pins, fresh resources and active reviews, including a pin racing archive upload', async () => {
    const env = await aged();
    expect((await call(env, '/operations/retention/pins', 'POST', { resource_type:'frame_set',resource_id:'fs_test',reason:'Frozen benchmark' })).status).toBe(200);
    expect((await retentionPreview(env)).candidates).toEqual([]);
    await call(env, '/operations/retention/pins', 'DELETE', { resource_type:'frame_set',resource_id:'fs_test' });
    const put = env.INTERNAL_ARTIFACTS_BUCKET.put.bind(env.INTERNAL_ARTIFACTS_BUCKET);
    env.INTERNAL_ARTIFACTS_BUCKET.put = async (...args) => {
      await put(...args);
      env.CONTROL_DB.db.prepare("INSERT INTO retention_pins VALUES ('frame_set','fs_test','Raced benchmark freeze',?)").run(old);
    };
    await expect(archiveResource(env,'frame_set','fs_test','Race')).rejects.toThrow();
    expect(env.CONTROL_DB.db.prepare('SELECT COUNT(*) AS n FROM resource_archives').get().n).toBe(0);
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head('frame.jpg')).not.toBeNull();
  });
  it('fences new references and permits cancellation only before deletion starts', async () => {
    const env = await aged(), registered = await policy(env);
    const archive = await archiveResource(env,'frame_set','fs_test','No consumers');
    expect((await call(env, '/operations/retention/pins', 'POST', { resource_type:'frame_set',resource_id:'fs_test',reason:'Too late' })).status).toBe(400);
    expect(() => env.CONTROL_DB.db.prepare("INSERT INTO templates(id,frame_set_id,policy_version_id,artifact_id,schema_version,status,frame_count,sha256,created_at) VALUES ('tpl_new','fs_test',?,'artifact_manifest','object-annotations.v1','ready',1,'hash',?)").run(registered.id, old)).toThrow(/archiving/);
    expect((await call(env, `/operations/retention/archives/${archive.id}/cancel`, 'POST', {})).status).toBe(200);
    expect(env.CONTROL_DB.db.prepare('SELECT status FROM frame_sets').get().status).toBe('ready');
    expect(env.CONTROL_DB.db.prepare('SELECT COUNT(*) AS n FROM artifact_retirements').get().n).toBe(0);
    const second = await archiveResource(env,'frame_set','fs_test','Still unused');
    afterGrace(); await purgeArchives(env);
    expect((await call(env, `/operations/retention/archives/${second.id}/cancel`, 'POST', {})).status).toBe(409);
  });
  it('keeps payloads when archive writing fails, and retries deletion failures', async () => {
    const env = await aged();
    const put = env.INTERNAL_ARTIFACTS_BUCKET.put.bind(env.INTERNAL_ARTIFACTS_BUCKET);
    env.INTERNAL_ARTIFACTS_BUCKET.put = async () => { throw new Error('storage unavailable'); };
    await expect(archiveResource(env,'frame_set','fs_test','Unused')).rejects.toThrow(/storage/);
    expect(env.CONTROL_DB.db.prepare('SELECT COUNT(*) AS n FROM artifact_retirements').get().n).toBe(0);
    env.INTERNAL_ARTIFACTS_BUCKET.put = put;
    await archiveResource(env,'frame_set','fs_test','Unused'); afterGrace();
    const remove = env.INTERNAL_ARTIFACTS_BUCKET.delete.bind(env.INTERNAL_ARTIFACTS_BUCKET);
    env.INTERNAL_ARTIFACTS_BUCKET.delete = async () => { throw new Error('temporary deletion failure'); };
    expect((await purgeArchives(env)).errors).toHaveLength(1);
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head('frame.jpg')).not.toBeNull();
    env.INTERNAL_ARTIFACTS_BUCKET.delete = remove;
    expect((await purgeArchives(env)).deleted_objects).toBe(1);
  });
  it.each(['archive','media'])('stops on changed %s bytes', async (target) => {
    const env = await aged(); const archive=await archiveResource(env,'frame_set','fs_test','Unused'); afterGrace();
    const key=target==='archive'?env.CONTROL_DB.db.prepare('SELECT storage_key FROM resource_archives WHERE id=?').get(archive.id).storage_key:'frame.jpg';
    await env.INTERNAL_ARTIFACTS_BUCKET.put(key,'replacement');
    expect((await purgeArchives(env)).errors[0]).toMatch(/changed/);
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head('frame.jpg')).not.toBeNull();
  });
  it('does not register an archive whose written bytes fail verification',async()=>{
    const env=await aged(),put=env.INTERNAL_ARTIFACTS_BUCKET.put.bind(env.INTERNAL_ARTIFACTS_BUCKET);
    env.INTERNAL_ARTIFACTS_BUCKET.put=async(key)=>put(key,'corrupt archive');
    await expect(archiveResource(env,'frame_set','fs_test','Unused')).rejects.toThrow(/verification failed/);
    expect(env.CONTROL_DB.db.prepare('SELECT COUNT(*) AS n FROM resource_archives').get().n).toBe(0);
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head('frame.jpg')).not.toBeNull();
  });
  it('keeps active campaigns but retires genuinely expired abandoned assignments', async () => {
    const env = await aged(), p = await policy(env);
    const t = (await (await call(env,'/templates','POST',templateInput(p.id))).json()).data;
    env.CONTROL_DB.db.prepare('UPDATE templates SET created_at=?').run(old);
    env.CONTROL_DB.db.prepare("INSERT INTO review_campaigns(id,name,template_id,status,created_at,updated_at) VALUES ('campaign_old','Abandoned',?,'active',?,?)").run(t.id,old,old);
    env.CONTROL_DB.db.prepare("INSERT INTO campaign_assignments(id,campaign_id,role,token_hash,created_at,updated_at,expires_at) VALUES ('assignment_old','campaign_old','reviewer-a','hash',?,?,'2999-01-01')").run(old,old);
    expect((await retentionPreview(env)).candidates).toEqual([]);
    env.CONTROL_DB.db.prepare('UPDATE campaign_assignments SET expires_at=?').run(old);
    expect((await retentionPreview(env)).candidates).toHaveLength(1);
    await runRetention(env);
    expect(env.CONTROL_DB.db.prepare('SELECT status FROM review_campaigns').get().status).toBe('cancelled');
  });
  it('automatically sweeps old orphans and records intent before removal', async () => {
    const env = await aged();
    await env.INTERNAL_ARTIFACTS_BUCKET.put('sampling/job_lost/frame.jpg','lost');
    env.INTERNAL_ARTIFACTS_BUCKET.objects.get('sampling/job_lost/frame.jpg').uploaded = new Date(old);
    await sweepOrphans(env);
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head('sampling/job_lost/frame.jpg')).toBeNull();
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events WHERE action='artifact.orphan_deletion_scheduled'").get().n).toBe(1);
  });
});

it('retains approved ground truth and retained evaluation inputs even after rejection', async () => {
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const prepared=await candidate();await approved(prepared);const {env,truth}=prepared;
  env.CONTROL_DB.db.prepare('UPDATE frame_sets SET created_at=?').run(old);
  env.CONTROL_DB.db.prepare('UPDATE templates SET created_at=?').run(old);
  vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
  expect((await retentionPreview(env)).candidates).toEqual([]);
  // A retained run must continue to pin its inputs even if the dataset later loses approval.
  env.CONTROL_DB.db.prepare("UPDATE ground_truth_versions SET approval_status='rejected',status='invalid'").run();
  env.CONTROL_DB.db.prepare("INSERT INTO internal_jobs(id,job_type,status,input_json,created_at,updated_at) VALUES ('job_retained','evaluation','succeeded','{}',?,?)").run(old,old);
  env.CONTROL_DB.db.prepare("INSERT INTO evaluation_runs(id,job_id,ground_truth_version_id,configuration_json,created_at) VALUES ('evaluation_retained','job_retained',?,'{}',?)").run(truth.id,old);
  expect((await retentionPreview(env)).candidates).toEqual([]);
  env.CONTROL_DB.db.prepare("UPDATE internal_jobs SET status='failed' WHERE id='job_retained'").run();
  expect((await retentionPreview(env)).candidates).toHaveLength(1);
  const entry=await archiveResource(env,'frame_set','fs_test','No retained consumers');
  expect(()=>env.CONTROL_DB.db.prepare("UPDATE internal_jobs SET status='queued' WHERE id='job_retained'").run()).toThrow(/archiving/);
  afterGrace();expect((await purgeArchives(env)).deleted_objects).toBe(5);
  expect(env.CONTROL_DB.db.prepare('SELECT state FROM resource_archives WHERE id=?').get(entry.id).state).toBe('deleted');
});

it('archives terminal model binaries while keeping model identity and licensing records', async () => {
  const env=await aged();
  const {sha256Hex}=await import('./artifact-pipeline');const binary='model bytes',sha=await sha256Hex(binary);
  await env.INTERNAL_ARTIFACTS_BUCKET.put('models/mv_old/model.onnx',binary);
  env.CONTROL_DB.db.prepare("INSERT INTO artifacts(id,kind,storage_key,sha256,size_bytes,media_type,created_at) VALUES ('a_model','model','models/mv_old/model.onnx',?,11,'application/onnx',?)").run(sha,old);
  env.CONTROL_DB.db.prepare("INSERT INTO models(id,name,task_type,created_at) VALUES ('model_old','Old model','object_detection',?)").run(old);
  env.CONTROL_DB.db.prepare("INSERT INTO model_versions(id,model_id,version,artifact_id,configuration_json,status,created_at,license) VALUES ('mv_old','model_old','v1','a_model','{}','rejected',?,'Apache-2.0')").run(old);
  expect((await retentionPreview(env)).candidates.some(item=>item.id==='mv_old')).toBe(true);
  await archiveResource(env,'model_version','mv_old','Rejected candidate');afterGrace();await purgeArchives(env);
  expect(await env.INTERNAL_ARTIFACTS_BUCKET.head('models/mv_old/model.onnx')).toBeNull();
  expect(env.CONTROL_DB.db.prepare("SELECT license FROM model_versions WHERE id='mv_old'").get().license).toBe('Apache-2.0');
});

it('serializes concurrent sweepers and resumes after object deletion precedes a database failure', async () => {
  const env=await aged();await archiveResource(env,'frame_set','fs_test','Unused');afterGrace();
  const batch=env.CONTROL_DB.batch.bind(env.CONTROL_DB);let fail=true;
  env.CONTROL_DB.batch=async statements=>{if(fail){fail=false;throw new Error('database interrupted after deletion');}return batch(statements);};
  expect((await purgeArchives(env)).errors).toHaveLength(1);
  expect(await env.INTERNAL_ARTIFACTS_BUCKET.head('frame.jpg')).toBeNull();
  env.CONTROL_DB.batch=batch;
  const results=await Promise.all([purgeArchives(env),purgeArchives(env)]);
  expect(results.reduce((sum,result)=>sum+result.deleted_objects,0)).toBe(1);
  expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events WHERE action='artifact.payload_deleted'").get().n).toBe(1);
});

it('archives expired identity metadata without keeping token hashes or removing active sessions', async()=>{
  const env=await aged(), db=env.CONTROL_DB.db;
  db.prepare("INSERT INTO internal_users(id,email,display_name,created_at,updated_at) VALUES ('user_expiry','expiry@example.test','Expiry',?,?)").run(old,old);
  db.prepare("INSERT INTO internal_sessions(id,user_id,token_hash,created_at,expires_at,last_seen_at) VALUES ('session_expired','user_expiry','old-sensitive-hash',?,?,?)").run(old,old,old);
  db.prepare("INSERT INTO internal_sessions(id,user_id,token_hash,created_at,expires_at,last_seen_at) VALUES ('session_active','user_expiry','active-sensitive-hash',?,'2999-01-01',?)").run(old,old);
  db.prepare("INSERT INTO internal_auth_challenges(id,user_id,token_hash,purpose,created_at,expires_at) VALUES ('challenge_expired','user_expiry','challenge-sensitive-hash','sign_in',?,?)").run(old,old);
  const {pruneExpiredIdentity}=await import('./resource-retention');
  const result=await pruneExpiredIdentity(env);
  expect(result.internal_sessions).toBe(1);expect(result.internal_auth_challenges).toBe(1);
  expect(db.prepare('SELECT id FROM internal_sessions').get().id).toBe('session_active');
  const events=db.prepare("SELECT details_json FROM internal_audit_events WHERE action='identity.expired_resources_archived'").all();
  expect(events).toHaveLength(2);expect(JSON.stringify(events)).not.toContain('sensitive-hash');
});
