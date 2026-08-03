# Portal de Demandas -> ClickUp

MVP para abertura de demandas internas via formulario web, com criacao automatica de task no ClickUp e gravacao de audio transcrito automaticamente (Whisper/OpenAI) direto no campo de descricao.

## O que este MVP faz

- Exibe formulario web para solicitacao de demandas.
- **Identifica o solicitante pela sessao da SASI** quando o portal roda como canal URL, dispensando os campos de nome e contato.
- Permite **gravar audio no navegador** e transcreve automaticamente na Descricao.
- Cria task no ClickUp em uma lista Kanban definida.
- Monta `description` estruturada com os dados da solicitacao.
- Anexa o audio gravado na task (quando houver).
- Implementa idempotencia por `x-idempotency-key` (ou fingerprint do payload).
- Retorna protocolo para o usuario.

## Requisitos

- Node.js 18+
- Conta ClickUp com token de API e `list_id`
- Chave da OpenAI (para transcricao de audio via Whisper)

## Configuracao

1. Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

2. Preencha as variaveis:

- `CLICKUP_API_TOKEN`
- `CLICKUP_LIST_ID`
- `CLICKUP_DEFAULT_STATUS`
- `OPENAI_API_KEY`

### Descobrir IDs do ClickUp

Se o endpoint `/team` funcionar na sua conta:

```bash
npm run discover:clickup
```

Se `/team` retornar erro (ex.: `SHARD_006`), use a URL do quadro:

```bash
node scripts/discover-from-url.js "https://app.clickup.com/<team>/v/li/<listId>"
```

Ambos imprimem `listId`, `statuses` e custom fields disponiveis.

### Teste rapido da integracao

Cria uma task real no ClickUp, sem audio nem IA:

```bash
npm run smoke:task
```

## Execucao

```bash
npm install
npm run dev
```

Abra:

- `http://localhost:3000`

Healthcheck:

- `GET /api/health`

## Endpoints

### `POST /api/transcribe` (`multipart/form-data`)

- `audio`: arquivo de audio (gravado no navegador)
- Retorna: `{ "text": "transcricao..." }`

### `GET /api/me`

Resolve quem e o solicitante a partir do token da SASI presente na requisicao.

- Com token valido: `{ "identified": true, "name", "email", "phone", "teamId" }`
- Sem token ou token invalido: `{ "identified": false }`

### `GET /api/sasi-debug`

Diagnostico para descobrir **como** a SASI entrega o token ao portal. Retorna os nomes dos cookies, as chaves da query string e o token mascarado. Nunca expoe o valor completo.

### `POST /api/requests` (`multipart/form-data`)

Campos esperados:

- `title` (obrigatorio)
- `requester` (obrigatorio **apenas quando nao ha identificacao da SASI**; com token, o valor enviado pelo formulario e ignorado e substituido pelo perfil real)
- `area` (obrigatorio, `Comercial|Marketing|Outro`)
- `demandType` (obrigatorio, `Figma|Sistema (VibeCode)|HubSpot (alteracoes)|App SASI|Outro`)
- `priority` (`baixa|media|alta|urgente`)
- `contact`
- `dueDate`
- `description`
- `audio` (arquivo opcional, anexado na task)

Header opcional para idempotencia:

- `x-idempotency-key: <valor-unico>`

## Variaveis de ambiente

- `PORT` (padrao 3000)
- `CLICKUP_API_TOKEN`
- `CLICKUP_LIST_ID`
- `CLICKUP_DEFAULT_STATUS` (padrao `backlog`)
- `OPENAI_API_KEY`
- `OPENAI_TRANSCRIBE_MODEL` (padrao `whisper-1`)
- `OPENAI_CLEANUP` (`true` para corrigir pontuacao/clareza do texto transcrito)
- `OPENAI_CLEANUP_MODEL` (padrao `gpt-4o-mini`)
- `SASI_API_BASE` (padrao `https://api.sasi.io`)
- `SASI_COOKIE_NAME` (padrao `sasi-token`)
- `SASI_DEBUG` (`false` desativa o `/api/sasi-debug`; deixe ligado ate descobrir o formato de entrega do token)

Nao existe variavel de token da SASI, e isso e proposital: o token e de cada usuario e chega na propria requisicao.

## Identificacao do solicitante via SASI

O portal e publicado como um **canal do tipo URL** dentro do app da SASI, com `useWebclientAuth` ativado. Assim a SASI abre a pagina ja autenticada e repassa o token daquele usuario.

O fluxo no backend:

