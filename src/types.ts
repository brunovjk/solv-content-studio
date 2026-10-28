export interface Source {
  id: string;
  name: string;
  url: string;
  website: string;
  language: string;
  enabled: boolean;
}

export interface Settings {
  brandName: string;
  brandHandle: string;
  brandColor: string;
  websiteUrl?: string;
  offerSummary?: string;
  editorialGuidelines?: string;
  visualGuidelines?: string;
  audience: string;
  region: string;
  topics: string[];
  mode: "auto" | "approval";
  paused: boolean;
  daysOfWeek: number[];
  hour: number;
  timezone: string;
  maxAgeDays: number;
  maxCandidates: number;
  minRelevance: number;
  maxPostsPerDay: number;
  sources: Source[];
  channels: Channel[];
}

export interface Channel {
  id: string;
  name: string;
  service: string;
  enabled: boolean;
}

export interface Article {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string;
  excerpt: string;
  language: string;
}

export interface DraftContent {
  origin?: "authored" | "reference";
  title: string;
  artTitle?: string;
  imagePrompt?: string;
  subtitle: string;
  caption: string;
  takeaways: string[];
  hashtags: string[];
  sourceUrl: string;
  sourceName: string;
  relevance: number;
  reason: string;
  topic: string;
  shouldPost: boolean;
}

export type PostStatus = "draft" | "rendering" | "ready" | "publishing" | "queued" | "published" | "needs_attention" | "rejected";

export interface Delivery {
  channelId: string;
  channelName: string;
  remoteId?: string;
  status: "pending" | "sending" | "queued" | "published" | "error" | "unknown";
  dueAt?: string;
  error?: string;
}

export interface Post {
  id: string;
  articleId: string;
  createdAt: string;
  updatedAt: string;
  content: DraftContent;
  status: PostStatus;
  imageReady: boolean;
  deliveries: Delivery[];
  demo: boolean;
  scheduledAt?: string;
  testBatchId?: string;
  archivedAt?: string;
  error?: string;
  visual?: { status: "ready" | "fallback"; model: string; createdAt: string; error?: string };
}

export interface Illustration { data: ArrayBuffer; mimeType: "image/jpeg"; }
export type BotJob = { type: "run"; demo: boolean; draftOnly?: boolean; scheduledAt?: string; testBatchId?: string; testChannelId?: string } | { type: "approve" | "visual" | "render"; postId: string };

export interface Run {
  id: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "success" | "skipped" | "error";
  message: string;
  postId?: string;
  candidates: number;
  demo: boolean;
  testBatchId?: string;
  scheduledAt?: string;
}

export interface Env {
  DB: D1Database;
  JOBS: Queue<BotJob>;
  AI?: { run(model: string, input: { prompt: string; steps: number }): Promise<unknown> };
  BROWSER?: { quickAction(action: "screenshot", options: BrowserRunScreenshotOptions): Promise<Response> };
  ADMIN_TOKEN?: string;
  EDITOR_TOKEN?: string;
  PARTNER_1_TOKEN?: string;
  PARTNER_2_TOKEN?: string;
  ALLOWED_ORIGINS?: string;
  IGNORED_CHANNEL_IDS?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  BUFFER_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  CF_BROWSER_API_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  DEMO_MODE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export type Fetcher = typeof fetch;

export interface Repository {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  listPosts(): Promise<Post[]>;
  getPost(id: string): Promise<Post | null>;
  savePost(post: Post): Promise<void>;
  listRuns(): Promise<Run[]>;
  saveRun(run: Run): Promise<void>;
  isArticleUsed(id: string): Promise<boolean>;
  claimArticle(articleId: string, postId: string): Promise<boolean>;
  countPostsOnDate(date: string, timezone: string): Promise<number>;
  saveImage(postId: string, image: ArrayBuffer): Promise<void>;
  getImage(postId: string): Promise<ArrayBuffer | null>;
  saveIllustration(postId: string, image: Illustration): Promise<void>;
  getIllustration(postId: string): Promise<Illustration | null>;
  acquireLock(name: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(name: string): Promise<void>;
}
