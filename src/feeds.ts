import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Article, Fetcher, Settings, Source } from "./types.ts";

const MAX_FEED_BYTES = 512_000;
const MAX_SOURCES = 12;
const MAX_ITEMS_PER_SOURCE = 60;
const TRACKING_PARAMETERS = /^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|ref_src)$/i;
const BUSINESS_TOPICS = /\b(marketing|seo|search engine|local search|google business|business profile|reputation|reviews?|booking|appointments?|scheduling|customer experience|customer service|client experience|client retention|customer retention|conversion|website|web design|online presence|lead generation|leads|automation|whatsapp|no.show|reception|practice management|business growth|salon management|spa management|email campaign|digital advertising|social media|accessibility|data privacy|cybersecurity)\b/i;
const MEDICAL_TOPICS = /\b(dosage|contraindication|side effects?|clinical trial|medical advice|injection technique|treatment protocol|diagnosis|prescription|adverse event)\b/i;

/** Only configured, public HTTPS hosts are ever fetched. IP literals are unsupported. */
export function publicHttpsUrl(value: string): URL {
  if (value.length > 2048) throw new Error("A fonte possui uma URL muito longa.");
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !host.includes(".") || host.includes(":") || /^[\d.]+$/.test(host) ||
      /(^|\.)(localhost|local|internal|test|invalid|onion|arpa)$/.test(host) ||
      /(^|\.)(localhost\.localdomain|nip\.io|sslip\.io|localtest\.me|lvh\.me)$/.test(host)) {
    throw new Error("A fonte precisa usar um domínio público com HTTPS.");
  }
  url.hostname = host;
  return url;
}

function foreignUrl(url: URL): boolean {
  return !url.hostname.endsWith(".br");
}

function isPortuguese(language: string): boolean {
  return /^pt(?:[-_]|$)|portugu[eê]s/i.test(language.trim());
}

function sameWebsite(url: URL, website: URL): boolean {
  const base = website.hostname.replace(/^www\./, "");
  const host = url.hostname.replace(/^www\./, "");
  return host === base || host.endsWith(`.${base}`);
}

