import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import worker from "../src/worker.ts";
import { manualPost, MAX_UPLOAD_BODY } from "../src/manual.ts";
import { D1Repository } from "../src/repository.ts";
import { configuredEnv, configuredSettings, testJpeg } from "./helpers.ts";
import { sqliteD1 } from "./d1.ts";
import type { BotJob, Env, Post } from "../src/types.ts";

const base="https://bot.example.com";
function jpeg(width=1080,height=1350) {
  const bytes=testJpeg();bytes[7]=height>>8;bytes[8]=height&255;bytes[9]=width>>8;bytes[10]=width&255;return bytes;
}
function png() {
  const chunk=(name:string,data:Buffer)=>{
    const length=Buffer.alloc(4);length.writeUInt32BE(data.length);
    const payload=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;
    for(const byte of payload){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const checksum=Buffer.alloc(4);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([length,payload,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(320,0);header.writeUInt32BE(320,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(Buffer.alloc(320*(320*3+1)))),chunk("IEND",Buffer.alloc(0))]);
}
const payload=()=>({id:crypto.randomUUID(),caption:"Conheça a Solv.\nSites que apresentam seu negócio.",image:{mimeType:"image/jpeg",base64:Buffer.from(jpeg()).toString("base64")}});
function fixture(t:{after:(fn:()=>void)=>void}) {
  const storage=sqliteD1();t.after(storage.close);
  const jobs:BotJob[]=[];
  const env={...configuredEnv(),GEMINI_API_KEY:undefined,CF_ACCOUNT_ID:undefined,CF_BROWSER_API_TOKEN:undefined,PARTNER_1_TOKEN:"test-partner-token-with-enough-length",EDITOR_TOKEN:"test-editor-token-with-enough-length",DB:storage.db,JOBS:{send:async(job:BotJob)=>{jobs.push(job);}}} as unknown as Env;
  const repo=new D1Repository(storage.db);
  const request=(path:string,method="GET",value?:unknown,token=env.ADMIN_TOKEN)=>new Request(base+path,{method,headers:{Authorization:"Bearer "+token,...(["GET","HEAD"].includes(method)?{}:{"Content-Type":"application/json"})},...(value===undefined?{}:{body:JSON.stringify(value)})});
  return {...storage,env,repo,jobs,request};
}

test("manual image validation rejects disguised files, oversized data, invalid dimensions and blank captions",()=>{
  // Given an authenticated upload is still untrusted input.
  const input=payload();assert.equal(manualPost(input).post.uploadedImage?.width,1080);
  const bad:Record<string,unknown>[]=[{...input,id:"bad"},{...input,caption:" "},{...input,caption:"x".repeat(1801)},{...input,image:{mimeType:"image/svg+xml",base64:Buffer.from("<svg/>").toString("base64")}},{...input,image:{mimeType:"image/png",base64:input.image.base64}},{...input,image:{mimeType:"image/jpeg",base64:"!not-base64!"}},{...input,image:{mimeType:"image/jpeg",base64:"A".repeat(2_000_004)}},{...input,image:{mimeType:"image/jpeg",base64:Buffer.from(jpeg(1,1)).toString("base64")}},{...input,image:{mimeType:"image/jpeg",base64:Buffer.from(jpeg(1080,1920)).toString("base64")}}];
  // When a file lies about its type or exceeds supported Instagram dimensions.
  for(const value of bad)assert.throws(()=>manualPost(value));
  // Then valid PNG and JPEG data retain their actual format and dimensions.
  const image=png();const result=manualPost({...input,image:{mimeType:"image/png",base64:image.toString("base64")}});
  assert.equal(result.post.uploadedImage?.mimeType,"image/png");assert.equal(result.post.uploadedImage?.height,320);
  assert.deepEqual(Buffer.from(result.image),image);
});

test("owners, partners and editors can save original photo drafts with no feed, model or publication calls",async t=>{
  // Given the company is paused and no Gemini or renderer is configured.
  const f=fixture(t);const settings={...configuredSettings(),paused:true};await f.repo.saveSettings(settings);
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("No network for uploads");});
  for(const token of [f.env.ADMIN_TOKEN,f.env.PARTNER_1_TOKEN,f.env.EDITOR_TOKEN]) {
    const input=payload();
    // When each authorized collaborator saves photo plus caption.
    const response=await worker.fetch(f.request("/api/posts/manual","POST",input,token),f.env);
    assert.equal(response.status,201);const post=(await response.json() as {post:Post}).post;
    assert.equal(post.status,"draft");assert.equal(post.imageReady,true);assert.equal(post.content.origin,"authored");assert.equal(post.content.sourceUrl,"");
    assert.deepEqual(post.deliveries,[]);assert.deepEqual(Buffer.from((await f.repo.getImage(post.id))!),Buffer.from(jpeg()));
    const media=await worker.fetch(new Request(base+`/media/${post.id}.jpg`),f.env);
    assert.equal(media.headers.get("content-type"),"image/jpeg");assert.deepEqual(Buffer.from(await media.arrayBuffer()),Buffer.from(jpeg()));
    assert.equal((await worker.fetch(new Request(base+`/media/${post.id}.png`),f.env)).status,404);
  }
  // Then global settings stay paused, and no job or provider was invoked.
  assert.deepEqual(await f.repo.getSettings(),settings);assert.equal(calls,0);assert.deepEqual(f.jobs,[]);
  const denied=await worker.fetch(new Request(base+"/api/posts/manual",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload())}),f.env);
  assert.equal(denied.status,401);
});

