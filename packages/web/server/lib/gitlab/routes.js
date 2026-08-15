// Route-level budget for composite GitLab calls (lists, comments, MR context).
// The client bounds each individual request at 8s; this caps the whole route
// so a slow self-hosted instance cannot hold a response (and a client socket)
// open indefinitely. The client keeps its last-known state on error.
const ROUTE_TIMEOUT_MS = 15_000;

// MR diff pagination caps: never loop more than 10 pages / 3000 files.
const MR_DIFFS_MAX_PAGES = 10;
const MR_DIFFS_MAX_FILES = 3000;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

// Resolve the requested project from the query (read routes) or the JSON body
// (write routes). `namespace`/`project` override the directory-local git
// remote for repos checked out from non-GitLab remotes.
const getRequestedProject = (req) => {
  const namespace = asString(req.query?.namespace) || asString(req.body?.namespace);
  const project = asString(req.query?.project) || asString(req.body?.project);
  return namespace && project ? `${namespace}/${project}` : null;
};

const getRequiredNumber = (req) => {
  const raw = typeof req.query?.number === 'string' ? req.query.number : '';
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const mapGitLabUser = (data) => {
  if (!data || typeof data !== 'object') {
    return null;
  }
  return {
    username: typeof data.username === 'string' ? data.username : null,
    id: typeof data.id === 'number' ? data.id : null,
    name: typeof data.name === 'string' ? data.name : null,
    avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : null,
    webUrl: typeof data.web_url === 'string' ? data.web_url : null,
    email: typeof data.email === 'string' ? data.email : null,
  };
};

const mapAuthor = (author) => {
  if (!author || typeof author !== 'object') {
    return null;
  }
  return {
    username: typeof author.username === 'string' ? author.username : null,
    name: typeof author.name === 'string' ? author.name : null,
    avatarUrl: typeof author.avatar_url === 'string' ? author.avatar_url : null,
    webUrl: typeof author.web_url === 'string' ? author.web_url : null,
    id: typeof author.id === 'number' ? author.id : null,
  };
};

const mapIssueSummary = (item) => ({
  number: typeof item.iid === 'number' ? item.iid : Number(item.iid),
  title: typeof item.title === 'string' ? item.title : '',
  url: typeof item.web_url === 'string' ? item.web_url : '',
  state: typeof item.state === 'string' ? item.state : 'opened',
  author: mapAuthor(item.author) || {},
  labels: Array.isArray(item.labels) ? item.labels.filter((label) => typeof label === 'string') : [],
});

const mapIssue = (item) => ({
  ...mapIssueSummary(item),
  body: typeof item.description === 'string' ? item.description : '',
  createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
  updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
  assignees: Array.isArray(item.assignees)
    ? item.assignees.map(mapAuthor).filter(Boolean)
    : [],
  milestone: item.milestone && typeof item.milestone === 'object'
    ? {
        title: typeof item.milestone.title === 'string' ? item.milestone.title : '',
        ...(typeof item.milestone.state === 'string' ? { state: item.milestone.state } : {}),
      }
    : null,
  commentsCount: typeof item.user_notes_count === 'number' ? item.user_notes_count : undefined,
});

const mapMergeRequestSummary = (item) => ({
  number: typeof item.iid === 'number' ? item.iid : Number(item.iid),
  title: typeof item.title === 'string' ? item.title : '',
  url: typeof item.web_url === 'string' ? item.web_url : '',
  state: typeof item.state === 'string' ? item.state : 'opened',
  draft: Boolean(item.draft) || Boolean(item.work_in_progress),
  author: mapAuthor(item.author) || {},
  sourceBranch: typeof item.source_branch === 'string' ? item.source_branch : '',
  targetBranch: typeof item.target_branch === 'string' ? item.target_branch : '',
  labels: Array.isArray(item.labels) ? item.labels.filter((label) => typeof label === 'string') : [],
  assignees: Array.isArray(item.assignees)
    ? item.assignees.map(mapAuthor).filter(Boolean)
    : [],
  milestone: item.milestone && typeof item.milestone === 'object'
    ? {
        title: typeof item.milestone.title === 'string' ? item.milestone.title : '',
        ...(typeof item.milestone.state === 'string' ? { state: item.milestone.state } : {}),
      }
    : null,
  commentsCount: typeof item.user_notes_count === 'number' ? item.user_notes_count : undefined,
});

// GitLab v4 MR notes expose `system: boolean` but carry no machine-readable
// action field — the timeline event type must be inferred from the system
// note's rendered body text. Match the prefixes GitLab produces for known
// actions and fall back to 'other'. Best-effort heuristic; it may drift across
// GitLab versions, so the UI must treat unknown types generically.
const mapGitLabSystemNoteType = (note) => {
  const body = typeof note?.body === 'string' ? note.body.toLowerCase() : '';
  if (!body) {
    return 'other';
  }
  if (body.includes('merged')) return 'merged';
  if (body.includes('closed')) return 'closed';
  if (body.includes('reopened')) return 'reopened';
  if (body.includes('approved')) return 'approved';
  if (body.includes('unassigned')) return 'unassigned';
  if (body.includes('assigned')) return 'assigned';
  if (body.includes('label')) return body.includes('removed') ? 'unlabeled' : 'labeled';
  if (body.includes('milestone')) return body.includes('removed') ? 'demilestoned' : 'milestoned';
  if (body.includes('merge request') && body.includes('created')) return 'opened';
  return 'other';
};

const mapComment = (note, webUrl) => ({
  id: typeof note.id === 'number' ? note.id : Number(note.id),
  url: webUrl ? `${webUrl}#note_${note.id}` : '',
  body: typeof note.body === 'string' ? note.body : '',
  createdAt: typeof note.created_at === 'string' ? note.created_at : undefined,
  updatedAt: typeof note.updated_at === 'string' ? note.updated_at : undefined,
  author: mapAuthor(note.author) || {},
});

// GitLab error bodies carry `message` as a string ("405 Method Not Allowed") or
// as a field->errors object ({ title: ['is invalid'] }); some endpoints use an
// `error` field instead. Flatten whichever shape is present into one readable
// string so write routes can surface it in { error } or { message }.
const gitLabErrorMessage = (data) => {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const message = data.message;
  if (typeof message === 'string' && message) {
    return message;
  }
  if (message && typeof message === 'object') {
    const parts = Object.entries(message).map(([field, errors]) => {
      const list = Array.isArray(errors) ? errors : [errors];
      const detail = list.filter((item) => typeof item === 'string' && item).join(', ');
      return detail ? `${field}: ${detail}` : field;
    });
    if (parts.length > 0) {
      return parts.join('; ');
    }
  }
  if (typeof data.error === 'string' && data.error) {
    return data.error;
  }
  return null;
};

// GitLab update endpoints take `milestone_id` (numeric), not the title. Resolve
// a title via the project milestones list (first page is enough for title-based
// lookups); unmatched titles yield `milestoneId: null` so routes can surface
// `400 { error: 'Milestone not found' }`.
const resolveMilestoneId = async (client, projectPath, title) => {
  const resp = await client.milestones(projectPath, { state: 'all', per_page: 100 });
  if (resp.status === 429) {
    return { milestoneId: null, rateLimited: true };
  }
  if (resp.status !== 200 || !Array.isArray(resp.data)) {
    return { milestoneId: null, rateLimited: false };
  }
  const match = resp.data.find(
    (item) => typeof item?.title === 'string' && item.title.toLowerCase() === title.toLowerCase(),
  );
  return { milestoneId: typeof match?.id === 'number' ? match.id : null, rateLimited: false };
};

const countDiffLines = (diffText) => {
  if (typeof diffText !== 'string') {
    return { additions: 0, deletions: 0, changes: 0 };
  }
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions, changes: additions + deletions };
};

