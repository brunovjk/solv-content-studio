import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";
import { D1Repository } from "../src/repository.ts";
import { configuredEnv, configuredSettings, preparedPost, feedResponse, geminiResponse, testJpeg } from "./helpers.ts";
import { sqliteD1 } from "./d1.ts";
import type { BotJob, Env, Settings } from "../src/types.ts";

const base = "https://api.example.com";
const studio = "https://solv-studio-test.web.app";
const editorToken = "test-editor-token-with-enough-length";
const png = () => new Uint8Array([137,80,78,71,13,10,26,10]);

function fixture(t: {after:(callback:()=>void)=>void}) {
  const storage=sqliteD1(); t.after(storage.close);
  const sent: BotJob[]=[];
  const env={...configuredEnv(),EDITOR_TOKEN:editorToken,ALLOWED_ORIGINS:studio+",https://solv-studio-test.firebaseapp.com",DB:storage.db,JOBS:{send:async(job:BotJob)=>{sent.push(job);}}} as unknown as Env;
  const repo=new D1Repository(storage.db);
  const request=(path:string,method="GET",value?:unknown,role:"owner"|"editor"="editor",headers:Record<string,string>={})=>new Request(base+path,{method,headers:{Authorization:"Bearer "+(role==="owner"?env.ADMIN_TOKEN:editorToken),...(method==="GET"||method==="HEAD"?{}:{"Content-Type":"application/json"}),...headers},...(value===undefined?{}:{body:JSON.stringify(value)})});
  return {...storage,sent,env,repo,request};
}

test("trusted Firebase origins can preflight authenticated API requests without exposing wildcard or credential access",async t=>{
  // Given a separately hosted frontend, only its exact HTTPS origins should read API responses.
  const f=fixture(t);
  const response=await worker.fetch(new Request(base+"/api/state",{method:"OPTIONS",headers:{Origin:studio,"Access-Control-Request-Method":"GET","Access-Control-Request-Headers":"authorization"}}),f.env);
  // When the browser preflights before login, no credential is needed for the preflight itself.
  assert.equal(response.status,204);
  assert.equal(response.headers.get("access-control-allow-origin"),studio);
  assert.match(response.headers.get("access-control-allow-headers")||"",/authorization/i);
  assert.match(response.headers.get("vary")||"",/origin/i);
  assert.notEqual(response.headers.get("access-control-allow-credentials"),"true");
  // Then lookalike domains and unencrypted versions are not silently allowed.
  for(const origin of ["https://attacker.example.com",studio+".attacker.example.com",studio.replace("https:","http:")]) {
    const denied=await worker.fetch(new Request(base+"/api/state",{method:"OPTIONS",headers:{Origin:origin,"Access-Control-Request-Method":"GET"}}),f.env);
    assert.equal(denied.status,403);
    assert.equal(denied.headers.get("access-control-allow-origin"),null);
  }
});

test("Firebase login returns a short-lived role session rather than requiring the browser to retain a master credential",async t=>{
  const f=fixture(t);
  // Given either a valid owner or editor login from the trusted frontend.
  for(const role of ["owner","editor"] as const) {
    const credential=role==="owner"?f.env.ADMIN_TOKEN:editorToken;
    const response=await worker.fetch(new Request(base+"/api/login",{method:"POST",headers:{Origin:studio,"Content-Type":"application/json"},body:JSON.stringify({token:credential})}),f.env);
    assert.equal(response.status,200);
    const login=await response.json() as {role:string;sessionToken:string};
    assert.equal(login.role,role); assert.ok(login.sessionToken);
    assert.notEqual(login.sessionToken,credential);
    // When the client uses the returned session, it keeps the same role.
    const state=await worker.fetch(f.request("/api/state","GET",undefined,role,{Origin:studio,Authorization:"Bearer "+login.sessionToken}),f.env);
    assert.equal(state.status,200);
    const data=await state.json() as {role:string};
    assert.equal(data.role,role);
    assert.doesNotMatch(JSON.stringify(data),/test-editor-token|test-admin-token|test-gemini-key|test-buffer-key/);
    // Then the original same-origin protected-cookie flow is retained as well.
    const cookie=await worker.fetch(new Request(base+"/api/state",{headers:{Cookie:response.headers.get("set-cookie")!}}),f.env);
    assert.equal(cookie.status,200);
  }
});

