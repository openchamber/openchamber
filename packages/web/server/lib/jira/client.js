import { JIRA_DEPLOYMENT_CLOUD } from './auth.js';

const REQUEST_TIMEOUT_MS = 15_000;

export class JiraApiError extends Error {
  constructor(message, { status = 0, code = 'jira_error' } = {}) {
    super(message);
    this.name = 'JiraApiError';
    this.status = status;
    this.code = code;
  }
}

const codeForStatus = (status) => {
  if (status === 401) return 'auth_invalid';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  return 'jira_error';
};

const extractErrorMessage = (body) => {
  if (!body || typeof body !== 'object') return null;
  const messages = Array.isArray(body.errorMessages) ? body.errorMessages.filter((m) => typeof m === 'string' && m) : [];
  const fieldErrors = body.errors && typeof body.errors === 'object'
    ? Object.entries(body.errors)
      .filter(([, value]) => typeof value === 'string' && value)
      .map(([field, value]) => `${field}: ${value}`)
    : [];
  const combined = [...messages, ...fieldErrors].join(' · ');
  return combined || null;
};

const buildAuthHeader = (connection) => {
  if (connection.deployment === JIRA_DEPLOYMENT_CLOUD) {
    const basic = Buffer.from(`${connection.email}:${connection.apiToken}`, 'utf8').toString('base64');
    return `Basic ${basic}`;
  }
  // Jira Server / Data Center: personal access token as bearer credential.
  return `Bearer ${connection.apiToken}`;
};

/**
 * Minimal Jira REST client over fetch. Uses REST API v2 on both Cloud and
 * Server/Data Center so issue descriptions and comments arrive as plain
 * strings instead of Atlassian Document Format.
 */
export function createJiraClient(connection, { fetchImpl = fetch } = {}) {
  if (!connection?.baseUrl || !connection?.apiToken) {
    throw new JiraApiError('Jira is not connected', { status: 401, code: 'not_connected' });
  }

  const request = async (apiPath, { method = 'GET', query, body } = {}) => {
    const url = new URL(`${connection.baseUrl}/rest/api/2${apiPath}`);
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: {
          authorization: buildAuthHeader(connection),
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new JiraApiError(
        `Jira request failed: ${error?.message || 'network error'}`,
        { status: 0, code: 'network_error' },
      );
    }

    // Server/DC installs answer redirects (e.g. to a login page) for
    // unauthenticated API requests; treat that as an auth failure instead of
    // following into HTML.
    if (response.status >= 300 && response.status < 400) {
      throw new JiraApiError('Jira redirected the API request — check the base URL and credentials', {
        status: 401,
        code: 'auth_invalid',
      });
    }

    if (response.status === 204) return null;

    const text = await response.text().catch(() => '');
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const detail = extractErrorMessage(parsed);
      throw new JiraApiError(
        detail || `Jira request failed with status ${response.status}`,
        { status: response.status, code: codeForStatus(response.status) },
      );
    }

    return parsed;
  };

  const getMyself = () => request('/myself');

  const ISSUE_FIELDS = [
    'summary',
    'description',
    'status',
    'issuetype',
    'priority',
    'labels',
    'components',
    'reporter',
    'assignee',
    'project',
    'parent',
    'created',
    'updated',
    'comment',
    'issuelinks',
  ].join(',');

  const getIssue = (issueKey) => request(`/issue/${encodeURIComponent(issueKey)}`, {
    query: { fields: ISSUE_FIELDS },
  });

  const addComment = (issueKey, text) => request(`/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: 'POST',
    body: { body: text },
  });

  const createRemoteLink = (issueKey, { globalId, url, title, summary }) => request(
    `/issue/${encodeURIComponent(issueKey)}/remotelink`,
    {
      method: 'POST',
      body: {
        ...(globalId ? { globalId } : {}),
        object: {
          url,
          title,
          ...(summary ? { summary } : {}),
        },
      },
    },
  );

  const removeLabel = (issueKey, label) => request(`/issue/${encodeURIComponent(issueKey)}`, {
    method: 'PUT',
    body: { update: { labels: [{ remove: label }] } },
  });

  /**
   * JQL search for the issue listener. Jira Cloud removed the classic
   * `/search` resource in favor of `/search/jql`; Server/Data Center still
   * only offers `/search`. The deployment difference is intentional.
   */
  const searchIssues = async (jql, { maxResults = 25, fields = 'summary,project,labels,updated' } = {}) => {
    if (connection.deployment === JIRA_DEPLOYMENT_CLOUD) {
      const result = await request('/search/jql', {
        query: { jql, maxResults, fields },
      });
      return Array.isArray(result?.issues) ? result.issues : [];
    }
    const result = await request('/search', {
      query: { jql, maxResults, fields },
    });
    return Array.isArray(result?.issues) ? result.issues : [];
  };

  return {
    request,
    getMyself,
    getIssue,
    addComment,
    createRemoteLink,
    removeLabel,
    searchIssues,
  };
}

/**
 * Summarize the `/myself` payload for storage/display. Cloud identifies users
 * by accountId; Server/Data Center uses name/key.
 */
export function summarizeJiraUser(myself) {
  if (!myself || typeof myself !== 'object') return null;
  const avatarUrls = myself.avatarUrls && typeof myself.avatarUrls === 'object' ? myself.avatarUrls : {};
  return {
    accountId: typeof myself.accountId === 'string'
      ? myself.accountId
      : (typeof myself.name === 'string' ? myself.name : null),
    displayName: typeof myself.displayName === 'string' ? myself.displayName : null,
    emailAddress: typeof myself.emailAddress === 'string' ? myself.emailAddress : null,
    avatarUrl: typeof avatarUrls['48x48'] === 'string' ? avatarUrls['48x48'] : null,
  };
}
