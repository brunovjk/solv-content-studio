import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";
import { D1Repository } from "../src/repository.ts";
import { configuredEnv, configuredSettings, preparedPost } from "./helpers.ts";
import { sqliteD1 } from "./d1.ts";
import type { BotJob, Env, Post, Settings } from "../src/types.ts";

const base="https://api.example.com";
const origin="https://solv-studio-test.web.app";
const partnerTokens=["test-partner-one-credential-at-least-24-characters","test-partner-two-credential-at-least-24-characters"] as const;
const editorToken="test-editor-credential-at-least-24-characters";

function fixture(t:{after:(callback:()=>void)=>void}) {
  const storage=sqliteD1();t.after(storage.close);
  const sent:BotJob[]=[];
  const env={...configuredEnv(),DB:storage.db,EDITOR_TOKEN:editorToken,PARTNER_1_TOKEN:partnerTokens[0],PARTNER_2_TOKEN:partnerTokens[1],ALLOWED_ORIGINS:origin,JOBS:{send:async(job:BotJob)=>{sent.push(job);}}} as unknown as Env;
  const repo=new D1Repository(storage.db);
  const request=(path:string,method="GET",value?:unknown,credential:string=partnerTokens[0])=>new Request(base+path,{method,headers:{Authorization:"Bearer "+credential,Origin:origin,...(!["GET","HEAD"].includes(method)?{"Content-Type":"application/json"}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})});
  return {...storage,env,repo,sent,request};
}

test("each partner logs in as a distinct identity while both read the same working posts",async t=>{
  const f=fixture(t);await f.repo.saveSettings(configuredSettings());
  const post=preparedPost();post.id=crypto.randomUUID();post.status="draft";await f.repo.savePost(post);
  const sessions:string[]=[];
  // Given two separate credentials, a login identifies its partner without allocating another content workspace.
  for(const [index,credential] of partnerTokens.entries()) {
    const loginResponse=await worker.fetch(f.request("/api/login","POST",{token:credential},credential),f.env);
    assert.equal(loginResponse.status,200);
    const login=await loginResponse.json() as {role:string;subject:string;sessionToken:string};
    assert.equal(login.role,"partner");assert.equal(login.subject,`partner-${index+1}`);
    assert.ok(login.sessionToken);assert.notEqual(login.sessionToken,credential);sessions.push(login.sessionToken);
    // When each returned session reads state, the original post and shared brand settings remain visible.
    const response=await worker.fetch(f.request("/api/state","GET",undefined,login.sessionToken),f.env);
    assert.equal(response.status,200);
    const state=await response.json() as {role:string;subject:string;posts:Post[];settings:Settings};
    assert.equal(state.role,"partner");assert.equal(state.subject,login.subject);
    assert.deepEqual(state.posts.map(p=>p.id),[post.id]);assert.equal(state.settings.brandName,"Solv");
    // Then master credentials and provider keys are never returned as account information.
    for(const secret of [f.env.ADMIN_TOKEN!,...partnerTokens,editorToken,f.env.GEMINI_API_KEY!,f.env.BUFFER_API_KEY!])assert.ok(!JSON.stringify(state).includes(secret));
  }
  assert.notEqual(sessions[0],sessions[1]);
});

test("edits and publication settings saved by one partner are visible to the other",async t=>{
  const f=fixture(t);await f.repo.saveSettings(configuredSettings());
  const post=preparedPost();post.id=crypto.randomUUID();post.status="draft";await f.repo.savePost(post);
  // Given one shared draft, the first partner can refine its caption.
  const patch=await worker.fetch(f.request(`/api/posts/${post.id}`,"PATCH",{caption:"Uma apresentação clara para o seu negócio de beleza."},partnerTokens[0]),f.env);
  assert.equal(patch.status,200);
  const stateResponse=await worker.fetch(f.request("/api/state","GET",undefined,partnerTokens[1]),f.env);
  const state=await stateResponse.json() as {posts:Post[]};
  assert.equal(state.posts[0].content.caption,"Uma apresentação clara para o seu negócio de beleza.");
  // When either partner adjusts delivery controls, the same configuration is persisted for everyone.
  for(const [index,credential] of partnerTokens.entries()) {
    const settings={...await f.repo.getSettings(),mode:"approval" as const,paused:true,hour:10+index,daysOfWeek:[2,4],channels:[]};
    assert.equal((await worker.fetch(f.request("/api/settings","PUT",settings,credential),f.env)).status,200);
    const other=await(await worker.fetch(f.request("/api/state","GET",undefined,partnerTokens[1-index]),f.env)).json() as {settings:Settings};
    assert.equal(other.settings.hour,10+index);assert.equal(other.settings.paused,true);assert.deepEqual(other.settings.channels,[]);
  }
  // Then this broader permission does not silently promote the optional restricted editor account.
  const changed={...await f.repo.getSettings(),hour:15};
  assert.equal((await worker.fetch(f.request("/api/settings","PUT",changed,editorToken),f.env)).status,403);
  assert.equal((await f.repo.getSettings()).hour,11);
});

