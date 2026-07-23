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

// Em serverless (Vercel) o filesystem do projeto e somente leitura; so /tmp e gravavel.
// Localmente usamos ./data para persistir entre reinicios.
const STORE_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), "clickup-portal")
  : path.join(process.cwd(), "data");
const IDEMPOTENCY_STORE_PATH = path.join(STORE_DIR, "idempotency-store.json");

app.use(express.static(path.join(process.cwd(), "public")));
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
  return [
    "## Descricao",
    data.description || "Sem descricao informada",
    "",
    "## Detalhes da solicitacao",
    `- Solicitante: ${data.requester || "Nao informado"}`,
    `- Area: ${data.area || "Nao informado"}`,
    `- Time destino: ${data.team || "Nao informado"}`,
    `- Prioridade: ${data.priority || "Nao informado"}`,
    `- Prazo desejado: ${data.dueDate || "Nao informado"}`,
    `- Canal de contato: ${data.contact || "Nao informado"}`
  ].join("\n");
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
    const title = String(req.body.title || "").trim();
    const requester = String(req.body.requester || "").trim();
    const area = String(req.body.area || "").trim();
    const team = String(req.body.team || "").trim();
    const contact = String(req.body.contact || "").trim();
    const dueDate = String(req.body.dueDate || "").trim();
    const description = String(req.body.description || "").trim();
    const priority = normalizePriority(req.body.priority);

    if (!title || !requester || !area || !team) {
      return res.status(400).json({
        error: "Missing required fields: title, requester, area, team"
      });
    }

    const payloadFingerprint = computePayloadFingerprint({
      title,
      requester,
      area,
      team,
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
        area,
        team,
        priority,
        dueDate,
        contact
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
