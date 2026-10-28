import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";
import { D1Repository } from "../src/repository.ts";
import { configuredEnv, configuredSettings, preparedPost, testJpeg } from "./helpers.ts";
import { sqliteD1 } from "./d1.ts";
import type { BotJob, Env } from "../src/types.ts";

type Job = BotJob;
const base = "https://bot.example.com";
function fixture(t: { after: (fn: () => void) => void }) {
  const storage = sqliteD1(); t.after(storage.close);
  const sent: Job[] = [];
  const env = { ...configuredEnv(), DB: storage.db, JOBS: { send: async (body: Job) => { sent.push(body); } } } as unknown as Env;
  const repo = new D1Repository(storage.db);
  const request = (path: string, method = "GET", value?: unknown, extra: Record<string, string> = {}) => new Request(`${base}${path}`, { method, headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, ...(method !== "GET" && method !== "HEAD" ? { "Content-Type": "application/json" } : {}), ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { ...storage, sent, env, repo, request };
}

async function consume(job: Job, env: Env) {
  let acknowledgments = 0;
  await worker.queue({ messages: [{ body: job, ack() { acknowledgments++; } }] } as never, env);
  return acknowledgments;
}

test("public landing is available but state and previews require authentication", async t => {
  const f = fixture(t);
  const landing = await worker.fetch(new Request(base), f.env);
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(landing.headers.get("content-security-policy")!, /frame-ancestors 'self'/);
  for (const path of ["/api/state", `/preview/${crypto.randomUUID()}`]) assert.equal((await worker.fetch(new Request(`${base}${path}`), f.env)).status, 401);
});

test("login issues a protected cookie; invalid tokens, cross-origin requests and wrong content types are rejected", async t => {
  const f = fixture(t);
  const login = await worker.fetch(f.request("/api/login", "POST", { token: f.env.ADMIN_TOKEN }), f.env);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Secure/);
  const state = await worker.fetch(new Request(`${base}/api/state`, { headers: { Cookie: cookie } }), f.env);
  assert.equal(state.status, 200);
  const text = await state.text();
  assert.doesNotMatch(text, /test-gemini-key|test-buffer-key|test-cf-key|test-admin-token/);
  assert.equal((await worker.fetch(f.request("/api/login", "POST", { token: "wrong" }), f.env)).status, 401);
  assert.equal((await worker.fetch(f.request("/api/run", "POST", { demo: true }, { Origin: "https://attacker.example.com" }), f.env)).status, 403);
  assert.equal((await worker.fetch(f.request("/api/run", "POST", { demo: true }, { "Content-Type": "text/plain" }), f.env)).status, 415);
});

test("run endpoint dispatches to Queue; processing demo persists a post without any external calls", async t => {
  const f = fixture(t); await f.repo.saveSettings(configuredSettings());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call"); });
  const response = await worker.fetch(f.request("/api/run", "POST", { demo: true }), f.env);
  assert.equal(response.status, 202);
  assert.deepEqual(f.sent, [{ type: "run", demo: true }]);
  assert.equal(await consume(f.sent[0], f.env), 1);
  const posts = await f.repo.listPosts();
  assert.equal(posts.length, 1); assert.equal(posts[0].demo, true);
  assert.equal(calls, 0); assert.equal(await f.repo.busy(), false);
});

test("real run without Gemini and concurrent jobs are rejected before dispatch", async t => {
  const f = fixture(t);
  assert.equal((await worker.fetch(f.request("/api/run", "POST", { demo: false }), { ...f.env, GEMINI_API_KEY: undefined })).status, 400);
  assert.equal(f.sent.length, 0);
  await f.repo.acquireLock("pipeline", 900);
  assert.equal((await worker.fetch(f.request("/api/run", "POST", { demo: true }), f.env)).status, 409);
  assert.equal(f.sent.length, 0);
});

test("editing draft title invalidates the saved PNG and rejection persists", async t => {
  const f = fixture(t); const post = preparedPost(); post.id = crypto.randomUUID(); post.status = "draft";
  await f.repo.savePost(post);
  const patch = await worker.fetch(f.request(`/api/posts/${post.id}`, "PATCH", { title: "Novo título" }), f.env);
  assert.equal(patch.status, 200);
  const updated = (await f.repo.getPost(post.id))!;
  assert.equal(updated.content.title, "Novo título"); assert.equal(updated.imageReady, false);
  const rejection = await worker.fetch(f.request(`/api/posts/${post.id}/reject`, "POST"), f.env);
  assert.equal(rejection.status, 200);
  assert.equal((await f.repo.getPost(post.id))!.status, "rejected");
});

test("queued and published posts cannot be edited, rejected or dispatched again", async t => {
  const f = fixture(t);
  for (const status of ["queued", "published"] as const) {
    const post = preparedPost(); post.id = crypto.randomUUID(); post.status = status;
    post.deliveries = [{ channelId: "instagram-1", channelName: "Instagram", remoteId: "accepted", status }];
    await f.repo.savePost(post);
    assert.equal((await worker.fetch(f.request(`/api/posts/${post.id}`, "PATCH", { caption: "Changed" }), f.env)).status, 400);
    assert.equal((await worker.fetch(f.request(`/api/posts/${post.id}/reject`, "POST"), f.env)).status, 400);
    assert.equal((await worker.fetch(f.request(`/api/posts/${post.id}/approve`, "POST"), f.env)).status, 400);
  }
  assert.equal(f.sent.length, 0);
});

test("duplicate approval queue messages never create a second Buffer post", async t => {
  const f = fixture(t); await f.repo.saveSettings(configuredSettings());
  const post = preparedPost(); post.id = crypto.randomUUID(); post.status = "draft";
  await f.repo.savePost(post);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    calls++; assert.match(JSON.parse(String(options.body)).query, /mutation BotCreatePost/);
    return Response.json({ data: { createPost: { post: { id: "only-one" } } } });
  });
  assert.equal(await consume({ type: "approve", postId: post.id }, f.env), 1);
  assert.equal(await consume({ type: "approve", postId: post.id }, f.env), 1);
  assert.equal(calls, 1);
  const saved = (await f.repo.getPost(post.id))!;
  assert.equal(saved.status, "queued"); assert.equal(saved.deliveries[0].remoteId, "only-one");
  assert.equal(await f.repo.busy(), false);
});

