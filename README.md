# Portal de Demandas -> ClickUp

MVP para abertura de demandas internas via formulario web, com criacao automatica de task no ClickUp e gravacao de audio transcrito automaticamente (Whisper/OpenAI) direto no campo de descricao.

## O que este MVP faz

- Exibe formulario web para solicitacao de demandas.
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

### `POST /api/requests` (`multipart/form-data`)

Campos esperados:

- `title` (obrigatorio)
- `requester` (obrigatorio)
- `area` (obrigatorio)
- `team` (obrigatorio)
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

## Deploy no Vercel

O Vercel detecta o Express automaticamente pelo `package.json` e usa `src/server.js` como entrypoint (o app e exportado com `module.exports = app`). O `public/` e servido como estatico. Nao e necessario `vercel.json`.

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

Publique:

```bash
vercel --prod
```

### Alternativa (Git)

1. Suba o repositorio para o GitHub (o `.env` NAO vai, esta no `.gitignore`).
2. Importe o projeto em vercel.com.
3. Em Settings -> Environment Variables, cadastre as mesmas variaveis acima.
4. Deploy.

### Observacoes de producao no Vercel

- **Microfone exige HTTPS** — o Vercel ja entrega HTTPS, entao a gravacao funciona.
- **Idempotencia e best-effort** no serverless (usa `/tmp`, efemero). Para idempotencia duravel, migrar o store para Upstash Redis, Vercel Blob ou Neon.
- **Sem autenticacao**: qualquer pessoa com a URL pode criar tasks. Para uso interno, ative Vercel Deployment Protection (ou adicione login) antes de divulgar o link.
- **Timeout**: transcricao de audios curtos fica bem dentro do limite padrao (300s).

## Observacoes importantes

- A gravacao usa a API `MediaRecorder` do navegador. Em `localhost` funciona; em producao exige HTTPS para acessar o microfone.
- Para maior robustez em producao, recomenda-se:
  - fila assincrona para transcricao,
  - banco de dados para idempotencia e auditoria,
  - retries com backoff,
  - autenticacao no formulario interno.