test("manual draft retries are idempotent, caption edits retain the photo, and generation actions cannot replace it",async t=>{
  const f=fixture(t);await f.repo.saveSettings(configuredSettings());const input=payload();
  // Given a photo draft already saved and subsequently edited.
  assert.equal((await worker.fetch(f.request("/api/posts/manual","POST",input),f.env)).status,201);
  const edit=await worker.fetch(f.request(`/api/posts/${input.id}`,"PATCH",{caption:"Nova legenda."}),f.env);
  assert.equal(edit.status,200);
  const retry=await worker.fetch(f.request("/api/posts/manual","POST",input),f.env);
  // When the client repeats the original upload after an uncertain network result.
  assert.equal(retry.status,200);assert.equal((await retry.json() as {post:Post}).post.content.caption,"Nova legenda.");
  const post=(await f.repo.getPost(input.id))!;assert.equal(post.imageReady,true);assert.equal(post.content.title,"Nova legenda.");
  assert.deepEqual(Buffer.from((await f.repo.getImage(input.id))!),Buffer.from(jpeg()));assert.equal((await f.repo.listPosts()).length,1);
  // Then neither AI visual actions nor title/brief changes may overwrite the user's photo.
  for(const action of ["visual","render"])assert.equal((await worker.fetch(f.request(`/api/posts/${input.id}/${action}`,"POST",{}),f.env)).status,409);
  assert.equal((await worker.fetch(f.request(`/api/posts/${input.id}`,"PATCH",{imagePrompt:"Replace photo"}),f.env)).status,400);
  assert.deepEqual(f.jobs,[]);
});

test("manual publication sends the saved JPEG and exact caption to Buffer without Gemini, artwork or invented attribution",async t=>{
  const f=fixture(t);await f.repo.saveSettings(configuredSettings());const input=payload();
  await worker.fetch(f.request("/api/posts/manual","POST",input),f.env);
  // Given the original photo can publish without a model or a Cloudflare PNG renderer.
  const state=await(await worker.fetch(f.request("/api/state"),f.env)).json() as {publicationMissing:string[];manualPublicationMissing:string[]};
  assert.ok(state.publicationMissing.some(v=>v.includes("renderização")));assert.deepEqual(state.manualPublicationMissing,[]);
  let calls=0;t.mock.method(globalThis,"fetch",async(url:string|URL|Request,options?:RequestInit)=>{
    // When the queued approval reaches Buffer, it must reference the original photo.
    calls++;assert.equal(String(url),"https://api.buffer.com");const data=JSON.parse(String(options?.body));
    assert.equal(data.variables.input.text,input.caption);assert.equal(data.variables.input.aiAssisted,false);
    assert.match(data.variables.input.assets[0].image.url,new RegExp(`/media/${input.id}\\.jpg$`));
    return Response.json({data:{createPost:{post:{id:"manual-accepted"}}}});
  });
  const editor=await worker.fetch(f.request(`/api/posts/${input.id}/approve`,"POST",{},f.env.EDITOR_TOKEN),f.env);assert.equal(editor.status,403);
  assert.equal((await worker.fetch(f.request(`/api/posts/${input.id}/approve`,"POST",{},f.env.PARTNER_1_TOKEN),f.env)).status,202);
  await worker.queue({messages:[{body:f.jobs[0],ack(){}}]} as never,f.env);
  // Then retries cannot publish again, and the photo is still byte-for-byte unchanged.
  const post=(await f.repo.getPost(input.id))!;assert.equal(post.status,"queued");assert.equal(calls,1);
  assert.equal((await worker.fetch(f.request(`/api/posts/${input.id}`,"PATCH",{caption:"Too late"}),f.env)).status,400);
  assert.deepEqual(Buffer.from((await f.repo.getImage(input.id))!),Buffer.from(jpeg()));
});

test("manual save observes pipeline lock and request body limit before storage",async t=>{
  const f=fixture(t);await f.repo.acquireLock("pipeline",60);
  // Given another operation owns the storage lock.
  assert.equal((await worker.fetch(f.request("/api/posts/manual","POST",payload()),f.env)).status,409);
  await f.repo.releaseLock("pipeline");
  // When a request is larger than the upload contract, it is rejected before any post appears.
  const response=await worker.fetch(f.request("/api/posts/manual","POST",{...payload(),padding:"x".repeat(MAX_UPLOAD_BODY)}),f.env);
  assert.equal(response.status,400);
  // Then no partial post or queued operation remains.
  assert.deepEqual(await f.repo.listPosts(),[]);assert.deepEqual(f.jobs,[]);
});