test("rejected approval jobs are safe and never call external services", async t => {
  const f = fixture(t); const post = preparedPost(); post.id = crypto.randomUUID(); post.status = "rejected";
  await f.repo.savePost(post);
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call"); });
  await consume({ type: "approve", postId: post.id }, f.env);
  assert.equal(calls, 0); assert.equal((await f.repo.getPost(post.id))!.status, "rejected");
  assert.equal((await f.repo.listRuns())[0].status, "error"); assert.equal(await f.repo.busy(), false);
});

test("public PNG media round-trips D1 BLOBs and HEAD returns metadata without body", async t => {
  const f = fixture(t); const id = crypto.randomUUID();
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await f.repo.saveImage(id, image.buffer);
  const imageResponse = await worker.fetch(new Request(`${base}/media/${id}.png`), f.env);
  assert.equal(imageResponse.status, 200); assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await imageResponse.arrayBuffer()), image);
  const head = await worker.fetch(new Request(`${base}/media/${id}.png`, { method: "HEAD" }), f.env);
  assert.equal(head.headers.get("content-length"), "8"); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await worker.fetch(new Request(`${base}/media/${crypto.randomUUID()}.png`), f.env)).status, 404);
});

test("D1 lock ownership prevents an expired worker from unlocking a newer owner", async t => {
  const f = fixture(t); const first = f.repo; const second = new D1Repository(f.db);
  assert.equal(await first.acquireLock("pipeline", 900), true);
  assert.equal(await second.acquireLock("pipeline", 900), false);
  f.sqlite.exec("UPDATE locks SET expires_at=0");
  assert.equal(await second.acquireLock("pipeline", 900), true);
  await first.releaseLock("pipeline"); assert.equal(await second.busy(), true);
  await second.releaseLock("pipeline"); assert.equal(await first.busy(), false);
});

test("D1 daily count honors São Paulo midnight and excludes demos and rejected posts", async t => {
  const f = fixture(t);
  for (const [createdAt, status, demo] of [
    ["2026-10-22T02:59:59Z", "queued", false], ["2026-10-22T03:00:00Z", "queued", false],
    ["2026-10-23T02:59:59Z", "published", false], ["2026-10-23T03:00:00Z", "queued", false],
    ["2026-10-22T12:00:00Z", "ready", true], ["2026-10-22T12:00:00Z", "rejected", false],
  ] as const) {
    const post = preparedPost(); post.id = crypto.randomUUID(); post.createdAt = new Date(createdAt).toISOString(); post.status = status; post.demo = demo;
    await f.repo.savePost(post);
  }
  assert.equal(await f.repo.countPostsOnDate("2026-10-22", "America/Sao_Paulo"), 2);
});

