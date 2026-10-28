# Solv · Estúdio de conteúdo

Ferramenta da [Solv](https://solv-cf55a.web.app/) para preparar textos e artes do [@solv_tec](https://www.instagram.com/solv_tec/). O foco inicial é apresentar a oferta de sites para negócios e profissionais de beleza e estética.

## Arquitetura

- **Firebase Hosting:** entrega o painel ao navegador em um projeto próprio.
- **Cloudflare Workers:** API protegida, geração de conteúdo e controle de publicação.
- **D1 e Queues:** armazenamento de configurações, rascunhos, imagens e tarefas.
- **Gemini e Workers AI/FLUX:** texto estruturado e ilustração; Browser Run monta o PNG de 1080 × 1350.
- **Buffer:** integra os canais sociais e confirma entregas.

O Firebase hospeda a interface; o processamento e os segredos continuam no backend Cloudflare. Publicar o painel não ativa postagens nas redes.

## Acesso para revisão

O painel exige login. A credencial de **editor** permite revisar e editar conteúdo e solicitar as gerações autorizadas. Ela não permite publicar, habilitar canais, alterar a agenda de entrega ou despausar a automação. O administrador mantém esses controles.

`ADMIN_TOKEN` e `EDITOR_TOKEN` são configurados no backend. Não compartilhe a credencial administrativa para uma revisão editorial, nem coloque tokens de serviços no código do frontend.

## Desenvolvimento local

Requer Node.js 24 ou mais recente.

```sh
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npm run dev
```

O arquivo `wrangler.jsonc` é local e ignorado pelo Git. Preencha seus próprios identificadores ao configurar uma implantação real. O exemplo público não contém dados da conta de produção.

Abra **http://127.0.0.1:8787**. No primeiro início, o servidor cria `.dev.vars` e gera `ADMIN_TOKEN`; esse valor é a credencial administrativa local. Os campos disponíveis estão em [.dev.vars.example](.dev.vars.example). Nunca publique o arquivo preenchido.

**Testar demonstração** usa dados de exemplo e não chama os provedores nem publica. **Executar agora** pode usar fontes e IA reais quando configuradas; isso consome as cotas das contas. O ambiente local usa `DEMO_MODE=true` para bloquear envio externo.

Para informar chaves sem gravá-las no repositório:

```sh
npm run configure
```

Para usar os bindings remotos de imagem e renderização, autentique sua conta com `npx wrangler login`. Não é necessária uma chave FLUX separada. Veja [as integrações](docs/INTEGRATIONS.md).

## Configurar o backend

Crie seus próprios recursos e copie os identificadores para o `wrangler.jsonc` local:

```sh
npx wrangler login
npx wrangler d1 create solv-content-studio
npx wrangler queues create solv-content-studio-jobs
```

Ajuste nomes, bindings e IDs conforme o exemplo. Defina `PUBLIC_BASE_URL` com o endereço HTTPS do seu Worker e `ALLOWED_ORIGINS` com as origens exatas do novo projeto Firebase (`https://YOUR_PROJECT.web.app,https://YOUR_PROJECT.firebaseapp.com`). Essa lista contém endereços públicos, não credenciais.

```sh
npm run db:remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put EDITOR_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put BUFFER_API_KEY
npm run deploy
```

Use credenciais administrativas e editoriais diferentes, aleatórias e com pelo menos 24 caracteres. As chaves de serviços permanecem nos secrets do Worker. Só ative execução real e canais após revisar a configuração; instalações novas começam pausadas e com aprovação.

## Hospedar o painel no Firebase

Crie um projeto Firebase próprio e configure-o na CLI. O painel é estático: não exige migrar o banco, criar funções Firebase ou mover as chaves das APIs para o navegador.

Defina `PUBLIC_API_BASE_URL` no ambiente de build com o endereço HTTPS do backend. Esse endereço é público; não inclua tokens nele.

```sh
PUBLIC_API_BASE_URL=https://YOUR_WORKER.workers.dev npm run build:hosting
```

Depois de selecionar o projeto correto na CLI:

```sh
npm run deploy:hosting
```

As regras e os arquivos publicados ficam definidos em `firebase.json`. O comando `deploy:hosting` recompila a interface; mantenha `PUBLIC_API_BASE_URL` definido também durante essa execução. Confira as origens permitidas no Worker antes de abrir o painel hospedado.

## Revisar a campanha Solv

- [Perfil, oferta e direção editorial](content/solv-profile.json).
- [Campanha inicial de 12 rascunhos](content/solv-launch.json).
- [Plano editorial e critérios de revisão](docs/SOLV.md).

Em **Publicações → Importar campanha em rascunho**, carregue o JSON da campanha. A importação autenticada aceita até 21 itens e 64 KB, preserva edições de IDs já existentes e não chama IA, gera imagens ou publica. Depois, revise legendas e use **Gerar imagem com IA** e **Preparar PNG** conforme necessário.

As artes salvas são reutilizadas ao abrir a prévia, preparar o PNG e aprovar um envio. Referências externas mantêm atribuição e link; conteúdos autorais são identificados separadamente. Demonstrações de layouts são fictícias e não representam clientes ou resultados comerciais.

## Publicação e operação

Conecte **@solv_tec** ao Buffer como perfil profissional com publicação automática disponível. Configure `BUFFER_API_KEY` no backend, sincronize canais no painel administrativo e habilite somente o destino correto.

A agenda inicial da Solv é segunda, quarta e sexta às 09h, em `America/Sao_Paulo`; o horário é ajustável. A automação permanece pausada durante a revisão editorial e não é controlada pelo acesso de editor.

**Na fila** significa aceito pelo Buffer; **Publicado** exige confirmação do canal. Um envio incerto não é repetido automaticamente. Pausar o bot impede novas execuções, mas não cancela posts já aceitos pelo Buffer. Conteúdo entregue deve ser alterado no Buffer ou na própria rede.

## Custos e limites

O projeto utiliza serviços com faixas gratuitas, sujeitos às cotas e ao plano de cada conta. Chamadas reais de IA e renderização consomem essas cotas mesmo em desenvolvimento. Não há garantia de uso ilimitado ou de custo zero em qualquer plano.

Consulte as condições oficiais de [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Browser Run](https://developers.cloudflare.com/browser-run/pricing/), [Firebase Hosting](https://firebase.google.com/docs/hosting/usage-quotas-pricing) e [Buffer](https://buffer.com/pricing) antes de ativar faturamento pago. No plano gratuito, respeite também os intervalos entre renderizações de PNG.

## Verificações

```sh
npm run check
npm run check:feeds
```

`check` executa TypeScript e testes automatizados com provedores simulados e SQLite local. `check:feeds` consulta somente as fontes públicas. O roteiro opcional `npm run test:ui` usa um servidor local ativo e o Chrome instalado; capturas ficam em `test-results/`, fora do Git.

## Estrutura

`src/worker.ts` contém API e tarefas; `auth.ts`, acesso; `pipeline.ts`, geração e envio; `feeds.ts`, referências; `gemini.ts`, texto; `visuals.ts` e `artwork.ts`, imagens; `buffer.ts`, canais; `repository.ts`, persistência; `dashboard.ts`, interface. `migrations/` define o banco e `tests/` contém as verificações.

Cada instalação mantém uma marca. Outros clientes podem usar instalações separadas com banco, fila, credenciais e canais próprios. Vários clientes com dados e permissões isolados em um único painel ainda exigem implementação específica.
