import { defaultSettings, localClock } from "./settings.ts";
import type { Illustration, Post, Repository, Run, Settings } from "./types.ts";

export class D1Repository implements Repository {
  private db: D1Database;
  private owners = new Map<string, string>();
  constructor(db: D1Database) { this.db = db; }

  async getSettings(): Promise<Settings> {
    const row = await this.db.prepare("SELECT value FROM settings WHERE id = 1").first<{ value: string }>();
    return row ? JSON.parse(row.value) as Settings : structuredClone(defaultSettings);
  }
  async saveSettings(settings: Settings) {
    await this.db.prepare("INSERT INTO settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").bind(JSON.stringify(settings)).run();
  }
  async listPosts(): Promise<Post[]> {
    const rows = await this.db.prepare("SELECT value FROM posts WHERE json_extract(value,'$.archivedAt') IS NULL ORDER BY created_at DESC LIMIT 120").all<{value:string}>();
    return rows.results.map(r => JSON.parse(r.value) as Post);
  }
  async getPost(id: string): Promise<Post | null> {
    const row = await this.db.prepare("SELECT value FROM posts WHERE id=?").bind(id).first<{value:string}>();
    return row ? JSON.parse(row.value) as Post : null;
  }
  async savePost(post: Post) {
    await this.db.prepare("INSERT INTO posts(id,created_at,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").bind(post.id, post.createdAt, JSON.stringify(post)).run();
  }
  async listRuns(): Promise<Run[]> {
    const rows = await this.db.prepare("SELECT value FROM runs ORDER BY started_at DESC LIMIT 40").all<{value:string}>();
    return rows.results.map(r => JSON.parse(r.value) as Run);
  }
  async saveRun(run: Run) {
    await this.db.prepare("INSERT INTO runs(id,started_at,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").bind(run.id, run.startedAt, JSON.stringify(run)).run();
  }
  async isArticleUsed(id: string) {
    return Boolean(await this.db.prepare("SELECT id FROM articles WHERE id=?").bind(id).first());
  }
  async claimArticle(articleId: string, postId: string) {
    const result = await this.db.prepare("INSERT OR IGNORE INTO articles(id,post_id,claimed_at) VALUES(?,?,?)").bind(articleId, postId, Date.now()).run();
    return result.meta.changes === 1;
  }
  async countPostsOnDate(date: string, timezone: string) {
    // A full UTC day does not match the owner's local day around midnight.
    const start = new Date(`${date}T00:00:00Z`).getTime() - 86400000;
    const end = start + 3 * 86400000;
    const rows = await this.db.prepare("SELECT value FROM posts WHERE created_at >= ? AND created_at < ?").bind(new Date(start).toISOString(), new Date(end).toISOString()).all<{value:string}>();
    return rows.results.map(r => JSON.parse(r.value) as Post).filter(p => !p.demo && !p.testBatchId && p.content.origin !== "authored" && p.status !== "rejected" && localClock(new Date(p.createdAt), timezone).date === date).length;
  }
  async saveImage(postId: string, image: ArrayBuffer) {
    if (image.byteLength > 1500000) throw new Error("A arte excedeu o tamanho suportado nesta versão.");
    await this.db.prepare("INSERT INTO images(post_id,data) VALUES(?,?) ON CONFLICT(post_id) DO UPDATE SET data=excluded.data").bind(postId, image).run();
  }
  async getImage(postId: string): Promise<ArrayBuffer | null> {
    const row = await this.db.prepare("SELECT data FROM images WHERE post_id=?").bind(postId).first<{data: number[] | ArrayBuffer}>();
    return row ? (row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data).buffer) : null;
  }
  async saveIllustration(postId: string, image: Illustration) {
    if (image.mimeType !== "image/jpeg" || image.data.byteLength > 1250000) throw new Error("Ilustração inválida ou grande demais.");
    await this.db.prepare("INSERT INTO illustrations(post_id,data) VALUES(?,?) ON CONFLICT(post_id) DO UPDATE SET data=excluded.data").bind(postId, image.data).run();
  }
  async getIllustration(postId: string): Promise<Illustration | null> {
    const row = await this.db.prepare("SELECT data FROM illustrations WHERE post_id=?").bind(postId).first<{data: number[] | ArrayBuffer}>();
    return row ? {mimeType:"image/jpeg",data:row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data).buffer} : null;
  }
  async acquireLock(name: string, ttlSeconds: number) {
    const owner = crypto.randomUUID();
    const result = await this.db.prepare("INSERT INTO locks(name,owner,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at WHERE locks.expires_at < ?").bind(name, owner, Date.now()+ttlSeconds*1000, Date.now()).run();
    if (result.meta.changes === 1) this.owners.set(name, owner);
    return result.meta.changes === 1;
  }
  async releaseLock(name: string) {
    const owner = this.owners.get(name);
    if (owner) await this.db.prepare("DELETE FROM locks WHERE name=? AND owner=?").bind(name, owner).run();
    this.owners.delete(name);
  }
  async busy() {
    return Boolean(await this.db.prepare("SELECT name FROM locks WHERE name='pipeline' AND expires_at > ?").bind(Date.now()).first());
  }
}
