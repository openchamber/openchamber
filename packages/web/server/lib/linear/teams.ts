import { clearLinearAuth, getLinearAuth } from './auth.js';
import { fetchLinearGraphql, getValidLinearAccessToken } from './client.js';
import { isPlainObject, readTrimmedString } from './parse.js';
import type { Connected } from '../trackers/tracker-contract.js';

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

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

interface LinearTeamsQueryVariables {
  first: number;
  after?: string;
}

function canReadStatus(value: unknown): value is { status?: unknown } {
  return value != null;
}

function readTeam(node: Parameters<typeof readTrimmedString>[0]): LinearTeam | null {
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

export async function listLinearTeams(): Promise<Connected<{ teams: LinearTeam[] }>> {
  try {
    const token = await getValidLinearAccessToken();
    if (!token) {
      return { connected: false };
    }

    const teams: LinearTeam[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const variables: LinearTeamsQueryVariables = { first: PAGE_SIZE };
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
        break;
      }
    }

    return { connected: true, teams };
  } catch (error) {
    if (canReadStatus(error) && error.status === 401) {
      clearLinearAuth(getLinearAuth()?.workspaceId);
      return { connected: false };
    }
    throw error;
  }
}
