import { defaultSettings } from "../src/settings.ts";
import { createDemoArticle } from "../src/feeds.ts";
import { createDemoDraft } from "../src/gemini.ts";
import type { Env, Illustration, Post, Repository, Run, Settings } from "../src/types.ts";

export const configuredSettings = (): Settings => ({ ...structuredClone(defaultSettings), brandName: "Solv", mode: "auto", paused: false, brandHandle: "@solv_tec", sources: [{ id: "foreign", name: "Foreign Clinic News", url: "https://news.example.com/feed.xml", website: "https://news.example.com", language: "en", enabled: true }], channels: [{ id: "instagram-1", name: "@solv_tec", service: "instagram", enabled: true }] });
export const configuredEnv = (): Env => ({ ADMIN_TOKEN: "test-admin-token-with-enough-length", GEMINI_API_KEY: "test-gemini-key", BUFFER_API_KEY: "test-buffer-key", CF_ACCOUNT_ID: "a".repeat(32), CF_BROWSER_API_TOKEN: "test-cf-key", PUBLIC_BASE_URL: "https://clinic-content-bot.workers.dev" } as Env);
export const preparedPost = (): Post => ({ id: "local-post", articleId: "local-article", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), content: createDemoDraft(createDemoArticle(), configuredSettings()), status: "ready", imageReady: true, deliveries: [], demo: false });

export class MemoryRepository implements Repository {
  settings: Settings;
  posts = new Map<string, Post>();
  runs = new Map<string, Run>();
  images = new Map<string, ArrayBuffer>();
  illustrations = new Map<string, Illustration>();
  claims = new Map<string, string>();
  locked = false;
  dailyCount = 0;
  releases = 0;
  postWrites: Post[] = [];
  constructor(settings = configuredSettings()) { this.settings = structuredClone(settings); }
  async getSettings() { return structuredClone(this.settings); }
  async saveSettings(settings: Settings) { this.settings = structuredClone(settings); }
  async listPosts() { return structuredClone([...this.posts.values()]); }
  async getPost(id: string) { return structuredClone(this.posts.get(id) ?? null); }
  async savePost(post: Post) { this.posts.set(post.id, structuredClone(post)); this.postWrites.push(structuredClone(post)); }
  async listRuns() { return structuredClone([...this.runs.values()]); }
  async saveRun(run: Run) { this.runs.set(run.id, structuredClone(run)); }
  async isArticleUsed(id: string) { return this.claims.has(id); }
  async claimArticle(articleId: string, postId: string) { if (this.claims.has(articleId)) return false; this.claims.set(articleId, postId); return true; }
  async countPostsOnDate(_date: string, _timezone: string) { return this.dailyCount; }
  async saveImage(id: string, image: ArrayBuffer) { this.images.set(id, image.slice(0)); }
  async getImage(id: string) { return this.images.get(id)?.slice(0) ?? null; }
  async saveIllustration(id: string, image: Illustration) { this.illustrations.set(id,structuredClone(image)); }
  async getIllustration(id: string) { return structuredClone(this.illustrations.get(id) ?? null); }
  async acquireLock(_name: string, _ttl: number) { if (this.locked) return false; this.locked = true; return true; }
  async releaseLock(_name: string) { this.locked = false; this.releases++; }
}

export function feedResponse() {
  return new Response(`<rss version="2.0"><channel><title>Foreign News</title><language>en</language><item><title>Improve online booking and customer experience</title><link>https://news.example.com/booking</link><pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate><description>A clear online booking journey helps customers understand services and opening hours, and contact a clinic to schedule an appointment.</description></item></channel></rss>`, { headers: { "Content-Type": "application/rss+xml" } });
}
export const modelDraft = () => ({ title: "Facilite o agendamento", subtitle: "Deixe o próximo passo claro para seu cliente.", caption: "Confira se os serviços, horários e contato para agendamento estão fáceis de encontrar no seu site.", takeaways: ["Revise a experiência pelo celular."], hashtags: ["#GestaoDeClinicas"], relevance: 91, reason: "Orientação prática para o atendimento da clínica.", topic: "Agendamento online", shouldPost: true });
export const geminiResponse = (draft = modelDraft()) => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(draft) }] } }] }), { headers: { "Content-Type": "application/json" } });
export const testJpeg = () => new Uint8Array([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,127,255,217]);
