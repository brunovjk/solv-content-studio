import assert from "node:assert/strict";
import test from "node:test";
import { artworkHtml, canRenderArtwork, renderArtwork } from "../src/artwork.ts";
import type { DraftContent, Env, Illustration, Settings } from "../src/types.ts";

const content: DraftContent = {
  title: "Seu atendimento perde oportunidades?", subtitle: "Uma experiência simples começa antes da consulta.",
  caption: "Automatize lembretes e facilite o contato.", takeaways: ["Dê um caminho claro para agendar.", "Lembre o cliente do horário.", "Meça o tempo de resposta."],
  hashtags: ["GestãoDeClínicas"], sourceUrl: "https://example.com/article", sourceName: "Clinic News",
  relevance: 90, reason: "Útil para gestores", topic: "Atendimento", shouldPost: true,
};
const settings = { brandName: "Studio Digital", brandHandle: "@studiodigital", brandColor: "#e68b73" } as Settings;
const env = { CF_ACCOUNT_ID: "a".repeat(32), CF_BROWSER_API_TOKEN: "SECRET-TOKEN" } as Env;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const illustration: Illustration = {
  data: new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0xff, 0xd9]).buffer,
  mimeType: "image/jpeg",
};

test("artwork is a self-contained bold portrait with original fallback and Portuguese branding", () => {
  const html = artworkHtml(content, settings);
  assert.match(html, /width:1080px;height:1350px/);
  assert.match(html, /lang="pt-BR"/);
  assert.match(html, /class="fallback-visual"/);
  assert.match(html, /class="with-fallback"/);
  assert.match(html, /LEIA A LEGENDA/);
  assert.match(html, /@studiodigital/);
  assert.doesNotMatch(html, /Uma experiência simples|Automatize lembretes|Clinic News|example\.com/);
  assert.doesNotMatch(html, /<script|<img|<link|@import|url\((?!#)/i);
  assert.match(html, /font-weight:900/);
  assert.match(html, /img-src data:/);
});

test("HTML escapes model and branding content and rejects CSS injection", () => {
  const html = artworkHtml({ ...content, title: '<img src=x onerror="bad()">', topic: "A&B", takeaways: ["</style><script>bad()</script>"] }, {
    ...settings, brandName: '<script>brand()</script>', brandColor: 'red;}body{background:url(https://evil)}',
  });
  assert.match(html, /&lt;img src=x <span>onerror=&quot;bad\(\)&quot;&gt;<\/span>/);
  assert.match(html, /A&amp;B/);
  assert.doesNotMatch(html, /<script>|url\(https:\/\/evil\)/);
  assert.match(html, /background:#64b5ff/);
});

test("short artwork title wins while long titles receive a smaller type size", () => {
  const html = artworkHtml({ ...content, artTitle: "Sua agenda tem buracos?" }, settings);
  assert.match(html, /Sua agenda tem <span>buracos\?<\/span>/);
  assert.doesNotMatch(html, /Seu atendimento perde/);
  const long = artworkHtml({ ...content, title: "Organize o atendimento da sua clínica para reduzir dificuldades no primeiro agendamento" }, settings);
  const smallSize = Number(long.match(/font-size:(\d+)px;font-weight:900/)![1]);
  const largeSize = Number(html.match(/font-size:(\d+)px;font-weight:900/)![1]);
  assert.ok(smallSize >= 64 && smallSize < largeSize);
});

test("illustrations are embedded as validated data, without external image requests", () => {
  const html = artworkHtml(content, settings, illustration);
  assert.match(html, /<img class="hero-photo" src="data:image\/jpeg;base64,/);
  assert.match(html, /Imagem ilustrativa gerada por IA/);
  assert.match(html, /class="with-image"/);
  assert.doesNotMatch(html, /class="fallback-visual"|src="https?:|<script|<link|@import|url\(/i);
});

test("render sends HTML to the official endpoint and returns PNG bytes", async () => {
  const image = await renderArtwork(content, settings, env, async (url, options) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/browser-run/screenshot`);
    assert.equal((options!.headers as Record<string, string>).Authorization, "Bearer SECRET-TOKEN");
    const payload = JSON.parse(options!.body as string);
    assert.deepEqual(payload.viewport, { width: 1080, height: 1350, deviceScaleFactor: 1 });
    assert.equal(payload.screenshotOptions.type, "png");
    assert.equal(payload.url, undefined);
    assert.match(payload.html, /Seu atendimento/);
    assert.match(payload.html, /src="data:image\/jpeg;base64,/);
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  }, illustration);
  assert.deepEqual(new Uint8Array(image), png);
});

test("native Browser Run binding renders the cached illustration without credentials or fetch", async () => {
  let calls = 0;
  const bindingEnv = { BROWSER: { async quickAction(action, payload) {
    calls++;
    assert.equal(action, "screenshot");
    assert.deepEqual(payload.viewport, { width: 1080, height: 1350, deviceScaleFactor: 1 });
    assert.deepEqual(payload.screenshotOptions, { type: "png", fullPage: false, captureBeyondViewport: false });
    assert.match(payload.html!, /src="data:image\/jpeg;base64,/);
    assert.equal(payload.url, undefined);
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  } } } as Env;
  assert.equal(canRenderArtwork(bindingEnv), true);
  const result = await renderArtwork(content, settings, bindingEnv, async () => { throw new Error("fetch must not be called"); }, illustration);
  assert.deepEqual(new Uint8Array(result), png);
  assert.equal(calls, 1);
});

test("binding takes precedence over REST credentials, even invalid ones", async () => {
  const bindingEnv = { ...env, CF_ACCOUNT_ID: "invalid", BROWSER: { async quickAction() {
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  } } } as Env;
  let fetches = 0;
  assert.deepEqual(new Uint8Array(await renderArtwork(content, settings, bindingEnv, async () => { fetches++; throw new Error("not called"); })), png);
  assert.equal(fetches, 0);
});

test("binding failures are sanitized and never retried through REST", async () => {
  let calls = 0;
  let fetches = 0;
  const bindingEnv = { ...env, BROWSER: { async quickAction() { calls++; throw new Error("SECRET-TOKEN INTERNAL"); } } } as Env;
  await assert.rejects(renderArtwork(content, settings, bindingEnv, async () => { fetches++; throw new Error("not called"); }), (error: Error) => {
    assert.match(error.message, /tempo limite/);
    assert.doesNotMatch(error.message, /SECRET|INTERNAL/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(fetches, 0);
});

test("binding HTTP errors and malformed results never expose provider response bodies", async () => {
  for (const [response, expected] of [
    [new Response("SECRET-TOKEN INTERNAL", { status: 429 }), /HTTP 429/],
    [new Response("SECRET-TOKEN INTERNAL", { headers: { "Content-Type": "application/json" } }), /PNG/],
    [new Response("SECRET-TOKEN INTERNAL", { headers: { "Content-Type": "image/png" } }), /inválida/],
  ] as const) {
    const bindingEnv = { BROWSER: { async quickAction() { return response; } } } as Env;
    await assert.rejects(renderArtwork(content, settings, bindingEnv), (error: Error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /SECRET|INTERNAL/);
      return true;
    });
  }
});

test("binding timeout is bounded to 45 seconds without invoking REST", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetches = 0;
  const bindingEnv = { ...env, BROWSER: { quickAction() { return new Promise<Response>(() => {}); } } } as Env;
  const pending = renderArtwork(content, settings, bindingEnv, async () => { fetches++; throw new Error("not called"); });
  const rejected = assert.rejects(pending, /tempo limite/);
  t.mock.timers.tick(45_001);
  await rejected;
  assert.equal(fetches, 0);
});

test("render capability accepts a binding or valid REST credentials", () => {
  assert.equal(canRenderArtwork(env), true);
  assert.equal(canRenderArtwork({} as Env), false);
  assert.equal(canRenderArtwork({ CF_ACCOUNT_ID: "invalid", CF_BROWSER_API_TOKEN: "token" } as Env), false);
  assert.equal(canRenderArtwork({ CF_ACCOUNT_ID: "a".repeat(32) } as Env), false);
});

test("render refuses an announced PNG beyond D1's 1.5 MB limit before reading", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { "Content-Type": "image/png", "Content-Length": "1500001" },
  });
  await assert.rejects(renderArtwork(content, settings, { BROWSER: { async quickAction() { return response; } } } as Env), /1,5 MB/);
  assert.equal(cancelled, true);
});

test("render caps chunked PNG data while streaming and sanitizes read failures", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_000_000)); controller.enqueue(new Uint8Array(500_001)); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "image/png" } });
  await assert.rejects(renderArtwork(content, settings, env, async () => response), /1,5 MB/);
  assert.equal(cancelled, true);
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error("SECRET-TOKEN INTERNAL")); } }), { headers: { "Content-Type": "image/png" } });
  await assert.rejects(renderArtwork(content, settings, env, async () => broken), (error: Error) => {
    assert.match(error.message, /tempo limite/);
    assert.doesNotMatch(error.message, /SECRET|INTERNAL/);
    return true;
  });
});

test("missing credentials keep preview usable but block real rendering", async () => {
  assert.match(artworkHtml(content, settings), /Seu atendimento/);
  await assert.rejects(renderArtwork(content, settings, {} as Env), /CF_ACCOUNT_ID/);
});

test("render errors do not expose provider bodies or tokens", async () => {
  await assert.rejects(renderArtwork(content, settings, env, async () => new Response("SECRET-TOKEN INTERNAL", { status: 403 })), (error: Error) => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /SECRET|INTERNAL/);
    return true;
  });
  await assert.rejects(renderArtwork(content, settings, env, async () => { throw new Error("SECRET-TOKEN"); }), /tempo limite/);
  await assert.rejects(renderArtwork(content, settings, env, async () => new Response("not png", { headers: { "Content-Type": "image/png" } })), /inválida/);
  await assert.rejects(renderArtwork(content, settings, env, async () => new Response("{}", { headers: { "Content-Type": "application/json" } })), /PNG/);
});


test("brand accents remain legible on a fixed dark canvas and layouts repeat deterministically", () => {
  // Given a very dark or bright brand, the headline must never inherit a low-contrast brand foreground.
  for (const brandColor of ["#000000", "#ffffff", "#64b5ff"]) {
    const html = artworkHtml(content, { ...settings, brandColor });
    // When rendering, the accent is lightened and all layout variants retain a plain dark headline area.
    assert.match(html, /body\{background:#080b12;color:#f5f9ff/);
    assert.match(html, /h1 span\{color:#[\da-f]{6}\}/);
    assert.doesNotMatch(html, /h1 span\{color:#000000\}/);
    assert.equal(artworkHtml(content, { ...settings, brandColor }), html);
  }
  // Then a content series can vary composition without randomness or external assets.
  const layouts = new Set(Array.from({ length: 15 }, (_, index) => artworkHtml({ ...content, artTitle: `Seu site responde ${index}?` }, settings).match(/<article class="[^"]+" data-layout="([^"]+)"/)![1]));
  assert.equal(layouts.size, 3);
});
