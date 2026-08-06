const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/**
 * Resolve the effective Linear GraphQL endpoint. `OPENCHAMBER_LINEAR_API_URL`
 * exists for tests and local end-to-end validation against a stub server; it
 * is read at call time so tests can set it per-case.
 */
function resolveLinearApiUrl() {
  const override = process.env.OPENCHAMBER_LINEAR_API_URL;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return LINEAR_GRAPHQL_URL;
}

/**
 * Linear personal API keys are sent raw; OAuth access tokens require the
 * `Bearer` prefix. Personal keys are prefixed `lin_api_`, OAuth tokens
 * `lin_oauth_` — anything unrecognized is treated as a personal key because
 * that is the only kind a user can paste from Linear's settings UI.
 */
export function resolveLinearAuthorizationHeader(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return null;
  if (key.startsWith('lin_oauth_') || key.toLowerCase().startsWith('bearer ')) {
    return key.toLowerCase().startsWith('bearer ') ? key : `Bearer ${key}`;
  }
  return key;
}

const ISSUE_IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

/**
 * Accepts a Linear issue UUID, an identifier like `ENG-123`, or a full issue
 * URL like `https://linear.app/acme/issue/ENG-123/some-slug`, and returns the
 * value Linear's `issue(id:)` query accepts (UUID or identifier), or null.
 */
export function parseIssueReference(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  const urlMatch = raw.match(/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-\d+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  if (ISSUE_IDENTIFIER_RE.test(raw)) return raw.toUpperCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw;
  return null;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  branchName
  priorityLabel
  createdAt
  state { name type }
  team { id key name }
  assignee { name }
  labels { nodes { name } }
`;

const ISSUE_WITH_COMMENTS_FIELDS = `
  ${ISSUE_FIELDS}
  comments(last: 20) { nodes { body createdAt user { name } botActor { name } } }
`;

export class LinearApiError extends Error {
  constructor(message, { status = null, authFailed = false } = {}) {
    super(message);
    this.name = 'LinearApiError';
    this.status = status;
    this.authFailed = authFailed;
  }
}

/**
 * Minimal Linear GraphQL client over fetch. No SDK dependency — the
 * integration needs a handful of queries/mutations and full control over the
 * auth header form (raw personal key vs Bearer OAuth token).
 */
export function createLinearClient({ getApiKey, fetchImpl = fetch } = {}) {
  async function request(query, variables = {}, { apiKeyOverride = null } = {}) {
    const apiKey = apiKeyOverride ?? (typeof getApiKey === 'function' ? getApiKey() : null);
    const authorization = resolveLinearAuthorizationHeader(apiKey);
    if (!authorization) {
      throw new LinearApiError('Linear is not connected', { authFailed: true });
    }
    let response;
    try {
      response = await fetchImpl(resolveLinearApiUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new LinearApiError(`Linear request failed: ${error?.message ?? error}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new LinearApiError('Linear rejected the API key', {
        status: response.status,
        authFailed: true,
      });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new LinearApiError(
        `Linear request failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
        { status: response.status },
      );
    }
    const body = await response.json().catch(() => null);
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const message = body.errors
        .map((entry) => entry?.message)
        .filter(Boolean)
        .join('; ');
      const authFailed = body.errors.some(
        (entry) => entry?.extensions?.code === 'AUTHENTICATION_ERROR',
      );
      throw new LinearApiError(message || 'Linear returned a GraphQL error', { authFailed });
    }
    return body?.data ?? null;
  }

  async function fetchViewer({ apiKeyOverride = null } = {}) {
    const data = await request(
      `query OpenChamberViewer {
        viewer { id name email }
        organization { id name urlKey }
      }`,
      {},
      { apiKeyOverride },
    );
    if (!data?.viewer?.id) throw new LinearApiError('Linear returned no viewer');
    return { viewer: data.viewer, organization: data.organization ?? null };
  }

  async function listTeams() {
    const data = await request(
      `query OpenChamberTeams {
        teams(first: 100) { nodes { id key name } }
      }`,
    );
    return Array.isArray(data?.teams?.nodes) ? data.teams.nodes : [];
  }

  async function fetchIssue(issueRef) {
    const data = await request(
      `query OpenChamberIssue($id: String!) {
        issue(id: $id) { ${ISSUE_WITH_COMMENTS_FIELDS} }
      }`,
      { id: issueRef },
    );
    return data?.issue ?? null;
  }

  /**
   * Issues carrying the trigger label that are still in an unstarted/started
   * state — the label is how a Linear user hands an issue to OpenChamber.
   */
  async function listTriggerIssues({ label, first = 25 }) {
    const data = await request(
      `query OpenChamberTriggerIssues($label: String!, $first: Int!) {
        issues(
          first: $first
          orderBy: updatedAt
          filter: {
            labels: { name: { eqIgnoreCase: $label } }
            state: { type: { in: ["triage", "backlog", "unstarted", "started"] } }
          }
        ) { nodes { ${ISSUE_FIELDS} } }
      }`,
      { label, first },
    );
    return Array.isArray(data?.issues?.nodes) ? data.issues.nodes : [];
  }

  async function createComment({ issueId, body }) {
    const data = await request(
      `mutation OpenChamberCommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id url } }
      }`,
      { input: { issueId, body } },
    );
    if (data?.commentCreate?.success !== true) {
      throw new LinearApiError('Linear comment creation failed');
    }
    return data.commentCreate.comment ?? null;
  }

  async function createAttachment({ issueId, title, subtitle = null, url }) {
    const data = await request(
      `mutation OpenChamberAttachmentCreate($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) { success attachment { id } }
      }`,
      { input: { issueId, title, ...(subtitle ? { subtitle } : {}), url } },
    );
    if (data?.attachmentCreate?.success !== true) {
      throw new LinearApiError('Linear attachment creation failed');
    }
    return data.attachmentCreate.attachment ?? null;
  }

  return {
    request,
    fetchViewer,
    listTeams,
    fetchIssue,
    listTriggerIssues,
    createComment,
    createAttachment,
  };
}
