/** @type test @purpose Persist reproducible selection provenance and enforce frozen taxonomy boundaries. */
import { describe,it,expect } from 'vitest';
import { environment,call } from './registry-test-support';
import { SAMPLE_LIBRARY, selectSamples } from './sample-library';
import { parseAnnotationRules, validateFrameAnnotations } from './managed-annotations';
import { compareReviews } from './review-comparison';
import { parseValidationProfile,validateGroundTruthContent } from './ground-truth-validation';
import { probeMedia } from './media-preflight';

describe('sample library and extended annotations',()=>{
  it('reproduces unique selections, changes with seed, and freezes content hashes in actual SQLite', async()=>{
    const env=environment(), selected=await selectSamples(7,'fixed-seed');
    expect(SAMPLE_LIBRARY.sources).toHaveLength(27);
    expect(await selectSamples(7,'fixed-seed')).toEqual(selected);
    expect(new Set(selected.source_ids).size).toBe(7);
    expect((await selectSamples(7,'another-seed')).source_ids).not.toEqual(selected.source_ids);
    const {sources,...selection}=selected;
    const response=await call(env,'/datasets','POST',{name:'Frozen random selection',sources:sources.map(({url})=>({url})),selection});
    expect(response.status).toBe(201);
    const version=(await response.json()).data.initial_version;
    const stored=JSON.parse(env.DATASET_DB.db.prepare('SELECT selection_json FROM dataset_versions WHERE id=?').get(version.id).selection_json);
    expect(stored.source_sha256).toEqual(sources.map(s=>s.sha256));
    expect(()=>env.DATASET_DB.db.prepare("UPDATE dataset_versions SET selection_json='{}'").run()).toThrow(/immutable/);
    expect(()=>env.DATASET_DB.db.prepare("UPDATE dataset_sources SET expected_sha256=?").run('0'.repeat(64))).toThrow(/immutable/);
    expect(env.DATASET_DB.db.prepare('SELECT expected_sha256 FROM dataset_sources ORDER BY ordinal').all().map(s=>s.expected_sha256)).toEqual(stored.source_sha256);
    expect((await call(env,'/datasets','POST',{name:'Tampered',sources:[{url:'https://media.example/new.mp4'}],selection})).status).toBe(400);
    expect((await call(env,'/datasets','POST',{name:'Fresh links',sources:[{url:'https://media.example/new.mp4'}]})).status).toBe(201);
    await expect(selectSamples(SAMPLE_LIBRARY.sources.length+1,'seed')).rejects.toThrow();
    await expect(selectSamples(2,'')).rejects.toThrow();
    expect((await call(env,'/sample-library','GET',undefined,'wrong')).status).toBe(401);
    expect((await call(env,'/reference-benchmarks','GET',undefined,'wrong')).status).toBe(401);
    const evidence=(await (await call(env,'/reference-benchmarks')).json()).data;
    expect(evidence.video.status).toBe('awaiting_independent_review');
    expect(evidence.coco.models.map(model=>model.engine)).toEqual(['nanodet','yolov10']);
  });
  it('indexes the new media, selects the entire catalog, and rejects selections from the previous catalog',async()=>{
    const env=environment(),all=await selectSamples(27,'all-samples');
    expect(new Set(all.source_ids).size).toBe(27);
    expect(all.source_ids.slice().sort()).toEqual(SAMPLE_LIBRARY.sources.map(source=>source.id).sort());
    for(let index=18;index<=27;index++){
      const source=all.sources.find(source=>source.id===`sample_${index}`);
      expect(source).toMatchObject({full_decode_passed:true,coverage_status:'preview_inspected'});
      expect(source.url).toBe(`https://pub-f402b333934c4b279fdf90faf5864e0a.r2.dev/videos/sample_${index}.mp4`);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const {sources,...selection}=all;
    const payload={name:'All audited media',sources:sources.map(({url})=>({url})),selection};
    expect((await call(env,'/datasets','POST',payload)).status).toBe(201);
    expect(env.DATASET_DB.db.prepare('SELECT expected_sha256 FROM dataset_sources ORDER BY ordinal').all().map(row=>row.expected_sha256)).toEqual(sources.map(source=>source.sha256));
    const stale={...payload,selection:{...selection,catalog_version:'2026-10-18.1'}};
    expect((await call(env,'/datasets','POST',stale)).status).toBe(400);
    expect((await (await call(env,'/sample-library')).json()).data.sources).toHaveLength(27);
  });
  it('keeps legacy taxonomy strict and requires descriptions for other',()=>{
    const frame={filename:'f.jpg',width:100,height:100,objects:[],out_of_taxonomy:[]};
    const candidate={...frame,objects:[{id:'a',label:'other',description:'desk lamp',uncertain:false,subset:'live',region:[1,1,20,20]}]};
    const rules=parseAnnotationRules({taxonomy_version:'coco-extended.v1'});
    expect(()=>validateFrameAnnotations(candidate,frame,new Set(),rules)).not.toThrow();
    expect(()=>validateFrameAnnotations(candidate,frame)).toThrow();
    delete candidate.objects[0].description;
    expect(()=>validateFrameAnnotations(candidate,frame,new Set(),rules)).toThrow(/descriptive/);
    expect(()=>parseAnnotationRules({allowed_labels:['microphone']})).toThrow();
    expect(()=>parseAnnotationRules({taxonomy_version:'coco-extended.v1',allowed_labels:['microphone','other']})).not.toThrow();
  });
  it('does not agree on different unknown objects merely because boxes overlap',()=>{
    const payload=name=>({policy_version:'1',sources:[{source:'s',frames:[{filename:'f',objects:[{label:'other',description:name,subset:'live',region:[0,0,20,20]}],out_of_taxonomy:[]}]}]});
    expect(compareReviews(payload('lamp'),payload('scanner')).agree).toBe(false);
    expect(compareReviews(payload('lamp'),payload('Lamp')).agree).toBe(true);
  });
  it('versions variable source counts without permitting gate overrides or changing v1',()=>{
    const hashes=SAMPLE_LIBRARY.sources.map(s=>s.sha256);
    expect(parseValidationProfile({id:'video-object-diagnostic.v2',source_sha256:hashes}).source_sha256).toHaveLength(27);
    expect(()=>parseValidationProfile({id:'coco-object-diagnostic.v1',source_sha256:hashes})).toThrow();
    expect(()=>parseValidationProfile({id:'video-object-diagnostic.v2',source_sha256:hashes,minimum_screen:0})).toThrow();
    expect(()=>parseValidationProfile({id:'video-object-diagnostic.v2',source_sha256:[...hashes.slice(1),hashes[1]]})).toThrow();
  });
  it('cannot satisfy COCO adequacy by adding other objects',()=>{
    const sources=Array.from({length:5},(_,i)=>({source:`s${i}`,source_sha256:SAMPLE_LIBRARY.sources[i].sha256,frames:[{filename:'f.jpg',frame_id:`f${i}`,width:100,height:100,objects:Array.from({length:10},(_,n)=>({id:`o${i}-${n}`,label:'other',description:'desk lamp',subset:'screen',region:[1,1,20,20]})),out_of_taxonomy:[]}]}));
    const template={schema_version:'object-annotations.v1',policy_version:'extended',provenance:{},validation:{annotation_rules:{taxonomy_version:'coco-extended.v1'}},review:{reviewed_frames:[]},sources};
    const candidate={...template,review:{independent_passes:2,adjudication_status:'complete',predictions_reviewed_before_freeze:false,adjudication_log:[],reviewed_frames:sources.map(s=>`${s.source}/f.jpg`)}};
    const result=validateGroundTruthContent(template,candidate,{id:'video-object-diagnostic.v2',source_sha256:sources.map(s=>s.source_sha256).sort()});
    expect(result.valid).toBe(true);expect(result.adequate).toBe(false);
    expect(result.counts.objects).toBe(50);expect(result.counts.coco_objects).toBe(0);
    expect(result.counts.extended_classes.other).toBe(50);expect(result.counts.non_person_classes).toBe(0);
    expect(result.corpus_adequacy_shortfalls.subsets.screen.remaining).toBe(20);
  });
  it('checks redirects independently and keeps failures distinct from successful decoding',async()=>{
    let calls=0;
    const result=await probeMedia(['https://media.example/good.mp4','https://media.example/redirect.mp4','https://127.0.0.1/private'],async url=>{
      calls++;return url.includes('redirect')?new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}}):new Response(null,{status:200,headers:{'content-type':'video/mp4','content-length':'123'}});
    });
    expect(calls).toBe(2);
    expect(result[0]).toMatchObject({reachable:true,size_bytes:123});
    expect(result[1].reachable).toBe(false);expect(result[2].reachable).toBe(false);
  });
});
