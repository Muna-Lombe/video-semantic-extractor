/** @type test @purpose Exercise adjudicator and appearance browser interactions using isolated API fixtures. */
// Browser-only regression fixtures; this script never contacts the hosted service.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
fs.mkdirSync('work/adjudicator',{recursive:true});
const assets=path.resolve('workers/control-plane/adjudication-web');
const server=http.createServer((req,res)=>{
 const requested=new URL(req.url,'http://localhost').pathname;
 const file=path.resolve(assets,'.'+(requested.endsWith('/')?requested+'index.html':requested));
 if(!file.startsWith(assets+path.sep)){res.writeHead(403).end();return}
 try {res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file))}catch{res.writeHead(404).end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const fixtureImage='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#263c30"/><rect x="105" y="150" width="75" height="120" fill="#507896"/><circle cx="143" cy="110" r="35" fill="#b9a578"/><rect x="365" y="180" width="190" height="120" fill="#415f73"/></svg>';

const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
const checks=[], check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('PASS '+name)};
const frame=(filename,id,label)=>({filename,frame_id:id,timestamp_sec:1,width:640,height:360,artifact:{artifact_id:'artifact_'+id},objects:[{id:'object-'+id+'-'+label,label,subset:'live',region:label==='person'?[100,70,90,210]:[355,175,200,130]}],out_of_taxonomy:[]});
const payload=(label)=>({sources:[{source:'source-with-a-long-stable-identifier',frames:[frame('000001.jpg','one',label),frame('000002.jpg','two',label)]}]});
const makeState=(agree=false)=>({revision:0,assignment:{status:'in_progress'},policy:{name:'Independent annotation',version:'v1',document:'Compare both reviews against the evidence. Resolve all disagreements before completion.',annotation_rules:{allowed_labels:['person','chair'],allowed_subsets:['live','screen'],max_objects_per_frame:5}},reviewer_a:payload('person'),reviewer_b:payload(agree?'person':'chair'),merged:{...payload('person'),review:{adjudication_log:[]}},comparison:{disagreements:agree?[]:[{source:'source-with-a-long-stable-identifier',filename:'000001.jpg',type:'left_unmatched'},{source:'source-with-a-long-stable-identifier',filename:'000001.jpg',type:'right_unmatched'},{source:'source-with-a-long-stable-identifier',filename:'000002.jpg',type:'left_unmatched'}]}});
async function setup({agree=false,waiting=false,reviewer=false,extended=false,empty=false,mixed=false}={}){
 const context=await browser.newContext({viewport:{width:1580,height:1100},colorScheme:'light'}),page=await context.newPage(),errors=[];
 page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(e.message));
 let state=makeState(agree),puts=0,completes=0,stale=false,waitingNow=waiting,evidenceFails=false;
 if(empty)for(const key of ['reviewer_a','reviewer_b','merged'])for(const source of state[key].sources)for(const frame of source.frames)frame.objects=[];
 if(mixed)for(const key of ['reviewer_a','reviewer_b','merged']){const frame=structuredClone(state[key].sources[0].frames[0]);frame.filename='000001-agreed.jpg';frame.frame_id='frame-agreed';frame.objects=[];state[key].sources[0].frames.splice(1,0,frame);}
 if(extended){state.policy.annotation_rules.taxonomy_version='coco-extended.v1';state.policy.annotation_rules.allowed_labels.push('microphone','other');}
 let reviewerPayload={...payload('person'),review:{reviewed_frames:[]}};
 await page.route('**/adjudicate/**',route=>route.fulfill({contentType:'text/html',body:fs.readFileSync('workers/control-plane/adjudication-web/index.html','utf8')}));
 await page.route('**/review/**',route=>route.fulfill({contentType:'text/html',body:fs.readFileSync('workers/control-plane/adjudication-web/index.html','utf8')}));
 await page.route('**/api/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname,method=r.method(),json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/api/v1/me')return json({assignment_id:'assignment-test',actor:{role:reviewer?'reviewer-a':'adjudicator'},links:{state:reviewer?'/api/v1/assignments/assignment-test':'/api/v1/adjudications/assignment-test'}});
  if(path.includes('/frames/')&&method==='GET'&&evidenceFails)return json({error:{message:'Unavailable'}},503);
  if(path.includes('/frames/')&&method==='GET')return route.fulfill({contentType:'image/svg+xml',body:fixtureImage});
  if(method==='PUT'){
   if(reviewer){reviewerPayload=r.postDataJSON();state.revision++;puts++;return json({revision:state.revision});}
   if(stale){stale=false;return json({error:{message:'adjudication changed; reload before saving'}},412)}
   assert.equal(r.headers()['if-match'],String(state.revision));const value=r.postDataJSON();
   const filename=decodeURIComponent(path.split('/').at(-1)),target=state.merged.sources[0].frames.find(f=>f.filename===filename);
   assert.equal(value.frame.frame_id,target.frame_id);assert.equal(value.frame.width,640);
   const copy=structuredClone(value.frame);Object.assign(target,copy);state.merged.review.adjudication_log=state.merged.review.adjudication_log.filter(e=>e.filename!==filename);
   state.merged.review.adjudication_log.push({source:state.merged.sources[0].source,filename,resolution:value.resolution});state.revision++;puts++;
   await new Promise(r=>setTimeout(r,120));return json({saved:true,revision:state.revision});
  }
  if(path.endsWith('/complete')){assert.equal(r.headers()['if-match'],String(state.revision));completes++;state.assignment.status='complete';state.result_url='/api/v1/campaigns/test/result';state.revision++;return json({completed:true,revision:state.revision,result_url:state.result_url});}
  if(path.endsWith('/result'))return json(state.merged);
  if(path==='/api/internal/v1/auth/status')return json({data:{authentication:'administrator_token',bootstrap_available:false}});
  if(path==='/api/internal/v1/auth/me')return json({error:{message:'Sign in required'}},401);
  if(path.includes('/adjudications/'))return waitingNow?json({error:{message:'both independent reviewer passes must be complete'}},409):json(state);
  if(reviewer&&path==='/api/v1/assignments/assignment-test')return json({revision:state.revision,assignment:{status:'in_progress'},frame_count:2,annotations:reviewerPayload,policy:state.policy});
  return json({data:[]});
 });
 await page.goto(base+'/'+(reviewer?'review/':'adjudicate/')+'#token=ui-test');
 if(waiting)await page.locator('#adjudication-empty').waitFor({state:'visible'});
 else if(!agree&&!reviewer)await page.waitForFunction(()=>document.querySelector('#left-canvas').width===640&&!document.querySelector('#save-resolution').disabled);
 else await page.locator(reviewer?'#reviewer':'#adjudicator').waitFor({state:'visible'});
 return {page,context,errors,state,get reviewerPayload(){return reviewerPayload},get puts(){return puts},get completes(){return completes},failStale(){stale=true},ready(){waitingNow=false},failEvidence(value){evidenceFails=value}};
}
try{
 const t=await setup(),{page}=t;
 check('Select first unresolved frame automatically',(await page.locator('#adjudication-title').innerText())==='000001.jpg');
 check('Completion disabled while unresolved',await page.locator('#complete-adjudication').isDisabled());
 check('Highlight selected frame',(await page.locator('.frame[aria-current=true]').count())===1);
 check('Three visual evidence panels',(await page.locator('.evidence-canvas canvas').count())===3);
 await page.getByLabel('Appearance',{exact:true}).selectOption('dark');check('Dark theme applied',await page.evaluate(()=>document.documentElement.dataset.theme==='dark'));
 await page.reload();await page.waitForFunction(()=>document.querySelector('#left-canvas').width===640&&!document.querySelector('#save-resolution').disabled);check('Theme survives reload',await page.evaluate(()=>document.documentElement.dataset.theme==='dark'));
 check('Invitation token removed from URL',await page.evaluate(()=>location.hash===''));
 t.failEvidence(true);await page.locator('#refresh-adjudication').click();await page.waitForFunction(()=>document.querySelector('#adjudication-evidence-status').textContent.includes('could not be loaded'));check('Unavailable evidence blocks saving',await page.locator('#save-resolution').isDisabled());t.failEvidence(false);await page.locator('#refresh-adjudication').click();await page.waitForFunction(()=>!document.querySelector('#save-resolution').disabled);check('Evidence reload recovers',true);
 await page.screenshot({path:'work/adjudicator/dark-desktop.png',fullPage:true});
 await page.locator('#use-b').click();check('Reviewer choice creates unsaved draft',(await page.locator('#decision-state').innerText())==='Unsaved');
 page.once('dialog',d=>d.dismiss());await page.locator('#next-frame').click();check('Discard warning protects draft',(await page.locator('#adjudication-title').innerText())==='000001.jpg');
 await page.locator('#save-resolution').evaluate(button=>{button.click();button.click()});
 await page.waitForFunction(()=>document.querySelector('#adjudication-title').textContent==='000002.jpg'&&!document.querySelector('#save-resolution').disabled);
 check('Save advances to next unresolved',t.puts===1&&t.state.merged.review.adjudication_log[0].resolution==='reviewer_b');
 await page.getByLabel('Object 1 X',{exact:true}).fill('999');await page.locator('#save-resolution').click();check('Invalid box rejected inline',(await page.locator('#resolution-status').innerText()).includes('within the source image')&&t.puts===1);
 await page.getByLabel('Object 1 X',{exact:true}).fill('70');t.failStale();await page.locator('#save-resolution').click();await page.waitForFunction(()=>document.querySelector('#resolution-status').textContent.includes('Reload saved decisions'));
 check('Stale revision preserves draft',(await page.getByLabel('Object 1 X',{exact:true}).inputValue())==='70'&&(await page.locator('#resolution-status').innerText()).includes('Reload saved decisions'));
 page.once('dialog',d=>d.accept());await page.locator('#reload-adjudication').click();await page.waitForFunction(()=>!document.querySelector('#save-resolution').disabled);
 await page.locator('#draw-decision-box').click();await page.locator('#decision-canvas').scrollIntoViewIfNeeded();const bounds=await page.locator('#decision-canvas').boundingBox();await page.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.4,bounds.y+bounds.height*.5);await page.mouse.up();check('Draw box in source pixels',(await page.locator('.decision-object').count())===2&&Math.abs(Number(await page.getByLabel('Object 2 X',{exact:true}).inputValue())-128)<=1);await page.getByRole('button',{name:'Remove object 2',exact:true}).click();check('Remove drawn object',(await page.locator('.decision-object').count())===1);
 await page.locator('#advanced-decision summary').click();await page.locator('#merged').fill('{');await page.locator('#apply-decision-json').click();check('Invalid JSON stays editable',(await page.locator('#resolution-status').innerText()).includes('JSON is invalid'));
 page.once('dialog',d=>d.accept());await page.locator('#use-a').click();await page.getByLabel('Object 1 X',{exact:true}).fill('70');await page.locator('#decision-taxonomy').fill('unlisted visible fixture');await page.locator('#save-resolution').click();
 await page.waitForFunction(()=>!document.querySelector('#complete-adjudication').disabled);check('Custom edits saved with fixed identity',t.puts===2&&t.state.merged.sources[0].frames[1].objects[0].region[0]===70&&t.state.merged.review.adjudication_log[1].resolution==='edited');
 await page.locator('#disagreement-filter').selectOption('pending');check('Pending filter handles empty queue',await page.locator('#no-matching-frames').isVisible());await page.locator('#disagreement-filter').selectOption('all');
 await page.locator('#disagreement-search').fill('000001');check('Search filters long frame identifiers',(await page.locator('#disagreement-frames .frame').count())===1);await page.locator('#disagreement-search').fill('');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'work/adjudicator/dark-mobile.png',fullPage:true});check('No mobile horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('#complete-adjudication').click();await page.locator('#confirm-complete').click();await page.waitForFunction(()=>document.querySelector('#adjudication-status').textContent.includes('Adjudication complete'));
 check('Completion freezes editing',t.completes===1&&await page.locator('#save-resolution').isDisabled()&&await page.getByLabel('Object 1 X',{exact:true}).isDisabled());
 check('Authenticated result download offered',await page.locator('#download-result').isVisible());
 await page.goto(base+'/internals/');check('Shared theme persists into Internals',await page.evaluate(()=>document.documentElement.dataset.theme==='dark'));
 await page.getByLabel('Appearance',{exact:true}).selectOption('light');check('Light mode selectable',await page.evaluate(()=>document.documentElement.dataset.theme==='light'));
 await page.getByLabel('Appearance',{exact:true}).selectOption('system');await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');check('System preference follows OS appearance',true);
 await page.screenshot({path:'work/adjudicator/internals-dark.png',fullPage:true});check('No browser runtime errors',t.errors.length===0);await t.context.close();
 const agree=await setup({agree:true,empty:true});await agree.page.waitForFunction(()=>document.querySelector('#left-canvas').width===640&&!document.querySelector('#save-resolution').disabled);
 check('Agreed empty frames remain inspectable',await agree.page.locator('#adjudication-frame').isVisible()&&(await agree.page.locator('#disagreement-frames .frame').count())===2&&await agree.page.locator('#complete-adjudication').isEnabled());
 await agree.page.locator('#disagreement-filter').selectOption('agreed');check('Agreement filter includes shared empty frames',(await agree.page.locator('#disagreement-frames .frame').count())===2);
 await agree.page.locator('#add-decision-object').click();await agree.page.getByLabel('Object 1 label',{exact:true}).selectOption('chair');await agree.page.locator('#save-resolution').click();await agree.page.waitForFunction(()=>document.querySelector('#decision-state').textContent==='Saved'&&!document.querySelector('#save-resolution').disabled);
 check('Agreed empty frame correction persists',agree.puts===1&&agree.state.merged.sources[0].frames[0].objects[0].label==='chair'&&agree.state.reviewer_a.sources[0].frames[0].objects.length===0&&agree.state.reviewer_b.sources[0].frames[0].objects.length===0);
 check('Optional agreement decisions do not inflate required progress',(await agree.page.locator('#adjudication-progress').innerText()).startsWith('0 of 0 disagreements resolved')&&await agree.page.locator('#complete-adjudication').isEnabled()&&await agree.page.locator('#next-unresolved').isDisabled());
 await agree.page.locator('#disagreement-filter').selectOption('pending');check('Agreed frames do not become required disagreements',await agree.page.locator('#no-matching-frames').isVisible());await agree.page.locator('#disagreement-filter').selectOption('all');await agree.page.locator('#next-frame').click();check('Navigation includes agreed frames',(await agree.page.locator('#adjudication-title').innerText())==='000002.jpg');check('Agreement audit has no runtime errors',agree.errors.length===0);await agree.context.close();
 const mixed=await setup({mixed:true});await mixed.page.locator('#next-unresolved').click();check('Next unresolved skips optional agreed frames',(await mixed.page.locator('#adjudication-title').innerText())==='000002.jpg');await mixed.page.locator('#previous-frame').click();check('Previous frame can inspect shared agreement',(await mixed.page.locator('#adjudication-title').innerText())==='000001-agreed.jpg');await mixed.page.locator('#add-decision-object').click();await mixed.page.locator('#save-resolution').click();await mixed.page.waitForFunction(()=>document.querySelector('#adjudication-title').textContent==='000002.jpg'&&!document.querySelector('#save-resolution').disabled);check('Saving optional agreement advances to a required disagreement',mixed.puts===1&&await mixed.page.locator('#complete-adjudication').isDisabled()&&(await mixed.page.locator('#adjudication-progress').innerText()).startsWith('0 of 2 disagreements resolved'));await mixed.context.close();
 const waiting=await setup({waiting:true});check('Incomplete reviews show waiting state',await waiting.page.getByText('Waiting for both reviewer passes',{exact:true}).isVisible()&&await waiting.page.locator('#complete-adjudication').isDisabled());waiting.ready();await waiting.page.locator('#refresh-adjudication').click();await waiting.page.waitForFunction(()=>document.querySelector('#left-canvas').width===640);check('Waiting assignment can refresh into work',await waiting.page.locator('#adjudication-frame').isVisible());await waiting.context.close();
 const reviewer=await setup({reviewer:true});await reviewer.page.waitForFunction(()=>document.querySelector('#review-canvas').width===640);await reviewer.page.getByLabel('Appearance',{exact:true}).selectOption('dark');check('Reviewer workspace still loads evidence',await reviewer.page.locator('#object-list').getByText(/person/).count()>0&&reviewer.errors.length===0);await reviewer.context.close();
 const blocked=await browser.newContext({colorScheme:'dark'});await blocked.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw Error('Storage disabled')}}));const blockedPage=await blocked.newPage();await blockedPage.goto(base+'/');await blockedPage.getByLabel('Appearance',{exact:true}).selectOption('light');check('Appearance works when storage is disabled',await blockedPage.evaluate(()=>document.documentElement.dataset.theme==='light'));await blocked.close();
 const extended=await setup({extended:true});await extended.page.getByLabel('Object 1 label',{exact:true}).selectOption('other');await extended.page.locator('#save-resolution').click();check('Other needs a descriptive name',(await extended.page.locator('#resolution-status').innerText()).includes('descriptive name')&&extended.puts===0);await extended.page.getByLabel('Description for object-one-person',{exact:true}).fill('desk lamp');await extended.page.getByLabel('Uncertain identification or boundary',{exact:true}).check();await extended.page.locator('#save-resolution').click();await extended.page.waitForFunction(()=>document.querySelector('#adjudication-title').textContent==='000002.jpg');check('Other name and uncertainty survive adjudication',extended.state.merged.sources[0].frames[0].objects[0].description==='desk lamp'&&extended.state.merged.sources[0].frames[0].objects[0].uncertain===true);check('Extended editor has no runtime errors',extended.errors.length===0);await extended.context.close();
 const extendedReview=await setup({reviewer:true,extended:true});await extendedReview.page.waitForFunction(()=>document.querySelector('#review-canvas').width===640);await extendedReview.page.locator('#object-label').selectOption('other');await extendedReview.page.locator('#draw-box').click();const box=await extendedReview.page.locator('#review-canvas').boundingBox();await extendedReview.page.mouse.move(box.x+box.width*.5,box.y+box.height*.2);await extendedReview.page.mouse.down();await extendedReview.page.mouse.move(box.x+box.width*.7,box.y+box.height*.5);await extendedReview.page.mouse.up();await extendedReview.page.locator('#object-list input[type="text"]').last().fill('portable light');await extendedReview.page.locator('#mark-reviewed').click();await extendedReview.page.waitForFunction(()=>document.querySelector('#review-frames .resolved'));check('Reviewer other annotation round trips',extendedReview.reviewerPayload.sources[0].frames[0].objects.some(object=>object.label==='other'&&object.description==='portable light'));check('Extended reviewer has no runtime errors',extendedReview.errors.length===0);await extendedReview.context.close();
 fs.writeFileSync('work/adjudicator/browser-results.json',JSON.stringify({status:'passed',checks},null,2));console.log(checks.length+' browser checks passed.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