test("rejected and ambiguous posts are refused before adding approval jobs", async t => {
  const f = fixture(t);
  const rejected = preparedPost(); rejected.id = crypto.randomUUID(); rejected.status = "rejected";
  await f.repo.savePost(rejected);
  assert.equal((await worker.fetch(f.request(`/api/posts/${rejected.id}/approve`, "POST"), f.env)).status, 409);
  for (const status of ["unknown", "sending"] as const) {
    const post = preparedPost(); post.id = crypto.randomUUID(); post.status = "needs_attention";
    post.deliveries = [{ channelId: "instagram-1", channelName: "Instagram", status }];
    await f.repo.savePost(post);
    assert.equal((await worker.fetch(f.request(`/api/posts/${post.id}/approve`, "POST"), f.env)).status, 409);
  }
  assert.equal(f.sent.length, 0);
});

test("approval image-render failure marks the post needs_attention and releases the lock", async t => {
  const f = fixture(t); await f.repo.saveSettings(configuredSettings());
  const post = preparedPost(); post.id = crypto.randomUUID(); post.status = "draft"; post.imageReady = false;
  await f.repo.savePost(post);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls++; assert.match(String(url), /api.cloudflare.com/);
    return new Response("private upstream diagnostics", { status: 503 });
  });
  await consume({ type: "approve", postId: post.id }, f.env);
  const saved = (await f.repo.getPost(post.id))!;
  assert.equal(calls, 1);
  assert.equal(saved.status, "needs_attention");
  assert.match(saved.error!, /HTTP 503/);
  assert.doesNotMatch(saved.error!, /private upstream/);
  assert.equal((await f.repo.listRuns())[0].status, "error");
  assert.equal(await f.repo.busy(), false);
});

test("image-only job persists JPEG, authenticates preview and never publishes; duplicate delivery reuses image", async t => {
  const f=fixture(t);const post=preparedPost();post.id=crypto.randomUUID();post.imageReady=false;await f.repo.savePost(post);
  let generated=0,network=0;
  f.env.AI={run:async()=>{generated++;return {image:Buffer.from(testJpeg()).toString('base64')};}};
  t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('No network mutation expected');});
  const r=await worker.fetch(f.request(`/api/posts/${post.id}/visual`,'POST'),f.env);
  assert.equal(r.status,202);assert.deepEqual(f.sent,[{type:'visual',postId:post.id}]);
  await consume(f.sent[0],f.env);await consume(f.sent[0],f.env);
  assert.equal(generated,1);assert.equal(network,0);
  const saved=(await f.repo.getPost(post.id))!;
  assert.equal(saved.visual?.status,'ready');assert.equal(saved.imageReady,false);assert.deepEqual(saved.deliveries,[]);
  const preview=await worker.fetch(f.request(`/preview/${post.id}`),f.env);
  assert.match(await preview.text(),/data:image\/jpeg;base64,/);
  const state=await(await worker.fetch(f.request('/api/state'),f.env)).json() as {readiness:{illustration:boolean};posts:unknown[]};
  assert.equal(state.readiness.illustration,true);assert.doesNotMatch(JSON.stringify(state.posts),/data:image|\/9j\//);
  assert.equal((await worker.fetch(f.request(`/api/posts/${post.id}/visual`,'POST'),f.env)).status,409);
  assert.equal((await worker.fetch(new Request(`${base}/preview/${post.id}`),f.env)).status,401);
});

test("image-only generation refuses demo, rejected, accepted and unconfigured posts",async t=>{
  const f=fixture(t);
  for(const variant of ['demo','rejected','queued','missing-binding']){
    const p=preparedPost();p.id=crypto.randomUUID();p.demo=variant==='demo';
    if(variant==='rejected')p.status='rejected';
    if(variant==='queued'){p.status='queued';p.deliveries=[{channelId:'one',channelName:'one',status:'queued'}];}
    await f.repo.savePost(p);
    const r=await worker.fetch(f.request(`/api/posts/${p.id}/visual`,'POST'),f.env);
    assert.ok(r.status>=400);
  }
  assert.equal(f.sent.length,0);
});

