const express = require("express");
const multer = require("multer");
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const crypto = require("crypto");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const PORT = Number(process.env.PORT || 3000);
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";
const SASI_API_BASE = process.env.SASI_API_BASE || "https://api.sasi.io";
const SASI_COOKIE_NAME = process.env.SASI_COOKIE_NAME || "sasi-token";

// Em serverless (Vercel) o filesystem do projeto e somente leitura; so /tmp e gravavel.
// Localmente usamos ./data para persistir entre reinicios.
const STORE_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), "clickup-portal")
  : path.join(process.cwd(), "data");
const IDEMPOTENCY_STORE_PATH = path.join(STORE_DIR, "idempotency-store.json");

// __dirname em vez de cwd: no serverless o diretorio de trabalho nao e a raiz do projeto.
app.use(express.static(path.resolve(__dirname, "..", "public")));
app.use(express.json({ limit: "2mb" }));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function parseCookies(header) {
  const jar = {};
  if (!header) return jar;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key) jar[key] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return jar;
}

// A SASI abre o portal como canal URL e repassa o token do usuario logado naquela
// sessao. O formato exato da entrega ainda nao foi confirmado no app de producao,
// entao aceitamos cookie, query string e header.
//
// Nao existe token padrao aqui de proposito: sem token o portal cai no
// preenchimento manual, nunca na identidade de outra pessoa.
function extractSasiToken(req) {
  const fromCookie = parseCookies(req.headers.cookie)[SASI_COOKIE_NAME];
  if (fromCookie) return fromCookie;

  const query = req.query || {};
  const fromQuery = query[SASI_COOKIE_NAME] || query.sasiToken || query.token;
  if (fromQuery) return String(fromQuery);

  const fromHeader = req.headers["x-sasi-token"];
  if (fromHeader) return String(fromHeader);

  const authorization = req.headers.authorization || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();

  return null;
}

