import assert from "node:assert/strict";
import test from "node:test";
import { missingPublicationRequirements, publishPreparedPost, reconcileDeliveries, runPipeline } from "../src/pipeline.ts";
import { localClock } from "../src/settings.ts";
import { configuredEnv, configuredSettings, feedResponse, geminiResponse, MemoryRepository, preparedPost } from "./helpers.ts";
import type { Env, Fetcher } from "../src/types.ts";

const noNetwork: Fetcher = async () => { throw new Error("Unexpected network request"); };

test("demo creates an identifiable local post without AI, rendering, Buffer or Telegram", async () => {
  const repo = new MemoryRepository();
  let calls = 0;
  const run = await runPipeline({ ...configuredEnv(), TELEGRAM_BOT_TOKEN: "test-telegram", TELEGRAM_CHAT_ID: "owner" }, repo, { demo: true }, async () => { calls++; throw new Error("must not call"); });
  assert.equal(run.status, "success");
  assert.equal(calls, 0);
  const post = (await repo.listPosts())[0];
  assert.equal(post.demo, true);
  assert.equal(post.status, "ready");
  assert.equal(post.imageReady, false);
  assert.match(post.content.caption, /DEMONSTRAÇÃO/);
  assert.deepEqual(post.deliveries, []);
  assert.equal(repo.claims.size, 0);
  assert.equal(repo.locked, false);
  assert.equal(repo.releases, 1);
});

test("scheduled demo does not reconcile queued real posts", async () => {
  const settings = configuredSettings();
  const clock = localClock(new Date(), settings.timezone);
  settings.daysOfWeek = [clock.day]; settings.hour = clock.hour;
  const repo = new MemoryRepository(settings);
  const queued = preparedPost(); queued.status = "queued"; queued.deliveries = [{ channelId: "instagram-1", channelName: "Instagram", remoteId: "accepted", status: "queued" }];
  await repo.savePost(queued);
  let calls = 0;
  const run = await runPipeline(configuredEnv(), repo, { demo: true, scheduled: true }, async () => { calls++; throw new Error("must not call"); });
  assert.equal(run.status, "success");
  assert.equal(calls, 0);
  assert.equal((await repo.getPost(queued.id))!.deliveries[0].status, "queued");
});

test("missing Gemini fails before source collection and cannot publish", async () => {
  const repo = new MemoryRepository();
  let calls = 0;
  const run = await runPipeline({ ...configuredEnv(), GEMINI_API_KEY: undefined }, repo, { demo: false }, async () => { calls++; throw new Error("must not call"); });
  assert.equal(run.status, "error");
  assert.match(run.message, /chave Gemini/);
  assert.equal(calls, 0);
  assert.equal(repo.posts.size, 0);
  assert.equal(repo.locked, false);
});

test("daily quota prevents both source and AI calls", async () => {
  const repo = new MemoryRepository(); repo.dailyCount = 1;
  let calls = 0;
  const run = await runPipeline(configuredEnv(), repo, { demo: false }, async () => { calls++; return new Response(); });
  assert.equal(run.status, "skipped");
  assert.match(run.message, /Limite diário/);
  assert.equal(calls, 0);
  assert.equal(repo.posts.size, 0);
});

test("real draft generation with missing publishing credentials stays ready without enqueueing", async () => {
  const repo = new MemoryRepository();
  const urls: string[] = [];
  const run = await runPipeline({ GEMINI_API_KEY: "test-gemini" } as Env, repo, { demo: false }, async (input) => {
    const url = String(input); urls.push(url);
    if (url.includes("news.example.com")) return feedResponse();
    if (url.includes("generativelanguage.googleapis.com")) return geminiResponse();
    throw new Error("Must not render or publish");
  });
  assert.equal(run.status, "success");
  assert.equal(urls.length, 2);
  const post = (await repo.listPosts())[0];
  assert.equal(post.status, "ready"); assert.equal(post.demo, false); assert.equal(post.imageReady, false);
  assert.match(post.error!, /conexão Buffer/);
  assert.match(post.content.caption, /Fonte: Foreign Clinic News/);
  assert.deepEqual(post.deliveries, []);
});