test("PNG-only jobs use native Browser binding, reuse cached output and never call AI or publishing",async t=>{
  const f=fixture(t);const post=preparedPost();post.id=crypto.randomUUID();post.imageReady=false;await f.repo.savePost(post);
  let renderCalls=0,otherCalls=0;
  const env={...f.env,CF_ACCOUNT_ID:undefined,CF_BROWSER_API_TOKEN:undefined,BROWSER:{quickAction:async(action:string,options:unknown)=>{renderCalls++;assert.equal(action,'screenshot');assert.ok((options as {html:string}).html.includes(post.content.title.split(' ')[0]));return new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{'Content-Type':'image/png'}});}},AI:{run:async()=>{otherCalls++;throw Error('No new FLUX generation');}}} as Env;
  t.mock.method(globalThis,'fetch',async()=>{otherCalls++;throw Error('No external publication or LLM call');});
  const res=await worker.fetch(f.request(`/api/posts/${post.id}/render`,'POST'),env);assert.equal(res.status,202);
  assert.deepEqual(f.sent,[{type:'render',postId:post.id}]);await consume(f.sent[0],env);await consume(f.sent[0],env);
  const saved=(await f.repo.getPost(post.id))!;
  assert.equal(renderCalls,1);assert.equal(otherCalls,0);assert.equal(saved.imageReady,true);assert.equal(saved.status,post.status);assert.deepEqual(saved.deliveries,[]);
  const media=await worker.fetch(new Request(base+`/media/${post.id}.png`),env);assert.equal(media.status,200);
  const state=await(await worker.fetch(f.request('/api/state'),env)).json() as {readiness:{artwork:boolean};publicationMissing:string[]};
  assert.equal(state.readiness.artwork,true);assert.ok(!state.publicationMissing.includes('renderização PNG na Cloudflare'));
});

test("PNG preparation failure restores draft and releases lock without publishing",async t=>{
  const f=fixture(t);const p=preparedPost();p.id=crypto.randomUUID();p.status='draft';p.imageReady=false;await f.repo.savePost(p);
  f.env.BROWSER={quickAction:async()=>{throw Error('PRIVATE PROVIDER DETAILS');}} as Env['BROWSER'];
  await consume({type:'render',postId:p.id},f.env);
  const saved=(await f.repo.getPost(p.id))!;assert.equal(saved.status,'draft');assert.equal(saved.imageReady,false);assert.deepEqual(saved.deliveries,[]);
  assert.doesNotMatch(saved.error!,/PRIVATE/);assert.equal(await f.repo.busy(),false);
  assert.equal((await f.repo.listRuns())[0].status,'error');
});

test("PNG preparation refuses demo, rejected, accepted and unavailable renderer",async t=>{
  const f=fixture(t);
  for(const variant of ['demo','rejected','queued','missing']){
    const p=preparedPost();p.id=crypto.randomUUID();p.demo=variant==='demo';
    if(variant==='rejected')p.status='rejected';
    if(variant==='queued'){p.status='queued';p.deliveries=[{channelId:'one',channelName:'one',status:'queued'}];}
    await f.repo.savePost(p);
    const res=await worker.fetch(f.request(`/api/posts/${p.id}/render`,'POST'),{...f.env,CF_BROWSER_API_TOKEN:undefined});assert.ok(res.status>=400);
  }
  assert.equal(f.sent.length,0);
});

test("test batch queues exactly three future jobs once without changing the weekly routine",async t=>{
 const f=fixture(t);const original=configuredSettings();await f.repo.saveSettings(original);
 f.env.JOBS.sendBatch=async messages=>{for(const m of messages)f.sent.push(m.body);};
 const times=[5,15,25].map(m=>new Date(Date.now()+m*60000).toISOString());
 const input={id:crypto.randomUUID(),channelId:'instagram-1',scheduledAt:times};
 const first=await worker.fetch(f.request('/api/test-batch','POST',input),f.env);assert.equal(first.status,202);assert.equal(f.sent.length,3);
 assert.deepEqual(f.sent.map(j=>'scheduledAt' in j?j.scheduledAt:undefined),times);
 assert.ok(f.sent.every(j=>j.type==='run'&&j.testBatchId===input.id&&j.testChannelId==='instagram-1'));
 const second=await worker.fetch(f.request('/api/test-batch','POST',input),f.env);assert.equal(second.status,200);assert.equal(f.sent.length,3);
 assert.deepEqual(await f.repo.getSettings(),original);assert.equal((await f.repo.listPosts()).length,0);
});

