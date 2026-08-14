// Route-level budget for composite Gitea calls (lists, comments, PR context).
// The client bounds each individual request at 8s; this caps the whole route
// so a slow self-hosted instance cannot hold a response (and a client socket)
// open indefinitely. The client keeps its last-known state on error.
const ROUTE_TIMEOUT_MS = 15_000;

// PR list pagination cap for the source-branch scan: never loop more than 10
// pages when aggregating PRs for a local branch.
const PRS_MAX_PAGES = 10;

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

const getRequestedRepo = (req) => {
  const owner = asString(req.query?.owner);
  const repo = asString(req.query?.repo);
  return owner && repo ? { owner, repo } : null;
};

const getRequiredNumber = (req) => {
  const raw = typeof req.query?.number === 'string' ? req.query.number : '';
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : null;
};

// Gitea/Forgejo `GET /user` (and user sub-objects on issues/PRs) carry the
// username in `login` (plus `full_name`, `avatar_url`, `html_url`). Tolerate
// the `username`/`web_url` variants so mapping stays robust across API versions.
const mapGiteaUser = (data) => {
  if (!data || typeof data !== 'object') {
    return null;
  }
  return {
    username: typeof data.login === 'string' ? data.login : (typeof data.username === 'string' ? data.username : null),
    id: typeof data.id === 'number' ? data.id : null,
    name: typeof data.full_name === 'string' ? data.full_name : (typeof data.name === 'string' ? data.name : null),
    avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : null,
    webUrl: typeof data.html_url === 'string' ? data.html_url : (typeof data.web_url === 'string' ? data.web_url : null),
    email: typeof data.email === 'string' ? data.email : null,
  };
};

const mapGiteaAuthor = (user) => {
  if (!user || typeof user !== 'object') {
    return null;
  }
  return {
    username: typeof user.login === 'string' ? user.login : (typeof user.username === 'string' ? user.username : ''),
    id: typeof user.id === 'number' ? user.id : undefined,
  };
};

const mapGiteaLabels = (labels) => (
  Array.isArray(labels)
    ? labels.map((label) => (label && typeof label.name === 'string' ? label.name : '')).filter(Boolean)
    : []
);

const mapGiteaIssueSummary = (item) => ({
  number: typeof item.number === 'number' ? item.number : Number(item.number),
  title: typeof item.title === 'string' ? item.title : '',
  url: typeof item.html_url === 'string' ? item.html_url : '',
  state: typeof item.state === 'string' ? item.state : 'open',
  author: mapGiteaAuthor(item.user) || {},
  labels: mapGiteaLabels(item.labels),
});

const mapGiteaPullRequestSummary = (item) => {
  const merged = Boolean(item.merged);
  const closed = item.state === 'closed';
  return {
    number: typeof item.number === 'number' ? item.number : Number(item.number),
    title: typeof item.title === 'string' ? item.title : '',
    url: typeof item.html_url === 'string' ? item.html_url : '',
    state: merged ? 'merged' : (closed ? 'closed' : 'open'),
    draft: Boolean(item.draft),
    author: mapGiteaAuthor(item.user) || {},
    labels: mapGiteaLabels(item.labels),
    sourceBranch: typeof item.head?.ref === 'string' ? item.head.ref : '',
    targetBranch: typeof item.base?.ref === 'string' ? item.base.ref : '',
  };
};

const mapGiteaPullRequest = (item) => ({
  ...mapGiteaPullRequestSummary(item),
  body: typeof item.body === 'string' ? item.body : undefined,
  mergeable: typeof item.mergeable === 'boolean' ? item.mergeable : undefined,
  merged: Boolean(item.merged),
  createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
  updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
});

const mapGiteaComment = (comment) => ({
  id: typeof comment.id === 'number' ? comment.id : Number(comment.id),
  body: typeof comment.body === 'string' ? comment.body : '',
  url: typeof comment.html_url === 'string' ? comment.html_url : undefined,
  author: mapGiteaAuthor(comment.user) || {},
  createdAt: typeof comment.created_at === 'string' ? comment.created_at : undefined,
});

