import { collectArticles, createDemoArticle } from "./feeds.ts";
import { createDemoDraft, generateDraft } from "./gemini.ts";
import { canRenderArtwork, renderArtwork } from "./artwork.ts";
import { generateIllustration, ILLUSTRATION_MODEL } from "./visuals.ts";
import { AmbiguousPublishError, enqueuePost, getBufferPost } from "./buffer.ts";
import { localClock, safePublicUrl } from "./settings.ts";
import type { Env, Fetcher, Post, Repository, Run, Settings } from "./types.ts";

const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : "Erro inesperado na execução.";
const iso = () => new Date().toISOString();

/** A saved illustration is reused for preview, approval and final PNG. Failure uses the original graphic layout. */
export async function preparePostVisual(env: Env, repo: Repository, post: Post, retry = false): Promise<Post> {
  if (post.demo || (post.visual?.status === "fallback" && !retry)) return post;
  if (post.visual?.status === "ready" && await repo.getIllustration(post.id)) return post;
  const previousStatus = post.status;
  post.status = "rendering"; post.updatedAt = iso(); await repo.savePost(post);
  try {
    const illustration = await generateIllustration(post.content,env,await repo.getSettings());
    await repo.saveIllustration(post.id,illustration);
    post.visual = {status:"ready",model:ILLUSTRATION_MODEL,createdAt:iso()};
  } catch (error) {
    post.visual = {status:"fallback",model:ILLUSTRATION_MODEL,createdAt:iso(),error:message(error)};
  }
  post.imageReady = false;
  post.status = previousStatus; post.updatedAt = iso(); await repo.savePost(post);
  return post;
}

export function missingPublicationRequirements(env: Env, settings: Settings): string[] {
  const missing: string[] = [];
  if (env.DEMO_MODE === "true") missing.push("ambiente local em modo teste");
  if (!env.BUFFER_API_KEY) missing.push("conexão Buffer");
  if (!canRenderArtwork(env)) missing.push("renderização PNG na Cloudflare");
  if (!env.PUBLIC_BASE_URL || !safePublicUrl(env.PUBLIC_BASE_URL)) missing.push("endereço público HTTPS");
  if (!settings.channels.some(c => c.enabled)) missing.push("pelo menos uma rede habilitada");
  if (/^(Marca provisória|Sua empresa)$/i.test(settings.brandName)) missing.push("nome da marca");
  return missing;
}

export async function notifyOwner(env: Env, text: string, fetcher: Fetcher = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || env.DEMO_MODE === "true") return;
  try {
    await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 1200) }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { console.warn("Não foi possível entregar o alerta ao dono do bot."); }
}

export async function publishPreparedPost(env: Env, repo: Repository, post: Post, settings: Settings, fetcher: Fetcher = fetch): Promise<Post> {
  if (post.archivedAt) throw new Error("Uma publicação arquivada não pode ser enviada.");
  if (post.demo) throw new Error("Simulações não podem ser publicadas.");
  if (settings.paused) throw new Error("O bot está pausado.");
  if (post.deliveries.some(d => d.status === "sending" || d.status === "unknown")) throw new Error("Envio sem confirmação. Confira o Buffer antes de tentar novamente.");
  if (!post.imageReady) post = await preparePostVisual(env,repo,post);
  const missing = missingPublicationRequirements(env, settings);
  if (missing.length) {
    post.status = "ready";
    post.error = `Pronto para testar. Para publicar: ${missing.join(", ")}.`;
    post.updatedAt = iso();
    await repo.savePost(post);
    return post;
  }
  if (!post.imageReady) {
    post.status = "rendering"; post.updatedAt = iso(); await repo.savePost(post);
    const image = await renderArtwork(post.content, settings, env, fetcher,await repo.getIllustration(post.id) ?? undefined);
    await repo.saveImage(post.id, image);
    post.imageReady = true;
  }
  const enabled = settings.channels.filter(c => c.enabled);
  for (const channel of enabled) {
    if (!post.deliveries.some(d => d.channelId === channel.id)) post.deliveries.push({channelId: channel.id, channelName: channel.name, status: "pending"});
  }
  post.status = "publishing"; post.error = undefined; post.updatedAt = iso();
  await repo.savePost(post);
  for (const delivery of post.deliveries) {
    // Never replay accepted or ambiguous network mutations: an HTTP timeout can still mean a real post exists.
    if (delivery.status === "queued" || delivery.status === "published" || !enabled.some(c => c.id === delivery.channelId)) continue;
    const channel = enabled.find(c => c.id === delivery.channelId)!;
    delivery.status = "sending"; delivery.error = undefined; post.updatedAt = iso();
    await repo.savePost(post);
    try {
      const result = await enqueuePost(post, channel, `${env.PUBLIC_BASE_URL!.replace(/\/$/, "")}/media/${post.id}.png`, env, fetcher);
      delivery.remoteId = result.id; delivery.dueAt = result.dueAt; delivery.status = "queued";
    } catch (error) {
      delivery.status = error instanceof AmbiguousPublishError ? "unknown" : "error";
      delivery.error = message(error);
    }
    post.updatedAt = iso();
    await repo.savePost(post);
  }
  const relevant = post.deliveries.filter(d => enabled.some(c => c.id === d.channelId));
  post.status = relevant.some(d => d.status === "error" || d.status === "unknown") ? "needs_attention" : relevant.every(d => d.status === "published") ? "published" : "queued";
  post.error = post.status === "needs_attention" ? "Uma rede não confirmou o envio. Confira os detalhes antes de reenviar." : undefined;
  post.updatedAt = iso(); await repo.savePost(post);
  return post;
}

