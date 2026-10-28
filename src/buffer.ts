import type { Channel, DraftContent, Env, Fetcher, Post } from "./types.ts";

const ENDPOINT = "https://api.buffer.com";

/** Buffer may have accepted a mutation even though the response did not arrive. Never automatically retry. */
export class AmbiguousPublishError extends Error {
  constructor() {
    super("A resposta do Buffer não confirmou o resultado. Confira a fila no Buffer antes de tentar novamente para evitar duplicação.");
    this.name = "AmbiguousPublishError";
  }
}

type GraphQLResponse<T> = { data?: T; errors?: unknown[] };

async function request<T>(query: string, variables: Record<string, unknown>, env: Env, fetcher: Fetcher, mutation = false): Promise<T> {
  if (!env.BUFFER_API_KEY) throw new Error("Configure BUFFER_API_KEY para conectar as redes sociais.");
  let response: Response;
  try {
    response = await fetcher(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.BUFFER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    if (mutation) throw new AmbiguousPublishError();
    throw new Error("Não foi possível consultar o Buffer. Verifique a conexão e tente novamente.");
  }
  if (!response.ok) {
    if (mutation && (response.status >= 500 || response.status === 408)) throw new AmbiguousPublishError();
    throw new Error(`Buffer recusou a solicitação (HTTP ${response.status}).`);
  }
  let payload: GraphQLResponse<T>;
  try { payload = await response.json() as GraphQLResponse<T>; }
  catch {
    if (mutation) throw new AmbiguousPublishError();
    throw new Error("O Buffer retornou uma resposta inválida.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (mutation) throw new AmbiguousPublishError();
    throw new Error("O Buffer retornou uma resposta inválida.");
  }
  // A mutation may succeed with warnings. Preserve a confirmed remote ID instead of losing it.
  if (payload.errors?.length && !payload.data) {
    if (mutation) throw new AmbiguousPublishError();
    throw new Error("O Buffer recusou a consulta. Verifique a chave, permissões e configuração do canal.");
  }
  if (!payload.data) {
    if (mutation) throw new AmbiguousPublishError();
    throw new Error("O Buffer retornou uma resposta sem dados.");
  }
  return payload.data;
}

function validUrl(value: string, httpsOnly = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("URL de imagem ou referência inválida."); }
  if ((httpsOnly ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol)) || url.username || url.password) {
    throw new Error("URL de imagem ou referência inválida.");
  }
  return url.href;
}

/** Reserve room for the source and hashtags; the Instagram limit includes everything. */
export function postCaption(content: DraftContent, service = "instagram"): string {
  const source = `Fonte: ${content.sourceName.replace(/[\r\n]/g, " ").slice(0, 100)}\n${validUrl(content.sourceUrl)}`;
  const tags = [...new Set(content.hashtags.map((tag) => tag.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean))]
    .slice(0, 8).map((tag) => `#${Array.from(tag).slice(0, 50).join("")}`).join(" ");
  const footer = content.origin === "authored" ? (tags ? `\n\n${tags}` : "") : `\n\n${source}${tags ? `\n\n${tags}` : ""}`;
  const limit = ["google", "googlebusiness"].includes(service) ? 1500 : 2200;
  if (footer.length >= limit - 50) throw new Error("Referência e hashtags excedem o tamanho da legenda.");
  let body = content.caption.trim();
  const existingSource = `\n\nFonte: ${content.sourceName}\n${content.sourceUrl}`;
  if (body.endsWith(existingSource)) body = body.slice(0, -existingSource.length).trimEnd();
  if (!body) throw new Error("A legenda está vazia.");
  const room = limit - footer.length;
  const text = body.length <= room ? body : `${body.slice(0, room - 1).replace(/\s+\S*$/, "").trimEnd()}…`;
  return `${text}${footer}`;
}

