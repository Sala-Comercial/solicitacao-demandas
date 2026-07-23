/* eslint-disable no-console */
require("dotenv").config();

const API_BASE = "https://api.clickup.com/api/v2";
const token = process.env.CLICKUP_API_TOKEN;
const listId = process.env.CLICKUP_LIST_ID;
const status = process.env.CLICKUP_DEFAULT_STATUS || "backlog";

if (!token || !listId) {
  console.error("Faltam CLICKUP_API_TOKEN ou CLICKUP_LIST_ID no .env");
  process.exit(1);
}

async function main() {
  const payload = {
    name: `Teste de integracao - ${new Date().toLocaleString("pt-BR")}`,
    description:
      "Task criada automaticamente pelo smoke test do portal de demandas.\nSe voce esta vendo isso no ClickUp, a integracao funciona.",
    status
  };

  const response = await fetch(`${API_BASE}/list/${listId}/task`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Falha ao criar task (${response.status}): ${body}`);
  }

  const task = JSON.parse(body);
  console.log("Task criada com sucesso!");
  console.log(`ID: ${task.id}`);
  console.log(`URL: ${task.url}`);
  console.log(`Status: ${task.status ? task.status.status : status}`);
}

main().catch((error) => {
  console.error("[smoke-create-task] falhou:", error.message);
  process.exit(1);
});
