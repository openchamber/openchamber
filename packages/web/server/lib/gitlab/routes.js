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

const getRequestedProject = (req) => {
  const namespace = asString(req.query?.namespace);
  const project = asString(req.query?.project);
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

const mapMergeRequestSummary = (item) => ({
  number: typeof item.iid === 'number' ? item.iid : Number(item.iid),
  title: typeof item.title === 'string' ? item.title : '',
  url: typeof item.web_url === 'string' ? item.web_url : '',
  state: typeof item.state === 'string' ? item.state : 'opened',
  draft: Boolean(item.draft) || Boolean(item.work_in_progress),
  author: mapAuthor(item.author) || {},
  sourceBranch: typeof item.source_branch === 'string' ? item.source_branch : '',
  targetBranch: typeof item.target_branch === 'string' ? item.target_branch : '',
});

const mapComment = (note, webUrl) => ({
  id: typeof note.id === 'number' ? note.id : Number(note.id),
  url: webUrl ? `${webUrl}#note_${note.id}` : '',
  body: typeof note.body === 'string' ? note.body : '',
  createdAt: typeof note.created_at === 'string' ? note.created_at : undefined,
  updatedAt: typeof note.updated_at === 'string' ? note.updated_at : undefined,
  author: mapAuthor(note.author) || {},
});

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
      const { getGitLabAuth, getGitLabAuthAccounts, clearGitLabAuth, DEFAULT_GITLAB_BASE_URL } = await getGitLabLibraries();
      const auth = getGitLabAuth();
      const accounts = getGitLabAuthAccounts();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts, defaultBaseUrl: DEFAULT_GITLAB_BASE_URL });
      }

      const client = await getClient();
      let user = null;
      if (client) {
        const resp = await client.user();
        if (resp.status === 401 || resp.status === 403) {
          clearGitLabAuth();
          return res.json({ connected: false, accounts: getGitLabAuthAccounts(), defaultBaseUrl: DEFAULT_GITLAB_BASE_URL });
        }
        if (resp.status === 200 && resp.data) {
          user = mapGitLabUser(resp.data);
        }
      }

      return res.json({
        connected: true,
        ...(user ? { user } : {}),
        accounts,
        defaultBaseUrl: DEFAULT_GITLAB_BASE_URL,
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

      const { normalizeBaseUrl, DEFAULT_GITLAB_BASE_URL, setGitLabAuth, getGitLabAuthAccounts } = await getGitLabLibraries();
      const baseUrl = normalizeBaseUrl(req.body?.baseUrl) || DEFAULT_GITLAB_BASE_URL;

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
        defaultBaseUrl: DEFAULT_GITLAB_BASE_URL,
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

      const { activateGitLabAuth, getGitLabAuth, getGitLabAuthAccounts, DEFAULT_GITLAB_BASE_URL } = await getGitLabLibraries();
      const activated = activateGitLabAuth(accountId);
      if (!activated) {
        return res.status(404).json({ error: 'GitLab account not found' });
      }

      const auth = getGitLabAuth();
      const accounts = getGitLabAuthAccounts();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts, defaultBaseUrl: DEFAULT_GITLAB_BASE_URL });
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

      return res.json({ connected: true, user, accounts, defaultBaseUrl: DEFAULT_GITLAB_BASE_URL });
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
      const issue = {
        number: typeof item.iid === 'number' ? item.iid : Number(item.iid),
        title: typeof item.title === 'string' ? item.title : '',
        url: typeof item.web_url === 'string' ? item.web_url : '',
        state: typeof item.state === 'string' ? item.state : 'opened',
        body: typeof item.description === 'string' ? item.description : '',
        createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
        updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
        author: mapAuthor(item.author) || {},
        assignees: Array.isArray(item.assignees)
          ? item.assignees.map(mapAuthor).filter(Boolean)
          : [],
        labels: Array.isArray(item.labels) ? item.labels.filter((label) => typeof label === 'string') : [],
      };
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
        return res.json({ branches: [] });
      }

      const branches = [];
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
          }
        }
        if (chunk.length < 100 || !resp.page?.hasMore) {
          break;
        }
        page += 1;
      }

      return res.json({ branches });
    } catch (error) {
      console.error('Failed to fetch GitLab repo branches:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitLab repo branches' });
    }
  });
}