function canonicalUrl(value: string, website: URL): string {
  const url = publicHttpsUrl(new URL(value, website).href);
  if (!foreignUrl(url) || !sameWebsite(url, website)) throw new Error("Artigo fora do domínio autorizado.");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

async function articleId(url: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function asArray(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value !== null && typeof value === "object" ? textValue(record(value)["#text"]) : "";
}

function cleanText(value: unknown, max: number): string {
  return textValue(value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_match, code: string) => {
      const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    })
    .replace(/&(nbsp|amp|quot|apos|lt|gt);/g, (_match, name: string) => ({ nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[name] ?? " "))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

export function isBusinessArticle(article: Pick<Article, "title" | "excerpt">): boolean {
  return BUSINESS_TOPICS.test(`${article.title} ${article.excerpt}`) && !MEDICAL_TOPICS.test(article.title);
}

/** Body is bounded while streaming, including chunked responses with no Content-Length. */
export async function readLimitedText(response: Response, limit: number): Promise<string> {
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > limit) {
    await response.body?.cancel();
    throw new Error("Resposta excedeu o limite de tamanho.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error("Resposta excedeu o limite de tamanho.");
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function fetchFeed(source: Source, fetcher: Fetcher): Promise<string> {
  let url = publicHttpsUrl(source.url);
  if (!foreignUrl(url)) throw new Error("Fonte brasileira ignorada.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    // Redirects are followed explicitly so they cannot bypass the hostname checks.
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetcher(url.href, {
        redirect: "manual", signal: controller.signal,
        headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9", "User-Agent": "ClinicContentBot/0.1 (+RSS reader)" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3) throw new Error("Redirecionamento inválido na fonte.");
        url = publicHttpsUrl(new URL(location, url).href);
        if (!foreignUrl(url)) throw new Error("Fonte brasileira ignorada.");
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Fonte retornou HTTP ${response.status}.`);
      }
      return await readLimitedText(response, MAX_FEED_BYTES);
    }
    throw new Error("Redirecionamento inválido na fonte.");
  } finally {
    clearTimeout(timeout);
  }
}

async function parseFeed(xml: string, source: Source, settings: Settings): Promise<Article[]> {
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) throw new Error("RSS/Atom inválido.");
  // WordPress feeds often embed the entire article as well as a short description.
  // We only need the excerpt; avoiding those duplicated HTML blocks saves parser CPU.
  // Entries without a usable description retain content:encoded as a fallback.
  const excerptsXml = xml.replace(/<item\b[^>]*>[\s\S]*?<\/item\s*>/gi, (item) => {
    const description = item.match(/<description\b[^>]*>([\s\S]*?)<\/description\s*>/i);
    return description && cleanText(description[1], 2500).length >= 40
      ? item.replace(/<content:encoded\b[^>]*>[\s\S]*?<\/content:encoded\s*>/gi, "")
      : item;
  });
  if (XMLValidator.validate(excerptsXml) !== true) throw new Error("RSS/Atom inválido.");
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: true, parseTagValue: false, trimValues: true });
  const parsed = record(parser.parse(excerptsXml));
  const channel = record(record(parsed.rss).channel);
  const atom = record(parsed.feed);
  if (!Object.keys(channel).length && !Object.keys(atom).length) throw new Error("Formato da fonte não é RSS/Atom.");
  const language = textValue(channel.language || atom["@_xml:lang"] || source.language);
  if (isPortuguese(language)) return [];
  const website = publicHttpsUrl(source.website);
  if (!foreignUrl(website)) return [];
  const entries = asArray(channel.item ?? atom.entry).slice(0, MAX_ITEMS_PER_SOURCE);
  const now = Date.now();
  const maxAge = Math.max(1, Math.min(180, settings.maxAgeDays)) * 86_400_000;
  const output: Article[] = [];
  for (const entry of entries) {
    const item = record(entry);
    const entryLanguage = textValue(item["@_xml:lang"] || language);
    if (isPortuguese(entryLanguage)) continue;
    const published = textValue(item.pubDate || item.published || item.updated || item["dc:date"]);
    const time = Date.parse(published);
    // Missing/invalid dates are skipped rather than presented as fresh information.
    if (!Number.isFinite(time) || now - time > maxAge || time > now + 86_400_000) continue;
    const links = asArray(item.link);
    const atomLink = links.map(record).find((link) => !link["@_rel"] || link["@_rel"] === "alternate");
    const link = textValue(atomLink?.["@_href"] || item.link || (record(item.guid)["@_isPermaLink"] !== "false" ? item.guid : ""));
    if (!link) continue;
    let url: string;
    try { url = canonicalUrl(link, website); } catch { continue; }
    const article: Article = {
      id: await articleId(url), sourceId: source.id, sourceName: source.name,
      title: cleanText(item.title, 240), url, publishedAt: new Date(time).toISOString(),
      excerpt: cleanText(item.description || item.summary || item.content || item["content:encoded"], 2500),
      language: entryLanguage || source.language,
    };
    if (article.title && article.excerpt.length >= 40 && isBusinessArticle(article)) output.push(article);
  }
  return output;
}

export async function collectArticles(sources: Source[], settings: Settings, fetcher: Fetcher = fetch): Promise<{ articles: Article[]; errors: string[] }> {
  const errors: string[] = [];
  const articles: Article[] = [];
  const enabled = sources.filter((source) => source.enabled && !isPortuguese(source.language)).slice(0, MAX_SOURCES);
  // A small fixed batch avoids unbounded requests when the configuration grows.
  for (let index = 0; index < enabled.length; index += 3) {
    const batch = await Promise.all(enabled.slice(index, index + 3).map(async (source) => {
      try { return await parseFeed(await fetchFeed(source, fetcher), source, settings); }
      catch (error) {
        const message = error instanceof Error && /^(Fonte |RSS\/Atom |Formato |A fonte |Resposta |Redirecionamento )/.test(error.message)
          ? error.message : "Não foi possível ler a fonte.";
        errors.push(`${cleanText(source.name, 80)}: ${message}`);
        return [];
      }
    }));
    articles.push(...batch.flat());
  }
  const seen = new Set<string>();
  const titles = new Set<string>();
  const unique = articles.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).filter((article) => {
    const title = article.title.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (seen.has(article.id) || titles.has(title)) return false;
    seen.add(article.id);
    titles.add(title);
    return true;
  });
  // Keep older eligible references available after newer ones were already used.
  // The pipeline separately caps how many unused candidates can call the LLM.
  return { articles: unique.slice(0, 30), errors };
}

export function createDemoArticle(now = new Date()): Article {
  return {
    id: "demo-appointment-reminders", sourceId: "demo", sourceName: "Exemplo demonstrativo",
    title: "A simpler online booking experience for a local business",
    url: "https://example.com/demo/online-booking", publishedAt: now.toISOString(), language: "en",
    excerpt: "A local business can make its online booking experience clearer by displaying services, opening hours and contact details. Appointment reminders and a simple cancellation process can help clients organize their visit. This is an illustrative example, not an external news article.",
  };
}
