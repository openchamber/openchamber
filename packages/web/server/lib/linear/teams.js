import { clearLinearAuth, getLinearAuth } from './auth.js';
import { fetchLinearGraphql, getValidLinearAuthorization } from './client.js';
import { isPlainObject, readTrimmedString } from './parse.js';

const TEAMS_QUERY = `
  query ListLinearTeams($first: Int!, $after: String) {
    teams(first: $first, after: $after) {
      nodes { id key name }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

function readTeam(node) {
  if (!isPlainObject(node)) {
    return null;
  }
  const id = readTrimmedString(node.id);
  const key = readTrimmedString(node.key);
  const name = readTrimmedString(node.name);
  if (!id || !key || !name) {
    return null;
  }
  return { id, key, name };
}

export async function listLinearTeams() {
  try {
    const token = await getValidLinearAuthorization();
    if (!token) {
      return { connected: false };
    }

    const teams = [];
    let teamsMore = false;
    let after = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const variables = { first: PAGE_SIZE };
      if (after) {
        variables.after = after;
      }
      const data = await fetchLinearGraphql(token, TEAMS_QUERY, variables);
      const connection = isPlainObject(data.teams) ? data.teams : null;
      const nodes = isPlainObject(connection) && Array.isArray(connection.nodes)
        ? connection.nodes
        : [];
      for (const node of nodes) {
        const team = readTeam(node);
        if (team) {
          teams.push(team);
        }
      }
      const pageInfo = isPlainObject(connection) ? connection.pageInfo : null;
      if (!isPlainObject(pageInfo) || pageInfo.hasNextPage !== true) {
        break;
      }
      after = readTrimmedString(pageInfo.endCursor);
      if (!after) {
        teamsMore = true;
        break;
      }
      if (page === MAX_PAGES - 1) {
        teamsMore = true;
      }
    }

    return { connected: true, teams, teamsMore };
  } catch (error) {
    if (error?.status === 401) {
      const failed = getLinearAuth();
      if (!failed?.tokenReference) {
        clearLinearAuth(failed?.workspaceId);
      }
      return { connected: false };
    }
    throw error;
  }
}