1. `extractSasiToken` procura o token na requisicao, nesta ordem: cookie `sasi-token`, query string (`sasi-token`, `sasiToken` ou `token`), header `x-sasi-token`, header `Authorization: Bearer`.
2. Com o token, chama `GET /api/v2/providers/external/me` na SASI usando `Authorization: Bearer`.
3. Le `name` do perfil, e `email`/`phone` de `profileProps` com `customProps` como reserva.
4. Em `POST /api/requests`, a identidade resolvida **sobrescreve** o que veio do formulario.

Regras de seguranca adotadas:

- **Nao ha token padrao.** Sem token o portal exibe os campos manuais, nunca assume a identidade de outra pessoa.
- **A identidade e sempre resolvida no servidor.** O navegador nao consegue forjar o solicitante.
- Token invalido cai no mesmo caminho de "sem token".

Limitacoes conhecidas:

- O `/external/me` devolve apenas `TeamId` (numero), sem o nome do time. O endpoint `GET /teams` responde **403** para tokens de perfil, entao o campo de area continua manual.
- O `/external/me` esta marcado como `deprecated` no OpenAPI da SASI. Vale confirmar o substituto com o time deles.
- `customProps` e um objeto livre, definido por app. O mapeamento de email/telefone foi validado em um app de teste e precisa ser reconferido com um usuario do app de producao.

## Deploy no Vercel

O deploy e definido pelo `vercel.json`: todo o trafego vai para `src/server.js` rodando em `@vercel/node`, e o `public/` entra no bundle via `includeFiles`. O proprio Express serve os estaticos, entao nao ha divisao de rotas entre funcao e CDN.

### Passo a passo (CLI)

```bash
npm i -g vercel
vercel login
vercel link
```

Configure as variaveis de ambiente (producao):

```bash
vercel env add CLICKUP_API_TOKEN production
vercel env add CLICKUP_LIST_ID production
vercel env add CLICKUP_DEFAULT_STATUS production
vercel env add OPENAI_API_KEY production
vercel env add OPENAI_TRANSCRIBE_MODEL production
```

As variaveis `SASI_*` sao opcionais: os padroes (`https://api.sasi.io` e `sasi-token`) ja funcionam.

Publique:

```bash
vercel --prod
```

### Alternativa (Git)

1. Suba o repositorio para o GitHub (o `.env` NAO vai, esta no `.gitignore`).
2. Importe o projeto em vercel.com.
3. Em Settings -> Environment Variables, cadastre as mesmas variaveis acima.
4. Deploy.

## Publicar como canal na SASI

1. Faca o deploy no Vercel e anote a URL de producao.
2. Na SASI, crie um canal do tipo **URL** apontando para essa URL, com **`useWebclientAuth` ativado** (e o que faz a SASI repassar o token de cada usuario).
3. Garanta que o canal **libere a permissao de microfone**. Se o portal abrir em iframe sem `allow="microphone"`, a gravacao falha e o formulario mostra um aviso explicando isso.
4. Abra `SUA_URL/api/sasi-debug` **pelo app da SASI** (nao pelo navegador comum) e guarde o JSON. Ele revela se o token chega por cookie, query string ou header.
5. Com o formato confirmado, ajuste `SASI_COOKIE_NAME` se o nome for diferente e defina `SASI_DEBUG=false` para desligar o diagnostico.

Enquanto o passo 4 nao for feito, o portal ja funciona: ele tenta os quatro formatos de entrega e, nao achando token, cai no preenchimento manual.

### Observacoes de producao no Vercel

- **Microfone exige HTTPS** — o Vercel ja entrega HTTPS, entao a gravacao funciona.
- **Idempotencia e best-effort** no serverless (usa `/tmp`, efemero). Para idempotencia duravel, migrar o store para Upstash Redis, Vercel Blob ou Neon.
- **Sem autenticacao obrigatoria**: quem abrir a URL fora do app da SASI cai no formulario manual e consegue criar tasks. Se o portal nao deve aceitar demandas anonimas, exija identificacao rejeitando requisicoes sem token em `POST /api/requests`.
- **Nao ative Vercel Deployment Protection** neste projeto: ela bloquearia a abertura do portal dentro do app da SASI.
- **Token na URL**: o formulario remove o token da barra de enderecos assim que o le, e a pagina usa `referrer: strict-origin` para nao vazar a URL completa em requisicoes a terceiros.
- **Timeout**: transcricao de audios curtos fica bem dentro do limite padrao (300s).

## Observacoes importantes

- A gravacao usa a API `MediaRecorder` do navegador. Em `localhost` funciona; em producao exige HTTPS para acessar o microfone.
- Para maior robustez em producao, recomenda-se:
  - fila assincrona para transcricao,
  - banco de dados para idempotencia e auditoria,
  - retries com backoff,
  - autenticacao no formulario interno.