export async function reconcileDeliveries(env: Env, repo: Repository, fetcher: Fetcher = fetch) {
  if (!env.BUFFER_API_KEY || env.DEMO_MODE === "true") return;
  const posts = (await repo.listPosts()).filter(p => !p.demo && p.deliveries.some(d => d.status === "queued")).slice(0, 4);
  for (const post of posts) {
    for (const delivery of post.deliveries) {
      if (delivery.status !== "queued" || !delivery.remoteId) continue;
      try {
        const remote = await getBufferPost(delivery.remoteId, env, fetcher);
        if (remote.status.toLowerCase() === "sent") delivery.status = "published";
        else if (["error", "failed"].includes(remote.status.toLowerCase())) {
          delivery.status = "error"; delivery.error = remote.error || "O Buffer informou falha na entrega.";
        }
      } catch { /* A read failure does not change or retry an accepted post. */ }
    }
    post.status = post.deliveries.every(d => d.status === "published") ? "published" : post.deliveries.some(d => ["error", "unknown"].includes(d.status)) ? "needs_attention" : "queued";
    post.updatedAt = iso(); await repo.savePost(post);
  }
}

export async function runPipeline(env: Env, repo: Repository, options: { demo: boolean; draftOnly?: boolean; scheduled?: boolean; scheduledAt?: string; testBatchId?: string; testChannelId?: string }, fetcher: Fetcher = fetch): Promise<Run> {
  const run: Run = { id: crypto.randomUUID(), startedAt: iso(), status: "running", message: "Buscando uma referência útil…", candidates: 0, demo: options.demo };
  if (!await repo.acquireLock("pipeline", 900)) return {...run, status: "skipped", endedAt: iso(), message: "Já existe uma execução em andamento."};
  try {
    if (options.testBatchId) {
      if (options.demo || !options.scheduledAt || !options.testChannelId || !Number.isFinite(Date.parse(options.scheduledAt)) || Date.parse(options.scheduledAt) < Date.now()+60_000) throw new Error("Horário ou canal do teste inválido ou vencido.");
      run.testBatchId = options.testBatchId; run.scheduledAt = options.scheduledAt;
    }
    await repo.saveRun(run);
    const settings = await repo.getSettings();
    if (options.draftOnly) { settings.mode="approval"; settings.paused=false; settings.channels=[]; }
    if (options.testBatchId) {
      settings.channels = settings.channels.filter(c => c.id === options.testChannelId && c.enabled);
      if (settings.channels.length !== 1) throw new Error("O canal do teste não está habilitado.");
    }
    const clock = localClock(new Date(), settings.timezone);
    const skip = (reason: string) => { run.status = "skipped"; run.message = reason; };
    if (options.scheduled && !options.demo) await reconcileDeliveries(env, repo, fetcher);
    const duplicateTestJob = options.testBatchId && !await repo.claimArticle(`test-job:${options.testBatchId}:${options.scheduledAt}`,run.id);
    if (duplicateTestJob) skip("Este horário do teste já foi processado.");
    else if (settings.paused && !options.demo) skip("Bot pausado nas configurações.");
    else if (options.scheduled && (!settings.daysOfWeek.includes(clock.day) || settings.hour !== clock.hour)) skip("Fora do horário de geração configurado.");
    else if (!options.demo && !options.testBatchId && await repo.countPostsOnDate(clock.date, settings.timezone) >= settings.maxPostsPerDay) skip("Limite diário atingido; nenhuma nova chamada de IA.");
    else {
      let selected;
      if (options.demo) selected = { article: createDemoArticle(), content: createDemoDraft(createDemoArticle(), settings) };
      else {
        if (!env.GEMINI_API_KEY) throw new Error("Falta a chave Gemini. Use a simulação para conhecer o painel ou configure GEMINI_API_KEY para testar textos reais.");
        const result = await collectArticles(settings.sources, settings, fetcher);
        let attempted = 0;
        let lastRejection = "";
        for (const article of result.articles) {
          if (attempted >= settings.maxCandidates) break;
          if (await repo.isArticleUsed(article.id)) continue;
          attempted++; run.candidates = attempted;
          run.message = `Avaliando referência ${attempted}: ${article.sourceName}`;
          await repo.saveRun(run);
          const content = await generateDraft(article, settings, env, fetcher);
          if (!content.shouldPost || content.relevance < settings.minRelevance) {
            await repo.claimArticle(article.id, `skipped:${run.id}`);
            lastRejection = content.reason;
            continue;
          }
          selected = { article, content }; break;
        }
        if (!selected) skip(result.articles.length ? `Nenhuma referência passou no filtro. ${lastRejection}` : `Nenhum artigo recente e relevante. ${result.errors.join(" ").slice(0, 220)}`);
      }
      if (selected) {
        const id = crypto.randomUUID();
        if (!options.demo && !await repo.claimArticle(selected.article.id, id)) skip("Referência já utilizada por outra execução.");
        else {
          let post: Post = { id, articleId: selected.article.id, createdAt: iso(), updatedAt: iso(), content: selected.content, status: "ready", imageReady: false, deliveries: [], demo: options.demo };
          if (options.testBatchId) { post.testBatchId = options.testBatchId; post.scheduledAt = options.scheduledAt; }
          run.postId = id;
          await repo.savePost(post);
          if (!options.demo) {
            run.message = "Criando a imagem ilustrativa com FLUX…"; await repo.saveRun(run);
            post = await preparePostVisual(env,repo,post);
          }
          if (!options.demo && settings.mode === "auto") post = await publishPreparedPost(env, repo, post, settings, fetcher);
          else if (!options.demo) {
            if (canRenderArtwork(env)) {
              const image = await renderArtwork(post.content, settings, env, fetcher,await repo.getIllustration(post.id) ?? undefined);
              await repo.saveImage(post.id, image); post.imageReady = true;
            }
            post.status = "draft"; await repo.savePost(post);
          }
          run.status = post.status === "needs_attention" ? "error" : "success";
          run.message = options.demo ? "Simulação concluída com conteúdo de exemplo. Nada foi enviado às redes nem à IA." : post.status === "queued" ? "Post enviado ao Buffer. Aguardando confirmação da rede." : post.status === "draft" ? "Post criado e aguardando aprovação." : post.error || "Conteúdo e prévia criados. Nenhuma publicação externa.";
          if (!options.demo && post.visual?.status === "fallback") run.message += " Imagem de IA indisponível; composição gráfica utilizada.";
        }
      }
    }
  } catch (error) {
    run.status = "error"; run.message = message(error);
    if (run.postId) {
      const post = await repo.getPost(run.postId);
      if (post && !["queued", "published"].includes(post.status)) {
        post.status = "needs_attention"; post.error = run.message; post.updatedAt = iso(); await repo.savePost(post);
      }
    }
  } finally {
    run.endedAt = iso();
    await repo.saveRun(run);
    await repo.releaseLock("pipeline");
  }
  if (run.status === "error" && !options.demo) await notifyOwner(env, `ClinicContentBot: ${run.message}`, fetcher);
  return run;
}