const mapDiffItem = (item) => {
  const counts = countDiffLines(item.diff);
  const status = item.new_file
    ? 'added'
    : (item.deleted_file ? 'deleted' : (item.renamed_file ? 'renamed' : 'modified'));
  return {
    filename: typeof item.new_path === 'string' ? item.new_path : (typeof item.old_path === 'string' ? item.old_path : ''),
    status,
    additions: counts.additions,
    deletions: counts.deletions,
    changes: counts.changes,
    patch: typeof item.diff === 'string' ? item.diff : '',
  };
};

// GitLab assigns by numeric user ID, while the facade deals in logins. Resolve
// a set of assignee logins to IDs via the project members list; unmatched
// logins yield `{ unknown: login }` so update routes can surface a precise
// `400 { error: 'Unknown assignee: ...' }` instead of silently dropping a user.
const resolveAssigneeIds = async (client, projectPath, logins) => {
  const uniqueLogins = [...new Set(logins)];
  const ids = [];
  for (const login of uniqueLogins) {
    const resp = await client.members(projectPath, { per_page: 100, query: login });
    if (resp.status === 429) {
      return { ids: null, rateLimited: true, unknown: null };
    }
    if (resp.status !== 200 || !Array.isArray(resp.data)) {
      return { ids: null, rateLimited: false, unknown: null };
    }
    const match = resp.data.find(
      (item) => typeof item?.username === 'string' && item.username.toLowerCase() === login.toLowerCase(),
    );
    if (typeof match?.id !== 'number') {
      return { ids: null, rateLimited: false, unknown: login };
    }
    ids.push(match.id);
  }
  return { ids, rateLimited: false, unknown: null };
};

const repoRefFromProjectPath = (projectPath, baseUrl) => {
  const segments = projectPath.split('/');
  const project = segments[segments.length - 1] || '';
  const namespace = segments.slice(0, -1).join('/');
  let host = null;
  let normalizedBaseUrl = null;
  let url = null;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      host = parsed.hostname;
      normalizedBaseUrl = parsed.href.replace(/\/+$/, '');
      url = `${normalizedBaseUrl}/${projectPath}`;
    } catch {
      // fall back to unknown host
    }
  }
  return { namespace, project, host, baseUrl: normalizedBaseUrl, url };
};