test("both partners can approve posts and accepted deliveries remain shared and deduplicated",async t=>{
  const f=fixture(t);await f.repo.saveSettings(configuredSettings());
  const posts=partnerTokens.map(()=>{const p=preparedPost();p.id=crypto.randomUUID();p.status="draft";return p;});
  for(const p of posts)await f.repo.savePost(p);
  let publications=0;
  t.mock.method(globalThis,"fetch",async(url:string|URL|Request,options?:RequestInit)=>{
    assert.equal(String(url),"https://api.buffer.com");
    assert.match(JSON.parse(String(options?.body)).query,/mutation BotCreatePost/);
    publications++;
    return Response.json({data:{createPost:{post:{id:`accepted-${publications}`,dueAt:new Date(Date.now()+120000).toISOString()}}}});
  });
  // Given prepared drafts, each partner can request publication with the same authority as the owner.
  for(const [index,credential] of partnerTokens.entries()) {
    assert.equal((await worker.fetch(f.request(`/api/posts/${posts[index].id}/approve`,"POST",{},credential),f.env)).status,202);
  }
  assert.deepEqual(f.sent,posts.map(p=>({type:"approve",postId:p.id})));
  // When queue jobs are consumed, they use the regular guarded publishing path rather than separate account data.
  for(const job of f.sent)await worker.queue({messages:[{body:job,ack(){}}]} as never,f.env);
  assert.equal(publications,2);
  for(const credential of partnerTokens) {
    const state=await(await worker.fetch(f.request("/api/state","GET",undefined,credential),f.env)).json() as {posts:Post[]};
    assert.equal(state.posts.length,2);assert.ok(state.posts.every(p=>p.status==="queued"&&p.deliveries[0].remoteId?.startsWith("accepted-")));
  }
  // Then neither a partner nor the optional editor can create another delivery for an already accepted post.
  assert.equal((await worker.fetch(f.request(`/api/posts/${posts[0].id}/approve`,"POST",{},partnerTokens[1]),f.env)).status,400);
  assert.equal((await worker.fetch(f.request(`/api/posts/${posts[0].id}/approve`,"POST",{},editorToken),f.env)).status,403);
  assert.equal(publications,2);assert.equal(f.sent.length,2);
});

test("partners can synchronize channels and archive content in the shared workspace",async t=>{
  const f=fixture(t);await f.repo.saveSettings(configuredSettings());
  let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({data:calls===1?{account:{organizations:[{id:"org"}]}}:{channels:[{id:"instagram-1",name:"solv.insta",service:"instagram"}]}});});
  // Given an existing connected channel, a partner can refresh its operational connection.
  assert.equal((await worker.fetch(f.request("/api/channels/sync","POST",{},partnerTokens[0]),f.env)).status,200);
  assert.equal(calls,2);
  const post=preparedPost();post.id=crypto.randomUUID();post.status="draft";await f.repo.savePost(post);
  // When the other partner archives a draft, it leaves the same active list for all three administrators.
  assert.equal((await worker.fetch(f.request("/api/posts/archive","POST",{ids:[post.id]},partnerTokens[1]),f.env)).status,200);
  const state=await(await worker.fetch(f.request("/api/state","GET",undefined,partnerTokens[0]),f.env)).json() as {posts:Post[]};
  assert.equal(state.posts.length,0);assert.ok((await f.repo.getPost(post.id))!.archivedAt);
});