test("test batch rejects expired, too-distant, duplicate, missing channels and disabled automation",async t=>{
 const f=fixture(t);await f.repo.saveSettings(configuredSettings());
 const times=[5,15,25].map(m=>new Date(Date.now()+m*60000).toISOString());
 const baseInput={id:crypto.randomUUID(),channelId:'instagram-1',scheduledAt:times};
 for(const input of [{...baseInput,scheduledAt:times.slice(0,2)},{...baseInput,scheduledAt:[times[0],times[0],times[2]]},{...baseInput,scheduledAt:[new Date(Date.now()-1000).toISOString(),times[1],times[2]]},{...baseInput,scheduledAt:[times[0],times[1],new Date(Date.now()+3600000).toISOString()]},{...baseInput,channelId:'other'}]){
  assert.ok((await worker.fetch(f.request('/api/test-batch','POST',input),f.env)).status>=400);
 }
 assert.equal((await worker.fetch(f.request('/api/test-batch','POST',baseInput),{...f.env,DEMO_MODE:'true'})).status,409);
 assert.equal(f.sent.length,0);
});

test("authored campaign imports are authenticated drafts, idempotent and never enqueue AI or publishing", async t => {
  const f = fixture(t);
  const first = preparedPost(); first.id = crypto.randomUUID();
  first.content.artTitle = "Seu site, seu próximo passo";
  const payload = {drafts:[{id:first.id, content:first.content}]};
  const unauthorized = await worker.fetch(new Request(base+"/api/drafts/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}),f.env);
  assert.equal(unauthorized.status,401);
  let calls = 0; t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("No upstream calls");});
  const response = await worker.fetch(f.request("/api/drafts/import","POST",payload),f.env);
  assert.equal(response.status,201);
  assert.equal((await f.repo.getPost(first.id))!.status,"draft");
  assert.deepEqual((await f.repo.getPost(first.id))!.deliveries,[]);
  const edited = (await f.repo.getPost(first.id))!; edited.content.caption="Legenda editada pelo autor."; await f.repo.savePost(edited);
  const repeated = await (await worker.fetch(f.request("/api/drafts/import","POST",payload),f.env)).json() as {created:string[];existing:string[]};
  assert.deepEqual(repeated.created,[]); assert.deepEqual(repeated.existing,[first.id]);
  assert.equal((await f.repo.getPost(first.id))!.content.caption,"Legenda editada pelo autor.");
  assert.equal(calls,0); assert.deepEqual(f.sent,[]); assert.equal(await f.repo.busy(),false);
});

test("invalid authored campaigns are rejected before persisting any posts", async t => {
  const f = fixture(t); const content = {...preparedPost().content,artTitle:"Seu próximo passo"};
  const valid = {id:crypto.randomUUID(),content};
  for (const drafts of [[],[valid,valid],[valid,{id:crypto.randomUUID(),content:{...content,sourceUrl:"http://localhost"}}],[{id:crypto.randomUUID(),content:{...content,caption:"<script>alert(1)</script>"}}],Array.from({length:22},()=>({id:crypto.randomUUID(),content}))]) {
    assert.equal((await worker.fetch(f.request("/api/drafts/import","POST",{drafts}),f.env)).status,400);
    assert.equal((await f.repo.listPosts()).length,0);
  }
  await f.repo.acquireLock("pipeline",900);
  assert.equal((await worker.fetch(f.request("/api/drafts/import","POST",{drafts:[valid]}),f.env)).status,409);
  assert.equal((await f.repo.listPosts()).length,0); assert.deepEqual(f.sent,[]);
});

test("authored campaign drafts do not consume the RSS and AI daily generation allowance", async t => {
  const f = fixture(t); const authored = preparedPost(); authored.id=crypto.randomUUID();
  authored.content.origin="authored"; authored.status="draft"; authored.createdAt="2026-10-27T12:00:00.000Z";
  await f.repo.savePost(authored);
  assert.equal(await f.repo.countPostsOnDate("2026-10-27","America/Sao_Paulo"),0);
  const generated=preparedPost(); generated.id=crypto.randomUUID(); generated.createdAt=authored.createdAt;
  await f.repo.savePost(generated);
  assert.equal(await f.repo.countPostsOnDate("2026-10-27","America/Sao_Paulo"),1);
});
