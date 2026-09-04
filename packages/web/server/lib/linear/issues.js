import { clearLinearAuth, getLinearAuth, getLinearAuthByWorkspaceId } from './auth.js';
import { fetchLinearGraphql, getValidLinearAccessToken } from './client.js';
import { isPlainObject, isString, readFiniteNumber, readTrimmedString } from './parse.js';

const PAGE_SIZE = 50;

const LIST_STATUS_STATE = {
  open: { type: { nin: ['completed', 'canceled', 'duplicate'] } },
  backlog: { type: { eq: 'backlog' } },
  todo: { type: { eq: 'unstarted' } },
  started: { type: { eq: 'started' }, name: { neqIgnoreCase: 'In Review' } },
  inReview: { name: { eqIgnoreCase: 'In Review' } },
  completed: { type: { eq: 'completed' } },
  canceled: { type: { eq: 'canceled' }, name: { neqIgnoreCase: 'Duplicate' } },
  duplicate: { or: [{ type: { eq: 'duplicate' } }, { name: { eqIgnoreCase: 'Duplicate' } }] },
};

function readListStatus(value) {
  const status = readTrimmedString(value);
  if (status === 'all' || Object.hasOwn(LIST_STATUS_STATE, status)) {
    return status;
  }
  return 'open';
}

function readListAssignee(value) {
  const assignee = readTrimmedString(value);
  if (assignee === 'me' || assignee === 'any') {
    return assignee;
  }
  return 'any';
}

const LIST_PRIORITY_EQ = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

function readListPriority(value) {
  const priority = readTrimmedString(value);
  if (priority === 'none' || priority === 'urgent' || priority === 'high' || priority === 'medium' || priority === 'low') {
    return priority;
  }
  return 'all';
}

