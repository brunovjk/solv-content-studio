import { safePublicUrl } from "./settings.ts";
import type { DraftContent, Post } from "./types.ts";

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${label}: texto inválido.`);
  return value.trim();
}

/** Authored campaigns are saved only as drafts; importing never queues AI or publication. */
export function validateDraftImport(input: Record<string, unknown>, now = new Date()): Post[] {
  if (!Array.isArray(input.drafts) || !input.drafts.length || input.drafts.length > 21) throw new Error("Importe entre 1 e 21 rascunhos por vez.");
  const posts = input.drafts.map((item: unknown, index: number): Post => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Rascunho inválido.");
    const draft = item as Record<string, unknown>;
    if (typeof draft.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(draft.id)) throw new Error("Cada rascunho exige um UUID válido e estável.");
    const raw = draft.content;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Conteúdo inválido.");
    const c = raw as Record<string, unknown>;
    const sourceUrl = text(c.sourceUrl, "Referência", 2048);
    if (!safePublicUrl(sourceUrl)) throw new Error("A referência exige uma URL HTTPS pública.");
    const list = (value: unknown, label: string, min: number, max: number, limit: number): string[] => {
      if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${label}: lista inválida.`);
      return value.map(v => text(v, label, limit));
    };
    const hashtags = list(c.hashtags, "Hashtags", 0, 5, 32);
    if (hashtags.some(tag => !/^#[\p{L}\p{N}_]+$/u.test(tag))) throw new Error("Hashtag inválida.");
    const content: DraftContent = {
      origin: "authored",
      title: text(c.title, "Título", 88), artTitle: text(c.artTitle, "Chamada da capa", 54),
      subtitle: text(c.subtitle, "Subtítulo", 150), caption: text(c.caption, "Legenda", 1500),
      imagePrompt: c.imagePrompt === undefined ? undefined : text(c.imagePrompt, "Descrição visual", 1000),
      takeaways: list(c.takeaways, "Dicas", 1, 3, 140), hashtags: [...new Set(hashtags)],
      sourceUrl, sourceName: text(c.sourceName, "Origem", 100), relevance: 100,
      reason: "Conteúdo autoral importado para revisão; não foi publicado nem avaliado por uma IA.",
      topic: text(c.topic, "Tema", 60), shouldPost: true,
    };
    if (content.artTitle!.split(/\s+/).length > 8) throw new Error("A chamada da capa permite até 8 palavras.");
    if (/<\/?[a-z][^>]*>/i.test([content.title, content.artTitle, content.subtitle, content.caption, ...content.takeaways].join(" "))) throw new Error("Use texto simples no conteúdo.");
    // Reverse timestamps retain the supplied editorial order in the existing newest-first dashboard.
    const createdAt = new Date(now.getTime() - index).toISOString();
    return {id:draft.id.toLowerCase(), articleId:`authored:${draft.id.toLowerCase()}`, createdAt, updatedAt:createdAt, content, status:"draft", imageReady:false, deliveries:[], demo:false};
  });
  if (new Set(posts.map(p => p.id)).size !== posts.length) throw new Error("Rascunhos com identificadores repetidos.");
  return posts;
}