// Gitea's pull-files endpoint returns capitalized JSON fields
// (Filename/Status/Additions/Deletions/Patch); tolerate the lowercase GitHub
// style too for Forgejo versions that match GitHub output.
const mapGiteaFile = (file) => ({
  filename: typeof file.Filename === 'string' ? file.Filename : (typeof file.filename === 'string' ? file.filename : ''),
  status: typeof file.Status === 'string' ? file.Status : (typeof file.status === 'string' ? file.status : undefined),
  additions: typeof file.Additions === 'number' ? file.Additions : undefined,
  deletions: typeof file.Deletions === 'number' ? file.Deletions : undefined,
  patch: typeof file.Patch === 'string' ? file.Patch : (typeof file.patch === 'string' ? file.patch : undefined),
});

// Gitea error bodies carry `message` (string) or `error` (string). Flatten
// whichever shape is present into one readable string for write routes.
const giteaErrorMessage = (data) => {
  if (!data || typeof data !== 'object') {
    return null;
  }
  if (typeof data.message === 'string' && data.message) {
    return data.message;
  }
  if (typeof data.error === 'string' && data.error) {
    return data.error;
  }
  return null;
};

const repoRefFromOwnerRepo = (owner, repo, baseUrl) => {
  let host = null;
  let normalizedBaseUrl = null;
  let url = null;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      host = parsed.hostname;
      normalizedBaseUrl = parsed.href.replace(/\/+$/, '');
      url = `${normalizedBaseUrl}/${owner}/${repo}`;
    } catch {
      // fall back to unknown host
    }
  }
  return { owner, repo, host, baseUrl: normalizedBaseUrl, url };
};

