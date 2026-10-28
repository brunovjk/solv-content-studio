import type { DraftContent, Env, Illustration, Settings } from "./types.ts";

export const ILLUSTRATION_MODEL = "@cf/black-forest-labs/flux-1-schnell";

// Keep the source illustration small enough for a D1 row and bounded HTML previews.
const MAX_IMAGE_BYTES = 1_250_000;
const MAX_ENCODED_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const GENERATION_TIMEOUT_MS = 60_000;
const MAX_PROMPT_LENGTH = 2048;
const INVALID_IMAGE = "A imagem gerada é inválida. Gere outra arte para este post.";

function editorialScene(content: DraftContent): string {
  // Classify locally: neither the source article nor the caption goes to the image model.
  const subject = `${content.topic} ${content.title}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/site|busca|google|presenca|encontr|pagina|digital/.test(subject)) {
    return "A sculptural smartphone beside an abstract local business storefront, connected by a clear luminous pathway, suggesting a clear online discovery and booking journey.";
  }
  if (/financ|fatura|gestao|cresci|receita|negocio/.test(subject)) {
    return "A sculptural business operations dashboard made of unlabelled geometric tiles, an orderly stepped composition and organized appointment blocks, suggesting clarity and sustainable business growth.";
  }
  return "A dramatic sculptural appointment calendar with blank dark tiles, several glowing appointment blocks and one conspicuous empty slot, beside an abstract smartphone, suggesting appointment booking and customer follow-up.";
}

function visualBrief(value: unknown): string {
  if (typeof value !== "string") return "";
  const brief = value.normalize("NFKC").slice(0, 1000)
    // A harmless negative constraint is common in Gemini and authored briefs. Strip only its
    // explicit forbidden-item list; a following positive request ("then draw a logo") still fails.
    .replace(/\b(?:no|without)\s+(?:any\s+)?(?:text|words?|letters?|lettering|typography|logos?|watermarks?|branding|numbers?)(?:\s*(?:,|or|and)\s*(?:text|words?|letters?|lettering|typography|logos?|watermarks?|branding|numbers?))*\b/gi, " ");
  // Optional model text is untrusted. Reject instructions, links and named platforms,
  // then retain a short descriptive phrase inside our fixed editorial direction.
  if (/(?:[a-z]+:\/\/|www\.|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|@|ignore|instruction|system|secret|token|api\s*key|reveal|prompt|watermark|logo|brand|typograph|\btext\b|\bletters?\b|phorest|buffer|google|microsoft|openai|gemini|chatgpt|instagram|facebook|whatsapp|patient|syringe|injection|surgery)/i.test(brief)) return "";
  return brief.replace(/[^a-zA-Z0-9 ,.'()\-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

type VisualSettings = Pick<Settings, "brandColor"> & { visualGuidelines?: string };

function clientDirection(value: unknown): string {
  if (typeof value !== "string") return "";
  const direction = value.normalize("NFKC").slice(0, 1000);
  // Client-owned style notes may guide aesthetics, never add a remote resource or execution instruction.
  if (/(?:https?:\/\/|www\.|[<>]|ignore|system|secret|token|api\s*key|reveal|patient|syringe|injection|surgery)/i.test(direction)) return "";
  return direction.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function illustrationPrompt(content: DraftContent, settings?: VisualSettings): string {
  const scene = (visualBrief(content.imagePrompt) || editorialScene(content))
    .replace(/\b(?:coral|orange|navy|pink|lime|purple)\b/gi, "").replace(/\s+/g, " ").trim().slice(0, 400);
  const accent = /^#[\da-f]{6}$/i.test(settings?.brandColor || "") ? settings!.brandColor : "#64b5ff";
  const direction = clientDirection(settings?.visualGuidelines).slice(0, 400);
  const introduction = [
    "Conceptual editorial illustration for a business social post, without assuming a specific industry.",
    "One oversized main object, at most two supporting objects. Tactile materials, precise geometry, dramatic lighting, soft shadows. No clutter, stock-photo cliches, generic dashboards or fabricated performance charts.",
    `Restricted palette: nearly black #080b12, client accent ${accent}, subtle cool cyan light, white highlight. High contrast, restrained composition, legible at phone size. This palette overrides scene colors.`,
    "Main object in the lower half; plain dark negative space across the upper half for a headline added later. Clear in a vertical 4:5 crop.",
  ].join(" ");
  const restrictions = "No text, letters, words, numbers, logos, watermarks, signatures, readable interfaces or competitor branding. No people, patients, medical procedures, medical advice or before-and-after imagery. Do not render any typography. Concept only, never evidence of a real customer project or result.";
  const aestheticDetails = [`Scene description: ${scene}`, ...(direction ? [`Client art direction, aesthetics only: ${direction}`] : [])].join(" ");
  // FLUX.1 schnell's official prompt schema caps input at 2048 characters. Budget only
  // aesthetic details; mandatory restrictions are always retained verbatim at the end.
  const remaining = Math.max(0, MAX_PROMPT_LENGTH - introduction.length - restrictions.length - 2);
  return `${introduction} ${aestheticDetails.slice(0, remaining).trim()} ${restrictions}`;
}

