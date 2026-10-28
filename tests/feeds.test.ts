import test from "node:test";
import assert from "node:assert/strict";
import { collectArticles, createDemoArticle } from "../src/feeds.ts";
import type { Fetcher, Settings, Source } from "../src/types.ts";

const source: Source = { id: "news", name: "Business News", url: "https://news.example.com/feed", website: "https://news.example.com", language: "en", enabled: true };
const settings = { maxAgeDays: 14, maxCandidates: 10 } as Settings;
const recent = new Date(Date.now() - 86_400_000).toUTCString();
const excerpt = "Improve the customer experience with clear appointment booking, opening hours and helpful confirmation messages.";
const item = (title: string, url: string, date = recent, description = excerpt) => `<item><title>${title}</title><link>${url.replaceAll("&", "&amp;")}</link><pubDate>${date}</pubDate><description><![CDATA[${description}]]></description></item>`;
const rss = (...items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><language>en</language>${items.join("")}</channel></rss>`;
const fetchXml = (body: string): Fetcher => (async () => new Response(body)) as Fetcher;

test("reads only RSS excerpts, canonicalizes tracking URLs, deduplicates and skips stale or medical articles", async () => {
  let requests = 0;
  const xml = rss(
    item("Make appointment booking easier", "https://news.example.com/booking?utm_source=feed&amp;campaign=fall#intro".replace("&amp;", "&")),
    item("Make appointment booking easier", "https://news.example.com/booking?campaign=fall"),
    item("Improve your website", "https://news.example.com/old", "Tue, 01 Jan 2019 12:00:00 GMT"),
    item("Clinical trial: injection technique", "https://news.example.com/treatment"),
    item("SEO outside the source", "https://untrusted.example.net/seo"),
    item("Data privacy update", "https://news.example.com/privacy", "not-a-date"),
  );
  const result = await collectArticles([source], settings, (async () => { requests++; return new Response(xml); }) as Fetcher);
  assert.equal(requests, 1, "Article webpages must not be downloaded");
  assert.equal(result.errors.length, 0);
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].url, "https://news.example.com/booking?campaign=fall");
  assert.match(result.articles[0].id, /^[a-f0-9]{64}$/);
  assert.equal(result.articles[0].excerpt, excerpt);
});

test("supports Atom alternate links, HTML summaries and language filtering", async () => {
  const date = new Date().toISOString();
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en"><entry><title>Local SEO for your website</title><updated>${date}</updated><link rel="self" href="https://news.example.com/api/seo"/><link rel="alternate" href="https://news.example.com/seo"/><summary type="html">&lt;p&gt;${excerpt}&lt;/p&gt;</summary></entry><entry xml:lang="pt-BR"><title>SEO local para clínicas</title><updated>${date}</updated><link href="https://news.example.com/portuguese"/><summary>${excerpt}</summary></entry></feed>`;
  const result = await collectArticles([source], settings, fetchXml(xml));
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].url, "https://news.example.com/seo");
  assert.equal(result.articles[0].excerpt, excerpt);
});

test("uses short RSS description instead of duplicated full articles, retaining content-only entries", async () => {
  const full = '<content:encoded><![CDATA[<p>' + 'Duplicated full article. '.repeat(4000) + '</p>]]></content:encoded>';
  const first = item("Clearer appointment booking", "https://news.example.com/booking").replace("</item>", full + "</item>");
  const second = `<item><title>Website customer experience</title><link>https://news.example.com/customer</link><pubDate>${recent}</pubDate><content:encoded><![CDATA[<p>${excerpt}</p>]]></content:encoded></item>`;
  const result = await collectArticles([source], settings, fetchXml(rss(first, second)));
  assert.equal(result.errors.length, 0);
  assert.equal(result.articles.length, 2);
  assert.ok(result.articles.every((article) => article.excerpt === excerpt));
});

test("skips missing or empty RSS excerpts without discarding other articles", async () => {
  // Given: publishers can include a blank excerpt alongside usable business articles.
  const missing = item("Website with no excerpt", "https://news.example.com/missing")
    .replace(/<description>[\s\S]*?<\/description>/, "");
  const blank = item("Website with an empty excerpt", "https://news.example.com/blank", recent, "");
  const valid = item("Clear appointment booking on your website", "https://news.example.com/valid");

  // When: the whole feed is read, incomplete entries must not fail the source.
  const result = await collectArticles([source], settings, fetchXml(rss(missing, blank, valid)));

  // Then: the useful article is retained and neither missing excerpt is invented.
  assert.equal(result.errors.length, 0);
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].url, "https://news.example.com/valid");
  assert.equal(result.articles[0].excerpt, excerpt);
});

test("rejects Portuguese, Brazilian and private hosts without requesting them", async () => {
  let requests = 0;
  const bad = [
    { ...source, id: "pt", language: "pt-PT" },
    { ...source, id: "br", url: "https://site.com.br/feed" },
    { ...source, id: "ip", url: "https://127.0.0.1/feed" },
    { ...source, id: "lan", url: "https://service.internal/feed" },
    { ...source, id: "disabled", enabled: false },
  ];
  const result = await collectArticles(bad, settings, (async () => { requests++; return new Response(rss()); }) as Fetcher);
  assert.equal(requests, 0);
  assert.equal(result.articles.length, 0);
  assert.equal(result.errors.length, 3);
});

test("validates redirects before following them", async () => {
  let requests = 0;
  const result = await collectArticles([source], settings, (async (_url, init) => {
    requests++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://[::1]/feed" } });
  }) as Fetcher);
  assert.equal(requests, 1);
  assert.equal(result.articles.length, 0);
  assert.equal(result.errors.length, 1);
});

test("bounds chunked bodies and rejects XML declarations that could expand entities", async () => {
  const oversized = await collectArticles([source], settings, fetchXml("x".repeat(512_001)));
  assert.match(oversized.errors[0], /limite de tamanho/);
  const entity = await collectArticles([source], settings, fetchXml('<!DOCTYPE rss [<!ENTITY x "boom">]><rss><channel/></rss>'));
  assert.match(entity.errors[0], /RSS\/Atom inválido/);
  const malformed = await collectArticles([source], settings, fetchXml("<rss><channel>"));
  assert.equal(malformed.articles.length, 0);
  assert.equal(malformed.errors.length, 1);
});

test("continues with working sources when another feed fails", async () => {
  const second = { ...source, id: "second", name: "Other Business News", url: "https://news.example.com/other" };
  const result = await collectArticles([source, second], settings, (async (url) => String(url).endsWith("/other")
    ? new Response(rss(item("Local SEO for clinics", "https://news.example.com/seo")))
    : new Response("error", { status: 503 })) as Fetcher);
  assert.equal(result.articles.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /HTTP 503/);
});

test("demo article is clearly illustrative and date can be controlled", () => {
  const article = createDemoArticle(new Date("2026-10-22T12:00:00Z"));
  assert.equal(article.publishedAt, "2026-10-22T12:00:00.000Z");
  assert.match(article.excerpt, /illustrative example/);
});