test("editor accounts cannot publish, connect channels, archive history or start a publication test batch",async t=>{
  const f=fixture(t); await f.repo.saveSettings(configuredSettings());
  const post=preparedPost();post.id=crypto.randomUUID();post.status="draft";await f.repo.savePost(post);
  // Given an editor who can create content, publishing controls remain a separate owner capability.
  for(const path of ["/api/test-batch","/api/channels/sync","/api/posts/archive",`/api/posts/${post.id}/approve`]) {
    const response=await worker.fetch(f.request(path,"POST",{}),f.env);
    assert.equal(response.status,403,path);
  }
  // Then no privileged job was dispatched as a side effect of a rejected request.
  assert.deepEqual(f.sent,[]);assert.equal((await f.repo.getPost(post.id))!.status,"draft");
});

test("editors can refine brand direction while delivery settings and usage limits remain protected",async t=>{
  const f=fixture(t); const original=configuredSettings();await f.repo.saveSettings(original);
  // Given a colleague updating the creative brief, changing wording should remain useful.
  const creative={...original,offerSummary:"Sites de apresentação com contato por WhatsApp.",editorialGuidelines:"Abrir com uma dúvida concreta."};
  const saved=await worker.fetch(f.request("/api/settings","PUT",creative),f.env);
  assert.equal(saved.status,200);
  assert.equal((await f.repo.getSettings()).editorialGuidelines,creative.editorialGuidelines);
  const current=await f.repo.getSettings();
  // When the same editor tries to modify delivery or consumption, the whole update is rejected.
  const changes:Partial<Settings>[]=[{mode:"approval"},{paused:true},{daysOfWeek:[2,4]},{hour:10},{timezone:"UTC"},{maxAgeDays:31},{maxCandidates:1},{minRelevance:90},{maxPostsPerDay:2},{channels:current.channels.map(c=>({...c,enabled:false}))}];
  for(const change of changes) {
    const response=await worker.fetch(f.request("/api/settings","PUT",{...current,...change}),f.env);
    assert.equal(response.status,403,JSON.stringify(change));
    assert.deepEqual(await f.repo.getSettings(),current);
  }
});

test("editor generation is draft-only even when the owner's global configuration is automatic and paused",async t=>{
  const f=fixture(t); const original={...configuredSettings(),paused:true};await f.repo.saveSettings(original);
  f.env.BROWSER={quickAction:async()=>new Response(png(),{headers:{"Content-Type":"image/png"}})};
  let publicationCalls=0;
  t.mock.method(globalThis,"fetch",async(url:string|URL|Request)=>{
    const target=String(url);
    if(target.includes("news.example.com"))return feedResponse();
    if(target.includes("generativelanguage.googleapis.com"))return geminiResponse();
    publicationCalls++;throw Error("No external publication permitted");
  });
  // Given an editor requesting real content, even an explicit false flag must not grant publication.
  const response=await worker.fetch(f.request("/api/run","POST",{demo:false,draftOnly:false}),f.env);
  assert.equal(response.status,202);
  assert.deepEqual(f.sent,[{type:"run",demo:false,draftOnly:true}]);
  // When that job is consumed, the paused owner configuration is only overridden for draft preparation.
  await worker.queue({messages:[{body:f.sent[0],ack(){}}]} as never,f.env);
  const posts=await f.repo.listPosts();assert.equal(posts.length,1);
  assert.equal(posts[0].status,"draft");assert.deepEqual(posts[0].deliveries,[]);
  // Then no Buffer call or persistent change to the owner's routine occurred.
  assert.equal(publicationCalls,0);assert.deepEqual(await f.repo.getSettings(),original);
});

