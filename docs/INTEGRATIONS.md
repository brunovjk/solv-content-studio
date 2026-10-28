# Integrações da Solv

As chaves pertencem ao usuário e ficam nos secrets do Worker (ou `.dev.vars` local, ignorado pelo Git). Nunca colocar chaves no navegador, em posts ou no repositório.

## Firebase Hosting e acesso

O Firebase publica os arquivos estáticos da interface. O backend Cloudflare continua responsável por autenticação, D1, fila, geração de conteúdo e Buffer. `PUBLIC_API_BASE_URL` é o endereço público da API usado pelo build, sem tokens na URL.

Configure `ALLOWED_ORIGINS` no Worker com as origens HTTPS exatas do projeto Firebase. Autorizações são verificadas no servidor. O acesso editorial permite as operações de conteúdo previstas para o editor; publicação, canais e configurações de entrega continuam restritos ao administrador.

Use `ADMIN_TOKEN` e `EDITOR_TOKEN` distintos. As chaves Gemini, Buffer e integrações opcionais ficam nos secrets do backend. O repositório contém somente `.dev.vars.example`, com valores vazios, e `wrangler.example.jsonc`, com identificadores de exemplo. `wrangler.jsonc` e `.dev.vars` preenchidos são arquivos locais ignorados.

## Cloudflare Workers AI · FLUX

O Gemini escreve a legenda e `artTitle` (até 54 caracteres) em português, além de `imagePrompt` em inglês. O bot combina a descrição visual com uma direção editorial fixa, sem enviar o artigo ou a legenda ao modelo de imagem. FLUX cria a ilustração sem tipografia; o HTML adiciona o título grande e a marca de forma legível.

O projeto usa `@cf/black-forest-labs/flux-1-schnell`, com **quatro passos fixos**, via `env.AI.run()`. O binding já está em `wrangler.jsonc`:

```json
{ "ai": { "binding": "AI", "remote": true } }
```

No desenvolvimento, `npx wrangler login` autentica o acesso remoto à conta Cloudflare; não é preciso criar uma chave FLUX. Na nuvem, o Worker usa esse binding. O uso real de imagem consome a franquia da conta mesmo quando o restante do bot roda no computador.

A ilustração JPEG é validada e salva em D1 uma vez por post. Abrir a prévia, gerar o PNG ou aprovar reutiliza esses bytes. Uma falha registra o motivo no post e usa uma composição gráfica própria, sem repetição automática da chamada. O botão **Gerar imagem com IA** permite uma tentativa manual para posts reais sem imagem salva; ele envia `POST /api/posts/:id/visual` à fila e **não publica**, nem gera outro texto.

**Testar demonstração** usa conteúdo e arte de exemplo, sem IA. **Executar agora**, mesmo com `DEMO_MODE=true`, pode chamar Gemini e FLUX para avaliar conteúdo real; esse modo bloqueia o envio às redes.

Workers AI oferece **10.000 neurons/dia**, compartilhados pelo uso da conta. No Workers Free, exceder a franquia interrompe novas gerações até a renovação diária; o bot mantém a composição gráfica. No Workers Paid, uso acima da franquia pode ser cobrado. Não há promessa de imagens ilimitadas ou custo zero em qualquer plano.

Referências oficiais:

