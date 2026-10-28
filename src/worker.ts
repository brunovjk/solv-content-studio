import { manualPost, mediaExtension, MAX_UPLOAD_BODY } from "./manual.ts";
import { dashboardHtml } from "./dashboard.ts";
import { artworkHtml, canRenderArtwork, renderArtwork } from "./artwork.ts";
import { listBufferChannels } from "./buffer.ts";
import { authenticatedIdentity, createIdentitySession, sessionCookie } from "./auth.ts";
import { readLimitedText } from "./feeds.ts";
import { missingPublicationRequirements, notifyOwner, preparePostVisual, publishPreparedPost, runPipeline } from "./pipeline.ts";
import { D1Repository } from "./repository.ts";
import { validateSettings } from "./settings.ts";
import { validateDraftImport } from "./drafts.ts";
import type { BotJob, Env, Post, Run } from "./types.ts";

const json = (value: unknown, status = 200, extra: Record<string,string> = {}) => new Response(JSON.stringify(value), {status, headers: {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", ...extra}});
const failure = (message: string, status = 400) => json({error:message}, status);
const now = () => new Date().toISOString();

async function body(request: Request, limit = 65536): Promise<Record<string,unknown>> {
  const value = JSON.parse(await readLimitedText(new Response(request.body, {headers:request.headers}), limit));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dados inválidos.");
  return value as Record<string,unknown>;
}

function allowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin || (env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(s=>{try {const u=new URL(s);return u.protocol==="https:" && u.origin===s;}catch{return false;}}).includes(origin);
}

function responseHeaders(response: Response, request: Request, env: Env) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigin(request,env)) {
    headers.set("Access-Control-Allow-Origin",origin);
    headers.set("Access-Control-Allow-Headers","Authorization, Content-Type");
    headers.set("Access-Control-Allow-Methods","GET, HEAD, POST, PUT, PATCH, OPTIONS");
    headers.set("Access-Control-Max-Age","600");
    headers.set("Vary","Origin");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  if (headers.get("Content-Type")?.includes("text/html")) headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
  return new Response(response.body, {status:response.status, headers});
}

function editable(post: Post) {
  return !post.deliveries.some(d => ["sending","queued","published","unknown"].includes(d.status));
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const repo = new D1Repository(env.DB);
  if (request.method === "OPTIONS") return allowedOrigin(request,env) ? new Response(null,{status:204}) : failure("Origem não autorizada.",403);
  if (path === "/" && request.method === "GET") return new Response(dashboardHtml(), {headers:{"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store"}});
  if (path === "/favicon.ico") return new Response(null,{status:204});
  if (path === "/api/health") return json({ok:true,service:"solv-studio"});
  const media = path.match(/^\/media\/([a-f0-9-]{36})\.(png|jpg)$/);
  if (media && ["GET","HEAD"].includes(request.method)) {
    const post = await repo.getPost(media[1]);
    if (media[2] !== (post ? mediaExtension(post) : "png")) return failure("Imagem não encontrada.",404);
    const image = await repo.getImage(media[1]);
    if (!image) return failure("Imagem não encontrada.",404);
    return new Response(request.method === "HEAD" ? null : image,{headers:{"Content-Type":post?.uploadedImage?.mimeType || "image/png","Content-Length":String(image.byteLength),"Cache-Control":"public,max-age=86400"}});
  }
  if (!["GET","HEAD"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    if (origin && !allowedOrigin(request,env)) return failure("Origem não autorizada.",403);
    if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") return failure("Envie dados em JSON.",415);
  }
  if (path === "/api/login" && request.method === "POST") {
    const data = await body(request);
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) return failure("Configure ADMIN_TOKEN antes de acessar o painel.",503);
    if (typeof data.token !== "string" || data.token.length > 4096) return failure("Chave de acesso inválida.",401);
    const identity = await authenticatedIdentity(new Request(request.url,{headers:{Authorization:`Bearer ${data.token}`}}),env);
    if (!identity) return failure("Chave de acesso inválida.",401);
    const sessionToken = await createIdentitySession(env,identity);
    return json({ok:true,role:identity.role,subject:identity.subject,sessionToken},200,{"Set-Cookie":sessionCookie(request,sessionToken)});
  }
  const identity = await authenticatedIdentity(request,env);
  if (!identity) return failure("Entre com a chave de acesso do painel.",401);
  const role = identity.role;
  if (role === "editor" && request.method !== "GET" && request.method !== "HEAD" && (path === "/api/test-batch" || path === "/api/channels/sync" || path === "/api/posts/archive" || /\/approve$/.test(path))) return failure("Apenas o responsável pode alterar a publicação nas redes.",403);
  if (path === "/api/logout" && request.method === "POST") return json({ok:true},200,{"Set-Cookie":sessionCookie(request,"",true)});
  if (path === "/api/state" && request.method === "GET") {
    const [settings,posts,runs,busy] = await Promise.all([repo.getSettings(),repo.listPosts(),repo.listRuns(),repo.busy()]);
    return json({role,subject:identity.subject,settings,posts,runs,busy,readiness:{demo:env.DEMO_MODE === "true",gemini:Boolean(env.GEMINI_API_KEY),buffer:Boolean(env.BUFFER_API_KEY),illustration:Boolean(env.AI),artwork:canRenderArtwork(env),publicUrl:Boolean(env.PUBLIC_BASE_URL?.startsWith("https://")),admin:true},publicationMissing:missingPublicationRequirements(env,settings),manualPublicationMissing:missingPublicationRequirements(env,settings,{uploadedImage:{mimeType:"image/jpeg",width:1080,height:1080}} as Post)});
  }
  if (path === "/api/settings" && request.method === "PUT") {
    const settings = validateSettings(await body(request));
    if (role === "editor") {
      const current = await repo.getSettings();
      const protectedFields = ["mode","paused","daysOfWeek","hour","timezone","maxAgeDays","maxCandidates","minRelevance","maxPostsPerDay","channels"] as const;
      if (protectedFields.some(field=>JSON.stringify(settings[field])!==JSON.stringify(current[field]))) return failure("O colaborador pode ajustar a criação, mas não a rotina, os limites ou os canais.",403);
    }
    await repo.saveSettings(settings);
    return json({ok:true,settings});
  }
  if (path === "/api/posts/archive" && request.method === "POST") {
    const input = await body(request);
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 120 || input.ids.some(id=>typeof id!=="string"||!/^[a-f0-9-]{36}$/.test(id))) return failure("Informe os identificadores das publicações.");
    if (!await repo.acquireLock("pipeline",60)) return failure("Aguarde a execução atual terminar.",409);
    const archived: string[] = [];
    try { for (const id of input.ids as string[]) {const post=await repo.getPost(id);if(post){post.archivedAt=now();await repo.savePost(post);archived.push(id);}} }
    finally { await repo.releaseLock("pipeline"); }
    return json({ok:true,archived});
  }
  if (path === "/api/posts/manual" && request.method === "POST") {
    const {post,image}=manualPost(await body(request,MAX_UPLOAD_BODY));
    if (!await repo.acquireLock("pipeline",60)) return failure("Aguarde a execução atual terminar.",409);
    try {
      const existing=await repo.getPost(post.id);
      if (existing) {
        if (!existing.uploadedImage || existing.archivedAt) return failure("Identificador já utilizado.",409);
        return json({ok:true,post:existing,existing:true});
      }
      await repo.saveImage(post.id,image);
      await repo.savePost(post);
      return json({ok:true,post},201);
    } finally { await repo.releaseLock("pipeline"); }
  }
  if (path === "/api/drafts/import" && request.method === "POST") {
    const posts = validateDraftImport(await body(request));
    if (!await repo.acquireLock("pipeline", 60)) return failure("Aguarde a execução atual terminar.",409);
    const created: string[] = [], existing: string[] = [];
    try {
      for (const post of posts) {
        // Stable IDs make retries safe and never overwrite edits or accepted publications.
        if (await repo.getPost(post.id)) { existing.push(post.id); continue; }
        await repo.savePost(post); created.push(post.id);
      }
    } finally { await repo.releaseLock("pipeline"); }
    return json({ok:true,created,existing,message:"Rascunhos salvos. Nenhuma IA ou publicação foi acionada."},201);
  }
  if (path === "/api/run" && request.method === "POST") {
    const input = await body(request);
    const demo = input.demo === true;
    if (!demo && !env.GEMINI_API_KEY) return failure("Configure GEMINI_API_KEY para testar conteúdo real. A simulação funciona sem chave.");
    if (await repo.busy()) return failure("Já existe uma execução em andamento.",409);
    await env.JOBS.send({type:"run",demo,...(!demo && (role === "editor" || input.draftOnly === true) ? {draftOnly:true} : {})});
    return json({ok:true,message:demo ? "Simulação iniciada." : "Geração real iniciada."},202);
  }
  if (path === "/api/test-batch" && request.method === "POST") {
    if (await repo.busy()) return failure("Já existe uma execução em andamento.",409);
    const input = await body(request);
    if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id)) return failure("Identificador de teste inválido.");
    if (!Array.isArray(input.scheduledAt) || input.scheduledAt.length !== 3) return failure("O teste exige exatamente três horários.");
    const times: string[] = [];
    for (const value of input.scheduledAt) {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) return failure("Horário de teste inválido.");
      const ms = Date.parse(value);
      if (ms < Date.now()+120_000 || ms > Date.now()+30*60_000) return failure("Use horários entre dois e trinta minutos no futuro.");
      times.push(new Date(ms).toISOString());
    }
    if (new Set(times).size !== 3 || times.some((t,i)=>i>0 && Date.parse(t)-Date.parse(times[i-1])<60_000)) return failure("Use três horários crescentes, separados por pelo menos um minuto.");
    const settings = await repo.getSettings();
    const channel = settings.channels.find(c=>c.id===input.channelId && c.enabled);
    if (!channel || channel.service !== "instagram") return failure("Escolha um canal Instagram habilitado.");
    if (env.DEMO_MODE === "true" || settings.mode !== "auto" || settings.paused || missingPublicationRequirements(env,settings).length || !env.GEMINI_API_KEY) return failure("O teste exige as conexões prontas e o modo automático ativo.",409);
    if (!await repo.claimArticle(`test-batch:${input.id}`,"reserved")) return json({ok:true,id:input.id,alreadyAccepted:true,scheduledAt:times});
    await env.JOBS.sendBatch(times.map(scheduledAt=>({body:{type:"run" as const,demo:false,scheduledAt,testBatchId:input.id as string,testChannelId:channel.id}})));
    return json({ok:true,id:input.id,scheduledAt:times,channel:channel.name},202);
  }
  if (path === "/api/channels/sync" && request.method === "POST") {
    const ignored = new Set((env.IGNORED_CHANNEL_IDS || "").split(",").map(id=>id.trim()).filter(Boolean));
    const channels = (await listBufferChannels(env)).filter(channel=>!ignored.has(channel.id));
    const settings = await repo.getSettings();
    // Connecting an account does not opt every channel into publication.
    settings.channels = channels.slice(0,3).map(c => ({...c,enabled:c.enabled && Boolean(settings.channels.find(old => old.id === c.id)?.enabled)}));
    await repo.saveSettings(settings);
    return json({channels:settings.channels});
  }
  const preview = path.match(/^\/preview\/([a-f0-9-]{36})$/);
  if (preview && request.method === "GET") {
    const post = await repo.getPost(preview[1]);
    if (!post || post.archivedAt) return failure("Publicação não encontrada.",404);
    return new Response(artworkHtml(post.content,await repo.getSettings(),(post.visual?.status === "ready" ? await repo.getIllustration(post.id) : undefined) ?? undefined),{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
  }
  const match = path.match(/^\/api\/posts\/([a-f0-9-]{36})(?:\/(approve|reject|visual|render))?$/);
  if (match) {
    const post = await repo.getPost(match[1]);
    if (!post || post.archivedAt) return failure("Publicação não encontrada.",404);
    if (await repo.busy()) return failure("Aguarde a execução atual terminar.",409);
    if (request.method === "POST" && match[2] === "approve") {
      if (post.demo) return failure("A simulação não pode ser enviada às redes.");
      if (["queued","published"].includes(post.status)) return failure("Esse post já foi enviado ao Buffer.");
      if (post.status === "rejected") return failure("Esse post foi descartado.",409);
      if (post.deliveries.some(d => ["sending","unknown"].includes(d.status))) return failure("O envio ainda não foi confirmado. Confira a fila no Buffer antes de qualquer nova tentativa.",409);
      await env.JOBS.send({type:"approve",postId:post.id});
      return json({ok:true,message:"Publicação solicitada."},202);
    }
    if (!editable(post)) return failure("Esse post já foi enviado ou aguarda confirmação. Faça alterações diretamente no Buffer ou na rede.");
    if (post.uploadedImage && request.method === "POST" && ["render","visual"].includes(match[2])) return failure("Este post usa sua própria foto.",409);
    if (request.method === "POST" && match[2] === "render") {
      if (post.demo || post.status === "rejected") return failure("Use uma publicação real que ainda não foi descartada.",409);
      if (!canRenderArtwork(env)) return failure("Ative a conexão Browser Run na configuração Cloudflare.",503);
      await env.JOBS.send({type:"render",postId:post.id});
      return json({ok:true,message:"Preparação do PNG iniciada. Nenhuma publicação será enviada."},202);
    }
    if (request.method === "POST" && match[2] === "visual") {
      if (post.demo || post.status === "rejected") return failure("Use uma publicação real que ainda não foi descartada.",409);
      if (!env.AI) return failure("Ative a conexão Workers AI na configuração Cloudflare.",503);
      if (post.visual?.status === "ready" && await repo.getIllustration(post.id)) return failure("Esta publicação já tem uma imagem de IA salva.",409);
      await env.JOBS.send({type:"visual",postId:post.id});
      return json({ok:true,message:"Geração de imagem iniciada. Nenhuma publicação será enviada."},202);
    }
    if (request.method === "POST" && match[2] === "reject") {
      post.status = "rejected"; post.updatedAt = now(); await repo.savePost(post); return json({ok:true,post});
    }
    if (request.method === "PATCH" && !match[2]) {
      const changes = await body(request);
      if (post.uploadedImage) {
        if (Object.keys(changes).some(key=>key!=="caption")) return failure("Edite apenas a legenda deste post.");
        if (typeof changes.caption!=="string" || !changes.caption.trim() || changes.caption.trim().length>1800) return failure("Escreva uma legenda de até 1800 caracteres.");
        post.content.caption=changes.caption.trim();post.content.title=post.content.caption.split(/\r?\n/)[0].slice(0,88);
        post.status="draft";post.updatedAt=now();post.error=undefined;
        await repo.savePost(post);return json({ok:true,post});
      }
      for (const [field,max] of [["caption",1800],["title",88],["artTitle",54],["subtitle",150]] as const) {
        if (changes[field] !== undefined) {
          if (typeof changes[field] !== "string" || !changes[field].trim() || changes[field].length > max) return failure(`${field}: tamanho inválido.`);
          post.content[field] = changes[field].trim();
        }
      }
      if (changes.imagePrompt !== undefined) {
        if (typeof changes.imagePrompt !== "string" || !changes.imagePrompt.trim() || changes.imagePrompt.length>1000 || /<\/?[a-z][^>]*>/i.test(changes.imagePrompt)) return failure("Brief visual: use texto simples de até 1000 caracteres.");
        if (post.content.imagePrompt !== changes.imagePrompt.trim()) {post.content.imagePrompt=changes.imagePrompt.trim();delete post.visual;post.imageReady=false;}
      }
      if (changes.title !== undefined && changes.artTitle === undefined) delete post.content.artTitle;
      if (changes.title !== undefined || changes.artTitle !== undefined || changes.subtitle !== undefined) post.imageReady = false;
      post.status = "draft"; post.updatedAt = now(); post.error = undefined;
      await repo.savePost(post); return json({ok:true,post});
    }
  }
  return failure("Endereço não encontrado.",404);
}

async function approve(env: Env, postId: string) {
  const repo = new D1Repository(env.DB);
  if (!await repo.acquireLock("pipeline",900)) return;
  const run: Run = {id:crypto.randomUUID(),startedAt:now(),status:"running",message:"Preparando envio ao Buffer…",postId,candidates:0,demo:false};
  try {
    await repo.saveRun(run);
    const post = await repo.getPost(postId);
    if (!post || post.archivedAt || post.demo || ["queued","published","rejected"].includes(post.status)) throw new Error("Esta publicação não pode ser enviada.");
    const result = await publishPreparedPost(env,repo,post,await repo.getSettings());
    run.status = result.status === "needs_attention" ? "error" : "success";
    run.message = result.status === "queued" ? "Post enviado ao Buffer; confirmação da rede pendente." : result.error || "Conteúdo pronto.";
  } catch (error) {
    run.status = "error"; run.message = error instanceof Error ? error.message.slice(0,300) : "Falha no envio.";
    const post = await repo.getPost(postId);
    if (post && !["queued","published","rejected"].includes(post.status)) {
      post.status = "needs_attention"; post.error = run.message; post.updatedAt = now();
      await repo.savePost(post);
    }
    await notifyOwner(env,`ClinicContentBot: ${run.message}`);
  } finally {
    run.endedAt = now(); await repo.saveRun(run); await repo.releaseLock("pipeline");
  }
}

async function createVisual(env: Env, postId: string) {
  const repo = new D1Repository(env.DB);
  if (!await repo.acquireLock("pipeline",900)) return;
  const run: Run = {id:crypto.randomUUID(),startedAt:now(),status:"running",message:"Criando imagem com FLUX. Nenhuma publicação será enviada…",postId,candidates:0,demo:false};
  try {
    await repo.saveRun(run);
    const post = await repo.getPost(postId);
    if (!post || post.archivedAt || post.demo || post.uploadedImage || post.status === "rejected" || !editable(post)) throw new Error("Esta publicação não pode ter sua arte alterada.");
    const result = await preparePostVisual(env,repo,post,true);
    run.status = result.visual?.status === "ready" ? "success" : "error";
    run.message = result.visual?.status === "ready" ? "Imagem criada e salva na prévia. Nada foi publicado." : result.visual?.error || "Imagem indisponível. A composição gráfica continua disponível.";
  } catch (error) {
    run.status = "error"; run.message = error instanceof Error ? error.message.slice(0,300) : "Falha na criação da imagem.";
  } finally {
    run.endedAt = now(); await repo.saveRun(run); await repo.releaseLock("pipeline");
  }
}

async function createPng(env: Env, postId: string) {
  const repo = new D1Repository(env.DB);
  if (!await repo.acquireLock("pipeline",900)) return;
  const run: Run = {id:crypto.randomUUID(),startedAt:now(),status:"running",message:"Preparando PNG. Nenhuma publicação será enviada…",postId,candidates:0,demo:false};
  let post: Post | null = null;
  let previousStatus: Post["status"] = "draft";
  try {
    await repo.saveRun(run);
    post = await repo.getPost(postId);
    if (!post || post.archivedAt || post.demo || post.uploadedImage || post.status === "rejected" || !editable(post)) throw new Error("Esta publicação não pode ter sua arte alterada.");
    previousStatus = post.status;
    if (!post.imageReady || !await repo.getImage(post.id)) {
      post.status = "rendering"; post.updatedAt = now(); await repo.savePost(post);
      const image = await renderArtwork(post.content,await repo.getSettings(),env,fetch,(post.visual?.status === "ready" ? await repo.getIllustration(post.id) : undefined) ?? undefined);
      await repo.saveImage(post.id,image);
      post.imageReady = true; post.status = previousStatus; post.updatedAt = now(); post.error = undefined;
      await repo.savePost(post);
    }
    run.status = "success"; run.message = "PNG preparado e salvo. Nada foi publicado.";
  } catch (error) {
    run.status = "error"; run.message = error instanceof Error ? error.message.slice(0,300) : "Falha na preparação do PNG.";
    if (post?.status === "rendering") {
      post.status = previousStatus; post.error = run.message; post.updatedAt = now(); await repo.savePost(post);
    }
  } finally {
    run.endedAt = now(); await repo.saveRun(run); await repo.releaseLock("pipeline");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return responseHeaders(await handle(request,env),request,env); }
    catch (error) {
      console.error("Falha na requisição", error instanceof Error ? error.name : "Error");
      return responseHeaders(failure(error instanceof Error ? error.message.slice(0,300) : "Não foi possível concluir a operação."),request,env);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    if (env.DEMO_MODE === "true") return;
    await runPipeline(env,new D1Repository(env.DB),{demo:false,scheduled:true});
  },
  async queue(batch: MessageBatch<BotJob>, env: Env) {
    for (const item of batch.messages) {
      if (item.body.type === "run") await runPipeline(env,new D1Repository(env.DB),{demo:item.body.demo,draftOnly:item.body.draftOnly,scheduledAt:item.body.scheduledAt,testBatchId:item.body.testBatchId,testChannelId:item.body.testChannelId});
      else if (item.body.type === "approve") await approve(env,item.body.postId);
      else if (item.body.type === "visual") await createVisual(env,item.body.postId);
      else if (item.body.type === "render") await createPng(env,item.body.postId);
      item.ack();
    }
  },
};
