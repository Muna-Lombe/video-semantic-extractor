/** @type test @purpose Stress responsive layouts with populated tables, long resource identifiers, dialogs, and evidence across all workspaces. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = "work/ui-layout"; fs.mkdirSync(output, { recursive: true });
const assets = path.resolve("workers/control-plane/adjudication-web");
const server = http.createServer((req, res) => {
  let requested = new URL(req.url, "http://localhost").pathname;
  if (["/review/", "/adjudicate/"].includes(requested)) requested = "/index.html";
  const file = path.resolve(assets, "." + (requested.endsWith("/") ? requested + "index.html" : requested));
  if (!file.startsWith(assets + path.sep)) { res.writeHead(403).end(); return; }
  try { res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html"); res.end(fs.readFileSync(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ["--no-sandbox"] });
const long = "LongUnbrokenResourceName".repeat(5), digest = "a".repeat(64), date = "2026-10-15T12:00:00.000Z";
const sampleCatalog = JSON.parse(fs.readFileSync("scripts/fixtures/sample-library.v1.json", "utf8")), submittedDatasets = [];
const id = (prefix) => `${prefix}_${"a".repeat(64)}`;
const user = { id: id("user"), display_name: long, email: "long-assigned-operator-" + "a".repeat(100) + "@example.test", roles: ["owner", "review_coordinator", "release_approver"], status: "active", email_verified: true };
const dataset = { id: id("ds"), name: long, description: "Description".repeat(150), source_count: 2, status: "ready", latest_version: { id: id("dsv"), version: 12, status: "frozen" }, created_at: date };
const job = { id: id("job"), status: "failed", input: { dataset_version_id: id("dsv"), method: "hybrid", source_url: "https://media.example.test/" + "path".repeat(150) + ".mp4" }, attempt_count: 2, max_attempts: 2, lease_owner: id("runner"), created_at: date, updated_at: date, error_message: "FailureDetail".repeat(100), progress: { stage: "sampling", reference: long }, attempts: [{ attempt_number: 1, status: "failed", worker_id: id("runner"), started_at: date, error_message: "WorkerFailure".repeat(100) }] };
const frame = { id: id("frame"), dataset_source_id: id("src"), timestamp_seconds: 1.25, reasons: ["first", "near_final"], width: 640, height: 360, artifact: { id: id("artifact"), sha256: digest, size_bytes: 100 } };
const frameSet = { id: id("frameset"), dataset_version_id: id("dsv"), sampling_job_id: job.id, status: "ready", source_count: 1, frame_count: 1, sha256: digest, created_at: date, engine: { name: "video-semantic-extractor", version: "1.0.0@sha256:" + digest, configuration_sha256: digest }, sources: [{ dataset_source_id: id("src"), source_sha256: digest, ordinal: 0, duration_seconds: 120, size_bytes: 1000 }], frames: [frame] };
const policy = { id: id("pv"), name: long, version: "v".repeat(80), status: "active", revision: 0, annotation_schema_version: "object-annotations.v1", annotation_rules: {taxonomy_version:"coco-extended.v1"}, document: "Instruction".repeat(1000), sha256: digest, created_at: date };
const template = { id: id("tpl"), frame_set_id: frameSet.id, policy_version_id: policy.id, status: "ready", frame_count: 1, sha256: digest, schema_version: "object-annotations.v1" };
const assignments = ["reviewer-a", "reviewer-b", "adjudicator"].map((role) => ({ id: id("ca") + role, role, status: "pending", reviewed_frames: 0, revision: 0, assignee_email: user.email }));
const campaign = { id: id("campaign"), name: long, template_id: template.id, frame_set_id: frameSet.id, policy_version_id: policy.id, frame_count: 1, status: "active", assignments, audit_events: [], created_at: date };
const truth = { id: id("gt"), campaign_id: campaign.id, campaign_name: long, template_id: template.id, policy_version_id: policy.id, approval_status: "pending", status: "candidate", revision: 0, sha256: digest, validations: [], decisions: [], created_at: date };
const pipeline = { id: id("pipeline"), name: long, description: long.repeat(8), status: "active", progress: { status: "in_progress", completed_count: 2, total_count: 3, percentage: 66 }, updated_at: date, resources: [{ resource_type: "sampling_job", resource_id: job.id, label: long, status: "failed", lineage: { dataset_version_id: id("dsv") } }] };
const model = { id: id("mv"), name: long, version: "v".repeat(80), status: "candidate", revision: 0, history: [], provenance_json: JSON.stringify({ source: long.repeat(10) }), created_at: date };
const release = { id: id("release"), version: "v".repeat(80), status: "candidate", revision: 0, history: [], configuration_json: JSON.stringify({ source: long }), created_at: date };
const evaluation = { id: id("evaluation"), status: "succeeded", model_version_id: model.id, ground_truth_version_id: truth.id, configuration: { implementation_version: long }, created_at: date };
const runners = { available_count: 1, busy_count: 1, total_count: 2, heartbeat_ttl_seconds: 360, runners: [{ runner_id: id("runner"), status: "busy", current_job_id: job.id, last_seen_at: date }] };
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#264f43"/></svg>';
const annotationFrame = { filename: "FrameFilenameWithoutSpaces".repeat(8) + ".jpg", frame_id: frame.id, width: 640, height: 360, objects: Array.from({ length: 8 }, (_, i) => ({ id: "object-" + i, label: "traffic light", subset: "composited", region: [1, 2, 120.12345, 100.56789] })), out_of_taxonomy: ["VisibleConcept".repeat(70)] };
const annotations = { sources: [{ source: id("src"), frames: [annotationFrame] }], review: { reviewed_frames: [], adjudication_log: [] } };
const failures = [], cases = [], runtimeErrors = [];
async function contextFor(role = "internals") {
  const context = await browser.newContext(), page = await context.newPage();
  page.on("pageerror", (error) => { runtimeErrors.push(error.message); console.log("RUNTIME " + error.message); });
  await page.route("**/api/**", (route) => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname.replace("/api/internal/v1", "");
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (endpoint.endsWith("/preflight")) return json({ data: { readiness: { diagnostic_ready: false, effective_taxonomy: "coco-extended.v1", blockers: ["Register a diagnostic validation profile with the exact frame-set source SHA-256 digests."] }, draft_revision: 65, annotations: { counts: { coco_objects: 118, non_person_classes: 13, subsets: { live: 118, screen: 0, composited: 0 }, area_bands: { small: 35, large: 61 } }, errors: [] }, failed_gates: ["review_complete", "frozen_sources", "subset_minimums"] } });
    if (endpoint.endsWith("/readiness")) return json({ data: { diagnostic_ready: false, effective_taxonomy: "coco-80", blockers: ["Register a frozen diagnostic profile before review."], notice: "Configuration checks do not establish annotation accuracy." } });
    if (url.pathname === "/api/v1/me") return json({ assignment_id: "assignment", actor: { role }, links: { state: role === "adjudicator" ? "/api/v1/adjudications/assignment" : "/api/v1/assignments/assignment" } });
    if (url.pathname.includes("/frames/") || url.pathname.endsWith("/evidence")) return route.fulfill({ contentType: "image/svg+xml", body: image });
    if (url.pathname.startsWith("/api/v1/")) return json(role === "adjudicator" ? { assignment: { status: "in_progress" }, revision: 0, policy, reviewer_a: annotations, reviewer_b: annotations, merged: annotations, comparison: { disagreements: [{ source: annotations.sources[0].source, filename: annotationFrame.filename, type: "out_of_taxonomy" }] } } : { assignment: { status: "in_progress" }, revision: 0, policy, annotations, frame_count: 1 });
    if (endpoint === "/auth/status") return json({ data: { authentication: "email_link_session" } });
    if (endpoint === "/auth/me") return json({ data: user });
    if (endpoint === "/overview") return json({ engines: { sampler: long, evaluator: long } });
    if (endpoint === "/runners") return json({ data: runners });
    if (endpoint === "/operations") return json({ data: { jobs: [job], expired_leases: [], artifacts: [{ kind: long, size_bytes: 1000 }] } });
    if (endpoint === "/reference-benchmarks") return json({data:JSON.parse(fs.readFileSync("docs/verification/2026-10-18-reference-benchmarks.json","utf8"))});
    if (endpoint === "/operations/orphans") return json({ data: [{ key: "sampling/" + long.repeat(3) + ".jpg", size: 500, etag: digest }], pagination: { has_more: false, cursor: null } });
    if (endpoint === "/operations/retention") return json({data:{policy:{stale_days:30,grace_days:7},candidates:[{id:id("frameset"),resource_type:"frame_set",reclaimable_bytes:123456789}]}});
    if (endpoint === "/operations/retention/archives") return json({data:[{id:id("archive"),resource_id:id("frameset"),state:"scheduled",reason:long.repeat(8),delete_after:date,last_error:long.repeat(6)}]});
    if (endpoint === "/operations/retention/pins") return json({data:[{resource_type:"frame_set",resource_id:id("frameset"),reason:long.repeat(8)}]});
    if (endpoint === "/sample-library/select") { const value=request.postDataJSON(); const sources=sampleCatalog.sources.map(source=>({source,rank:createHash('sha256').update(JSON.stringify([sampleCatalog.version,value.seed,source.id])).digest('hex')})).sort((a,b)=>a.rank.localeCompare(b.rank)).slice(0,value.count).map(item=>item.source);return json({data:{catalog_version:sampleCatalog.version,seed:value.seed,source_ids:sources.map(source=>source.id),sources}}); }
    if (endpoint === "/datasets/probe") return json({data:request.postDataJSON().urls.map(url=>({url,status:200,media_type:"video/mp4",size_bytes:1000,reachable:true}))});
    if (endpoint === "/datasets" && request.method()==="POST") {submittedDatasets.push(request.postDataJSON());return json({data:dataset},201);}
    const resources = { datasets: dataset, "sampling-jobs": job, "frame-sets": frameSet, policies: policy, templates: template, "review-campaigns": campaign, "ground-truth": truth, pipelines: pipeline, models: model, releases: release, evaluations: evaluation, users: user, reviewers: user };
    const [collection, resourceId, action] = endpoint.replace(/^\//, "").split("/");
    if (resources[collection]) return json({ data: resourceId ? resources[collection] : [resources[collection], { ...resources[collection], id: resources[collection].id + "b" }], pagination: { has_more: false } });
    return json({ data: [] });
  });
  await page.goto(base + (role === "internals" ? "/internals/" : role === "adjudicator" ? "/adjudicate/#token=fixture" : "/review/#token=fixture"));
  if (role === "internals") { await page.locator("#workspace").waitFor({ state: "visible", timeout: 15000 }); await page.waitForSelector("#models-workspace table tbody tr", { state: "attached", timeout: 15000 }); }
  else await page.waitForFunction((id) => document.getElementById(id).width === 640, role === "adjudicator" ? "left-canvas" : "review-canvas");
  return { context, page };
}
async function audit(page, name) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const issues = await page.evaluate(() => {
    const problems = [], viewport = document.documentElement.clientWidth;
    const shown = (el) => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
    if (document.documentElement.scrollWidth > viewport + 2) problems.push(`viewport: ${document.documentElement.scrollWidth} > ${viewport}`);
    for (const el of document.querySelectorAll(".panel,.topbar,.table-toolbar,.detail-shell,.detail-section,.workspace,.review-layout,.review-canvas-column,.review-details,.canvas-toolbar,.comparison-panel,.frame-heading,.frame-navigation,.completion-controls,.decision-actions,dialog[open]")) {
      if (!shown(el)) continue;
      if (el.scrollWidth > el.clientWidth + 2 && !["auto", "scroll"].includes(getComputedStyle(el).overflowX)) problems.push(`${el.id || el.className}: content ${el.scrollWidth} > box ${el.clientWidth}`);
    }
    for (const dialog of document.querySelectorAll("dialog[open]")) {
      const bounds = dialog.getBoundingClientRect();
      if (bounds.top < -2 || bounds.bottom > innerHeight + 2) problems.push("dialog exceeds viewport height");
      if (dialog.scrollHeight > dialog.clientHeight + 2 && !["auto", "scroll"].includes(getComputedStyle(dialog).overflowY)) problems.push("dialog content is vertically clipped");
    }
    for (const table of document.querySelectorAll("table")) {
      if (!shown(table)) continue;
      let ancestor = table.parentElement, contained = false;
      while (ancestor && ancestor !== document.body) {
        if (["auto", "scroll"].includes(getComputedStyle(ancestor).overflowX)) { contained = true; break; }
        if (getComputedStyle(ancestor).overflowX === "hidden" && ancestor.scrollWidth > ancestor.clientWidth + 2) { problems.push("clipped table: " + (ancestor.id || ancestor.className)); break; }
        ancestor = ancestor.parentElement;
      }
      if (table.getBoundingClientRect().right > viewport + 2 && !contained) problems.push("uncontained table");
    }
    for (const region of document.querySelectorAll(".table-scroll")) {
      if (!shown(region) || region.scrollWidth <= region.clientWidth + 2) continue;
      if (region.tabIndex !== 0 || region.getAttribute("role") !== "region" || !region.getAttribute("aria-label")) problems.push("table scroll region is not keyboard accessible");
      const before = region.scrollLeft; region.scrollLeft = region.scrollWidth;
      const last = region.querySelector("tr > :last-child");
      if (region.scrollLeft <= 0 || last.getBoundingClientRect().right > region.getBoundingClientRect().right + 2) problems.push("last table column is unreachable");
      region.scrollLeft = before;
    }
    for (const actions of document.querySelectorAll(".frame-actions,.decision-actions")) {
      const previous = actions.previousElementSibling;
      if (shown(actions) && previous && actions.getBoundingClientRect().top < previous.getBoundingClientRect().bottom - 2) problems.push("save actions overlap the editor");
    }
    for (const cell of document.querySelectorAll(".table-scroll th")) if (shown(cell) && cell.colSpan === 1 && cell.getBoundingClientRect().width < 96) problems.push("table column is too narrow to read");
    for (const el of document.querySelectorAll("input,select,textarea,button,canvas")) {
      if (!shown(el) || el.closest(".sidebar") || el.closest(".table-scroll")) continue;
      const box = el.getBoundingClientRect();
      if (box.right > viewport + 2 || box.left < -2) problems.push(`control outside viewport: ${el.id || el.tagName}`);
    }
    return [...new Set(problems)];
  });
  if (["internals/datasets/320/light", "internals/overview/768/dark", "reviewer-a/768/light", "adjudicator/390/dark", "internals/dialog-campaign-dialog/320/light"].includes(name)) await page.screenshot({ path: `${output}/${name.replaceAll("/", "-")}.png`, fullPage: true });
  cases.push(name); if (issues.length) { failures.push({ name, issues }); console.log("FAIL " + name + " " + issues.slice(0, 5).join("; ")); }
}
try {
  const internals = await contextFor();
  await internals.page.locator('#campaign-create-dialog').evaluate(dialog=>dialog.showModal());
  await internals.page.waitForFunction(()=>document.querySelector('#campaign-readiness').textContent.includes('Register a frozen diagnostic profile'));
  assert.equal(await internals.page.locator('#campaign-form [type="submit"]').isDisabled(),true);
  await internals.page.locator('#campaign-purpose').selectOption('annotation');
  await internals.page.waitForFunction(()=>!document.querySelector('#campaign-form [type="submit"]').disabled);
  await internals.page.locator('#campaign-purpose').selectOption('diagnostic');
  await internals.page.waitForFunction(()=>document.querySelector('#campaign-form [type="submit"]').disabled);
  await internals.page.locator('#campaign-create-dialog').evaluate(dialog=>dialog.close());
  await internals.page.locator('#dataset-dialog').evaluate(dialog=>dialog.showModal());
  assert.equal(await internals.page.locator('#sample-count').getAttribute('max'),String(sampleCatalog.sources.length));
  await internals.page.locator('#sample-count').fill(String(sampleCatalog.sources.length));await internals.page.locator('#sample-seed').fill('reproducible-seed');await internals.page.locator('#sample-reproduce').click();await internals.page.waitForFunction(count=>document.querySelector('#dataset-sources').value.split('\n').length===count,sampleCatalog.sources.length);
  assert.equal(await internals.page.locator('#sample-selection-preview p').count(),sampleCatalog.sources.length);
  assert.match(await internals.page.locator('#sample-selection-preview').textContent(),/Verify photographic eligibility/);
  const originalSelection=await internals.page.locator('#dataset-sources').inputValue();await internals.page.locator('#sample-reproduce').click();await internals.page.waitForFunction(()=>!document.querySelector('#sample-reproduce').disabled);assert.equal(await internals.page.locator('#dataset-sources').inputValue(),originalSelection);
  await internals.page.locator('#dataset-probe').click();await internals.page.getByText(/HTTP 200, video\/mp4/).first().waitFor();
  await internals.page.locator('#dataset-name').fill('Reproduced sample selection');await internals.page.locator('#dataset-form [type="submit"]').click();await internals.page.locator('#dataset-dialog').waitFor({state:'hidden'});assert.equal(submittedDatasets.at(-1).selection.seed,'reproducible-seed');assert.equal(submittedDatasets.at(-1).sources.length,sampleCatalog.sources.length);
  await internals.page.locator('#dataset-dialog').evaluate(dialog=>dialog.showModal());await internals.page.locator('#sample-randomise').click();await internals.page.waitForFunction(()=>!document.querySelector('#sample-randomise').disabled);await internals.page.locator('#dataset-sources').fill('https://media.example/fresh.mp4');await internals.page.locator('#dataset-name').fill('Fresh links');await internals.page.locator('#dataset-form [type="submit"]').click();await internals.page.locator('#dataset-dialog').waitFor({state:'hidden'});assert.equal(submittedDatasets.at(-1).selection,undefined);assert.equal(submittedDatasets.at(-1).sources[0].url,'https://media.example/fresh.mp4');
  const pages = ["overview", "datasets", "pipelines", "sampling", "frame-sets", "policies", "templates", "reviews", "ground-truth", "models", "evaluations", "releases", "operations"];
  for (const theme of ["light", "dark"]) {
    await internals.page.getByLabel("Appearance", { exact: true }).selectOption(theme);
    for (const width of [320, 390, 520, 768, 1024, 1280, 1920]) {
      await internals.page.setViewportSize({ width, height: 800 });
      for (const name of pages) { await internals.page.evaluate((name) => { location.hash = name; }, name); await audit(internals.page, `internals/${name}/${width}/${theme}`); }
      for (const [pageName, selector, dialog] of [["datasets", "[data-dataset-inspect]", "registry-dialog"], ["sampling", "[data-job-inspect]", "job-dialog"], ["frame-sets", "[data-frame-set-id]", "frame-set-dialog"], ["policies", "[data-policy-inspect]", "registry-dialog"], ["templates", "[data-template-inspect]", "registry-dialog"], ["reviews", "[data-campaign-inspect]", "campaign-dialog"], ["ground-truth", "[data-ground-truth-inspect]", "ground-truth-dialog"], ["pipelines", "[data-pipeline-inspect]", "pipeline-detail-dialog"]]) {
        await internals.page.evaluate((name) => { location.hash = name; }, pageName);
        const button = internals.page.locator(`.page[data-page="${pageName}"] ${selector}`).first();
        if (!await button.count()) throw new Error("Missing fixture/action " + selector);
        await button.click(); await internals.page.waitForFunction((id) => document.getElementById(id).textContent.trim() && !document.getElementById(id).textContent.includes("Loading…"), dialog);
        if (dialog === "campaign-dialog") {
          await internals.page.locator("#campaign-preflight").getByText("Saved draft revision 65:", { exact: false }).waitFor();
          assert.match(await internals.page.locator("#campaign-preflight").textContent(), /Screen: 0 \/ 20/);
        }
        await audit(internals.page, `internals/dialog-${dialog}/${width}/${theme}`);
        await internals.page.locator(`#${dialog}`).evaluate((el) => el.close());
      }
      for (const dialog of ["dataset-dialog", "sampling-dialog", "policy-dialog", "template-dialog", "campaign-create-dialog", "pipeline-create-dialog", "ground-truth-decision-dialog", "invitations-dialog"]) {
        await internals.page.locator(`#${dialog}`).evaluate((el) => el.showModal());
        await audit(internals.page, `internals/form-${dialog}/${width}/${theme}`);
        await internals.page.locator(`#${dialog}`).evaluate((el) => el.close());
      }
      for (const name of ["models", "evaluations", "releases"]) {
        await internals.page.evaluate((name) => { location.hash = name; }, name);
        await internals.page.locator(`.page[data-page="${name}"] [data-governance-inspect]`).first().click();
        await internals.page.locator(`#${name}-inspection article`).waitFor({ state: "attached" });
        await audit(internals.page, `internals/inspection-${name}/${width}/${theme}`);
      }
      await internals.page.evaluate(() => { location.hash = "operations"; }); await internals.page.locator("[data-cleanup-preview]").click(); await audit(internals.page, `internals/cleanup/${width}/${theme}`);
    }
  }
  await internals.page.setViewportSize({width:1024,height:480});
  await internals.page.addStyleTag({content:":root {font-size:30px}"});
  for (const name of pages) { await internals.page.evaluate((name)=>{location.hash=name},name); await audit(internals.page, `internals/${name}/200-percent-text`); }
  await internals.page.setViewportSize({width:390,height:480});
  await internals.page.locator("#menu-toggle").click();
  const menu = await internals.page.locator(".sidebar").evaluate((el)=>({height:el.clientHeight,content:el.scrollHeight,overflow:getComputedStyle(el).overflowY}));
  assert.ok(menu.content <= menu.height + 2 || ["auto","scroll"].includes(menu.overflow), "Short-screen navigation must remain scrollable");
  cases.push("internals/short-screen-navigation");
  await internals.page.evaluate(() => document.body.classList.remove("menu-open"));
  await internals.page.setViewportSize({width:390,height:360});
  for (const dialog of ["dataset-dialog","sampling-dialog","policy-dialog","template-dialog","campaign-create-dialog","pipeline-create-dialog","ground-truth-decision-dialog","invitations-dialog","job-dialog","frame-set-dialog","registry-dialog","campaign-dialog","ground-truth-dialog","pipeline-detail-dialog"]) {
    await internals.page.locator(`#${dialog}`).evaluate(el=>el.showModal());
    await audit(internals.page,`internals/short-screen-${dialog}`);
    await internals.page.locator(`#${dialog}`).evaluate(el=>el.close());
  }
  await internals.page.evaluate(()=>{location.hash="datasets"});
  const scrollRegion=internals.page.locator('[data-page="datasets"] .table-scroll').first();
  await scrollRegion.waitFor({state:"visible"});
  await scrollRegion.evaluate(el=>{el.scrollLeft=0}); await scrollRegion.focus(); await internals.page.keyboard.press("ArrowRight");
  await internals.page.waitForFunction(()=>document.querySelector('[data-page="datasets"] .table-scroll').scrollLeft>0,{},{timeout:3000});
  cases.push("internals/keyboard-table-scrolling");
  await internals.context.close();
  for (const role of ["reviewer-a", "adjudicator"]) {
    const assignment = await contextFor(role);
    for (const theme of ["light", "dark"]) {
      await assignment.page.getByLabel("Appearance", { exact: true }).selectOption(theme);
      for (const width of [320, 390, 520, 768, 1024, 1280, 1920]) {
        await assignment.page.setViewportSize({ width, height: 800 }); await audit(assignment.page, `${role}/${width}/${theme}`);
      }
    }
    await assignment.page.setViewportSize({width:1024,height:480});
    await assignment.page.addStyleTag({content:":root {font-size:30px}"});
    await audit(assignment.page, `${role}/200-percent-text`);
    if(role==="adjudicator") {
      await assignment.page.locator("#complete-dialog").evaluate(el=>el.showModal());
      await audit(assignment.page,"adjudicator/completion-dialog/200-percent-text");
    }
    await assignment.context.close();
  }
  const result = { cases: cases.length, failures, runtimeErrors }; fs.writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log(`${cases.length} layout cases, ${failures.length} failing cases, ${runtimeErrors.length} runtime errors`);
  if (!process.env.LAYOUT_AUDIT_ONLY) { assert.equal(failures.length, 0, "Responsive layout failures"); assert.deepEqual(runtimeErrors, [], "Browser runtime errors"); }
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
