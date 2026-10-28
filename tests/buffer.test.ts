import assert from "node:assert/strict";
import test from "node:test";
import { AmbiguousPublishError, enqueuePost, getBufferPost, listBufferChannels, postCaption } from "../src/buffer.ts";
import type { Channel, DraftContent, Env, Post } from "../src/types.ts";

const env = { BUFFER_API_KEY: "SECRET-KEY" } as Env;
const channel: Channel = { id: "channel-1", name: "Solv", service: "instagram", enabled: true };
const content: DraftContent = {
  title: "Site profissional para beleza", subtitle: "Organize seu atendimento.", caption: "Uma ideia para o seu negócio.",
  takeaways: ["Facilite o agendamento"], hashtags: ["#Gestão", "Gestão", "Tecnologia clínicas"],
  sourceUrl: "https://example.com/article", sourceName: "International Clinic News", relevance: 90,
  reason: "Gestão", topic: "Atendimento", shouldPost: true,
};
const post: Post = { id: "local-1", articleId: "article-1", createdAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", content, status: "ready", imageReady: true, deliveries: [], demo: false };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("discovery queries organizations then channels with variables and connection state", async () => {
  let calls = 0;
  const channels = await listBufferChannels(env, async (url, options) => {
    assert.equal(url, "https://api.buffer.com");
    assert.equal((options!.headers as Record<string, string>).Authorization, "Bearer SECRET-KEY");
    const payload = JSON.parse(options!.body as string);
    calls++;
    if (calls === 1) return json({ data: { account: { organizations: [{ id: 'org"injection' }] } } });
    assert.deepEqual(payload.variables, { input: { organizationId: 'org"injection' } });
    assert.doesNotMatch(payload.query, /org"injection/);
    return json({ data: { channels: [{ id: "ig", name: "Instagram", service: "instagram" }, { id: "li", name: "LinkedIn", service: "linkedin", isDisconnected: true }] } });
  });
  assert.equal(calls, 2);
  assert.deepEqual(channels.map((item) => item.enabled), [true, false]);
});