- [FLUX.1 schnell: modelo, saída JPEG e passos](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/)
- [Workers AI: franquia e preços](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Binding Workers AI](https://developers.cloudflare.com/workers-ai/configuration/bindings/)

## Cloudflare Browser Run

Browser Run converte a composição HTML/CSS, com a ilustração salva ou a composição gráfica alternativa, em PNG de 1080 × 1350. A mesma composição aparece na prévia local. A ilustração fica embutida no HTML como dados; não há script, fonte externa nem carregamento do artigo no renderizador. O Worker oferece a URL pública `/media/:postId.png` para o Buffer acessar.

O projeto usa o binding nativo `BROWSER`, já configurado em `wrangler.jsonc`:

```json
{ "browser": { "binding": "BROWSER", "remote": true } }
```

No desenvolvimento, `npx wrangler login` autentica o uso remoto. Na nuvem, o Worker usa `env.BROWSER.quickAction("screenshot", ...)` diretamente. Não é necessário criar um API Token para esse caminho. Configure `PUBLIC_BASE_URL` com a URL HTTPS pública do Worker antes da publicação real para que o Buffer consiga buscar o PNG.

O botão **Preparar PNG** envia `POST /api/posts/:id/render` à fila. Ele reutiliza a ilustração já salva, gera o arquivo e habilita o download no painel, sem publicar e sem chamar Gemini ou FLUX novamente. Se o PNG já está salvo, ele é reutilizado.

Como alternativa para ambientes sem o binding `BROWSER`, permanece o caminho REST `POST https://api.cloudflare.com/client/v4/accounts/{accountId}/browser-run/screenshot`. Apenas esse caminho exige `CF_ACCOUNT_ID` e o secret `CF_BROWSER_API_TOKEN`, limitado à conta com permissão **Browser Run – Edit**. Não use a chave global da conta.

O plano Workers Free inclui 10 minutos de navegador por dia, compartilhados entre Quick Actions e sessões de navegador; gerar o PNG usa essa franquia. Consulte os limites da conta antes de ativar publicação automática.

Referências oficiais:

- [Screenshot com HTML e viewport](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)
- [Preços e franquia](https://developers.cloudflare.com/browser-run/pricing/)

## Buffer

1. Crie a conta e conecte Instagram profissional, LinkedIn, Facebook ou Perfil da Empresa no Google.
2. Autorize as permissões de publicação e confirme que cada canal permite **publicação automática**. Uma conta configurada somente para notificação exige uma ação manual e não atende ao fluxo autônomo.
3. Gere uma personal API key em [Buffer API](https://publish.buffer.com/settings/api).
4. Configure `BUFFER_API_KEY` como secret e sincronize os canais pelo painel administrativo do bot.
5. Ative os canais desejados; desconectados, bloqueados ou com fila pausada aparecem desativados na sincronização.

O projeto usa a API GraphQL atual em `https://api.buffer.com`, com `Authorization: Bearer`. Descobre organizações e canais, agenda cada imagem com `createPost` e consulta o status por `post(input: { id })`. `customScheduled` agenda para dois minutos após a execução, sem depender dos horários da fila; `schedulingType: automatic`, `saveToDraft: false` e `needsApproval: false` permitem o fluxo sem revisão prévia autorizado pelo usuário. A legenda inclui a referência e hashtags, com até 2200 caracteres (1500 para Google).

Sucesso no agendamento significa **na fila**, não já publicado. O bot reconcilia os estados `scheduled`, `sending`, `sent` e `error`; o painel do Buffer contém os detalhes das falhas de entrega. A documentação não garante uma chave de idempotência para `createPost`. Em timeout, falha de rede ou resposta ambígua, o envio fica sem repetição automática: conferir a fila no Buffer antes de qualquer nova tentativa evita publicações duplicadas.

A imagem deve estar acessível sem login em uma URL HTTPS. O painel continua protegido, mas a mídia de uma publicação é pública. Não usar dados pessoais ou confidenciais na arte.

Os planos, limites da API e quantidade de canais variam; o projeto não presume acesso gratuito ilimitado. Falta de permissão, desconexão ou limite do plano precisa ser resolvido no Buffer.

Referências oficiais:

- [Modelo de conta, organizações e canais](https://developers.buffer.com/guides/data-model.html)
- [Criar post com imagem](https://developers.buffer.com/examples/create-image-post.html)
- [Agendamento e ciclo do post](https://developers.buffer.com/guides/posts-and-scheduling.html)
- [Campos CreatePostInput](https://developers.buffer.com/types/CreatePostInput.html)
- [Tratamento de erros e variáveis GraphQL](https://developers.buffer.com/guides/error-handling.html)
- [Consulta de um post](https://developers.buffer.com/examples/get-post-metrics.html)
- [Estados de publicação](https://developers.buffer.com/types/PostStatus.html)
- [Serviços: Google usa `googlebusiness`](https://developers.buffer.com/types/Service.html)
- [Metadata de publicação no Google](https://developers.buffer.com/types/GoogleBusinessPostMetadataInput.html)
