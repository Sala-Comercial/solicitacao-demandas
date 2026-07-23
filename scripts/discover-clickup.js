/* eslint-disable no-console */
require("dotenv").config();

const API_BASE = "https://api.clickup.com/api/v2";

function requireToken() {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    throw new Error("Missing CLICKUP_API_TOKEN in environment");
  }
  return token;
}

async function api(path) {
  const token = requireToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: token }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ClickUp API error ${response.status} on ${path}: ${body}`);
  }
  return response.json();
}

async function tryApi(path) {
  try {
    return await api(path);
  } catch (error) {
    return { __error: error.message };
  }
}

function normalizeTeamsFromUser(userPayload) {
  const candidates = userPayload?.user?.teams || userPayload?.teams || [];
  return candidates
    .filter((t) => t && t.id)
    .map((t) => ({
      id: t.id,
      name: t.name || t.team_name || `team-${t.id}`
    }));
}

async function fetchSpacesForTeam(teamId) {
  const primary = await tryApi(`/team/${teamId}/space?archived=false`);
  if (!primary.__error) return primary;

  const fallback = await tryApi(`/workspace/${teamId}/space?archived=false`);
  if (!fallback.__error) return fallback;

  throw new Error(
    `Could not fetch spaces for team/workspace ${teamId}. Tried /team and /workspace endpoints.`
  );
}

async function fetchListsInSpace(spaceId) {
  const folderless = await api(`/space/${spaceId}/list?archived=false`);
  const foldersResp = await api(`/space/${spaceId}/folder?archived=false`);
  const fromFolders = [];

  for (const folder of foldersResp.folders || []) {
    const listsResp = await api(`/folder/${folder.id}/list?archived=false`);
    for (const list of listsResp.lists || []) {
      fromFolders.push({
        ...list,
        folderName: folder.name
      });
    }
  }

  return [
    ...(folderless.lists || []).map((list) => ({ ...list, folderName: null })),
    ...fromFolders
  ];
}

async function main() {
  const me = await api("/user");
  const teamsResp = await tryApi("/team");
  const teams =
    !teamsResp.__error && Array.isArray(teamsResp.teams) && teamsResp.teams.length
      ? teamsResp.teams
      : normalizeTeamsFromUser(me);

  if (!teams.length) {
    throw new Error(
      "No teams/workspaces found. Validate token permissions or use a Personal API token from Settings > Apps."
    );
  }

  const output = {
    user: {
      id: me.user.id,
      username: me.user.username,
      email: me.user.email
    },
    notes: {
      teamDiscovery:
        teamsResp.__error
          ? `Fallback to /user teams because /team failed: ${teamsResp.__error}`
          : "Teams discovered from /team endpoint"
    },
    teams: []
  };

  for (const team of teams || []) {
    const spacesResp = await fetchSpacesForTeam(team.id);
    const teamOutput = {
      teamId: team.id,
      teamName: team.name,
      spaces: []
    };

    for (const space of spacesResp.spaces || []) {
      const lists = await fetchListsInSpace(space.id);
      const spaceOutput = {
        spaceId: space.id,
        spaceName: space.name,
        lists: []
      };

      for (const list of lists) {
        const fieldsResp = await api(`/list/${list.id}/field`);
        spaceOutput.lists.push({
          listId: list.id,
          listName: list.name,
          folderName: list.folderName,
          statuses: (list.statuses || []).map((s) => s.status),
          fields: (fieldsResp.fields || []).map((field) => ({
            fieldId: field.id,
            fieldName: field.name,
            fieldType: field.type
          }))
        });
      }

      teamOutput.spaces.push(spaceOutput);
    }

    output.teams.push(teamOutput);
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error("[discover-clickup] failed:", error.message);
  process.exit(1);
});
