import type { DraftContent, Env, Fetcher, Illustration, Settings } from "./types.ts";
import { illustrationDataUrl } from "./visuals.ts";

const WIDTH = 1080;
const HEIGHT = 1350;
const MAX_PNG_BYTES = 1_500_000;
const RENDER_TIMEOUT = "A geração da imagem falhou ou excedeu o tempo limite.";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function short(value: string, limit: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const characters = Array.from(cleaned);
  return characters.length <= limit ? cleaned : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

/** Approximate Arial's uppercase advances so long titles stay within four lines. */
function headlineSize(title: string): number {
  const width = 924;
  const measure = (word: string) => Array.from(word.toLocaleUpperCase("pt-BR")).reduce((sum, letter) => {
    if (/[IÍÌÎÏ!.,:;'|]/u.test(letter)) return sum + 0.3;
    if (/[MW@%]/u.test(letter)) return sum + 0.91;
    return sum + 0.67;
  }, 0);
  const words = title.split(/\s+/u);
  for (let size = 144; size >= 64; size -= 2) {
    // Prefer shrinking the headline to splitting a meaningful word such as AGENDAMENTOS.
    if (words.some(word => measure(word) * size > width)) continue;
    let lines = 1;
    let line = 0;
    for (const word of words) {
      const advance = measure(word) * size;
      if (line && line + size * 0.3 + advance > width) { lines += 1; line = 0; }
      // Match overflow-wrap for unusually long words, including hostile input.
      lines += Math.max(0, Math.ceil(advance / width) - 1);
      line = (line ? line + size * 0.3 : 0) + Math.min(advance, width);
    }
    if (lines <= 4 && lines * size * 0.98 <= 496) return size;
  }
  return 64;
}

function highlightedTitle(title: string): string {
  const words = title.split(/\s+/u);
  const last = words.pop() || title;
  return `${escapeHtml(words.join(" "))}${words.length ? " " : ""}<span>${escapeHtml(last)}</span>`;
}

function palette(brandColor: string) {
  const color = /^#[\da-f]{6}$/i.test(brandColor) ? brandColor.toLowerCase() : "#64b5ff";
  // The headline accent always remains light against the fixed dark canvas, even for black brands.
  const rgb = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16));
  const highlight = `#${rgb.map(channel => Math.round(channel * .5 + 255 * .5).toString(16).padStart(2, "0")).join("")}`;
  return { color, highlight };
}

/** Repeatable compositions keep a series coherent without giving every topic an identical card. */
function composition(content: DraftContent): "spotlight" | "panel" | "orbit" {
  const key = `${content.topic}|${content.artTitle || content.title}`;
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return (["spotlight", "panel", "orbit"] as const)[hash % 3];
}

/** An authored, conceptual illustration: no claimed client results or fabricated interfaces. */
function fallbackVisual(content: DraftContent, color: string, highlight: string): string {
  const subject = `${content.topic} ${content.title}`.toLocaleLowerCase("pt-BR");
  const variant = /site|digital|internet|busca|google|online|página/u.test(subject) ? "browser"
    : /resposta|atendimento|cliente|conversa|contato|mensage|whatsapp/u.test(subject) ? "message" : "calendar";
  const icon = variant === "browser"
    ? `<rect x="280" y="158" width="465" height="330" rx="28" fill="#101923" stroke="#8ca8c1" stroke-width="2"/><path d="M280 214h465" stroke="#8ca8c1" stroke-opacity=".45" stroke-width="2"/><circle cx="309" cy="187" r="5" fill="${color}"/><circle cx="330" cy="187" r="5" fill="${highlight}"/><rect x="311" y="249" width="194" height="15" rx="7" fill="#f5f9ff"/><rect x="311" y="285" width="143" height="8" rx="4" fill="#8ca8c1"/><rect x="311" y="306" width="174" height="8" rx="4" fill="#8ca8c1" opacity=".6"/><rect x="311" y="359" width="135" height="45" rx="12" fill="${highlight}"/><rect x="552" y="247" width="161" height="180" rx="18" fill="${color}" fill-opacity=".17"/><path d="m580 345 42-52 26 28 21-17 28 41Z" fill="${highlight}" fill-opacity=".6"/><circle cx="675" cy="276" r="10" fill="${color}"/>`
    : variant === "message"
    ? `<rect x="350" y="95" width="281" height="466" rx="37" fill="#101923" stroke="#8ca8c1" stroke-width="3"/><path d="M443 119h95" stroke="#8ca8c1" stroke-width="6" stroke-linecap="round"/><path d="M320 213h315a24 24 0 0 1 24 24v99a24 24 0 0 1-24 24H419l-55 37 6-37h-50a24 24 0 0 1-24-24v-99a24 24 0 0 1 24-24Z" fill="${highlight}"/><path d="M336 263h224m-224 30h149" stroke="#080b12" stroke-width="12" stroke-linecap="round"/><rect x="420" y="411" width="252" height="61" rx="22" fill="${color}"/><path d="M447 440h121" stroke="#080b12" stroke-width="10" stroke-linecap="round"/>`
    : `<rect x="285" y="145" width="440" height="368" rx="30" fill="#101923" stroke="#8ca8c1" stroke-width="2"/><path d="M285 227h440" stroke="#8ca8c1" stroke-opacity=".5" stroke-width="2"/><path d="M372 119v51m266-51v51" stroke="${highlight}" stroke-width="15" stroke-linecap="round"/><g fill="#8ca8c1" fill-opacity=".25"><rect x="327" y="270" width="82" height="62" rx="12"/><rect x="464" y="270" width="82" height="62" rx="12"/><rect x="601" y="270" width="82" height="62" rx="12"/><rect x="327" y="381" width="82" height="62" rx="12"/><rect x="601" y="381" width="82" height="62" rx="12"/></g><rect x="464" y="381" width="82" height="62" rx="12" fill="${highlight}"/><path d="m484 412 14 14 29-31" fill="none" stroke="#080b12" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg class="fallback-visual" viewBox="0 0 1080 690" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<ellipse cx="560" cy="593" rx="345" ry="33" fill="#000" opacity=".4"/>
<circle cx="552" cy="337" r="280" fill="${color}" fill-opacity=".035" stroke="${color}" stroke-opacity=".16"/>
<circle cx="552" cy="337" r="226" fill="none" stroke="${highlight}" stroke-opacity=".1"/>
<g transform="translate(32 5) rotate(-7 515 330)">${icon}</g>
<path d="m804 189 24 24-24 24m-17-24h40" fill="none" stroke="${highlight}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="220" cy="433" r="6" fill="${color}"/><circle cx="831" cy="500" r="4" fill="${highlight}"/>
</svg>`;
}

/** Local preview and production rendering use this same, entirely self-contained layout. */
export function artworkHtml(content: DraftContent, settings: Settings, illustration?: Illustration): string {
  const title = short(content.artTitle || content.title, 100);
  const imageUrl = illustration ? illustrationDataUrl(illustration) : undefined;
  const { color, highlight } = palette(settings.brandColor);
  const layout = composition(content);
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH}, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; script-src 'none'; connect-src 'none'">
<title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
body{background:#080b12;color:#f5f9ff;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
article{position:relative;width:100%;height:100%;overflow:hidden;isolation:isolate;background:#080b12}
.ambient{position:absolute;z-index:-4;inset:0;background:radial-gradient(ellipse at 77% 67%,${color}26 0%,${color}00 48%)}
.hero-photo{position:absolute;z-index:-3;inset:492px 0 0;width:1080px;height:740px;object-fit:cover;object-position:center 60%}
.fallback-visual{position:absolute;z-index:-3;width:1080px;height:690px;left:0;bottom:116px}
.veil{position:absolute;z-index:-2;inset:0;background:linear-gradient(180deg,#080b12 0%,#080b12 37%,#080b12e8 45%,#080b1270 56%,#080b1200 66%,#080b1250 80%,#080b12 94%)}
article.with-fallback .veil{background:linear-gradient(180deg,#080b12 0%,#080b12 39%,#080b12a0 49%,#080b1200 66%,#080b1200 82%,#080b12 94%)}
.frame{position:absolute;z-index:-1;left:44px;right:44px;top:40px;bottom:36px;border:1px solid #94abc11a;border-radius:32px;pointer-events:none}
.brand{position:absolute;left:76px;right:76px;top:69px;display:flex;align-items:center;gap:14px;font-size:30px;font-weight:700;letter-spacing:-1px;white-space:nowrap}
.brand-name{max-width:810px;overflow:hidden;text-overflow:ellipsis}.mark{flex:none;width:10px;height:10px;border-radius:50%;background:${highlight};box-shadow:0 0 22px ${color}70}
.eyebrow{position:absolute;top:160px;left:76px;max-width:928px;display:flex;align-items:center;gap:12px;font-size:18px;line-height:1.3;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:${highlight}}
.eyebrow:before{content:"";width:25px;height:2px;flex:none;background:${highlight}}
h1{position:absolute;left:70px;top:221px;width:936px;margin:0;font-family:Arial,Helvetica,sans-serif;font-size:${headlineSize(title)}px;font-weight:900;line-height:.98;letter-spacing:-.057em;text-transform:uppercase;text-wrap:balance;overflow-wrap:anywhere}
h1 span{color:${highlight}}
.art-note{position:absolute;bottom:159px;left:76px;right:76px;margin:0;font-size:14px;color:#9aacc0;letter-spacing:.2px}
footer{position:absolute;left:76px;right:76px;bottom:72px;display:flex;align-items:center;justify-content:space-between;gap:24px;padding-top:26px;border-top:1px solid #94abc133}
.read-more{display:flex;align-items:center;gap:14px;font-size:19px;line-height:1;font-weight:700;letter-spacing:1.3px;white-space:nowrap}.arrow{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:50%;background:${highlight};color:#080b12;font-size:26px;font-weight:400;line-height:1}
.handle{max-width:400px;font-size:22px;line-height:1.2;font-weight:700;overflow-wrap:anywhere;text-align:right;color:#c7d7e6}
.accent{position:absolute;left:76px;top:111px;width:36px;height:3px;background:${color};border-radius:3px}
article[data-layout="panel"] .hero-photo{inset:554px 76px 0;width:928px;height:624px;border-radius:36px;object-position:center 55%}
article[data-layout="panel"] .ambient{background:radial-gradient(ellipse at 20% 70%,${color}22 0%,${color}00 48%)}
article[data-layout="panel"] .frame{border-radius:0;border-width:0 0 0 1px;left:44px}
article[data-layout="panel"] .fallback-visual{transform:translate(34px,20px) scale(.92)}
article[data-layout="orbit"] .fallback-visual{transform:translate(-35px,20px) rotate(6deg) scale(1.03)}
article[data-layout="orbit"] .hero-photo{object-position:58% 62%}
article[data-layout="orbit"] .frame{border-radius:0 120px 0 0}
article[data-layout="orbit"] .ambient{background:radial-gradient(ellipse at 90% 65%,${color}34 0%,${color}00 48%)}
</style></head><body><article class="${imageUrl ? "with-image" : "with-fallback"}" data-layout="${layout}">
<div class="ambient"></div>${imageUrl ? `<img class="hero-photo" src="${imageUrl}" alt="Ilustração conceitual do assunto da publicação">` : fallbackVisual(content, color, highlight)}
<div class="veil"></div><div class="frame"></div><div class="brand"><span class="mark" aria-hidden="true"></span><span class="brand-name">${escapeHtml(short(settings.brandName || "Sua marca", 42))}</span></div>
<div class="eyebrow">${escapeHtml(short(content.topic || "Presença digital", 30))}</div>
<h1>${highlightedTitle(title)}</h1>
${imageUrl ? `<p class="art-note">Imagem ilustrativa gerada por IA</p>` : ""}
<footer><div class="read-more">LEIA A LEGENDA <span class="arrow" aria-hidden="true">↗</span></div><div class="handle">${escapeHtml(short(settings.brandHandle || settings.brandName || "Sua marca", 42))}</div></footer>
<div class="accent"></div></article></body></html>`;
}

export function canRenderArtwork(env: Env): boolean {
  return typeof env.BROWSER?.quickAction === "function" || Boolean(env.CF_BROWSER_API_TOKEN && /^[a-f0-9]{32}$/i.test(env.CF_ACCOUNT_ID || ""));
}

/** Bound the PNG while streaming, before it reaches D1's storage limit. */
async function readPng(response: Response): Promise<ArrayBuffer> {
  const discard = async () => { try { await response.body?.cancel(); } catch { /* Discard errors contain no useful public detail. */ } };
  if (!response.ok) {
    await discard();
    throw new Error(`Cloudflare recusou a geração da imagem (HTTP ${response.status}).`);
  }
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "image/png") {
    await discard();
    throw new Error("Cloudflare não retornou uma imagem PNG.");
  }
  const tooLarge = "A imagem excedeu o limite de 1,5 MB. Gere outra arte para este post.";
  if (Number(response.headers.get("content-length")) > MAX_PNG_BYTES) {
    await discard();
    throw new Error(tooLarge);
  }
  if (!response.body) throw new Error("A imagem retornada pela Cloudflare é inválida.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { throw new Error(RENDER_TIMEOUT); }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PNG_BYTES) {
        try { await reader.cancel(); } catch { /* Keep the safe size-limit message. */ }
        throw new Error(tooLarge);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const image = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { image.set(chunk, offset); offset += chunk.byteLength; }
  if (image.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => image[index] === byte)) {
    throw new Error("A imagem retornada pela Cloudflare é inválida.");
  }
  return image.buffer;
}

export async function renderArtwork(content: DraftContent, settings: Settings, env: Env, fetcher: Fetcher = fetch, illustration?: Illustration): Promise<ArrayBuffer> {
  const browser = typeof env.BROWSER?.quickAction === "function" ? env.BROWSER : undefined;
  if (!browser && (!env.CF_ACCOUNT_ID || !env.CF_BROWSER_API_TOKEN)) {
    throw new Error("Configure a conexão BROWSER da Cloudflare para gerar a imagem. Como alternativa, use CF_ACCOUNT_ID e CF_BROWSER_API_TOKEN.");
  }
  if (!browser && !/^[a-f0-9]{32}$/i.test(env.CF_ACCOUNT_ID!)) throw new Error("CF_ACCOUNT_ID inválido.");
  const payload = {
    html: artworkHtml(content, settings, illustration),
    viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
    screenshotOptions: { type: "png", fullPage: false, captureBeyondViewport: false },
  } satisfies BrowserRunScreenshotOptions;
  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error(RENDER_TIMEOUT)); }, 45_000);
  });
  const rendering = (async () => {
    let response: Response;
    try {
      // Never retry through REST after a binding failure: one rendering request per attempt.
      response = browser ? await browser.quickAction("screenshot", payload) : await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-run/screenshot`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_BROWSER_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: controller.signal,
      });
    } catch { throw new Error(RENDER_TIMEOUT); }
    if (expired) {
      try { await response.body?.cancel(); } catch { /* A timed-out result must not be used. */ }
      throw new Error(RENDER_TIMEOUT);
    }
    return readPng(response);
  })();
  try { return await Promise.race([rendering, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