export function registerGiteaRoutes(app, options = {}) {
  let giteaLibraries = null;
  const getGiteaLibraries = async () => {
    if (!giteaLibraries) {
      giteaLibraries = await import('./index.js');
    }
    return giteaLibraries;
  };

  const getClient = async () => {
    const { getGiteaClientOrNull } = await getGiteaLibraries();
    return getGiteaClientOrNull();
  };

  // Resolve which Gitea repo a request targets. A directory-local git remote
  // is the primary source; `owner`/`repo` query params override it (needed for
  // repos checked out from non-Gitea remotes).
  const resolveRepoForRequest = async (directory, requestedRepo) => {
    if (requestedRepo) {
      return { owner: requestedRepo.owner, repo: requestedRepo.repo, repoRef: null, fromDirectory: false };
    }
    if (!directory) {
      return { owner: null, repo: null, repoRef: null, fromDirectory: false };
    }
    const { resolveGiteaRepoFromDirectory } = await getGiteaLibraries();
    const { repo } = await resolveGiteaRepoFromDirectory(directory);
    if (!repo) {
      return { owner: null, repo: null, repoRef: null, fromDirectory: false };
    }
    return { owner: repo.owner, repo: repo.repo, repoRef: repo, fromDirectory: true };
  };

  // ================= Gitea Auth APIs =================

  app.get('/api/gitea/auth/status', async (_req, res) => {
    try {
      const { getGiteaAuth, getGiteaAuthAccounts, clearGiteaAuth } = await getGiteaLibraries();
      const auth = getGiteaAuth();
      const accounts = getGiteaAuthAccounts();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts });
      }

      const client = await getClient();
      let user = null;
      if (client) {
        const resp = await client.user();
        if (resp.status === 401 || resp.status === 403) {
          clearGiteaAuth();
          return res.json({ connected: false, accounts: getGiteaAuthAccounts() });
        }
        if (resp.status === 200 && resp.data) {
          user = mapGiteaUser(resp.data);
        }
      }

      return res.json({
        connected: true,
        ...(user ? { user } : {}),
        accounts,
      });
    } catch (error) {
      console.error('Failed to get Gitea auth status:', error);
      return res.status(500).json({ error: error.message || 'Failed to get Gitea auth status' });
    }
  });

  app.post('/api/gitea/auth/connect', async (req, res) => {
    try {
      const accessToken = asString(req.body?.accessToken);
      if (!accessToken) {
        return res.status(400).json({ error: 'accessToken is required' });
      }

      const { normalizeBaseUrl, setGiteaAuth, getGiteaAuthAccounts } = await getGiteaLibraries();
      const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
      if (!baseUrl) {
        return res.status(400).json({ error: 'baseUrl is required and must be a valid URL' });
      }

      const { createGiteaClient } = await getGiteaLibraries();
      const client = createGiteaClient({ token: accessToken, baseUrl });
      const resp = await client.user();
      if (resp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (resp.status === 401 || resp.status === 403 || resp.status >= 400 || !mapGiteaUser(resp.data)?.username) {
        return res.status(400).json({ error: 'Invalid Gitea access token' });
      }

      setGiteaAuth({ accessToken, baseUrl, user: resp.data });
      return res.json({
        connected: true,
        user: mapGiteaUser(resp.data),
        accounts: getGiteaAuthAccounts(),
      });
    } catch (error) {
      console.error('Failed to connect Gitea:', error);
      return res.status(500).json({ error: error.message || 'Failed to connect Gitea' });
    }
  });

  app.post('/api/gitea/auth/activate', async (req, res) => {
    try {
      const accountId = asString(req.body?.accountId);
      if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
      }

      const { activateGiteaAuth, getGiteaAuth, getGiteaAuthAccounts } = await getGiteaLibraries();
      const activated = activateGiteaAuth(accountId);
      if (!activated) {
        return res.status(404).json({ error: 'Gitea account not found' });
      }

      const auth = getGiteaAuth();
      const accounts = getGiteaAuthAccounts();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts });
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
          user = mapGiteaUser(resp.data);
        }
      }

      return res.json({ connected: true, user, accounts });
    } catch (error) {
      console.error('Failed to activate Gitea account:', error);
      return res.status(500).json({ error: error.message || 'Failed to activate Gitea account' });
    }
  });

  app.delete('/api/gitea/auth', async (_req, res) => {
    try {
      const { clearGiteaAuth } = await getGiteaLibraries();
      const removed = clearGiteaAuth();
      return res.json({ removed });
    } catch (error) {
      console.error('Failed to disconnect Gitea:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect Gitea' });
    }
  });

  app.get('/api/gitea/me', async (_req, res) => {
    try {
      const { clearGiteaAuth } = await getGiteaLibraries();
      const client = await getClient();
      if (!client) {
        return res.status(401).json({ error: 'Gitea not connected' });
      }
      const resp = await client.user();
      if (resp.status === 401 || resp.status === 403) {
        clearGiteaAuth();
        return res.status(401).json({ error: 'Gitea token expired or revoked' });
      }
      if (resp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (resp.status !== 200 || !resp.data) {
        return res.status(500).json({ error: 'Failed to fetch Gitea user' });
      }
      return res.json(mapGiteaUser(resp.data));
    } catch (error) {
      console.error('Failed to fetch Gitea user:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch Gitea user' });
    }
  });

  // ================= Gitea Issue APIs =================

  app.get('/api/gitea/issues/list', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedRepo = getRequestedRepo(req);
      if (!directory && !requestedRepo) {
        return res.status(400).json({ error: 'directory or owner/repo is required' });
      }
      const rawPage = typeof req.query?.page === 'string' ? Number(req.query.page) : 1;
      const effectivePage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
      const searchQuery = asString(req.query?.query);

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, issues: [], page: effectivePage, hasMore: false });
      }

      const { owner, repo, repoRef } = await resolveRepoForRequest(directory, requestedRepo);
      if (!owner || !repo) {
        return res.json({ connected: true, repo: null, issues: [], page: effectivePage, hasMore: false });
      }

      // `type=issues` excludes pull requests from the issue list; the client-side
      // filter is a backstop for instances that ignore it.
      const params = { state: 'open', type: 'issues', limit: 50, page: effectivePage };
      if (searchQuery) {
        params.q = searchQuery;
      }
      const resp = await withTimeout(client.issues(owner, repo, params), ROUTE_TIMEOUT_MS, 'gitea issues list');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'Gitea returned an error while listing issues' });
      }

      const issues = (Array.isArray(resp.data) ? resp.data : [])
        .filter((item) => !item?.pull_request)
        .map(mapGiteaIssueSummary);
      return res.json({
        connected: true,
        repo: repoRef || repoRefFromOwnerRepo(owner, repo, client.baseUrl),
        issues,
        page: effectivePage,
        hasMore: Boolean(resp.page?.hasMore),
      });
    } catch (error) {
      console.error('Failed to list Gitea issues:', error);
      return res.status(500).json({ error: error.message || 'Failed to list Gitea issues' });
    }
  });

  app.get('/api/gitea/issues/get', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedRepo = getRequestedRepo(req);
      const number = getRequiredNumber(req);
      if (!directory && !requestedRepo) {
        return res.status(400).json({ error: 'directory or owner/repo is required' });
      }
      if (!number) {
        return res.status(400).json({ error: 'number is required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, issue: null });
      }

      const { owner, repo, repoRef } = await resolveRepoForRequest(directory, requestedRepo);
      if (!owner || !repo) {
        return res.json({ connected: true, repo: null, issue: null });
      }

      const resp = await withTimeout(client.issue(owner, repo, number), ROUTE_TIMEOUT_MS, 'gitea issue get');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (resp.status === 404) {
        return res.status(404).json({ error: 'Issue not found' });
      }
      if (resp.status !== 200 || !resp.data) {
        return res.status(502).json({ error: 'Gitea returned an error while fetching the issue' });
      }

      const item = resp.data;
      const issue = {
        ...mapGiteaIssueSummary(item),
        body: typeof item.body === 'string' ? item.body : '',
        createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
        updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
      };
      return res.json({ connected: true, repo: repoRef || repoRefFromOwnerRepo(owner, repo, client.baseUrl), issue });
    } catch (error) {
      console.error('Failed to fetch Gitea issue:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch Gitea issue' });
    }
  });

  app.get('/api/gitea/issues/comments', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedRepo = getRequestedRepo(req);
      const number = getRequiredNumber(req);
      if (!directory && !requestedRepo) {
        return res.status(400).json({ error: 'directory or owner/repo is required' });
      }
      if (!number) {
        return res.status(400).json({ error: 'number is required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, comments: [] });
      }

      const { owner, repo, repoRef } = await resolveRepoForRequest(directory, requestedRepo);
      if (!owner || !repo) {
        return res.json({ connected: true, repo: null, comments: [] });
      }

      const commentsResp = await withTimeout(
        client.issueComments(owner, repo, number, { limit: 100 }),
        ROUTE_TIMEOUT_MS,
        'gitea issue comments',
      );
      if (commentsResp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (commentsResp.status !== 200) {
        return res.status(502).json({ error: 'Gitea returned an error while fetching issue comments' });
      }

      const comments = (Array.isArray(commentsResp.data) ? commentsResp.data : []).map(mapGiteaComment);
      return res.json({ connected: true, repo: repoRef || repoRefFromOwnerRepo(owner, repo, client.baseUrl), comments });
    } catch (error) {
      console.error('Failed to fetch Gitea issue comments:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch Gitea issue comments' });
    }
  });

  // ================= Gitea Pull Request APIs =================

  app.get('/api/gitea/prs/list', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedRepo = getRequestedRepo(req);
      if (!directory && !requestedRepo) {
        return res.status(400).json({ error: 'directory or owner/repo is required' });
      }
      const rawPage = typeof req.query?.page === 'string' ? Number(req.query.page) : 1;
      const effectivePage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
      const searchQuery = asString(req.query?.query);
      const sourceBranch = asString(req.query?.sourceBranch);

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, prs: [], page: effectivePage, hasMore: false });
      }

      const { owner, repo, repoRef } = await resolveRepoForRequest(directory, requestedRepo);
      if (!owner || !repo) {
        return res.json({ connected: true, repo: null, prs: [], page: effectivePage, hasMore: false });
      }

      if (sourceBranch) {
        // Gitea has no server-side source-branch filter on pulls, so fetch all
        // states and filter by head.ref client-side — this returns open and
        // merged PRs for the local branch so the UI can prefer the open one.
        const matching = [];
        let hasMore = false;
        let page = 1;
        for (let depth = 0; depth < PRS_MAX_PAGES; depth += 1) {
          const resp = await withTimeout(
            client.pullRequests(owner, repo, { state: 'all', limit: 50, page }),
            ROUTE_TIMEOUT_MS,
            'gitea prs list',
          );
          if (resp.status === 429) {
            return res.status(503).json({ error: 'Gitea rate limited' });
          }
          if (resp.status !== 200 || !Array.isArray(resp.data)) {
            break;
          }
          for (const item of resp.data) {
            if (typeof item.head?.ref === 'string' && item.head.ref === sourceBranch) {
              matching.push(mapGiteaPullRequestSummary(item));
            }
          }
          hasMore = Boolean(resp.page?.hasMore);
          if (!hasMore || resp.data.length === 0) {
            break;
          }
          page += 1;
        }
        return res.json({
          connected: true,
          repo: repoRef || repoRefFromOwnerRepo(owner, repo, client.baseUrl),
          prs: matching,
          page: effectivePage,
          hasMore,
        });
      }

      const params = { state: 'open', limit: 50, page: effectivePage };
      if (searchQuery) {
        params.q = searchQuery;
      }
      const resp = await withTimeout(client.pullRequests(owner, repo, params), ROUTE_TIMEOUT_MS, 'gitea prs list');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (resp.status !== 200) {
        return res.status(502).json({ error: 'Gitea returned an error while listing pull requests' });
      }

      const prs = (Array.isArray(resp.data) ? resp.data : []).map(mapGiteaPullRequestSummary);
      return res.json({
        connected: true,
        repo: repoRef || repoRefFromOwnerRepo(owner, repo, client.baseUrl),
        prs,
        page: effectivePage,
        hasMore: Boolean(resp.page?.hasMore),
      });
    } catch (error) {
      console.error('Failed to list Gitea pull requests:', error);
      return res.status(500).json({ error: error.message || 'Failed to list Gitea pull requests' });
    }
  });

  app.get('/api/gitea/pr/context', async (req, res) => {
    try {
      const directory = asString(req.query?.directory);
      const requestedRepo = getRequestedRepo(req);
      const number = getRequiredNumber(req);
      const includeDiff = req.query?.includeDiff === '1' || req.query?.includeDiff === 'true';
      if (!directory && !requestedRepo) {
        return res.status(400).json({ error: 'directory or owner/repo is required' });
      }
      if (!number) {
        return res.status(400).json({ error: 'number is required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false, pr: null, comments: [], files: [] });
      }

      const { owner, repo, repoRef } = await resolveRepoForRequest(directory, requestedRepo);
      if (!owner || !repo) {
        return res.json({ connected: true, repo: null, pr: null, comments: [], files: [] });
      }

      const prResp = await withTimeout(client.pullRequest(owner, repo, number), ROUTE_TIMEOUT_MS, 'gitea pr context');
      if (prResp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (prResp.status === 404) {
        return res.status(404).json({ error: 'Pull request not found' });
      }
      if (prResp.status !== 200 || !prResp.data) {
        return res.status(502).json({ error: 'Gitea returned an error while fetching the pull request' });
      }
      const pr = mapGiteaPullRequest(prResp.data);

      // PR comments live on the issue comments endpoint in Gitea.
      const commentsResp = await withTimeout(
        client.issueComments(owner, repo, number, { limit: 100 }),
        ROUTE_TIMEOUT_MS,
        'gitea pr context comments',
      );
      if (commentsResp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      const comments = (commentsResp.status === 200 && Array.isArray(commentsResp.data) ? commentsResp.data : [])
        .map(mapGiteaComment);

      // Per-file patches. Older Gitea instances 404 on this endpoint; fall back
      // to an empty list rather than failing the whole context.
      const filesResp = await withTimeout(
        client.pullRequestFiles(owner, repo, number, { patch: 'true' }),
        ROUTE_TIMEOUT_MS,
        'gitea pr context files',
      );
      if (filesResp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      const files = (filesResp.status === 200 && Array.isArray(filesResp.data) ? filesResp.data : [])
        .map(mapGiteaFile);

      let diff;
      if (includeDiff) {
        // Raw unified diff; fall back to concatenated per-file patches.
        const diffResp = await withTimeout(client.pullRequestDiff(owner, repo, number), ROUTE_TIMEOUT_MS, 'gitea pr context diff');
        if (diffResp.status === 429) {
          return res.status(503).json({ error: 'Gitea rate limited' });
        }
        if (diffResp.status === 200 && typeof diffResp.data === 'string' && diffResp.data.trim()) {
          diff = diffResp.data;
        } else {
          const patches = files.map((file) => file.patch || '').filter(Boolean);
          if (patches.length > 0) {
            diff = patches.join('\n');
          }
        }
      }

      return res.json({
        connected: true,
        repo: repoRef || repoRefFromOwnerRepo(owner, repo, client.baseUrl),
        pr,
        comments,
        files,
        ...(diff ? { diff } : {}),
      });
    } catch (error) {
      console.error('Failed to load Gitea pull request context:', error);
      return res.status(500).json({ error: error.message || 'Failed to load Gitea pull request context' });
    }
  });

  // ================= Gitea Pull Request Write APIs =================

  app.post('/api/gitea/pr/create', async (req, res) => {
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

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedRepo = getRequestedRepo(req);
      const { owner, repo, repoRef } = await resolveRepoForRequest(directory, requestedRepo);
      if (!owner || !repo) {
        return res.status(400).json({ error: 'Unable to resolve Gitea repo from directory' });
      }

      const body = {
        title,
        head: sourceBranch,
        base: targetBranch,
      };
      if (description !== undefined) {
        body.body = description;
      }

      const resp = await withTimeout(client.createPullRequest(owner, repo, body), ROUTE_TIMEOUT_MS, 'gitea pr create');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your Gitea token needs write:repository scope to create pull requests' });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: giteaErrorMessage(resp.data) || 'Gitea returned an error while creating the pull request' });
      }
      if (!resp.data) {
        return res.status(500).json({ error: 'Gitea returned an empty response while creating the pull request' });
      }

      return res.json({
        connected: true,
        repo: repoRef || repoRefFromOwnerRepo(owner, repo, client.baseUrl),
        pr: mapGiteaPullRequest(resp.data),
      });
    } catch (error) {
      console.error('Failed to create Gitea pull request:', error);
      return res.status(500).json({ error: error.message || 'Failed to create Gitea pull request' });
    }
  });

  app.patch('/api/gitea/pr/update', async (req, res) => {
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

      const requestedRepo = getRequestedRepo(req);
      const { owner, repo, repoRef } = await resolveRepoForRequest(directory, requestedRepo);
      if (!owner || !repo) {
        return res.status(400).json({ error: 'Unable to resolve Gitea repo from directory' });
      }

      const body = {};
      if (title) {
        body.title = title;
      }
      if (description !== undefined) {
        body.body = description;
      }

      const resp = await withTimeout(client.updatePullRequest(owner, repo, number, body), ROUTE_TIMEOUT_MS, 'gitea pr update');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your Gitea token needs write:repository scope to update pull requests' });
      }
      if (resp.status === 404) {
        return res.status(404).json({ error: 'Pull request not found' });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: giteaErrorMessage(resp.data) || 'Gitea returned an error while updating the pull request' });
      }
      if (!resp.data) {
        return res.status(500).json({ error: 'Gitea returned an empty response while updating the pull request' });
      }

      return res.json({
        connected: true,
        repo: repoRef || repoRefFromOwnerRepo(owner, repo, client.baseUrl),
        pr: mapGiteaPullRequest(resp.data),
      });
    } catch (error) {
      console.error('Failed to update Gitea pull request:', error);
      return res.status(500).json({ error: error.message || 'Failed to update Gitea pull request' });
    }
  });

  app.post('/api/gitea/pr/merge', async (req, res) => {
    try {
      const directory = asString(req.body?.directory);
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }
      const method = ['merge', 'squash', 'rebase'].includes(req.body?.method) ? req.body.method : 'merge';

      const client = await getClient();
      if (!client) {
        return res.json({ connected: false });
      }

      const requestedRepo = getRequestedRepo(req);
      const { owner, repo } = await resolveRepoForRequest(directory, requestedRepo);
      if (!owner || !repo) {
        return res.status(400).json({ error: 'Unable to resolve Gitea repo from directory' });
      }

      const body = { Do: true, MergeMethod: method };

      const resp = await withTimeout(client.mergePullRequest(owner, repo, number, body), ROUTE_TIMEOUT_MS, 'gitea pr merge');
      if (resp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (resp.status === 403) {
        return res.status(400).json({ error: 'Your Gitea token needs write:repository scope to merge pull requests' });
      }
      if (resp.status === 404) {
        return res.status(404).json({ error: 'Pull request not found' });
      }
      // Gitea rejects non-mergeable requests with 405/409/422 and a `message`
      // in the body — surface it as a merge rejection (mirrors the GitHub
      // pr/merge contract) instead of a generic error.
      if (resp.status === 405 || resp.status === 409 || resp.status === 422) {
        return res.status(resp.status).json({
          connected: true,
          merged: false,
          message: giteaErrorMessage(resp.data) || 'Pull request not mergeable',
        });
      }
      if (resp.status !== 200 && resp.status !== 201) {
        const status = resp.status >= 500 ? 500 : 400;
        return res.status(status).json({ error: giteaErrorMessage(resp.data) || 'Gitea returned an error while merging the pull request' });
      }

      return res.json({ connected: true, merged: true });
    } catch (error) {
      console.error('Failed to merge Gitea pull request:', error);
      return res.status(500).json({ error: error.message || 'Failed to merge Gitea pull request' });
    }
  });

  // ================= Gitea Repo APIs =================

  app.get('/api/gitea/repo/branches', async (req, res) => {
    try {
      const owner = asString(req.query?.owner);
      const repo = asString(req.query?.repo);
      if (!owner || !repo) {
        return res.status(400).json({ error: 'owner and repo are required' });
      }

      const client = await getClient();
      if (!client) {
        return res.json({ branches: [], defaultBranch: null });
      }

      const branches = [];
      let page = 1;
      while (page <= 10) {
        const resp = await withTimeout(client.branches(owner, repo, { limit: 50, page }), ROUTE_TIMEOUT_MS, 'gitea repo branches');
        if (resp.status === 429) {
          return res.status(503).json({ error: 'Gitea rate limited' });
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
        if (chunk.length < 50 || !resp.page?.hasMore) {
          break;
        }
        page += 1;
      }

      // Gitea branch objects carry no default flag; read `default_branch` from
      // the repo object instead.
      let defaultBranch = null;
      const repoResp = await withTimeout(client.repo(owner, repo), ROUTE_TIMEOUT_MS, 'gitea repo');
      if (repoResp.status === 429) {
        return res.status(503).json({ error: 'Gitea rate limited' });
      }
      if (repoResp.status === 200 && repoResp.data) {
        defaultBranch = typeof repoResp.data.default_branch === 'string' ? repoResp.data.default_branch : null;
      }

      return res.json({ branches, defaultBranch });
    } catch (error) {
      console.error('Failed to fetch Gitea repo branches:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch Gitea repo branches' });
    }
  });
}