test("complete pipeline persists the sending guard before enqueue, and queued retry never republishes", async () => {
  const repo = new MemoryRepository(); const env = configuredEnv();
  const calls = { feeds: 0, ai: 0, render: 0, publish: 0 };
  const run = await runPipeline(env, repo, { demo: false }, async (input, options) => {
    const url = String(input);
    if (url.includes("news.example.com")) { calls.feeds++; return feedResponse(); }
    if (url.includes("generativelanguage.googleapis.com")) { calls.ai++; return geminiResponse(); }
    if (url.includes("api.cloudflare.com")) { calls.render++; return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "Content-Type": "image/png" } }); }
    if (url === "https://api.buffer.com") {
      calls.publish++;
      const post = (await repo.listPosts())[0];
      assert.equal(post.deliveries[0].status, "sending");
      const payload = JSON.parse(String(options?.body));
      assert.match(payload.query, /mutation BotCreatePost/);
      assert.equal(payload.variables.input.channelId, "instagram-1");
      assert.equal(payload.variables.input.needsApproval, false);
      assert.equal((payload.variables.input.text.match(/Fonte:/g) || []).length, 1);
      assert.ok(payload.variables.input.text.length <= 2200);
      assert.match(payload.variables.input.assets[0].image.url, /\/media\/.+\.png$/);
      return Response.json({ data: { createPost: { __typename: "PostActionSuccess", post: { id: "buffer-accepted", dueAt: "2026-10-22T16:00:00Z" } } } });
    }
    throw new Error("Unexpected URL");
  });
  assert.equal(run.status, "success");
  assert.deepEqual(calls, { feeds: 1, ai: 1, render: 1, publish: 1 });
  const post = (await repo.listPosts())[0];
  assert.equal(post.status, "queued"); assert.equal(post.deliveries[0].remoteId, "buffer-accepted");
  assert.ok(await repo.getImage(post.id));
  let retries = 0;
  await publishPreparedPost(env, repo, post, await repo.getSettings(), async () => { retries++; throw new Error("must not send again"); });
  assert.equal(retries, 0);
  assert.equal((await repo.getPost(post.id))!.deliveries[0].status, "queued");
});

test("ambiguous mutation becomes unknown and subsequent attempts are blocked", async () => {
  const repo = new MemoryRepository(); const post = preparedPost(); let calls = 0;
  const outcome = await publishPreparedPost(configuredEnv(), repo, post, await repo.getSettings(), async () => { calls++; throw new Error("timeout after request may be accepted"); });
  assert.equal(calls, 1);
  assert.equal(outcome.status, "needs_attention");
  assert.equal(outcome.deliveries[0].status, "unknown");
  await assert.rejects(publishPreparedPost(configuredEnv(), repo, outcome, await repo.getSettings(), noNetwork), /sem confirmação/);
});

test("a persisted sending guard cannot be retried after interrupted execution", async () => {
  const repo = new MemoryRepository(); const post = preparedPost();
  post.deliveries = [{ channelId: "instagram-1", channelName: "Instagram", status: "sending" }];
  await assert.rejects(publishPreparedPost(configuredEnv(), repo, post, await repo.getSettings(), noNetwork), /sem confirmação/);
});

test("delivery reconciliation only reads status; read failure never resends accepted posts", async () => {
  for (const status of ["sent", "error", "network-error"]) {
    const repo = new MemoryRepository(); const post = preparedPost();
    post.status = "queued"; post.deliveries = [{ channelId: "instagram-1", channelName: "Instagram", remoteId: "accepted", status: "queued" }];
    await repo.savePost(post);
    let calls = 0;
    await reconcileDeliveries(configuredEnv(), repo, async (_input, options) => {
      calls++; const payload = JSON.parse(String(options?.body));
      assert.match(payload.query, /^query BotPostStatus/);
      if (status === "network-error") throw new Error("temporary");
      return Response.json({ data: { post: { id: "accepted", status } } });
    });
    assert.equal(calls, 1);
    const saved = (await repo.getPost(post.id))!;
    assert.equal(saved.status, status === "sent" ? "published" : status === "error" ? "needs_attention" : "queued");
  }
});

test("approval mode generates a draft and avoids publishing", async () => {
  const settings = configuredSettings(); settings.mode = "approval";
  const repo = new MemoryRepository(settings);
  const run = await runPipeline({ GEMINI_API_KEY: "test" } as Env, repo, { demo: false }, async (input) => String(input).includes("news.example.com") ? feedResponse() : geminiResponse());
  assert.equal(run.status, "success");
  assert.equal((await repo.listPosts())[0].status, "draft");
});