function buildIssueListFilter({ status, assignee, teamId, priority } = {}) {
  const filter = {};
  const resolvedStatus = readListStatus(status);
  const resolvedAssignee = readListAssignee(assignee);
  const resolvedPriority = readListPriority(priority);
  const team = readTrimmedString(teamId);
  if (resolvedStatus !== 'all') {
    filter.state = LIST_STATUS_STATE[resolvedStatus];
  }
  if (resolvedAssignee === 'me') {
    filter.assignee = { isMe: { eq: true } };
  }
  if (team) {
    filter.team = { id: { eq: team } };
  }
  if (resolvedPriority !== 'all') {
    filter.priority = { eq: LIST_PRIORITY_EQ[resolvedPriority] };
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

const ISSUE_SUMMARY_FIELDS = `
  id
  identifier
  title
  url
  priority
  state { id name type }
  assignee { name displayName avatarUrl }
  team { id key name }
  labels { nodes { id name color } }
`;
const LIST_QUERY = `
  query ListLinearIssues($first: Int!, $after: String, $filter: IssueFilter) {
    issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      nodes { ${ISSUE_SUMMARY_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const SEARCH_QUERY = `
  query SearchLinearIssues($term: String!, $first: Int!, $after: String, $filter: IssueFilter) {
    searchIssues(term: $term, first: $first, after: $after, filter: $filter) {
      nodes { ${ISSUE_SUMMARY_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const GET_QUERY = `
  query GetLinearIssue($id: String!) {
    issue(id: $id) {
      ${ISSUE_SUMMARY_FIELDS}
      description
      comments(first: 50) {
        nodes {
          id
          body
          createdAt
          user { name displayName avatarUrl }
        }
      }
    }
  }
`;
const COMMENT_CREATE = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id }
    }
  }
`;
const STATES_QUERY = `
  query TeamWorkflowStates($id: String!) {
    team(id: $id) {
      states(first: 50) {
        nodes { id name type position }
      }
    }
  }
`;
const ISSUE_UPDATE = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        ${ISSUE_SUMMARY_FIELDS}
        description
        comments(first: 50) {
          nodes {
            id
            body
            createdAt
            user { name displayName avatarUrl }
          }
        }
      }
    }
  }
`;
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_IDENTIFIER_RE = /linear\.app\/(?:[^/]+\/)?issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i;

export function parseLinearIssueRef(value) {
  const trimmed = readTrimmedString(value);
  if (!trimmed) return null;
  const urlMatch = trimmed.match(URL_IDENTIFIER_RE);
  if (urlMatch) {
    return { kind: 'identifier', value: urlMatch[1].toUpperCase() };
  }
  if (IDENTIFIER_RE.test(trimmed)) {
    return { kind: 'identifier', value: trimmed.toUpperCase() };
  }
  if (UUID_RE.test(trimmed)) {
    return { kind: 'id', value: trimmed.toLowerCase() };
  }
  return null;
}

function readState(value) {
  if (!isPlainObject(value)) return null;
  const id = readTrimmedString(value.id) || null;
  const name = readTrimmedString(value.name) || null;
  const type = readTrimmedString(value.type) || null;
  if (!id && !name && !type) return null;
  return { id, name, type };
}

const WORKFLOW_TYPE_ORDER = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
};

function workflowTypeRank(type) {
  if (type === 'triage' || type === 'backlog' || type === 'unstarted' || type === 'started' || type === 'completed' || type === 'canceled') {
    return WORKFLOW_TYPE_ORDER[type];
  }
  return 99;
}

function compareWorkflowStates(left, right) {
  const typeDelta = workflowTypeRank(left.type) - workflowTypeRank(right.type);
  if (typeDelta !== 0) return typeDelta;
  if (left.position !== right.position) return left.position - right.position;
  return left.name.localeCompare(right.name);
}

function readWorkflowState(value) {
  if (!isPlainObject(value)) return null;
  const id = readTrimmedString(value.id);
  const name = readTrimmedString(value.name);
  if (!id || !name) return null;
  const position = readFiniteNumber(value.position);
  return {
    id,
    name,
    type: readTrimmedString(value.type) || null,
    position: position ?? 0,
  };
}

function readAssignee(value) {
  if (!isPlainObject(value)) return null;
  const name = readTrimmedString(value.name) || null;
  const displayName = readTrimmedString(value.displayName) || null;
  const avatarUrl = readTrimmedString(value.avatarUrl) || null;
  if (!name && !displayName && !avatarUrl) return null;
  return { name, displayName, avatarUrl };
}

function readTeam(value) {
  if (!isPlainObject(value)) return null;
  const id = readTrimmedString(value.id);
  const key = readTrimmedString(value.key);
  const name = readTrimmedString(value.name);
  if (!id || !key || !name) return null;
  return { id, key, name };
}

function readPriority(value) {
  if (!Number.isInteger(value) || value < 0 || value > 4) return null;
  return value;
}

function readLabelColor(value) {
  const raw = readTrimmedString(value);
  if (!raw) return null;
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) return null;
  return `#${hex.toLowerCase()}`;
}

function readLabel(value) {
  if (!isPlainObject(value)) return null;
  const id = readTrimmedString(value.id);
  const name = readTrimmedString(value.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    color: readLabelColor(value.color),
  };
}

function readLabels(value) {
  const nodes = isPlainObject(value) && Array.isArray(value.nodes)
    ? value.nodes
    : Array.isArray(value)
      ? value
      : [];
  return nodes.map(readLabel).filter(Boolean);
}

function readIssueSummary(node) {
  if (!isPlainObject(node)) return null;
  const id = readTrimmedString(node.id);
  const identifier = readTrimmedString(node.identifier);
  const title = readTrimmedString(node.title);
  const url = readTrimmedString(node.url);
  if (!id || !identifier || !title || !url) return null;
  return {
    id,
    identifier,
    title,
    url,
    state: readState(node.state),
    assignee: readAssignee(node.assignee),
    team: readTeam(node.team),
    priority: readPriority(node.priority),
    labels: readLabels(node.labels),
  };
}

function readComment(node) {
  if (!isPlainObject(node)) return null;
  const id = readTrimmedString(node.id);
  if (!id) return null;
  const body = isString(node.body) ? node.body : '';
  const user = isPlainObject(node.user)
    ? {
      name: readTrimmedString(node.user.name) || null,
      displayName: readTrimmedString(node.user.displayName) || null,
      avatarUrl: readTrimmedString(node.user.avatarUrl) || null,
    }
    : null;
  return {
    id,
    body,
    createdAt: readTrimmedString(node.createdAt) || null,
    user: user && (user.name || user.displayName) ? user : null,
  };
}

function readIssue(node) {
  const summary = readIssueSummary(node);
  if (!summary) return null;
  const commentsPayload = isPlainObject(node.comments) ? node.comments.nodes : null;
  const comments = Array.isArray(commentsPayload)
    ? commentsPayload.map(readComment).filter(Boolean)
    : [];
  return {
    ...summary,
    description: isString(node.description) ? node.description : null,
    comments,
  };
}

function readPageInfo(connection) {
  const pageInfo = isPlainObject(connection) ? connection.pageInfo : null;
  if (!isPlainObject(pageInfo)) {
    return { hasMore: false, cursor: null };
  }
  return {
    hasMore: pageInfo.hasNextPage === true,
    cursor: readTrimmedString(pageInfo.endCursor) || null,
  };
}

function readIssueNodes(connection) {
  const nodes = isPlainObject(connection) ? connection.nodes : null;
  if (!Array.isArray(nodes)) return [];
  return nodes.map(readIssueSummary).filter(Boolean);
}

async function withLinearToken(run, workspaceId) {
  try {
    const token = await getValidLinearAccessToken(workspaceId);
    if (!token) {
      return { connected: false };
    }
    return await run(token);
  } catch (error) {
    if (error?.status === 401) {
      const failed = workspaceId
        ? getLinearAuthByWorkspaceId(workspaceId)
        : getLinearAuth();
      clearLinearAuth(failed?.workspaceId || workspaceId);
      return { connected: false };
    }
    throw error;
  }
}

async function fetchIssueByRef(token, ref) {
  const data = await fetchLinearGraphql(token, GET_QUERY, { id: ref.value });
  return readIssue(data.issue);
}

export async function listLinearIssues({ query, cursor, status, assignee, teamId, priority } = {}) {
  return withLinearToken(async (token) => {
    const ref = parseLinearIssueRef(query);
    if (ref) {
      const issue = await fetchIssueByRef(token, ref);
      return {
        connected: true,
        issues: issue ? [issue] : [],
        cursor: null,
        hasMore: false,
      };
    }

    const after = readTrimmedString(cursor) || null;
    const term = readTrimmedString(query);
    const filter = buildIssueListFilter({ status, assignee, teamId, priority });
    const variables = {
      first: PAGE_SIZE,
    };
    if (filter) {
      variables.filter = filter;
    }
    if (after) {
      variables.after = after;
    }

    if (term) {
      variables.term = term;
      const data = await fetchLinearGraphql(token, SEARCH_QUERY, variables);
      const connection = isPlainObject(data.searchIssues) ? data.searchIssues : null;
      const page = readPageInfo(connection);
      return {
        connected: true,
        issues: readIssueNodes(connection),
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
    }

    const data = await fetchLinearGraphql(token, LIST_QUERY, variables);
    const connection = isPlainObject(data.issues) ? data.issues : null;
    const page = readPageInfo(connection);
    return {
      connected: true,
      issues: readIssueNodes(connection),
      cursor: page.cursor,
      hasMore: page.hasMore,
    };
  });
}

export async function getLinearIssue(id) {
  const ref = parseLinearIssueRef(id) || (readTrimmedString(id) ? { kind: 'id', value: readTrimmedString(id) } : null);
  if (!ref) {
    return { connected: true, issue: null };
  }
  return withLinearToken(async (token) => {
    const issue = await fetchIssueByRef(token, ref);
    return { connected: true, issue };
  });
}

export async function listLinearIssueStates(teamId) {
  const id = readTrimmedString(teamId);
  if (!id) {
    const error = new Error('teamId is required');
    error.code = 'INVALID';
    throw error;
  }
  return withLinearToken(async (token) => {
    const data = await fetchLinearGraphql(token, STATES_QUERY, { id });
    const team = isPlainObject(data.team) ? data.team : null;
    const connection = isPlainObject(team) ? team.states : null;
    const nodes = isPlainObject(connection) && Array.isArray(connection.nodes)
      ? connection.nodes
      : [];
    const states = nodes
      .map(readWorkflowState)
      .filter(Boolean)
      .sort(compareWorkflowStates);
    return { connected: true, states };
  });
}

export async function updateLinearIssue({ id, stateId } = {}) {
  const issueId = readTrimmedString(id);
  const nextStateId = readTrimmedString(stateId);
  if (!issueId || !nextStateId) {
    const error = new Error('id and stateId are required');
    error.code = 'INVALID';
    throw error;
  }
  const ref = parseLinearIssueRef(issueId) || { kind: 'id', value: issueId };
  return withLinearToken(async (token) => {
    const resolved = ref.kind === 'identifier'
      ? await fetchIssueByRef(token, ref)
      : null;
    const resolvedId = resolved?.id || (ref.kind === 'id' ? ref.value : '');
    if (!resolvedId) {
      return { connected: true, issue: null };
    }
    const data = await fetchLinearGraphql(token, ISSUE_UPDATE, {
      id: resolvedId,
      input: { stateId: nextStateId },
    });
    const payload = isPlainObject(data.issueUpdate) ? data.issueUpdate : null;
    return {
      connected: true,
      issue: payload ? readIssue(payload.issue) : null,
    };
  });
}

export async function createLinearIssueComment({ issueId, body, organizationId } = {}) {
  const text = isString(body) ? body : '';
  const ref = parseLinearIssueRef(issueId)
    || (readTrimmedString(issueId) ? { kind: 'id', value: readTrimmedString(issueId) } : null);
  if (!ref || !text.trim()) {
    return { connected: true, comment: null };
  }
  return withLinearToken(async (token) => {
    const issue = await fetchIssueByRef(token, ref);
    if (!issue) {
      return { connected: true, comment: null };
    }
    const data = await fetchLinearGraphql(token, COMMENT_CREATE, {
      input: { issueId: issue.id, body: text },
    });
    const payload = isPlainObject(data.commentCreate) ? data.commentCreate : null;
    const comment = isPlainObject(payload?.comment) ? payload.comment : null;
    const id = comment ? readTrimmedString(comment.id) : '';
    return {
      connected: true,
      comment: id ? { id } : null,
    };
  }, organizationId);
}