test("a changed image brief invalidates the old visual and preview/render do not reuse stale illustration bytes",async t=>{
  const f=fixture(t);const post=preparedPost();post.id=crypto.randomUUID();post.status="draft";
  post.content.imagePrompt="A blue glass browser.";post.visual={status:"ready",model:"test",createdAt:new Date().toISOString()};
  await f.repo.savePost(post);await f.repo.saveIllustration(post.id,{data:testJpeg().buffer,mimeType:"image/jpeg"});await f.repo.saveImage(post.id,png().buffer);
  // Given a saved illustration, changing its brief should make its previous bytes ineligible for the new preview.
  const patch=await worker.fetch(f.request(`/api/posts/${post.id}`,"PATCH",{imagePrompt:"A clear cyan bridge between two browser panels."}),f.env);
  assert.equal(patch.status,200);
  const edited=(await f.repo.getPost(post.id))!;assert.equal(edited.imageReady,false);assert.equal(edited.visual,undefined);
  const preview=await worker.fetch(f.request(`/preview/${post.id}`),f.env);
  assert.equal(preview.status,200);assert.doesNotMatch(await preview.text(),/data:image\/jpeg;base64,/);
  let rendered=0;
  f.env.BROWSER={quickAction:async(_action,options)=>{rendered++;assert.doesNotMatch(options.html,/data:image\/jpeg;base64,/);return new Response(png(),{headers:{"Content-Type":"image/png"}});}};
  // When PNG is prepared before regenerating the illustration, the old bytes remain excluded.
  assert.equal((await worker.fetch(f.request(`/api/posts/${post.id}/render`,"POST",{}),f.env)).status,202);
  await worker.queue({messages:[{body:f.sent[0],ack(){}}]} as never,f.env);
  assert.equal(rendered,1);
});

test("production cleanup softly archives old posts without deleting stored history or exposing it in state",async t=>{
  const f=fixture(t);const legacy=preparedPost();legacy.id=crypto.randomUUID();legacy.status="published";
  const current=preparedPost();current.id=crypto.randomUUID();current.status="draft";
  await f.repo.savePost(legacy);await f.repo.savePost(current);
  // Given historical publications, cleanup should remove them from the working view without destroying them.
  const response=await worker.fetch(f.request("/api/posts/archive","POST",{ids:[legacy.id]},"owner"),f.env);
  assert.equal(response.status,200);
  assert.ok((await f.repo.getPost(legacy.id))!.archivedAt);
  assert.deepEqual((await f.repo.listPosts()).map(p=>p.id),[current.id]);
  const state=await(await worker.fetch(f.request("/api/state"),f.env)).json() as {posts:{id:string}[]};
  assert.deepEqual(state.posts.map(p=>p.id),[current.id]);
  // Then archived content cannot be edited or used as an active preview by guessing its old identifier.
  assert.equal((await worker.fetch(f.request(`/preview/${legacy.id}`),f.env)).status,404);
  assert.equal((await worker.fetch(f.request(`/api/posts/${legacy.id}`,"PATCH",{caption:"Reativar"},"owner"),f.env)).status,404);
});

test("channel sync omits ignored staging channels and never enables a new one", async t => {
  const storage=sqliteD1();t.after(storage.close);
  const repo=new D1Repository(storage.db);await repo.saveSettings(configuredSettings());
  const env={...configuredEnv(),DB:storage.db,IGNORED_CHANNEL_IDS:"staging-channel",JOBS:{send:async()=>{}}} as unknown as Env;
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({data:calls===1?{account:{organizations:[{id:"org"}]}}:{channels:[{id:"staging-channel",name:"Staging",service:"instagram"},{id:"official-channel",name:"solv_tec",service:"instagram"}]}});});
  const response=await worker.fetch(new Request("https://bot.example.com/api/channels/sync",{method:"POST",headers:{Authorization:"Bearer "+env.ADMIN_TOKEN,"Content-Type":"application/json"},body:"{}"}),env);
  assert.equal(response.status,200);
  assert.deepEqual((await response.json() as {channels:unknown[]}).channels,[{id:"official-channel",name:"solv_tec",service:"instagram",enabled:false}]);
});