/** Validate a JPEG again whenever persisted bytes are embedded into an HTML preview. */
function jpegBytes(illustration: Illustration): Uint8Array {
  if (illustration.mimeType !== "image/jpeg" || !(illustration.data instanceof ArrayBuffer)) throw new Error(INVALID_IMAGE);
  const bytes = new Uint8Array(illustration.data);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("A imagem excedeu o limite de 1,25 MB. Gere outra arte para este post.");
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error(INVALID_IMAGE);

  // Inspect JPEG marker lengths and frame dimensions before accepting scan data.
  let offset = 2;
  let hasFrame = false;
  while (offset + 1 < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) throw new Error(INVALID_IMAGE);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) throw new Error(INVALID_IMAGE);
    if (offset + 2 > bytes.length - 2) throw new Error(INVALID_IMAGE);
    const segmentLength = bytes[offset] * 256 + bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length - 2) throw new Error(INVALID_IMAGE);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (segmentLength < 8) throw new Error(INVALID_IMAGE);
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error(INVALID_IMAGE);
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (!hasFrame || segmentLength < 6 || offset + segmentLength >= bytes.length - 2) throw new Error(INVALID_IMAGE);
      return bytes;
    }
    offset += segmentLength;
  }
  throw new Error(INVALID_IMAGE);
}

function decodeImage(output: unknown): Illustration {
  if (!output || typeof output !== "object" || !("image" in output) || typeof output.image !== "string") throw new Error(INVALID_IMAGE);
  const encoded = output.image;
  if (encoded.length > MAX_ENCODED_LENGTH) throw new Error("A imagem excedeu o limite de 1,25 MB. Gere outra arte para este post.");
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error(INVALID_IMAGE);
  let binary: string;
  try {
    binary = atob(encoded);
    if (btoa(binary) !== encoded) throw new Error();
  } catch { throw new Error(INVALID_IMAGE); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const illustration: Illustration = { data: bytes.buffer, mimeType: "image/jpeg" };
  jpegBytes(illustration);
  return illustration;
}

export function illustrationDataUrl(illustration: Illustration): string {
  const bytes = jpegBytes(illustration);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32_768) binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

export async function generateIllustration(content: DraftContent, env: Env, settings?: VisualSettings): Promise<Illustration> {
  if (!env.AI) throw new Error("Configure o binding AI do Cloudflare para gerar imagens com FLUX.");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol("image-generation-timeout");
  let output: unknown;
  try {
    output = await Promise.race([
      env.AI.run(ILLUSTRATION_MODEL, { prompt: illustrationPrompt(content, settings), steps: 4 }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(expired), GENERATION_TIMEOUT_MS); }),
    ]);
  } catch (error) {
    if (error === expired) throw new Error("A geração da imagem excedeu 60 segundos. Tente novamente mais tarde.");
    throw new Error("A geração da imagem por IA falhou. Confira a disponibilidade e a cota gratuita do Workers AI.");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  return decodeImage(output);
}