async function fetchSasiProfile(token) {
  const response = await fetch(`${SASI_API_BASE}/api/v2/providers/external/me`, {
    headers: { Authorization: `Bearer ${token}` },
    // a identificacao nunca pode segurar o carregamento do formulario
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(`SASI /external/me failed (${response.status})`);
  }

  const profile = await response.json();
  // Email e telefone nao sao campos de primeira classe do MobileProfileDto.
  // profileProps e o formato padronizado; customProps varia por app e serve de reserva.
  const props = profile.profileProps || {};
  const custom = profile.customProps || {};

  return {
    id: profile.id ? String(profile.id) : null,
    name: profile.name || props.name || null,
    email: props.email || custom.email || null,
    phone: props.phone || custom.phone || null,
    teamId: profile.TeamId ?? null,
    appName: profile.App?.name || null
  };
}

// Resolve a identidade sempre no servidor: o que o navegador manda no formulario
// nunca substitui o que a SASI confirma para aquele token.
async function resolveSasiIdentity(req) {
  const token = extractSasiToken(req);
  if (!token) return null;

  try {
    const profile = await fetchSasiProfile(token);
    return profile.name ? profile : null;
  } catch (error) {
    console.error("sasi identity error", error.message);
    return null;
  }
}

// Idempotencia best-effort: nunca deve quebrar a criacao da task.
// Em serverless o /tmp e efemero, entao serve como protecao contra duplo-clique
// dentro da mesma instancia. Para idempotencia duravel use Upstash/Blob/Neon.
async function readStore() {
  try {
    await fs.mkdir(path.dirname(IDEMPOTENCY_STORE_PATH), { recursive: true });
    const raw = await fs.readFile(IDEMPOTENCY_STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { keys: {} };
  }
}

async function writeStore(data) {
  try {
    await fs.mkdir(path.dirname(IDEMPOTENCY_STORE_PATH), { recursive: true });
    await fs.writeFile(IDEMPOTENCY_STORE_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // filesystem somente leitura/efemero: ignora sem quebrar o fluxo
  }
}

function computePayloadFingerprint(payload) {
  const base = JSON.stringify(payload);
  return crypto.createHash("sha256").update(base).digest("hex");
}

function buildTaskDescription(data) {
  const lines = [
    "## Descricao",
    data.description || "Sem descricao informada",
    "",
    "## Detalhes da solicitacao",
    `- Tipo de demanda: ${data.demandType || "Nao informado"}`,
    `- Solicitante: ${data.requester || "Nao informado"}`,
    `- E-mail: ${data.email || "Nao informado"}`,
    `- Area: ${data.area || "Nao informado"}`,
    `- Prioridade: ${data.priority || "Nao informado"}`,
    `- Prazo desejado: ${data.dueDate || "Nao informado"}`
  ];

  if (data.identity) {
    lines.push(`- Telefone: ${data.identity.phone || "Nao informado"}`);
    lines.push(
      `- Identificacao: SASI (perfil ${data.identity.id}, time ${data.identity.teamId ?? "n/d"})`
    );
  } else {
    lines.push(`- Canal de contato: ${data.contact || "Nao informado"}`);
    lines.push("- Identificacao: preenchida manualmente");
  }

  return lines.join("\n");
}

async function clickUpRequest(url, init = {}) {
  const token = requireEnv("CLICKUP_API_TOKEN");
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: token,
      ...init.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ClickUp request failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function createClickUpTask(taskInput) {
  const listId = requireEnv("CLICKUP_LIST_ID");
  const payload = {
    name: taskInput.title,
    description: taskInput.description,
    status: process.env.CLICKUP_DEFAULT_STATUS || "backlog"
  };

  if (taskInput.priority === "urgente") payload.priority = 1;
  if (taskInput.priority === "alta") payload.priority = 2;
  if (taskInput.priority === "media") payload.priority = 3;
  if (taskInput.priority === "baixa") payload.priority = 4;

  return clickUpRequest(`${CLICKUP_API_BASE}/list/${listId}/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function uploadClickUpAttachment(taskId, file) {
  const token = requireEnv("CLICKUP_API_TOKEN");
  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype });
  form.append("attachment", blob, file.originalname || "audio.webm");

  const response = await fetch(`${CLICKUP_API_BASE}/task/${taskId}/attachment`, {
    method: "POST",
    headers: {
      Authorization: token
    },
    body: form
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ClickUp attachment upload failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function transcribeAudio(file) {
  if (!openai) throw new Error("OPENAI_API_KEY is required for audio transcription");
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
  const uploadable = await OpenAI.toFile(file.buffer, file.originalname || "audio.webm", {
    type: file.mimetype || "audio/webm"
  });

  const result = await openai.audio.transcriptions.create({
    file: uploadable,
    model,
    language: "pt"
  });

  return (result.text || "").trim();
}

async function cleanupTranscript(text) {
  if (process.env.OPENAI_CLEANUP !== "true" || !openai) return text;
  const model = process.env.OPENAI_CLEANUP_MODEL || "gpt-4o-mini";
  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "Corrija pontuacao e clareza da transcricao em portugues do Brasil. Nao invente informacao. Retorne apenas o texto corrigido."
      },
      { role: "user", content: text }
    ]
  });
  return (response.choices[0]?.message?.content || text).trim();
}

function normalizePriority(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["baixa", "media", "alta", "urgente"].includes(normalized)) return normalized;
  return "media";
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "clickup-demand-portal" });
});

app.get("/api/me", async (req, res) => {
  // resposta contem dado pessoal: nao pode ficar em cache de CDN nem do navegador
  res.set("Cache-Control", "no-store, private");
  const identity = await resolveSasiIdentity(req);
  if (!identity) {
    return res.json({ identified: false });
  }
  return res.json({
    identified: true,
    name: identity.name,
    email: identity.email,
    phone: identity.phone,
    teamId: identity.teamId
  });
});

// Diagnostico para descobrir como a SASI entrega o token quando o portal roda
// como canal URL. Expoe apenas nomes de chaves e o token mascarado.
app.get("/api/sasi-debug", (req, res) => {
  if (process.env.SASI_DEBUG === "false") {
    return res.status(404).json({ error: "Not found" });
  }

  res.set("Cache-Control", "no-store, private");
  const token = extractSasiToken(req);
  const masked = token
    ? `${token.slice(0, 8)}...${token.slice(-6)} (${token.length} chars)`
    : null;

  res.json({
    cookieNames: Object.keys(parseCookies(req.headers.cookie)),
    queryKeys: Object.keys(req.query || {}),
    hasAuthorizationHeader: Boolean(req.headers.authorization),
    hasXSasiTokenHeader: Boolean(req.headers["x-sasi-token"]),
    referer: req.headers.referer || null,
    userAgent: req.headers["user-agent"] || null,
    tokenFound: masked
  });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum audio recebido" });
    }
    const raw = await transcribeAudio(req.file);
    const text = await cleanupTranscript(raw);
    return res.json({ text });
  } catch (error) {
    console.error("transcribe error", error);
    return res.status(500).json({ error: "Falha na transcricao", details: error.message });
  }
});

app.post("/api/requests", upload.single("audio"), async (req, res) => {
  try {
    const identity = await resolveSasiIdentity(req);

    const title = String(req.body.title || "").trim();
    const area = String(req.body.area || "").trim();
    const demandType = String(req.body.demandType || "").trim();
    const dueDate = String(req.body.dueDate || "").trim();
    const description = String(req.body.description || "").trim();
    const priority = normalizePriority(req.body.priority);

    // Com token valido a identidade vem da SASI e o que o formulario enviou e ignorado.
    const requester = identity ? identity.name : String(req.body.requester || "").trim();
    const email = identity ? identity.email : "";
    const contact = identity ? "" : String(req.body.contact || "").trim();

    if (!title || !requester || !area || !demandType) {
      return res.status(400).json({
        error: "Missing required fields: title, requester, area, demandType"
      });
    }

    const payloadFingerprint = computePayloadFingerprint({
      title,
      requester,
      area,
      demandType,
      contact,
      dueDate,
      description,
      priority
    });

    const idempotencyKey = String(req.headers["x-idempotency-key"] || payloadFingerprint);
    const store = await readStore();
    const existing = store.keys[idempotencyKey];
    if (existing) {
      return res.json({
        protocol: existing.protocol,
        duplicated: true,
        clickupTaskId: existing.clickupTaskId,
        clickupTaskUrl: existing.clickupTaskUrl
      });
    }

    const task = await createClickUpTask({
      title,
      description: buildTaskDescription({
        description,
        requester,
        email,
        area,
        demandType,
        priority,
        dueDate,
        contact,
        identity
      }),
      priority
    });

    if (req.file) {
      await uploadClickUpAttachment(task.id, req.file);
    }

    const protocol = `DEM-${Date.now()}`;
    store.keys[idempotencyKey] = {
      protocol,
      clickupTaskId: task.id,
      clickupTaskUrl: task.url,
      createdAt: new Date().toISOString()
    };
    await writeStore(store);

    return res.status(201).json({
      protocol,
      duplicated: false,
      clickupTaskId: task.id,
      clickupTaskUrl: task.url
    });
  } catch (error) {
    console.error("request processing error", error);
    return res.status(500).json({
      error: "Failed to process demand request",
      details: error.message
    });
  }
});

// Local: inicia o servidor. No Vercel o app e importado como handler serverless.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Portal running on http://localhost:${PORT}`);
  });
}

module.exports = app;
