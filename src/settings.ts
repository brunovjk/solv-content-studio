import type { Settings, Source } from "./types.ts";

export const defaultSettings: Settings = {
  brandName: "Solv",
  brandHandle: "@solv.insta",
  brandColor: "#64b5ff",
  websiteUrl: "",
  offerSummary: "",
  editorialGuidelines: "",
  visualGuidelines: "",
  audience: "Donos, gestores e profissionais de clínicas de estética, salões e negócios de beleza com operação ativa",
  region: "Chapecó e Oeste de Santa Catarina, Brasil",
  topics: ["sites para negócios de beleza", "presença digital", "busca local e Google", "serviços e informações claras", "contato pelo WhatsApp", "acesso à agenda existente"],
  mode: "approval",
  paused: true,
  daysOfWeek: [1, 3, 5],
  hour: 9,
  timezone: "America/Sao_Paulo",
  maxAgeDays: 30,
  maxCandidates: 3,
  minRelevance: 75,
  maxPostsPerDay: 1,
  sources: [
    { id: "phorest", name: "Phorest — gestão de beleza", url: "https://www.phorest.com/blog/feed/", website: "https://www.phorest.com", language: "en", enabled: true },
    { id: "buffer", name: "Buffer — marketing digital (feed grande, opcional)", url: "https://buffer.com/resources/rss/", website: "https://buffer.com", language: "en", enabled: false },
    { id: "google-search", name: "Google Search Central", url: "https://developers.google.com/search/blog/feed.xml", website: "https://developers.google.com", language: "en", enabled: true },
  ],
  channels: [],
};

export function safePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      host.includes(".") && !host.endsWith(".local") && !host.endsWith(".internal") &&
      !host.endsWith(".test") && !host.endsWith(".invalid") && !host.endsWith(".example") && !host.endsWith(".localhost") &&
      !host.endsWith(".localdomain") && !/(^|\.)(nip\.io|sslip\.io|localtest\.me|lvh\.me)$/.test(host) &&
      !/^\d/.test(host) && !host.includes(":") && host !== "localhost";
  } catch { return false; }
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}: texto inválido.`);
  return value.trim();
};

const optionalText = (value: unknown, label: string, max: number): string => {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${label}: texto inválido.`);
  return value.trim();
};

export function validateSettings(input: unknown): Settings {
  if (!input || typeof input !== "object") throw new Error("Configuração inválida.");
  const value = input as Settings;
  const websiteUrl = optionalText(value.websiteUrl, "Site da marca", 2000);
  if (websiteUrl && !safePublicUrl(websiteUrl)) throw new Error("Site da marca exige uma URL HTTPS pública, sem credenciais.");
  const offerSummary = optionalText(value.offerSummary, "Oferta", 3500);
  const editorialGuidelines = optionalText(value.editorialGuidelines, "Direção editorial", 2500);
  const visualGuidelines = optionalText(value.visualGuidelines, "Direção visual", 1000);
  if (!["auto", "approval"].includes(value.mode)) throw new Error("Modo inválido.");
  if (typeof value.paused !== "boolean") throw new Error("Pausa inválida.");
  if (!/^#[0-9a-f]{6}$/i.test(value.brandColor)) throw new Error("Cor inválida.");
  if (!Array.isArray(value.daysOfWeek) || value.daysOfWeek.length > 7 || value.daysOfWeek.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("Dias inválidos.");
  if (!Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23) throw new Error("Horário inválido.");
  if (typeof value.timezone !== "string" || !value.timezone || value.timezone.length > 80) throw new Error("Fuso horário inválido.");
  try { new Intl.DateTimeFormat("pt-BR", { timeZone: value.timezone }).format(); } catch { throw new Error("Fuso horário inválido."); }
  const integer = (n: number, low: number, high: number, label: string) => {
    if (!Number.isInteger(n) || n < low || n > high) throw new Error(`${label}: limite inválido.`);
    return n;
  };
  if (!Array.isArray(value.topics) || !value.topics.length || value.topics.length > 12) throw new Error("Informe entre 1 e 12 assuntos.");
  if (!Array.isArray(value.sources) || value.sources.length > 8) throw new Error("Use no máximo 8 fontes nesta versão.");
  const sources: Source[] = value.sources.map(s => {
    if (!safePublicUrl(s.url) || !safePublicUrl(s.website)) throw new Error("Fontes exigem URLs HTTPS públicas, sem credenciais.");
    if (/^pt(?:[-_]|$)/i.test(s.language) || new URL(s.website).hostname.endsWith(".br")) throw new Error("Nesta versão, use fontes estrangeiras em outro idioma.");
    return { id: text(s.id, "Identificador da fonte", 80), name: text(s.name, "Nome da fonte", 100), url: s.url, website: s.website, language: text(s.language, "Idioma", 12), enabled: Boolean(s.enabled) };
  });
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error("Fontes com identificadores repetidos.");
  if (!Array.isArray(value.channels) || value.channels.length > 3) throw new Error("Use até 3 canais nesta versão.");
  const channels = value.channels.map(c => ({ id: text(c.id, "Canal", 150), name: text(c.name, "Nome do canal", 120), service: text(c.service, "Rede", 40), enabled: Boolean(c.enabled) }));
  if (new Set(channels.map(c => c.id)).size !== channels.length) throw new Error("Canais repetidos.");
  return {
    brandName: text(value.brandName, "Nome da marca", 50), brandHandle: text(value.brandHandle, "Perfil", 60),
    brandColor: value.brandColor, websiteUrl, offerSummary, editorialGuidelines, visualGuidelines, audience: text(value.audience, "Público", 250), region: text(value.region, "Região", 180),
    topics: value.topics.map(t => text(t, "Assunto", 100)), mode: value.mode, paused: value.paused,
    daysOfWeek: [...new Set(value.daysOfWeek)], hour: value.hour, timezone: value.timezone,
    maxAgeDays: integer(value.maxAgeDays, 1, 90, "Idade dos artigos"), maxCandidates: integer(value.maxCandidates, 1, 3, "Tentativas de IA"),
    minRelevance: integer(value.minRelevance, 50, 100, "Relevância"), maxPostsPerDay: integer(value.maxPostsPerDay, 1, 3, "Posts por dia"), sources, channels,
  };
}

export function localClock(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const get = (name: string) => parts.find(p => p.type === name)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}