export function registerGitLabRoutes(app, options = {}) {
  let gitlabLibraries = null;
  const getGitLabLibraries = async () => {
    if (!gitlabLibraries) {
      gitlabLibraries = await import('./index.js');
    }
    return gitlabLibraries;
  };

  const getClient = async () => {
    const { getGitLabClientOrNull } = await getGitLabLibraries();
    return getGitLabClientOrNull();
  };

  // Resolve which GitLab project a request targets. A directory-local git
  // remote is the primary source; `namespace`/`project` query params override
  // it (needed for repos checked out from non-GitLab remotes).
  const resolveProjectForRequest = async (directory, requestedProject) => {
    if (requestedProject) {
      return { projectPath: requestedProject, repo: null, fromDirectory: false };
    }
    if (!directory) {
      return { projectPath: null, repo: null, fromDirectory: false };
    }
    const { resolveGitLabRepoFromDirectory } = await getGitLabLibraries();
    const { repo } = await resolveGitLabRepoFromDirectory(directory);
    if (!repo) {
      return { projectPath: null, repo: null, fromDirectory: false };
    }
    return { projectPath: `${repo.namespace}/${repo.project}`, repo, fromDirectory: true };
  };

  // ================= GitLab Auth APIs =================

  app.get('/api/gitlab/auth/status', async (_req, res) => {
    try {
      const { getGitLabAuth, getGitLabAuthAccounts, clearGitLabAuth, getGitLabDefaultBaseUrl } = await getGitLabLibraries();
      const auth = getGitLabAuth();
      const accounts = getGitLabAuthAccounts();
      const defaultBaseUrl = getGitLabDefaultBaseUrl();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts, defaultBaseUrl });
      }

      const client = await getClient();
      let user = null;
      if (client) {
        const resp = await client.user();
        if (resp.status === 401 || resp.status === 403) {
          clearGitLabAuth();
          return res.json({ connected: false, accounts: getGitLabAuthAccounts(), defaultBaseUrl });
        }
        if (resp.status === 200 && resp.data) {
          user = mapGitLabUser(resp.data);
        }
      }

      return res.json({
        connected: true,
        ...(user ? { user } : {}),
        accounts,
        defaultBaseUrl,
      });
    } catch (error) {
      console.error('Failed to get GitLab auth status:', error);
      return res.status(500).json({ error: error.message || 'Failed to get GitLab auth status' });
    }
  });

  app.post('/api/gitlab/auth/connect', async (req, res) => {
    try {
      const accessToken = asString(req.body?.accessToken);
      if (!accessToken) {
        return res.status(400).json({ error: 'accessToken is required' });
      }

      const { normalizeBaseUrl, getGitLabDefaultBaseUrl, setGitLabAuth, getGitLabAuthAccounts } = await getGitLabLibraries();
      const baseUrl = normalizeBaseUrl(req.body?.baseUrl) || getGitLabDefaultBaseUrl();

      const { createGitLabClient } = await getGitLabLibraries();
      const client = createGitLabClient({ token: accessToken, baseUrl });
      const resp = await client.user();
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 401 || resp.status === 403 || resp.status >= 400 || !resp.data?.username) {
        return res.status(400).json({ error: 'Invalid GitLab access token' });
      }

      setGitLabAuth({ accessToken, baseUrl, user: resp.data });
      return res.json({
        connected: true,
        user: mapGitLabUser(resp.data),
        accounts: getGitLabAuthAccounts(),
        defaultBaseUrl: getGitLabDefaultBaseUrl(),
      });
    } catch (error) {
      console.error('Failed to connect GitLab:', error);
      return res.status(500).json({ error: error.message || 'Failed to connect GitLab' });
    }
  });

  app.post('/api/gitlab/auth/activate', async (req, res) => {
    try {
      const accountId = asString(req.body?.accountId);
      if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
      }

      const { activateGitLabAuth, getGitLabAuth, getGitLabAuthAccounts, getGitLabDefaultBaseUrl } = await getGitLabLibraries();
      const activated = activateGitLabAuth(accountId);
      if (!activated) {
        return res.status(404).json({ error: 'GitLab account not found' });
      }

      const auth = getGitLabAuth();
      const accounts = getGitLabAuthAccounts();
      const defaultBaseUrl = getGitLabDefaultBaseUrl();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts, defaultBaseUrl });
      }

      let user = auth.username
        ? {
          username: auth.username,
          id: null,
          name: auth.name,
          avatarUrl: auth.avatarUrl,
          webUrl: auth.webUrl,
          email: auth.email,
        }
        : null;
      const client = await getClient();
      if (client) {
        const resp = await client.user();
        if (resp.status === 200 && resp.data) {
          user = mapGitLabUser(resp.data);
        }
      }

      return res.json({ connected: true, user, accounts, defaultBaseUrl });
    } catch (error) {
      console.error('Failed to activate GitLab account:', error);
      return res.status(500).json({ error: error.message || 'Failed to activate GitLab account' });
    }
  });

  app.delete('/api/gitlab/auth', async (_req, res) => {
    try {
      const { clearGitLabAuth } = await getGitLabLibraries();
      const removed = clearGitLabAuth();
      return res.json({ removed });
    } catch (error) {
      console.error('Failed to disconnect GitLab:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect GitLab' });
    }
  });

  app.get('/api/gitlab/me', async (_req, res) => {
    try {
      const { clearGitLabAuth } = await getGitLabLibraries();
      const client = await getClient();
      if (!client) {
        return res.status(401).json({ error: 'GitLab not connected' });
      }
      const resp = await client.user();
      if (resp.status === 401 || resp.status === 403) {
        clearGitLabAuth();
        return res.status(401).json({ error: 'GitLab token expired or revoked' });
      }
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status !== 200 || !resp.data) {
        return res.status(500).json({ error: 'Failed to fetch GitLab user' });
      }
      return res.json(mapGitLabUser(resp.data));
    } catch (error) {
      console.error('Failed to fetch GitLab user:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitLab user' });
    }
  });

  // ================= GitLab Issue APIs =================

  app.get('/api/gitlab/issues/list', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedProject = getRequestedProject(req);
      if (!directory && !requestedProject) {
        return res.status(400).json({ error: 'directory or namespace/project is required' });
      }
      const rawPage = typeof req.query?.page === 'string' ? Number(req.query.page) : 1;
      const effectivePage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
      const searchQuery = asString(req.query?.query);

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, issues: [], page: effectivePage, hasMore: false });
      }

      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.json({ connected: true, repo: null, issues: [], page: effectivePage, hasMore: false });
      }

      const params = { state: 'opened', scope: 'all', per_page: 50, page: effectivePage };
      if (searchQuery) {
        params.search = searchQuery;
      }
      const resp = await withTimeout(client.issues(projectPath, params), ROUTE_TIMEOUT_MS, 'gitlab issues list');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while listing issues' });
      }

      const issues = (Array.isArray(resp.data) ? resp.data : []).map(mapIssueSummary);
      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        issues,
        page: effectivePage,
        hasMore: Boolean(resp.page?.hasMore),
      });
    } catch (error) {
      console.error('Failed to list GitLab issues:', error);
      return res.status(500).json({ error: error.message || 'Failed to list GitLab issues' });
    }
  });

  app.get('/api/gitlab/issues/get', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedProject = getRequestedProject(req);
      const number = getRequiredNumber(req);
      if (!directory && !requestedProject) {
        return res.status(400).json({ error: 'directory or namespace/project is required' });
      }
      if (!number) {
        return res.status(400).json({ error: 'number is required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, issue: null });
      }

      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.json({ connected: true, repo: null, issue: null });
      }

      const resp = await withTimeout(client.issue(projectPath, number), ROUTE_TIMEOUT_MS, 'gitlab issue get');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 404) {
        return res.status(404).json({ error: 'Issue not found' });
      }
      if (resp.status !== 200 || !resp.data) {
        return res.status(502).json({ error: 'GitLab returned an error while fetching the issue' });
      }

      const item = resp.data;
      const issue = mapIssue(item);
      return res.json({ connected: true, repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl), issue });
    } catch (error) {
      console.error('Failed to fetch GitLab issue:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitLab issue' });
    }
  });

  app.get('/api/gitlab/issues/comments', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedProject = getRequestedProject(req);
      const number = getRequiredNumber(req);
      if (!directory && !requestedProject) {
        return res.status(400).json({ error: 'directory or namespace/project is required' });
      }
      if (!number) {
        return res.status(400).json({ error: 'number is required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, comments: [] });
      }

      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.json({ connected: true, repo: null, comments: [] });
      }

      // GitLab notes carry no web URL; resolve it from the issue so each note
      // links as `{issue_web_url}#note_{id}`.
      const issueResp = await withTimeout(client.issue(projectPath, number), ROUTE_TIMEOUT_MS, 'gitlab issue comments issue');
      if (issueResp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (issueResp.status === 404) {
        return res.status(404).json({ error: 'Issue not found' });
      }
      if (issueResp.status !== 200 || !issueResp.data) {
        return res.status(502).json({ error: 'GitLab returned an error while fetching the issue' });
      }
      const webUrl = typeof issueResp.data.web_url === 'string' ? issueResp.data.web_url : '';

      const notesResp = await withTimeout(
        client.issueNotes(projectPath, number, { per_page: 100 }),
        ROUTE_TIMEOUT_MS,
        'gitlab issue comments notes',
      );
      if (notesResp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (notesResp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while fetching issue comments' });
      }

      const comments = (Array.isArray(notesResp.data) ? notesResp.data : [])
        .filter((note) => !note.system)
        .map((note) => mapComment(note, webUrl));
      return res.json({ connected: true, repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl), comments });
    } catch (error) {
      console.error('Failed to fetch GitLab issue comments:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitLab issue comments' });
    }
  });

  app.post('/api/gitlab/issues/comment', async (req, res) => {
    try {
      const directory = asString(req.body?.directory);
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
      if (!directory || !number || !body) {
        return res.status(400).json({ error: 'directory, number, body are required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedProject = getRequestedProject(req);
      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.status(400).json({ error: 'Unable to resolve GitLab repo from directory' });
      }

      // GitLab notes carry no web URL; resolve the issue web_url first so the
      // note links as `{issue_web_url}#note_{id}` (mirrors issues/comments).
      const issueResp = await client.issue(projectPath, number);
      if (issueResp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (issueResp.status === 404) {
        return res.status(404).json({ error: 'Issue not found' });
      }
      if (issueResp.status !== 200 || !issueResp.data) {
        return res.status(502).json({ error: 'GitLab returned an error while fetching the issue' });
      }
      const webUrl = typeof issueResp.data.web_url === 'string' ? issueResp.data.web_url : '';

      const resp = await client.createIssueNote(projectPath, number, body);
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your GitLab token needs the api scope to create issue comments' });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: gitLabErrorMessage(resp.data) || 'GitLab returned an error while creating the comment' });
      }
      if (!resp.data) {
        return res.status(500).json({ error: 'GitLab returned an empty response while creating the comment' });
      }

      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        comment: mapComment(resp.data, webUrl),
      });
    } catch (error) {
      console.error('Failed to create GitLab issue comment:', error);
      return res.status(500).json({ error: error.message || 'Failed to create GitLab issue comment' });
    }
  });

  app.post('/api/gitlab/issues/create', async (req, res) => {
    try {
      const directory = asString(req.body?.directory);
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (!directory || !title) {
        return res.status(400).json({ error: 'directory and title are required' });
      }
      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : undefined;
      const labels = Array.isArray(req.body?.labels)
        ? req.body.labels.filter((label) => typeof label === 'string' && label.length > 0)
        : undefined;

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedProject = getRequestedProject(req);
      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.status(400).json({ error: 'Unable to resolve GitLab repo from directory' });
      }

      const params = {
        title,
        ...(body !== undefined ? { description: body } : {}),
        ...(labels !== undefined ? { labels } : {}),
      };
      const resp = await client.createIssue(projectPath, params);
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your GitLab token needs the api scope to create issues' });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: gitLabErrorMessage(resp.data) || 'GitLab returned an error while creating the issue' });
      }
      if (!resp.data) {
        return res.status(500).json({ error: 'GitLab returned an empty response while creating the issue' });
      }

      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        issue: mapIssue(resp.data),
      });
    } catch (error) {
      console.error('Failed to create GitLab issue:', error);
      return res.status(500).json({ error: error.message || 'Failed to create GitLab issue' });
    }
  });

  app.put('/api/gitlab/issues/update', async (req, res) => {
    try {
      const directory = asString(req.body?.directory);
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedProject = getRequestedProject(req);
      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.status(400).json({ error: 'Unable to resolve GitLab repo from directory' });
      }

      const body = {};
      if (typeof req.body?.title === 'string') {
        body.title = req.body.title.trim();
      }
      if (typeof req.body?.body === 'string') {
        body.description = req.body.body;
      }
      // GitLab maps state transitions through `state_event` ('close'/'reopen').
      if (req.body?.state === 'open' || req.body?.state === 'closed') {
        body.state_event = req.body.state === 'closed' ? 'close' : 'reopen';
      }
      if (Array.isArray(req.body?.labels)) {
        body.labels = req.body.labels.filter((label) => typeof label === 'string');
      }
      if (Array.isArray(req.body?.assignees)) {
        const { ids, rateLimited, unknown } = await resolveAssigneeIds(client, projectPath, req.body.assignees.filter((login) => typeof login === 'string'));
        if (rateLimited) {
          return res.status(503).json({ error: 'GitLab rate limited' });
        }
        if (unknown !== null) {
          return res.status(400).json({ error: `Unknown assignee: ${unknown}` });
        }
        body.assignee_ids = ids;
      }
      if (Array.isArray(req.body?.assigneeIds)) {
        body.assignee_ids = req.body.assigneeIds.filter((id) => typeof id === 'number');
      }
      if (req.body?.milestone !== undefined) {
        if (req.body.milestone === null) {
          body.milestone_id = null;
        } else if (typeof req.body.milestone === 'string' && req.body.milestone.trim()) {
          const { milestoneId, rateLimited } = await resolveMilestoneId(client, projectPath, req.body.milestone.trim());
          if (rateLimited) {
            return res.status(503).json({ error: 'GitLab rate limited' });
          }
          if (milestoneId === null) {
            return res.status(400).json({ error: 'Milestone not found' });
          }
          body.milestone_id = milestoneId;
        }
      }

      const resp = await client.updateIssue(projectPath, number, body);
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your GitLab token needs the api scope to update issues' });
      }
      if (resp.status === 404) {
        return res.status(404).json({ error: 'Issue not found' });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: gitLabErrorMessage(resp.data) || 'GitLab returned an error while updating the issue' });
      }
      if (!resp.data) {
        return res.status(500).json({ error: 'GitLab returned an empty response while updating the issue' });
      }

      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        issue: mapIssue(resp.data),
      });
    } catch (error) {
      console.error('Failed to update GitLab issue:', error);
      return res.status(500).json({ error: error.message || 'Failed to update GitLab issue' });
    }
  });

  // ================= GitLab Merge Request APIs =================

  app.get('/api/gitlab/mrs/list', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedProject = getRequestedProject(req);
      if (!directory && !requestedProject) {
        return res.status(400).json({ error: 'directory or namespace/project is required' });
      }
      const rawPage = typeof req.query?.page === 'string' ? Number(req.query.page) : 1;
      const effectivePage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
      const searchQuery = asString(req.query?.query);
      const sourceBranch = asString(req.query?.sourceBranch);

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, mrs: [], page: effectivePage, hasMore: false });
      }

      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.json({ connected: true, repo: null, mrs: [], page: effectivePage, hasMore: false });
      }

      const params = { state: 'opened', scope: 'all', per_page: 50, page: effectivePage };
      if (searchQuery) {
        params.search = searchQuery;
      }
      if (sourceBranch) {
        params.source_branch = sourceBranch;
      }
      const resp = await withTimeout(client.mergeRequests(projectPath, params), ROUTE_TIMEOUT_MS, 'gitlab mrs list');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while listing merge requests' });
      }

      const mrs = (Array.isArray(resp.data) ? resp.data : []).map(mapMergeRequestSummary);
      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        mrs,
        page: effectivePage,
        hasMore: Boolean(resp.page?.hasMore),
      });
    } catch (error) {
      console.error('Failed to list GitLab merge requests:', error);
      return res.status(500).json({ error: error.message || 'Failed to list GitLab merge requests' });
    }
  });

  app.get('/api/gitlab/mrs/context', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedProject = getRequestedProject(req);
      const number = getRequiredNumber(req);
      const includeDiff = req.query?.diff === '1' || req.query?.diff === 'true';
      if (!directory && !requestedProject) {
        return res.status(400).json({ error: 'directory or namespace/project is required' });
      }
      if (!number) {
        return res.status(400).json({ error: 'number is required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, mr: null, comments: [], files: [] });
      }

      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.json({ connected: true, repo: null, mr: null, comments: [], files: [] });
      }

      const mrResp = await withTimeout(client.mergeRequest(projectPath, number), ROUTE_TIMEOUT_MS, 'gitlab mr context');
      if (mrResp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (mrResp.status === 404) {
        return res.status(404).json({ error: 'Merge request not found' });
      }
      if (mrResp.status !== 200 || !mrResp.data) {
        return res.status(502).json({ error: 'GitLab returned an error while fetching the merge request' });
      }

      const item = mrResp.data;
      const mr = {
        number: typeof item.iid === 'number' ? item.iid : Number(item.iid),
        title: typeof item.title === 'string' ? item.title : '',
        url: typeof item.web_url === 'string' ? item.web_url : '',
        state: typeof item.state === 'string' ? item.state : 'opened',
        draft: Boolean(item.draft) || Boolean(item.work_in_progress),
        body: typeof item.description === 'string' ? item.description : '',
        createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
        updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
        author: mapAuthor(item.author) || {},
        sourceBranch: typeof item.source_branch === 'string' ? item.source_branch : '',
        targetBranch: typeof item.target_branch === 'string' ? item.target_branch : '',
        labels: Array.isArray(item.labels) ? item.labels.filter((label) => typeof label === 'string') : [],
        assignees: Array.isArray(item.assignees)
          ? item.assignees.map(mapAuthor).filter(Boolean)
          : [],
        milestone: item.milestone && typeof item.milestone === 'object'
          ? {
              title: typeof item.milestone.title === 'string' ? item.milestone.title : '',
              ...(typeof item.milestone.state === 'string' ? { state: item.milestone.state } : {}),
            }
          : null,
        commentsCount: typeof item.user_notes_count === 'number' ? item.user_notes_count : undefined,
        headSha: typeof item.sha === 'string' ? item.sha : (typeof item.diff_head_sha === 'string' ? item.diff_head_sha : undefined),
      };

      const notesResp = await withTimeout(
        client.request(`/projects/${encodeURIComponent(projectPath)}/merge_requests/${number}/notes`, { query: { per_page: 100 } }),
        ROUTE_TIMEOUT_MS,
        'gitlab mr context notes',
      );
      if (notesResp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      const comments = (notesResp.status === 200 && Array.isArray(notesResp.data) ? notesResp.data : [])
        .filter((note) => !note.system)
        .map((note) => mapComment(note, mr.url));

      // Diffs are paginated; loop pages but cap the total work.
      const files = [];
      for (let page = 1; page <= MR_DIFFS_MAX_PAGES; page += 1) {
        const diffsResp = await client.mergeRequestDiffs(projectPath, number, { per_page: 100, page });
        if (diffsResp.status === 429) {
          return res.status(503).json({ error: 'GitLab rate limited' });
        }
        if (diffsResp.status !== 200 || !Array.isArray(diffsResp.data)) {
          break;
        }
        const chunk = diffsResp.data;
        for (const diffItem of chunk) {
          files.push(mapDiffItem(diffItem));
          if (files.length >= MR_DIFFS_MAX_FILES) {
            break;
          }
        }
        if (files.length >= MR_DIFFS_MAX_FILES) {
          break;
        }
        if (chunk.length < 100 || !diffsResp.page?.hasMore) {
          break;
        }
      }

      let diff;
      if (includeDiff) {
        const patches = files.map((file) => file.patch || '').filter(Boolean);
        diff = patches.length > 0 ? patches.join('\n') : undefined;
      }

      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        mr,
        comments,
        files,
        ...(diff ? { diff } : {}),
      });
    } catch (error) {
      console.error('Failed to load GitLab merge request context:', error);
      return res.status(500).json({ error: error.message || 'Failed to load GitLab merge request context' });
    }
  });

  app.get('/api/gitlab/mrs/commits', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedProject = getRequestedProject(req);
      const number = getRequiredNumber(req);
      if (!directory && !requestedProject) {
        return res.status(400).json({ error: 'directory or namespace/project is required' });
      }
      if (!number) {
        return res.status(400).json({ error: 'number is required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, commits: [] });
      }

      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.json({ connected: true, repo: null, commits: [] });
      }

      const resp = await withTimeout(
        client.mergeRequestCommits(projectPath, number, { per_page: 100 }),
        ROUTE_TIMEOUT_MS,
        'gitlab mr commits',
      );
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 404) {
        return res.status(404).json({ error: 'Merge request not found' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while fetching merge request commits' });
      }

      const commits = (Array.isArray(resp.data) ? resp.data : []).map((commit) => ({
        sha: typeof commit.id === 'string' ? commit.id : '',
        shortSha: typeof commit.short_id === 'string' ? commit.short_id : '',
        message: typeof commit.message === 'string' ? commit.message : '',
        ...(typeof commit.title === 'string' && commit.title ? { summary: commit.title } : {}),
        ...(typeof commit.author_name === 'string' && commit.author_name ? { authorName: commit.author_name } : {}),
        ...(typeof commit.committed_date === 'string' ? { committedAt: commit.committed_date } : {}),
        parents: Array.isArray(commit.parent_ids) ? commit.parent_ids : [],
      }));

      return res.json({ connected: true, repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl), commits });
    } catch (error) {
      console.error('Failed to fetch GitLab merge request commits:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitLab merge request commits' });
    }
  });

  app.get('/api/gitlab/mrs/timeline', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedProject = getRequestedProject(req);
      const number = getRequiredNumber(req);
      if (!directory && !requestedProject) {
        return res.status(400).json({ error: 'directory or namespace/project is required' });
      }
      if (!number) {
        return res.status(400).json({ error: 'number is required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, events: [] });
      }

      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.json({ connected: true, repo: null, events: [] });
      }

      const notesResp = await withTimeout(
        client.mergeRequestNotes(projectPath, number, { per_page: 100 }),
        ROUTE_TIMEOUT_MS,
        'gitlab mr timeline notes',
      );
      if (notesResp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (notesResp.status === 404) {
        return res.status(404).json({ error: 'Merge request not found' });
      }
      if (notesResp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while fetching merge request timeline' });
      }

      // Timeline = system notes only (GitLab records state changes as system
      // notes; human comments are surfaced by mrs/context).
      const events = (Array.isArray(notesResp.data) ? notesResp.data : [])
        .filter((note) => note.system === true)
        .map((note) => ({
          id: String(note.id),
          type: mapGitLabSystemNoteType(note),
          body: typeof note.body === 'string' ? note.body : null,
          author: mapAuthor(note.author),
          createdAt: typeof note.created_at === 'string' ? note.created_at : undefined,
        }));

      return res.json({ connected: true, repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl), events });
    } catch (error) {
      console.error('Failed to fetch GitLab merge request timeline:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitLab merge request timeline' });
    }
  });

  // ================= GitLab Merge Request Write APIs =================

  app.post('/api/gitlab/mrs/create', async (req, res) => {
    try {
      const directory = asString(req.body?.directory);
      const title = asString(req.body?.title);
      const sourceBranch = asString(req.body?.sourceBranch);
      const targetBranch = asString(req.body?.targetBranch);
      if (!directory || !title || !sourceBranch || !targetBranch) {
        return res.status(400).json({ error: 'directory, title, sourceBranch, targetBranch are required' });
      }
      const description = typeof req.body?.description === 'string' && req.body.description
        ? req.body.description
        : undefined;
      const removeSourceBranch = typeof req.body?.removeSourceBranch === 'boolean'
        ? req.body.removeSourceBranch
        : false;

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedProject = getRequestedProject(req);
      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.status(400).json({ error: 'Unable to resolve GitLab repo from directory' });
      }

      const body = {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        remove_source_branch: removeSourceBranch,
      };
      if (description !== undefined) {
        body.description = description;
      }

      const resp = await withTimeout(client.createMergeRequest(projectPath, body), ROUTE_TIMEOUT_MS, 'gitlab mr create');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your GitLab token needs the api scope to create merge requests' });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: gitLabErrorMessage(resp.data) || 'GitLab returned an error while creating the merge request' });
      }
      if (!resp.data) {
        return res.status(500).json({ error: 'GitLab returned an empty response while creating the merge request' });
      }

      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        mr: mapMergeRequestSummary(resp.data),
      });
    } catch (error) {
      console.error('Failed to create GitLab merge request:', error);
      return res.status(500).json({ error: error.message || 'Failed to create GitLab merge request' });
    }
  });

  app.put('/api/gitlab/mrs/update', async (req, res) => {
    try {
      const directory = asString(req.body?.directory);
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }
      const title = asString(req.body?.title);
      const description = typeof req.body?.description === 'string' ? req.body.description : undefined;

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedProject = getRequestedProject(req);
      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.status(400).json({ error: 'Unable to resolve GitLab repo from directory' });
      }

      const body = {};
      if (title) {
        body.title = title;
      }
      if (description !== undefined) {
        body.description = description;
      }
      // GitLab maps state transitions through `state_event` ('close'/'reopen').
      if (req.body?.state === 'open' || req.body?.state === 'closed') {
        body.state_event = req.body.state === 'closed' ? 'close' : 'reopen';
      }
      if (Array.isArray(req.body?.labels)) {
        body.labels = req.body.labels.filter((label) => typeof label === 'string');
      }
      if (Array.isArray(req.body?.assignees)) {
        const { ids, rateLimited, unknown } = await resolveAssigneeIds(client, projectPath, req.body.assignees.filter((login) => typeof login === 'string'));
        if (rateLimited) {
          return res.status(503).json({ error: 'GitLab rate limited' });
        }
        if (unknown !== null) {
          return res.status(400).json({ error: `Unknown assignee: ${unknown}` });
        }
        body.assignee_ids = ids;
      }
      if (Array.isArray(req.body?.assigneeIds)) {
        body.assignee_ids = req.body.assigneeIds.filter((id) => typeof id === 'number');
      }
      if (req.body?.milestone !== undefined) {
        if (req.body.milestone === null) {
          body.milestone_id = null;
        } else if (typeof req.body.milestone === 'string' && req.body.milestone.trim()) {
          const { milestoneId, rateLimited } = await resolveMilestoneId(client, projectPath, req.body.milestone.trim());
          if (rateLimited) {
            return res.status(503).json({ error: 'GitLab rate limited' });
          }
          if (milestoneId === null) {
            return res.status(400).json({ error: 'Milestone not found' });
          }
          body.milestone_id = milestoneId;
        }
      }

      const resp = await withTimeout(client.updateMergeRequest(projectPath, number, body), ROUTE_TIMEOUT_MS, 'gitlab mr update');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your GitLab token needs the api scope to update merge requests' });
      }
      if (resp.status === 404) {
        return res.status(404).json({ error: 'Merge request not found' });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: gitLabErrorMessage(resp.data) || 'GitLab returned an error while updating the merge request' });
      }
      if (!resp.data) {
        return res.status(500).json({ error: 'GitLab returned an empty response while updating the merge request' });
      }

      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        mr: mapMergeRequestSummary(resp.data),
      });
    } catch (error) {
      console.error('Failed to update GitLab merge request:', error);
      return res.status(500).json({ error: error.message || 'Failed to update GitLab merge request' });
    }
  });

  app.put('/api/gitlab/mrs/merge', async (req, res) => {
    try {
      const directory = asString(req.body?.directory);
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }
      const squash = typeof req.body?.squash === 'boolean' ? req.body.squash : undefined;

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedProject = getRequestedProject(req);
      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.status(400).json({ error: 'Unable to resolve GitLab repo from directory' });
      }

      const body = {};
      if (squash !== undefined) {
        body.squash = squash;
      }

      const resp = await withTimeout(client.mergeMergeRequest(projectPath, number, body), ROUTE_TIMEOUT_MS, 'gitlab mr merge');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your GitLab token needs the api scope to create merge requests' });
      }
      if (resp.status === 404) {
        return res.status(404).json({ error: 'Merge request not found' });
      }
      // GitLab rejects non-mergeable requests with 405/406/409/422 and a
      // `message` in the body — surface it as a merge rejection (mirrors the
      // GitHub pr/merge contract) instead of a generic error.
      if (resp.status === 405 || resp.status === 406 || resp.status === 409 || resp.status === 422) {
        return res.status(resp.status).json({
          connected: true,
          merged: false,
          message: gitLabErrorMessage(resp.data) || 'Merge request not mergeable',
        });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: gitLabErrorMessage(resp.data) || 'GitLab returned an error while merging the merge request' });
      }

      return res.json({ connected: true, merged: true });
    } catch (error) {
      console.error('Failed to merge GitLab merge request:', error);
      return res.status(500).json({ error: error.message || 'Failed to merge GitLab merge request' });
    }
  });

  app.post('/api/gitlab/mrs/comment', async (req, res) => {
    try {
      const directory = asString(req.body?.directory);
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
      if (!directory || !number || !body) {
        return res.status(400).json({ error: 'directory, number, body are required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedProject = getRequestedProject(req);
      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.status(400).json({ error: 'Unable to resolve GitLab repo from directory' });
      }

      // MR notes carry no web URL; resolve the MR web_url first so the note
      // links as `{mr_web_url}#note_{id}` (mirrors mrs/context).
      const mrResp = await client.mergeRequest(projectPath, number);
      if (mrResp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (mrResp.status === 404) {
        return res.status(404).json({ error: 'Merge request not found' });
      }
      if (mrResp.status !== 200 || !mrResp.data) {
        return res.status(502).json({ error: 'GitLab returned an error while fetching the merge request' });
      }
      const webUrl = typeof mrResp.data.web_url === 'string' ? mrResp.data.web_url : '';

      const resp = await client.createMrNote(projectPath, number, body);
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your GitLab token needs the api scope to comment on merge requests' });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: gitLabErrorMessage(resp.data) || 'GitLab returned an error while creating the comment' });
      }
      if (!resp.data) {
        return res.status(500).json({ error: 'GitLab returned an empty response while creating the comment' });
      }

      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        comment: mapComment(resp.data, webUrl),
      });
    } catch (error) {
      console.error('Failed to create GitLab merge request comment:', error);
      return res.status(500).json({ error: error.message || 'Failed to create GitLab merge request comment' });
    }
  });

  app.post('/api/gitlab/mrs/approve', async (req, res) => {
    try {
      const directory = asString(req.body?.directory);
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedProject = getRequestedProject(req);
      const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
      if (!projectPath) {
        return res.status(400).json({ error: 'Unable to resolve GitLab repo from directory' });
      }

      const resp = await client.approveMr(projectPath, number);
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your GitLab token needs the api scope to approve merge requests' });
      }
      if (resp.status === 404) {
        return res.status(404).json({ error: 'Merge request not found' });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: gitLabErrorMessage(resp.data) || 'GitLab returned an error while approving the merge request' });
      }

      return res.json({
        connected: true,
        repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl),
        approved: true,
      });
    } catch (error) {
      console.error('Failed to approve GitLab merge request:', error);
      return res.status(500).json({ error: error.message || 'Failed to approve GitLab merge request' });
    }
  });

  // ================= GitLab Rich Lookup APIs =================

  // Repo-scoped lookups for pickers/mentions. Each resolves the target project
  // (directory remote + namespace/project override) and hits a GitLab endpoint
  // that supports server-side `query` filtering where available. `connected:
  // false` means the lookup could not be performed — never an authoritative
  // empty list.

  const lookupProject = async (req) => {
    const directory = asString(req.query?.directory);
    const requestedProject = getRequestedProject(req);
    if (!directory && !requestedProject) {
      return { error: 'directory or namespace/project is required' };
    }
    const client = await getClient();
    if (!client) {
      return { client: null };
    }
    const { projectPath, repo } = await resolveProjectForRequest(directory, requestedProject);
    return { client, projectPath, repo };
  };

  app.get('/api/gitlab/users/search', async (req, res) => {
    try {
      const query = asString(req.query?.query);
      const resolved = await lookupProject(req);
      if (resolved.error) {
        return res.status(400).json({ error: resolved.error });
      }
      if (!resolved.client) {
        return res.json({ connected: false, users: [] });
      }
      const { client, projectPath, repo } = resolved;
      if (!projectPath) {
        return res.json({ connected: true, repo: null, users: [] });
      }

      const resp = await withTimeout(
        client.members(projectPath, { per_page: 100, ...(query ? { query } : {}) }),
        ROUTE_TIMEOUT_MS,
        'gitlab users search',
      );
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while searching users' });
      }
      const users = (Array.isArray(resp.data) ? resp.data : [])
        .map(mapGitLabUser)
        .filter((user) => user && user.username);
      return res.json({ connected: true, repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl), users });
    } catch (error) {
      console.error('Failed to search GitLab users:', error);
      return res.status(500).json({ error: error.message || 'Failed to search GitLab users' });
    }
  });

  app.get('/api/gitlab/labels/search', async (req, res) => {
    try {
      const query = asString(req.query?.query);
      const resolved = await lookupProject(req);
      if (resolved.error) {
        return res.status(400).json({ error: resolved.error });
      }
      if (!resolved.client) {
        return res.json({ connected: false, labels: [] });
      }
      const { client, projectPath, repo } = resolved;
      if (!projectPath) {
        return res.json({ connected: true, repo: null, labels: [] });
      }

      const resp = await withTimeout(
        client.labels(projectPath, { per_page: 100, ...(query ? { search: query } : {}) }),
        ROUTE_TIMEOUT_MS,
        'gitlab labels search',
      );
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while searching labels' });
      }
      const labels = (Array.isArray(resp.data) ? resp.data : [])
        .map((label) => (typeof label?.name === 'string' ? label.name : ''))
        .filter(Boolean);
      return res.json({ connected: true, repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl), labels });
    } catch (error) {
      console.error('Failed to search GitLab labels:', error);
      return res.status(500).json({ error: error.message || 'Failed to search GitLab labels' });
    }
  });

  app.get('/api/gitlab/milestones/search', async (req, res) => {
    try {
      const query = asString(req.query?.query);
      const resolved = await lookupProject(req);
      if (resolved.error) {
        return res.status(400).json({ error: resolved.error });
      }
      if (!resolved.client) {
        return res.json({ connected: false, milestones: [] });
      }
      const { client, projectPath, repo } = resolved;
      if (!projectPath) {
        return res.json({ connected: true, repo: null, milestones: [] });
      }

      const resp = await withTimeout(
        client.milestones(projectPath, { state: 'all', per_page: 100, ...(query ? { search: query } : {}) }),
        ROUTE_TIMEOUT_MS,
        'gitlab milestones search',
      );
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while searching milestones' });
      }
      const milestones = (Array.isArray(resp.data) ? resp.data : [])
        .map((item) => ({
          title: typeof item?.title === 'string' ? item.title : '',
          ...(typeof item?.state === 'string' ? { state: item.state } : {}),
        }))
        .filter((item) => item.title);
      return res.json({ connected: true, repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl), milestones });
    } catch (error) {
      console.error('Failed to search GitLab milestones:', error);
      return res.status(500).json({ error: error.message || 'Failed to search GitLab milestones' });
    }
  });

  app.get('/api/gitlab/branches/search', async (req, res) => {
    try {
      const query = asString(req.query?.query);
      const resolved = await lookupProject(req);
      if (resolved.error) {
        return res.status(400).json({ error: resolved.error });
      }
      if (!resolved.client) {
        return res.json({ connected: false, branches: [] });
      }
      const { client, projectPath, repo } = resolved;
      if (!projectPath) {
        return res.json({ connected: true, repo: null, branches: [] });
      }

      const resp = await withTimeout(
        client.branches(projectPath, { per_page: 100, ...(query ? { search: query } : {}) }),
        ROUTE_TIMEOUT_MS,
        'gitlab branches search',
      );
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while searching branches' });
      }
      const branches = (Array.isArray(resp.data) ? resp.data : [])
        .map((branch) => (typeof branch?.name === 'string' ? branch.name : ''))
        .filter(Boolean);
      return res.json({ connected: true, repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl), branches });
    } catch (error) {
      console.error('Failed to search GitLab branches:', error);
      return res.status(500).json({ error: error.message || 'Failed to search GitLab branches' });
    }
  });

  app.get('/api/gitlab/tags/search', async (req, res) => {
    try {
      const query = asString(req.query?.query);
      const resolved = await lookupProject(req);
      if (resolved.error) {
        return res.status(400).json({ error: resolved.error });
      }
      if (!resolved.client) {
        return res.json({ connected: false, tags: [] });
      }
      const { client, projectPath, repo } = resolved;
      if (!projectPath) {
        return res.json({ connected: true, repo: null, tags: [] });
      }

      const resp = await withTimeout(
        client.tags(projectPath, { per_page: 100, ...(query ? { search: query } : {}) }),
        ROUTE_TIMEOUT_MS,
        'gitlab tags search',
      );
      if (resp.status === 429) {
        return res.status(503).json({ error: 'GitLab rate limited' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'GitLab returned an error while searching tags' });
      }
      const tags = (Array.isArray(resp.data) ? resp.data : [])
        .map((tag) => (typeof tag?.name === 'string' ? tag.name : ''))
        .filter(Boolean);
      return res.json({ connected: true, repo: repo || repoRefFromProjectPath(projectPath, client.baseUrl), tags });
    } catch (error) {
      console.error('Failed to search GitLab tags:', error);
      return res.status(500).json({ error: error.message || 'Failed to search GitLab tags' });
    }
  });

  // ================= GitLab Repo APIs =================

  app.get('/api/gitlab/repo/branches', async (req, res) => {
    try {
      const namespace = asString(req.query?.namespace);
      const project = asString(req.query?.project);
      if (!namespace || !project) {
        return res.status(400).json({ error: 'namespace and project are required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ branches: [], defaultBranch: null });
      }

      const branches = [];
      let defaultBranch = null;
      let page = 1;
      while (page <= 10) {
        const resp = await client.branches(`${namespace}/${project}`, { per_page: 100, page });
        if (resp.status === 429) {
          return res.status(503).json({ error: 'GitLab rate limited' });
        }
        if (resp.status !== 200 || !Array.isArray(resp.data)) {
          break;
        }
        const chunk = resp.data;
        for (const branch of chunk) {
          if (typeof branch?.name === 'string') {
            branches.push(branch.name);
            if (defaultBranch === null && branch.default === true) {
              defaultBranch = branch.name;
            }
          }
        }
        if (chunk.length < 100 || !resp.page?.hasMore) {
          break;
        }
        page += 1;
      }

      return res.json({ branches, defaultBranch });
    } catch (error) {
      console.error('Failed to fetch GitLab repo branches:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitLab repo branches' });
    }
  });
}