export async function listBufferChannels(env: Env, fetcher: Fetcher = fetch): Promise<Channel[]> {
  const account = await request<{ account: { organizations: { id: string }[] } }>(
    "query BotOrganizations { account { organizations { id } } }", {}, env, fetcher,
  );
  if (!Array.isArray(account.account?.organizations)) throw new Error("O Buffer não retornou as organizações da conta.");
  const channels = new Map<string, Channel>();
  for (const organization of account.account.organizations) {
    const data = await request<{ channels: { id: string; name: string; service: string; isDisconnected?: boolean; isLocked?: boolean; isQueuePaused?: boolean }[] }>(
      "query BotChannels($input: ChannelsInput!) { channels(input: $input) { id name service isDisconnected isLocked isQueuePaused } }",
      { input: { organizationId: organization.id } }, env, fetcher,
    );
    if (!Array.isArray(data.channels)) throw new Error("O Buffer não retornou os canais da conta.");
    for (const channel of data.channels) {
      if (!channel.id || !channel.name || !channel.service) continue;
      channels.set(channel.id, {
        id: channel.id, name: channel.name, service: channel.service,
        enabled: !channel.isDisconnected && !channel.isLocked && !channel.isQueuePaused,
      });
    }
  }
  return [...channels.values()];
}

export async function enqueuePost(post: Post, channel: Channel, imageUrl: string, env: Env, fetcher: Fetcher = fetch): Promise<{ id: string; dueAt?: string }> {
  if (post.demo) throw new Error("Um post de demonstração não pode ser publicado nas redes.");
  if (!channel.enabled) throw new Error("O canal está desativado.");
  if (!["instagram", "linkedin", "facebook", "googlebusiness"].includes(channel.service)) throw new Error("Esta versão publica em Instagram, LinkedIn, Facebook e Perfil da Empresa no Google.");
  const now = Date.now();
  let dueAt = new Date(now + 120_000).toISOString();
  if (post.scheduledAt !== undefined) {
    const match = typeof post.scheduledAt === "string" && /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(post.scheduledAt);
    const timestamp = Date.parse(post.scheduledAt);
    const calendarValid = match && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[3]) >= 1 && Number(match[3]) <= new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
    if (!match || !calendarValid || !Number.isFinite(timestamp)) throw new Error("O horário da publicação deve ser uma data ISO válida, com fuso horário.");
    if (timestamp < now + 60_000) throw new Error("O horário da publicação deve estar pelo menos 60 segundos no futuro. Escolha um novo horário.");
    dueAt = new Date(timestamp).toISOString();
  }
  const input = {
    channelId: channel.id,
    text: postCaption(post.content, channel.service),
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt,
    needsApproval: false,
    saveToDraft: false,
    aiAssisted: true,
    source: "clinic-content-bot",
    assets: [{ image: { url: validUrl(imageUrl, true) } }],
    ...(channel.service === "instagram" ? { metadata: { instagram: { type: "post", shouldShareToFeed: true } } } : {}),
    ...(channel.service === "facebook" ? { metadata: { facebook: { type: "post" } } } : {}),
    ...(channel.service === "googlebusiness" ? { metadata: { google: { type: "whats_new" } } } : {}),
  };
  const result = await request<{ createPost: { __typename?: string; post?: { id?: string; dueAt?: string }; message?: string } }>(
    `mutation BotCreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        __typename
        ... on PostActionSuccess { post { id dueAt } }
        ... on MutationError { message }
      }
    }`, { input }, env, fetcher, true,
  );
  const action = result.createPost;
  if (action?.post?.id) return { id: action.post.id, ...(action.post.dueAt ? { dueAt: action.post.dueAt } : {}) };
  if (action?.message || (action?.__typename && action.__typename !== "PostActionSuccess")) {
    throw new Error("O Buffer rejeitou a publicação. Confira a conexão do canal, as permissões e os limites do plano no Buffer.");
  }
  throw new AmbiguousPublishError();
}

export async function getBufferPost(remoteId: string, env: Env, fetcher: Fetcher = fetch): Promise<{ status: string; error?: string }> {
  if (!remoteId) throw new Error("Informe o identificador do post no Buffer.");
  const result = await request<{ post?: { id: string; status: string } }>(
    "query BotPostStatus($input: PostInput!) { post(input: $input) { id status } }",
    { input: { id: remoteId } }, env, fetcher,
  );
  if (!result.post?.status) throw new Error("O Buffer não retornou o status da publicação.");
  return {
    status: result.post.status,
    ...(result.post.status === "error" ? { error: "O Buffer informou falha na publicação. Confira o detalhe no painel do Buffer." } : {}),
  };
}