test("caption preserves source and hashtags within final Instagram and Google limits", () => {
  const long = { ...content, caption: "Uma dica importante. ".repeat(250) };
  const caption = postCaption(long);
  assert.ok(caption.length <= 2200);
  assert.ok(postCaption(long, "googlebusiness").length <= 1500);
  assert.match(caption, /Fonte: International Clinic News\nhttps:\/\/example.com\/article/);
  assert.match(caption, /#Gestão #Tecnologiaclínicas$/);
  assert.equal((caption.match(/#Gestão/g) || []).length, 1);
});

test("publishes a real image with automatic scheduling, variables and source", async () => {
  const before = Date.now();
  const injection = '" }) { stealSecret } #';
  const result = await enqueuePost({ ...post, content: { ...content, caption: injection } }, { ...channel, id: injection }, "https://bot.example/media/post.png", env, async (_url, options) => {
    const payload = JSON.parse(options!.body as string);
    assert.doesNotMatch(payload.query, /stealSecret/);
    assert.equal(payload.variables.input.channelId, injection);
    assert.match(payload.variables.input.text, /stealSecret/);
    assert.equal(payload.variables.input.mode, "customScheduled");
    assert.equal(payload.variables.input.schedulingType, "automatic");
    assert.equal(payload.variables.input.needsApproval, false);
    assert.equal(payload.variables.input.saveToDraft, false);
    assert.ok(Date.parse(payload.variables.input.dueAt) >= before + 120_000);
    assert.deepEqual(payload.variables.input.assets, [{ image: { url: "https://bot.example/media/post.png" } }]);
    assert.deepEqual(payload.variables.input.metadata.instagram, { type: "post", shouldShareToFeed: true });
    return json({ data: { createPost: { __typename: "PostActionSuccess", post: { id: "remote-1", dueAt: "2026-10-22T12:00:00Z" } } } });
  });
  assert.deepEqual(result, { id: "remote-1", dueAt: "2026-10-22T12:00:00Z" });
});

test("mutation union errors are definitive and do not expose provider text", async () => {
  await assert.rejects(enqueuePost(post, channel, "https://bot.example/post.png", env, async () => json({ data: { createPost: { __typename: "InvalidInputError", message: "SECRET-KEY internal details" } } })), (error: Error) => {
    assert.ok(!(error instanceof AmbiguousPublishError));
    assert.match(error.message, /rejeitou/);
    assert.doesNotMatch(error.message, /SECRET|internal/);
    return true;
  });
});

test("custom schedule keeps the requested instant and returns Buffer's confirmed dueAt", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-23T12:00:00.000Z"));
  const result = await enqueuePost({ ...post, scheduledAt: "2026-10-23T09:10:00-03:00" }, channel, "https://bot.example/post.png", env, async (_url, options) => {
    const { variables } = JSON.parse(options!.body as string);
    assert.equal(variables.input.mode, "customScheduled");
    assert.equal(variables.input.dueAt, "2026-10-23T12:10:00.000Z");
    return json({ data: { createPost: { post: { id: "scheduled", dueAt: "2026-10-23T12:10:01.000Z" } } } });
  });
  assert.deepEqual(result, { id: "scheduled", dueAt: "2026-10-23T12:10:01.000Z" });
});

test("invalid, expired or too-close schedules never call Buffer or fall back to immediate publishing", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-23T12:00:00.000Z"));
  let calls = 0;
  const noFetch = async () => { calls++; throw new Error("must not call Buffer"); };
  for (const scheduledAt of ["", "tomorrow", "2026-10-24", "2026-10-24T12:00:00", "2026-02-30T12:00:00Z", "2026-13-01T12:00:00Z"]) {
    await assert.rejects(enqueuePost({ ...post, scheduledAt }, channel, "https://bot.example/post.png", env, noFetch), /data ISO válida/);
  }
  for (const scheduledAt of ["2026-10-23T11:59:00Z", "2026-10-23T12:00:00Z", "2026-10-23T12:00:59.999Z"]) {
    await assert.rejects(enqueuePost({ ...post, scheduledAt }, channel, "https://bot.example/post.png", env, noFetch), /60 segundos no futuro/);
  }
  assert.equal(calls, 0);
});

test("accepts a custom schedule exactly 60 seconds in the future", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-23T12:00:00.000Z"));
  await enqueuePost({ ...post, scheduledAt: "2026-10-23T12:01:00Z" }, channel, "https://bot.example/post.png", env, async (_url, options) => {
    assert.equal(JSON.parse(options!.body as string).variables.input.dueAt, "2026-10-23T12:01:00.000Z");
    return json({ data: { createPost: { post: { id: "boundary" } } } });
  });
});

test("mutation HTTP rejection is definitive; network, 5xx and malformed successes are uncertain with no retry", async () => {
  await assert.rejects(enqueuePost(post, channel, "https://bot.example/post.png", env, async () => new Response("SECRET-KEY", { status: 401 })), /HTTP 401/);
  for (const response of [() => Promise.reject(new Error("SECRET-KEY")), () => Promise.resolve(new Response("secret", { status: 503 })), () => Promise.resolve(new Response("broken")), () => Promise.resolve(json(null)), () => Promise.resolve(json({ data: { createPost: null }, errors: [{ message: "timeout" }] }))]) {
    let calls = 0;
    await assert.rejects(enqueuePost(post, channel, "https://bot.example/post.png", env, async () => { calls++; return response(); }), AmbiguousPublishError);
    assert.equal(calls, 1);
  }
});

test("confirmed mutation ID survives GraphQL warnings to prevent duplicate sends", async () => {
  assert.deepEqual(await enqueuePost(post, channel, "https://bot.example/post.png", env, async () => json({ data: { createPost: { post: { id: "accepted" } } }, errors: [{ message: "warning" }] })), { id: "accepted" });
});

test("reads documented post status using variables and safe error text", async () => {
  const status = await getBufferPost('id"query', env, async (_url, options) => {
    const payload = JSON.parse(options!.body as string);
    assert.equal(payload.variables.input.id, 'id"query');
    assert.doesNotMatch(payload.query, /id"query/);
    return json({ data: { post: { id: 'id"query', status: "error" } } });
  });
  assert.equal(status.status, "error");
  assert.match(status.error!, /painel do Buffer/);
});

test("blocks demonstration posts, disabled channels, unsupported networks and non-HTTPS images before calling Buffer", async () => {
  const noFetch = async () => { throw new Error("must not call"); };
  await assert.rejects(enqueuePost({ ...post, demo: true }, channel, "https://example.com/post.png", env, noFetch), /demonstração/);
  await assert.rejects(enqueuePost(post, { ...channel, enabled: false }, "https://example.com/post.png", env, noFetch), /desativado/);
  await assert.rejects(enqueuePost(post, { ...channel, service: "pinterest" }, "https://example.com/post.png", env, noFetch), /Esta versão/);
  await assert.rejects(enqueuePost(post, channel, "http://example.com/post.png", env, noFetch), /inválida/);
  await assert.rejects(enqueuePost(post, channel, "https://example.com/post.png", {} as Env, noFetch), /BUFFER_API_KEY/);
});

test("query failures are readable and never expose GraphQL body", async () => {
  await assert.rejects(listBufferChannels(env, async () => json({ errors: [{ message: "SECRET-KEY" }] })), /recusou a consulta/);
  await assert.rejects(listBufferChannels(env, async () => new Response("SECRET-KEY", { status: 429 })), /HTTP 429/);
});


test("uses the documented Google Business service name and network-specific metadata", async () => {
  for (const service of ["facebook", "googlebusiness", "linkedin"]) {
    await enqueuePost(post, { ...channel, service }, "https://bot.example/post.png", env, async (_url, options) => {
      const { variables } = JSON.parse(options!.body as string);
      if (service === "googlebusiness") assert.deepEqual(variables.input.metadata, { google: { type: "whats_new" } });
      if (service === "facebook") assert.deepEqual(variables.input.metadata, { facebook: { type: "post" } });
      if (service === "linkedin") assert.equal(variables.input.metadata, undefined);
      return json({ data: { createPost: { post: { id: "remote" } } } });
    });
  }
});


test("does not duplicate the exact source suffix already added by draft generation", () => {
  const caption = postCaption({ ...content, caption: `${content.caption}\n\nFonte: ${content.sourceName}\n${content.sourceUrl}` });
  assert.equal((caption.match(/Fonte:/g) || []).length, 1);
  assert.equal((caption.match(/https:\/\/example.com\/article/g) || []).length, 1);
  assert.ok(caption.startsWith(content.caption));
});

test("authored campaign captions omit a self-citation while keeping hashtags", () => {
  const authored = {...content, origin:"authored" as const, caption:"Um site para apresentar seu negócio.", sourceName:"Solv", sourceUrl:"https://solv-cf55a.web.app/", hashtags:["#Solv"]};
  const caption = postCaption(authored);
  assert.equal(caption,"Um site para apresentar seu negócio.\n\n#Solv");
  assert.doesNotMatch(caption,/Fonte:|https:/);
});