test("a lock and paused settings prevent generation; missing requirements name brand and preview mode", async () => {
  const repo = new MemoryRepository(); repo.locked = true;
  assert.equal((await runPipeline(configuredEnv(), repo, { demo: false }, noNetwork)).status, "skipped");
  assert.equal(repo.releases, 0);
  repo.locked = false; repo.settings.paused = true;
  assert.equal((await runPipeline(configuredEnv(), repo, { demo: false }, noNetwork)).status, "skipped");
  const settings = configuredSettings(); settings.brandName = "Marca provisória";
  assert.ok(missingPublicationRequirements({ ...configuredEnv(), DEMO_MODE: "true" }, settings).includes("nome da marca"));
  assert.ok(missingPublicationRequirements({ ...configuredEnv(), DEMO_MODE: "true" }, settings).includes("ambiente local em modo teste"));
});

test("real local generation saves one FLUX image without publishing and reuses it for PNG", async () => {
  const {testJpeg} = await import('./helpers.ts');
  const repo = new MemoryRepository(); let generated = 0, external = 0;
  const env = {...configuredEnv(),DEMO_MODE:'true',AI:{run:async () => {generated++;return {image:Buffer.from(testJpeg()).toString('base64')};}}};
  const run = await runPipeline(env,repo,{demo:false},async input => {
    if(String(input).includes('news.example.com'))return feedResponse();
    if(String(input).includes('generativelanguage'))return geminiResponse();
    external++;throw Error('No external publication or render in local mode');
  });
  assert.equal(run.status,'success'); assert.equal(generated,1); assert.equal(external,0);
  const post = (await repo.listPosts())[0];
  assert.equal(post.visual?.status,'ready');assert.ok(await repo.getIllustration(post.id));assert.deepEqual(post.deliveries,[]);
  const configured = {...env,DEMO_MODE:'false'};
  await publishPreparedPost(configured,repo,post,repo.settings,async (url,init)=> {
    if(String(url).includes('cloudflare.com')){
      const html = JSON.parse(String(init?.body)).html;
      assert.match(html,/data:image\/jpeg;base64,/);
      return new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{'Content-Type':'image/png'}});
    }
    return Response.json({data:{createPost:{post:{id:'accepted'}}}});
  });
  assert.equal(generated,1);assert.equal((await repo.getPost(post.id))?.status,'queued');
});

test("FLUX quota failure falls back once per post; demonstrations never use the binding", async () => {
  const {preparePostVisual} = await import('../src/pipeline.ts');
  const repo = new MemoryRepository();let calls=0;
  const env = {...configuredEnv(),AI:{run:async()=>{calls++;throw Error('SECRET_PROVIDER_DATA');}}};
  await runPipeline(env,repo,{demo:true},noNetwork);assert.equal(calls,0);
  const post = preparedPost();post.imageReady=false;
  await preparePostVisual(env,repo,post);
  await preparePostVisual(env,repo,post);
  assert.equal(calls,1);assert.equal(post.visual?.status,'fallback');assert.doesNotMatch(post.visual!.error!,/SECRET/);
  assert.equal(post.status,'ready');assert.equal(repo.illustrations.size,0);
});

test("a scheduled test job bypasses only the daily quota, pins its channel and deduplicates delivery",async()=>{
 const repo=new MemoryRepository();repo.dailyCount=99;
 const options={demo:false,scheduledAt:new Date(Date.now()+600000).toISOString(),testBatchId:crypto.randomUUID(),testChannelId:'instagram-1'};
 let mutations=0;
 const fetcher:Fetcher=async(url,init)=>{
  if(String(url).includes('news.example.com'))return feedResponse();
  if(String(url).includes('generativelanguage'))return geminiResponse();
  if(String(url).includes('cloudflare.com'))return new Response(new Uint8Array([137,80,78,71,13,10,26,10]),{headers:{'Content-Type':'image/png'}});
  mutations++;const payload=JSON.parse(String(init?.body));assert.equal(payload.variables.input.dueAt,options.scheduledAt);
  return Response.json({data:{createPost:{post:{id:'test-scheduled',dueAt:options.scheduledAt}}}});
 };
 const run=await runPipeline(configuredEnv(),repo,options,fetcher);assert.equal(run.status,'success');assert.equal(mutations,1);
 const post=(await repo.listPosts())[0];assert.equal(post.scheduledAt,options.scheduledAt);assert.equal(post.testBatchId,options.testBatchId);
 const duplicate=await runPipeline(configuredEnv(),repo,options,fetcher);assert.equal(duplicate.status,'skipped');assert.equal(mutations,1);
 assert.equal((await runPipeline(configuredEnv(),repo,{demo:false},fetcher)).status,'skipped');
 assert.equal(repo.settings.maxPostsPerDay,1);
});
