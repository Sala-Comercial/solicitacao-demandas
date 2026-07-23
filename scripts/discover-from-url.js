/* eslint-disable no-console */
require("dotenv").config();

const API_BASE = "https://api.clickup.com/api/v2";
const token = process.env.CLICKUP_API_TOKEN;

const inputUrl = process.argv[2];
if (!token) {
  console.error("Missing CLICKUP_API_TOKEN in .env");
  process.exit(1);
}
if (!inputUrl) {
  console.error('Uso: node scripts/discover-from-url.js "<url do ClickUp>"');
  console.error("Abra a lista/quadro no navegador e copie a URL completa.");
  process.exit(1);
}

async function api(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: token }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`ClickUp API ${response.status} em ${path}: ${body}`);
  }
  return JSON.parse(body);
}

function extractIds(url) {
  // Formatos comuns:
  // https://app.clickup.com/{team_id}/v/li/{list_id}
  // https://app.clickup.com/{team_id}/v/l/li/{list_id}
  // https://app.clickup.com/{team_id}/v/b/li/{list_id}  (board view)
  // https://app.clickup.com/{team_id}/v/l/{view_id}
  const teamMatch = url.match(/app\.clickup\.com\/(\d+)/);
  const listMatch = url.match(/\/li\/(\d+)/);
  return {
    teamId: teamMatch ? teamMatch[1] : null,
    listId: listMatch ? listMatch[1] : null
  };
}

async function describeList(listId) {
  const list = await api(`/list/${listId}`);
  const fields = await api(`/list/${listId}/field`);
  console.log("\n=== Lista encontrada ===");
  console.log(`listId: ${list.id}`);
  console.log(`nome: ${list.name}`);
  console.log(`space: ${list.space ? list.space.name : "?"}`);
  console.log(`statuses: ${(list.statuses || []).map((s) => s.status).join(", ") || "(herdados do space)"}`);
  console.log("\nCustom fields:");
  for (const field of fields.fields || []) {
    console.log(`- ${field.name} (tipo: ${field.type}) -> fieldId: ${field.id}`);
  }
  console.log("\n=== Valores para o .env ===");
  console.log(`CLICKUP_LIST_ID=${list.id}`);
  const firstStatus = (list.statuses || [])[0];
  if (firstStatus) console.log(`CLICKUP_DEFAULT_STATUS=${firstStatus.status}`);
  const transcriptField = (fields.fields || []).find((f) =>
    f.name.toLowerCase().includes("transcri")
  );
  if (transcriptField) {
    console.log(`CLICKUP_TRANSCRIPTION_FIELD_ID=${transcriptField.id}`);
  } else {
    console.log(
      "CLICKUP_TRANSCRIPTION_FIELD_ID= (nenhum campo 'Transcricao' encontrado; crie um campo de texto na lista se quiser salvar transcricao)"
    );
  }
}

async function exploreTeam(teamId) {
  console.log(`\nExplorando workspace ${teamId}...`);
  const spacesResp = await api(`/team/${teamId}/space?archived=false`);
  for (const space of spacesResp.spaces || []) {
    console.log(`\nSpace: ${space.name} (${space.id})`);
    const folderless = await api(`/space/${space.id}/list?archived=false`);
    for (const list of folderless.lists || []) {
      console.log(`  Lista: ${list.name} -> listId: ${list.id}`);
    }
    const foldersResp = await api(`/space/${space.id}/folder?archived=false`);
    for (const folder of foldersResp.folders || []) {
      for (const list of folder.lists || []) {
        console.log(`  Lista (pasta ${folder.name}): ${list.name} -> listId: ${list.id}`);
      }
    }
  }
}

async function main() {
  const { teamId, listId } = extractIds(inputUrl);
  console.log(`IDs extraidos da URL -> teamId: ${teamId || "nao encontrado"}, listId: ${listId || "nao encontrado"}`);

  if (listId) {
    await describeList(listId);
    return;
  }

  if (teamId) {
    await exploreTeam(teamId);
    console.log("\nCopie o listId da lista desejada e rode:");
    console.log('node scripts/discover-from-url.js "https://app.clickup.com/.../li/<listId>"');
    return;
  }

  console.error("Nao consegui extrair IDs dessa URL. Abra a lista no ClickUp e copie a URL completa do navegador.");
  process.exit(1);
}

main().catch((error) => {
  console.error("[discover-from-url] falhou:", error.message);
  process.exit(1);
});
