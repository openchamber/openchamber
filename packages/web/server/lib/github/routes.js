export function registerGitHubRoutes(app) {
  let githubLibraries = null;
  const getGitHubLibraries = async () => {
    if (!githubLibraries) {
      githubLibraries = await import('./index.js');
    }
    return githubLibraries;
  };

  const getGitHubUserSummary = async (octokit) => {
    const me = await octokit.rest.users.getAuthenticated();

    let email = typeof me.data.email === 'string' ? me.data.email : null;
    if (!email) {
      try {
        const emails = await octokit.rest.users.listEmailsForAuthenticatedUser({ per_page: 100 });
        const list = Array.isArray(emails?.data) ? emails.data : [];
        const primaryVerified = list.find((e) => e && e.primary && e.verified && typeof e.email === 'string');
        const anyVerified = list.find((e) => e && e.verified && typeof e.email === 'string');
        email = primaryVerified?.email || anyVerified?.email || null;
      } catch {
        // ignore (scope might be missing)
      }
    }

    return {
      login: me.data.login,
      id: me.data.id,
      avatarUrl: me.data.avatar_url,
      name: typeof me.data.name === 'string' ? me.data.name : null,
      email,
    };
  };

  const isGitHubAuthInvalid = (error) => error?.status === 401 || error?.status === 403;
  const isGitHubResourceUnavailable = (error) => error?.status === 403 || error?.status === 404;

  app.get('/api/github/auth/status', async (_req, res) => {
    try {
      const { getGitHubAuth, getOctokitOrNull, clearGitHubAuth, getGitHubAuthAccounts } = await getGitHubLibraries();
      const auth = getGitHubAuth();
      const accounts = getGitHubAuthAccounts();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts });
      }

      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false, accounts });
      }

      let user = null;
      try {
        user = await getGitHubUserSummary(octokit);
      } catch (error) {
        if (isGitHubAuthInvalid(error)) {
          clearGitHubAuth();
          return res.json({ connected: false, accounts: getGitHubAuthAccounts() });
        }
      }

      const fallback = auth.user;
      const mergedUser = user || fallback;

      return res.json({
        connected: true,
        user: mergedUser,
        scope: auth.scope,
        accounts,
      });
    } catch (error) {
      console.error('Failed to get GitHub auth status:', error);
      return res.status(500).json({ error: error.message || 'Failed to get GitHub auth status' });
    }
  });

  app.post('/api/github/auth/start', async (_req, res) => {
    try {
      const { getGitHubClientId, getGitHubScopes, startDeviceFlow } = await getGitHubLibraries();
      const clientId = getGitHubClientId();
      if (!clientId) {
        return res.status(400).json({
          error: 'GitHub OAuth client not configured. Set OPENCHAMBER_GITHUB_CLIENT_ID.',
        });
      }

      const scope = getGitHubScopes();

      const payload = await startDeviceFlow({
        clientId,
        scope,
      });

      return res.json({
        deviceCode: payload.device_code,
        userCode: payload.user_code,
        verificationUri: payload.verification_uri,
        verificationUriComplete: payload.verification_uri_complete,
        expiresIn: payload.expires_in,
        interval: payload.interval,
        scope,
      });
    } catch (error) {
      console.error('Failed to start GitHub device flow:', error);
      return res.status(500).json({ error: error.message || 'Failed to start GitHub device flow' });
    }
  });

  app.post('/api/github/auth/complete', async (req, res) => {
    try {
      const { getGitHubClientId, exchangeDeviceCode, setGitHubAuth, getGitHubAuthAccounts } = await getGitHubLibraries();
      const clientId = getGitHubClientId();
      if (!clientId) {
        return res.status(400).json({
          error: 'GitHub OAuth client not configured. Set OPENCHAMBER_GITHUB_CLIENT_ID.',
        });
      }

      const deviceCode = typeof req.body?.deviceCode === 'string'
        ? req.body.deviceCode
        : (typeof req.body?.device_code === 'string' ? req.body.device_code : '');

      if (!deviceCode) {
        return res.status(400).json({ error: 'deviceCode is required' });
      }

      const payload = await exchangeDeviceCode({ clientId, deviceCode });

      if (payload?.error) {
        return res.json({
          connected: false,
          status: payload.error,
          error: payload.error_description || payload.error,
        });
      }

      const accessToken = payload?.access_token;
      if (!accessToken) {
        return res.status(500).json({ error: 'Missing access_token from GitHub' });
      }

      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: accessToken });
      const user = await getGitHubUserSummary(octokit);

      setGitHubAuth({
        accessToken,
        scope: typeof payload.scope === 'string' ? payload.scope : '',
        tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'bearer',
        user,
      });

      return res.json({
        connected: true,
        user,
        scope: typeof payload.scope === 'string' ? payload.scope : '',
        accounts: getGitHubAuthAccounts(),
      });
    } catch (error) {
      console.error('Failed to complete GitHub device flow:', error);
      return res.status(500).json({ error: error.message || 'Failed to complete GitHub device flow' });
    }
  });

  app.post('/api/github/auth/activate', async (req, res) => {
    try {
      const { activateGitHubAuth, getGitHubAuth, getOctokitOrNull, clearGitHubAuth, getGitHubAuthAccounts } = await getGitHubLibraries();
      const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : '';
      if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
      }
      const activated = activateGitHubAuth(accountId);
      if (!activated) {
        return res.status(404).json({ error: 'GitHub account not found' });
      }

      const auth = getGitHubAuth();
      const accounts = getGitHubAuthAccounts();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts });
      }

      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false, accounts });
      }

      let user = auth.user || null;
      try {
        user = await getGitHubUserSummary(octokit);
      } catch (error) {
        if (isGitHubAuthInvalid(error)) {
          clearGitHubAuth();
          return res.json({ connected: false, accounts: getGitHubAuthAccounts() });
        }
      }

      return res.json({
        connected: true,
        user,
        scope: auth.scope,
        accounts,
      });
    } catch (error) {
      console.error('Failed to activate GitHub account:', error);
      return res.status(500).json({ error: error.message || 'Failed to activate GitHub account' });
    }
  });

  app.delete('/api/github/auth', async (_req, res) => {
    try {
      const { clearGitHubAuth } = await getGitHubLibraries();
      const removed = clearGitHubAuth();
      return res.json({ success: true, removed });
    } catch (error) {
      console.error('Failed to disconnect GitHub:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect GitHub' });
    }
  });

  app.get('/api/github/me', async (_req, res) => {
    try {
      const { getOctokitOrNull, clearGitHubAuth } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }
      let user;
      try {
        user = await getGitHubUserSummary(octokit);
      } catch (error) {
        if (isGitHubAuthInvalid(error)) {
          clearGitHubAuth();
          return res.status(401).json({ error: 'GitHub token expired or revoked' });
        }
        throw error;
      }
      return res.json(user);
    } catch (error) {
      console.error('Failed to fetch GitHub user:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitHub user' });
    }
  });

  // ================= GitHub PR APIs =================

  app.get('/api/github/pr/status', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const branch = typeof req.query?.branch === 'string' ? req.query.branch.trim() : '';
      const remote = typeof req.query?.remote === 'string' ? req.query.remote.trim() : 'origin';
      if (!directory || !branch) {
        return res.status(400).json({ error: 'directory and branch are required' });
      }

      const { getOctokitOrNull, getGitHubAuth } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubPrStatus } = await import('./pr-status.js');
      const resolvedStatus = await resolveGitHubPrStatus({
        octokit,
        directory,
        branch,
        remoteName: remote,
      });
      const searchRepo = resolvedStatus.repo;
      const first = resolvedStatus.pr;
      if (!searchRepo) {
        return res.json({ connected: true, repo: null, branch, pr: null, checks: null, canMerge: false, defaultBranch: null, resolvedRemoteName: null });
      }
      if (!first) {
        return res.json({ connected: true, repo: searchRepo, branch, pr: null, checks: null, canMerge: false, defaultBranch: resolvedStatus.defaultBranch ?? null, resolvedRemoteName: resolvedStatus.resolvedRemoteName ?? null });
      }

      // Enrich with mergeability fields
      const prFull = await octokit.rest.pulls.get({ owner: searchRepo.owner, repo: searchRepo.repo, pull_number: first.number });
      const prData = prFull?.data;
      if (!prData) {
        return res.json({ connected: true, repo: searchRepo, branch, pr: null, checks: null, canMerge: false });
      }

      // Checks summary: prefer check-runs (Actions), fallback to classic statuses.
      let checks = null;
      const sha = prData.head?.sha;
      if (sha) {
        try {
          const runs = await octokit.rest.checks.listForRef({
            owner: searchRepo.owner,
            repo: searchRepo.repo,
            ref: sha,
            per_page: 100,
          });
          const checkRuns = Array.isArray(runs?.data?.check_runs) ? runs.data.check_runs : [];
          if (checkRuns.length > 0) {
            const counts = { success: 0, failure: 0, pending: 0 };
            for (const run of checkRuns) {
              const status = run?.status;
              const conclusion = run?.conclusion;
              if (status === 'queued' || status === 'in_progress') {
                counts.pending += 1;
                continue;
              }
              if (!conclusion) {
                counts.pending += 1;
                continue;
              }
              if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
                counts.success += 1;
              } else {
                counts.failure += 1;
              }
            }
            const total = counts.success + counts.failure + counts.pending;
            const state = counts.failure > 0
              ? 'failure'
              : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
            checks = { state, total, ...counts };
          }
        } catch {
          // ignore and fall back
        }

        if (!checks) {
          try {
            const combined = await octokit.rest.repos.getCombinedStatusForRef({
              owner: searchRepo.owner,
              repo: searchRepo.repo,
              ref: sha,
            });
            const statuses = Array.isArray(combined?.data?.statuses) ? combined.data.statuses : [];
            const counts = { success: 0, failure: 0, pending: 0 };
            statuses.forEach((s) => {
              if (s.state === 'success') counts.success += 1;
              else if (s.state === 'failure' || s.state === 'error') counts.failure += 1;
              else if (s.state === 'pending') counts.pending += 1;
            });
            const total = counts.success + counts.failure + counts.pending;
            const state = counts.failure > 0
              ? 'failure'
              : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
            checks = { state, total, ...counts };
          } catch {
            checks = null;
          }
        }
      }

      // Permission check (best-effort)
      let canMerge = false;
      try {
        const auth = getGitHubAuth();
        const username = auth?.user?.login;
        if (username) {
          const perm = await octokit.rest.repos.getCollaboratorPermissionLevel({
            owner: searchRepo.owner,
            repo: searchRepo.repo,
            username,
          });
          const level = perm?.data?.permission;
          canMerge = level === 'admin' || level === 'maintain' || level === 'write';
        }
      } catch {
        canMerge = false;
      }

       const isMerged = Boolean(prData.merged || prData.merged_at);
       const mergedState = isMerged ? 'merged' : (prData.state === 'closed' ? 'closed' : 'open');

      return res.json({
        connected: true,
        repo: searchRepo,
        branch,
        pr: {
          number: prData.number,
          title: prData.title,
          body: prData.body || '',
          url: prData.html_url,
          state: mergedState,
          draft: Boolean(prData.draft),
          base: prData.base?.ref,
          head: prData.head?.ref,
          headSha: prData.head?.sha,
          mergeable: prData.mergeable,
          mergeableState: prData.mergeable_state,
        },
        checks,
        canMerge,
        defaultBranch: resolvedStatus.defaultBranch ?? null,
        resolvedRemoteName: resolvedStatus.resolvedRemoteName ?? null,
      });
    } catch (error) {
      if (error?.status === 401) {
        const { clearGitHubAuth } = await getGitHubLibraries();
        clearGitHubAuth();
        return res.json({ connected: false });
      }
      if (isGitHubResourceUnavailable(error)) {
        return res.json({
          connected: true,
          repo: null,
          branch: typeof req.query?.branch === 'string' ? req.query.branch.trim() : '',
          pr: null,
          checks: null,
          canMerge: false,
          defaultBranch: null,
          resolvedRemoteName: null,
        });
      }
      console.error('Failed to load GitHub PR status:', error);
      return res.status(500).json({ error: error.message || 'Failed to load GitHub PR status' });
    }
  });

  app.post('/api/github/pr/create', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const head = typeof req.body?.head === 'string' ? req.body.head.trim() : '';
      const requestedBase = typeof req.body?.base === 'string' ? req.body.base.trim() : '';
      const body = typeof req.body?.body === 'string' ? req.body.body : undefined;
      const draft = typeof req.body?.draft === 'boolean' ? req.body.draft : undefined;
      // remote = target repo (where PR is created, e.g., 'upstream' for forks)
      const remote = typeof req.body?.remote === 'string' ? req.body.remote.trim() : 'origin';
      // headRemote = source repo (where head branch lives, e.g., 'origin' for forks)
      const headRemote = typeof req.body?.headRemote === 'string' ? req.body.headRemote.trim() : '';
      if (!directory || !title || !head || !requestedBase) {
        return res.status(400).json({ error: 'directory, title, head, base are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory, remote);
      if (!repo) {
        return res.status(400).json({ error: 'Unable to resolve GitHub repo from git remote' });
      }

      const normalizeBranchRef = (value, remoteNames = new Set()) => {
        if (!value) {
          return value;
        }
        let normalized = value.trim();
        if (normalized.startsWith('refs/heads/')) {
          normalized = normalized.substring('refs/heads/'.length);
        }
        if (normalized.startsWith('heads/')) {
          normalized = normalized.substring('heads/'.length);
        }
        if (normalized.startsWith('remotes/')) {
          normalized = normalized.substring('remotes/'.length);
        }

        const slashIndex = normalized.indexOf('/');
        if (slashIndex > 0) {
          const maybeRemote = normalized.slice(0, slashIndex);
          if (remoteNames.has(maybeRemote)) {
            const withoutRemotePrefix = normalized.slice(slashIndex + 1).trim();
            if (withoutRemotePrefix) {
              normalized = withoutRemotePrefix;
            }
          }
        }

        return normalized;
      };

      // Determine the source remote for the head branch
      // Priority: 1) explicit headRemote, 2) tracking branch remote, 3) 'origin' if targeting non-origin
      let sourceRemote = headRemote;
      const { getStatus, getRemotes } = await import('../git/index.js');
      
      // If no explicit headRemote, check the branch's tracking info
      if (!sourceRemote) {
        const status = await getStatus(directory).catch(() => null);
        if (status?.tracking) {
          // tracking is like "gsxdsm/fix/multi-remote-branch-creation" or "origin/main"
          const trackingRemote = status.tracking.split('/')[0];
          if (trackingRemote) {
            sourceRemote = trackingRemote;
          }
        }
      }
      
      // Fallback: if targeting non-origin and no tracking info, try 'origin'
      if (!sourceRemote && remote !== 'origin') {
        sourceRemote = 'origin';
      }

      const remoteNames = new Set([remote]);
      const remotes = await getRemotes(directory).catch(() => []);
      for (const item of remotes) {
        if (item?.name) {
          remoteNames.add(item.name);
        }
      }
      if (sourceRemote) {
        remoteNames.add(sourceRemote);
      }

      const base = normalizeBranchRef(requestedBase, remoteNames);
      if (!base) {
        return res.status(400).json({ error: 'Invalid base branch name' });
      }

      // For fork workflows: we need to determine the correct head reference
      let headRef = head;
      
      if (sourceRemote && sourceRemote !== remote) {
        // The branch is on a different remote than the target - this is a cross-repo PR
        const { repo: headRepo } = await resolveGitHubRepoFromDirectory(directory, sourceRemote);
        if (headRepo) {
          // Always use owner:branch format for cross-repo PRs
          // GitHub API requires this when head is from a different repo/fork
          if (headRepo.owner !== repo.owner || headRepo.repo !== repo.repo) {
            headRef = `${headRepo.owner}:${head}`;
          }
        }
      }

      // For cross-repo PRs, verify the branch exists on the head repo first
      if (headRef.includes(':')) {
        const [headOwner] = headRef.split(':');
        const headRepoName = sourceRemote 
          ? (await resolveGitHubRepoFromDirectory(directory, sourceRemote)).repo?.repo 
          : repo.repo;
        
        if (headRepoName) {
          try {
            await octokit.rest.repos.getBranch({
              owner: headOwner,
              repo: headRepoName,
              branch: head,
            });
          } catch (branchError) {
            if (branchError?.status === 404) {
              return res.status(400).json({
                error: `Branch "${head}" not found on ${headOwner}/${headRepoName}. Please push your branch first: git push ${sourceRemote || 'origin'} ${head}`,
              });
            }
            // For other errors, continue - let the PR create attempt handle it
          }
        }
      }

      const created = await octokit.rest.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        title,
        head: headRef,
        base,
        ...(typeof body === 'string' ? { body } : {}),
        ...(typeof draft === 'boolean' ? { draft } : {}),
      });

      const pr = created?.data;
      if (!pr) {
        return res.status(500).json({ error: 'Failed to create PR' });
      }

      return res.json({
        number: pr.number,
        title: pr.title,
        body: pr.body || '',
        url: pr.html_url,
        state: pr.state === 'closed' ? 'closed' : 'open',
        draft: Boolean(pr.draft),
        base: pr.base?.ref,
        head: pr.head?.ref,
        headSha: pr.head?.sha,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
      });
    } catch (error) {
      console.error('Failed to create GitHub PR:', error);
      
      // Check for head validation error (common with fork PRs)
      const errorMessage = error.message || '';
      const isHeadValidationError = 
        errorMessage.includes('Validation Failed') && 
        errorMessage.includes('"field":"head"') &&
        errorMessage.includes('"code":"invalid"');
      
      if (isHeadValidationError) {
        return res.status(400).json({ 
          error: 'Unable to create PR: You must have write access to the source repository. Make sure you have pushed your branch to a repository you own (your fork), and that the branch exists on the remote.' 
        });
      }
      
      return res.status(500).json({ error: error.message || 'Failed to create GitHub PR' });
    }
  });

  app.post('/api/github/pr/update', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const body = typeof req.body?.body === 'string' ? req.body.body : undefined;
      if (!directory || !number || !title) {
        return res.status(400).json({ error: 'directory, number, title are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.status(400).json({ error: 'Unable to resolve GitHub repo from git remote' });
      }

      let updated;
      try {
        updated = await octokit.rest.pulls.update({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          title,
          ...(typeof body === 'string' ? { body } : {}),
        });
      } catch (error) {
        if (error?.status === 401) {
          return res.status(401).json({ error: 'GitHub not connected' });
        }
        if (error?.status === 403) {
          return res.status(403).json({ error: 'Not authorized to edit this PR' });
        }
        if (error?.status === 404) {
          return res.status(404).json({ error: 'PR not found in this repository' });
        }
        if (error?.status === 422) {
          const apiMessage = error?.response?.data?.message;
          const firstError = Array.isArray(error?.response?.data?.errors) && error.response.data.errors.length > 0
            ? (error.response.data.errors[0]?.message || error.response.data.errors[0]?.code)
            : null;
          const message = [apiMessage, firstError].filter(Boolean).join(' · ') || 'Invalid PR update payload';
          return res.status(422).json({ error: message });
        }
        throw error;
      }

      const pr = updated?.data;
      if (!pr) {
        return res.status(500).json({ error: 'Failed to update PR' });
      }

      return res.json({
        number: pr.number,
        title: pr.title,
        body: pr.body || '',
        url: pr.html_url,
        state: pr.merged_at ? 'merged' : (pr.state === 'closed' ? 'closed' : 'open'),
        draft: Boolean(pr.draft),
        base: pr.base?.ref,
        head: pr.head?.ref,
        headSha: pr.head?.sha,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
      });
    } catch (error) {
      console.error('Failed to update GitHub PR:', error);
      return res.status(500).json({ error: error.message || 'Failed to update GitHub PR' });
    }
  });

  app.post('/api/github/pr/merge', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      const method = typeof req.body?.method === 'string' ? req.body.method : 'merge';
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.status(400).json({ error: 'Unable to resolve GitHub repo from git remote' });
      }

      try {
        const result = await octokit.rest.pulls.merge({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          merge_method: method,
        });
        return res.json({ merged: Boolean(result?.data?.merged), message: result?.data?.message });
      } catch (error) {
        if (error?.status === 403) {
          return res.status(403).json({ error: 'Not authorized to merge this PR' });
        }
        if (error?.status === 405 || error?.status === 409) {
          return res.json({ merged: false, message: error?.message || 'PR not mergeable' });
        }
        throw error;
      }
    } catch (error) {
      console.error('Failed to merge GitHub PR:', error);
      return res.status(500).json({ error: error.message || 'Failed to merge GitHub PR' });
    }
  });

  app.post('/api/github/pr/ready', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.status(400).json({ error: 'Unable to resolve GitHub repo from git remote' });
      }

      const pr = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number });
      const nodeId = pr?.data?.node_id;
      if (!nodeId) {
        return res.status(500).json({ error: 'Failed to resolve PR node id' });
      }

      if (pr?.data?.draft === false) {
        return res.json({ ready: true });
      }

      try {
        await octokit.graphql(
          `mutation($pullRequestId: ID!) {\n  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {\n    pullRequest {\n      id\n      isDraft\n    }\n  }\n}`,
          { pullRequestId: nodeId }
        );
      } catch (error) {
        if (error?.status === 403) {
          return res.status(403).json({ error: 'Not authorized to mark PR ready' });
        }
        throw error;
      }

      return res.json({ ready: true });
    } catch (error) {
      console.error('Failed to mark PR ready:', error);
      return res.status(500).json({ error: error.message || 'Failed to mark PR ready' });
    }
  });

  // ================= GitHub Issue APIs =================

  app.get('/api/github/issues/list', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const page = typeof req.query?.page === 'string' ? Number(req.query.page) : 1;
      if (!directory) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, issues: [] });
      }

      const list = await octokit.rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.repo,
        state: 'open',
        per_page: 50,
        page: Number.isFinite(page) && page > 0 ? page : 1,
      });
      const link = typeof list?.headers?.link === 'string' ? list.headers.link : '';
      const hasMore = /rel="next"/.test(link);
      const issues = (Array.isArray(list?.data) ? list.data : [])
        .filter((item) => !item?.pull_request)
        .map((item) => ({
          number: item.number,
          title: item.title,
          url: item.html_url,
          state: item.state === 'closed' ? 'closed' : 'open',
          author: item.user ? { login: item.user.login, id: item.user.id, avatarUrl: item.user.avatar_url } : null,
          labels: Array.isArray(item.labels)
            ? item.labels
                .map((label) => {
                  if (typeof label === 'string') return null;
                  const name = typeof label?.name === 'string' ? label.name : '';
                  if (!name) return null;
                  return { name, color: typeof label?.color === 'string' ? label.color : undefined };
                })
                .filter(Boolean)
            : [],
        }));

      return res.json({ connected: true, repo, issues, page: Number.isFinite(page) && page > 0 ? page : 1, hasMore });
    } catch (error) {
      console.error('Failed to list GitHub issues:', error);
      return res.status(500).json({ error: error.message || 'Failed to list GitHub issues' });
    }
  });

  app.get('/api/github/issues/get', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const number = typeof req.query?.number === 'string' ? Number(req.query.number) : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, issue: null });
      }

      const result = await octokit.rest.issues.get({ owner: repo.owner, repo: repo.repo, issue_number: number });
      const issue = result?.data;
      if (!issue || issue.pull_request) {
        return res.status(400).json({ error: 'Not a GitHub issue' });
      }

      return res.json({
        connected: true,
        repo,
        issue: {
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          state: issue.state === 'closed' ? 'closed' : 'open',
          body: issue.body || '',
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          author: issue.user ? { login: issue.user.login, id: issue.user.id, avatarUrl: issue.user.avatar_url } : null,
          assignees: Array.isArray(issue.assignees)
            ? issue.assignees
                .map((u) => (u ? { login: u.login, id: u.id, avatarUrl: u.avatar_url } : null))
                .filter(Boolean)
            : [],
          labels: Array.isArray(issue.labels)
            ? issue.labels
                .map((label) => {
                  if (typeof label === 'string') return null;
                  const name = typeof label?.name === 'string' ? label.name : '';
                  if (!name) return null;
                  return { name, color: typeof label?.color === 'string' ? label.color : undefined };
                })
                .filter(Boolean)
            : [],
        },
      });
    } catch (error) {
      console.error('Failed to fetch GitHub issue:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitHub issue' });
    }
  });

  app.get('/api/github/issues/comments', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const number = typeof req.query?.number === 'string' ? Number(req.query.number) : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, comments: [] });
      }

      const result = await octokit.rest.issues.listComments({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        per_page: 100,
      });
      const comments = (Array.isArray(result?.data) ? result.data : [])
        .map((comment) => ({
          id: comment.id,
          url: comment.html_url,
          body: comment.body || '',
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
          author: comment.user ? { login: comment.user.login, id: comment.user.id, avatarUrl: comment.user.avatar_url } : null,
        }));

      return res.json({ connected: true, repo, comments });
    } catch (error) {
      console.error('Failed to fetch GitHub issue comments:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitHub issue comments' });
    }
  });

  app.post('/api/github/issues/start-work', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      const issueNumber = typeof req.body?.issueNumber === 'number' ? req.body.issueNumber : null;
      if (!directory || !issueNumber) {
        return res.status(400).json({ ok: false, error: { code: 'bad_input', message: 'directory and issueNumber are required' } });
      }

      const { getOctokitOrNull, resolveGitHubRepoFromDirectory } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ ok: false, error: { code: 'not_authenticated', message: 'GitHub not authenticated' } });
      }

      let owner = typeof req.body?.owner === 'string' ? req.body.owner.trim() : '';
      let repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
      if (!owner || !repo) {
        const resolved = await resolveGitHubRepoFromDirectory(directory);
        if (!resolved?.repo) {
          return res.status(400).json({ ok: false, error: { code: 'not_found', message: 'Could not resolve GitHub repo from directory' } });
        }
        owner = resolved.repo.owner;
        repo = resolved.repo.repo;
      }

      const issueResp = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
      const issue = issueResp.data;

      const { buildBranchName } = await import('./branch-naming.js');
      const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name || '')).filter(Boolean);
      const branchName = buildBranchName({ number: issueNumber, title: issue.title || '', labels });

      const { buildIssueBrief, renderBrief } = await import('./issue-brief.js');
      const brief = buildIssueBrief({
        number: issueNumber,
        title: issue.title || '',
        body: issue.body || '',
        labels,
        repoFullName: `${owner}/${repo}`,
      });
      const briefText = renderBrief(brief);

      const sessionSeed = `Plan how to resolve issue #${issueNumber}. Use the brief above as ground truth. Don't write code yet.\n\n${briefText}`;

      const baseBranch = typeof req.body?.baseBranch === 'string' ? req.body.baseBranch.trim() : 'HEAD';

      return res.json({
        ok: true,
        data: {
          branch: branchName,
          brief: briefText,
          sessionSeed,
          baseBranch,
        },
      });
    } catch (error) {
      console.error('Failed to start work from issue:', error);
      return res.status(500).json({ ok: false, error: { code: 'internal', message: error.message || 'Failed to start work from issue' } });
    }
  });

  // ================= GitHub Pull Request Context APIs =================

  app.get('/api/github/pulls/list', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const page = typeof req.query?.page === 'string' ? Number(req.query.page) : 1;
      if (!directory) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, prs: [] });
      }

      const list = await octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        state: 'open',
        per_page: 50,
        page: Number.isFinite(page) && page > 0 ? page : 1,
      });

      const link = typeof list?.headers?.link === 'string' ? list.headers.link : '';
      const hasMore = /rel="next"/.test(link);

      const prs = (Array.isArray(list?.data) ? list.data : []).map((pr) => {
        const mergedState = pr.merged_at ? 'merged' : (pr.state === 'closed' ? 'closed' : 'open');
        const headRepo = pr.head?.repo
          ? {
              owner: pr.head.repo.owner?.login,
              repo: pr.head.repo.name,
              url: pr.head.repo.html_url,
              cloneUrl: pr.head.repo.clone_url,
              sshUrl: pr.head.repo.ssh_url,
            }
          : null;
        return {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          state: mergedState,
          draft: Boolean(pr.draft),
          base: pr.base?.ref,
          head: pr.head?.ref,
          headSha: pr.head?.sha,
          mergeable: pr.mergeable,
          mergeableState: pr.mergeable_state,
          author: pr.user ? { login: pr.user.login, id: pr.user.id, avatarUrl: pr.user.avatar_url } : null,
          headLabel: pr.head?.label,
          headRepo: headRepo && headRepo.owner && headRepo.repo && headRepo.url
            ? headRepo
            : null,
        };
      });

      return res.json({ connected: true, repo, prs, page: Number.isFinite(page) && page > 0 ? page : 1, hasMore });
    } catch (error) {
      if (error?.status === 401) {
        const { clearGitHubAuth } = await getGitHubLibraries();
        clearGitHubAuth();
        return res.json({ connected: false });
      }
      console.error('Failed to list GitHub PRs:', error);
      return res.status(500).json({ error: error.message || 'Failed to list GitHub PRs' });
    }
  });

  app.get('/api/github/pulls/context', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const number = typeof req.query?.number === 'string' ? Number(req.query.number) : null;
      const includeDiff = req.query?.diff === '1' || req.query?.diff === 'true';
      const includeCheckDetails = req.query?.checkDetails === '1' || req.query?.checkDetails === 'true';
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, pr: null });
      }

      const prResp = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number });
      const prData = prResp?.data;
      if (!prData) {
        return res.status(404).json({ error: 'PR not found' });
      }

      const headRepo = prData.head?.repo
        ? {
            owner: prData.head.repo.owner?.login,
            repo: prData.head.repo.name,
            url: prData.head.repo.html_url,
            cloneUrl: prData.head.repo.clone_url,
            sshUrl: prData.head.repo.ssh_url,
          }
        : null;

      const mergedState = prData.merged ? 'merged' : (prData.state === 'closed' ? 'closed' : 'open');
      const pr = {
        number: prData.number,
        title: prData.title,
        url: prData.html_url,
        state: mergedState,
        draft: Boolean(prData.draft),
        base: prData.base?.ref,
        head: prData.head?.ref,
        headSha: prData.head?.sha,
        mergeable: prData.mergeable,
        mergeableState: prData.mergeable_state,
        author: prData.user ? { login: prData.user.login, id: prData.user.id, avatarUrl: prData.user.avatar_url } : null,
        headLabel: prData.head?.label,
        headRepo: headRepo && headRepo.owner && headRepo.repo && headRepo.url ? headRepo : null,
        body: prData.body || '',
        createdAt: prData.created_at,
        updatedAt: prData.updated_at,
      };

      const issueCommentsResp = await octokit.rest.issues.listComments({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        per_page: 100,
      });
      const issueComments = (Array.isArray(issueCommentsResp?.data) ? issueCommentsResp.data : []).map((comment) => ({
        id: comment.id,
        url: comment.html_url,
        body: comment.body || '',
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        author: comment.user ? { login: comment.user.login, id: comment.user.id, avatarUrl: comment.user.avatar_url } : null,
      }));

      const reviewCommentsResp = await octokit.rest.pulls.listReviewComments({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      });
      const reviewComments = (Array.isArray(reviewCommentsResp?.data) ? reviewCommentsResp.data : []).map((comment) => ({
        id: comment.id,
        url: comment.html_url,
        body: comment.body || '',
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        path: comment.path,
        line: typeof comment.line === 'number' ? comment.line : null,
        position: typeof comment.position === 'number' ? comment.position : null,
        diffHunk: comment.diff_hunk || '',
        inReplyToId: typeof comment.in_reply_to_id === 'number' ? comment.in_reply_to_id : undefined,
        author: comment.user ? { login: comment.user.login, id: comment.user.id, avatarUrl: comment.user.avatar_url } : null,
      }));

      const reviewsResp = await octokit.rest.pulls.listReviews({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      });
      const reviews = (Array.isArray(reviewsResp?.data) ? reviewsResp.data : []).map((review) => ({
        id: review.id,
        state: review.state,
        body: review.body || '',
        submittedAt: review.submitted_at,
        author: review.user ? { login: review.user.login, id: review.user.id, avatarUrl: review.user.avatar_url } : null,
      }));

      const requestedReviewersResp = await octokit.rest.pulls.listRequestedReviewers({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
      });
      const requestedReviewers = {
        users: (Array.isArray(requestedReviewersResp?.data?.users) ? requestedReviewersResp.data.users : []).map((u) => ({
          login: u.login,
          id: u.id,
          avatarUrl: u.avatar_url,
        })),
        teams: (Array.isArray(requestedReviewersResp?.data?.teams) ? requestedReviewersResp.data.teams : []).map((t) => ({
          slug: t.slug,
          name: t.name,
        })),
      };

      const filesResp = await octokit.rest.pulls.listFiles({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      });
      const files = (Array.isArray(filesResp?.data) ? filesResp.data : []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch,
      }));

      // checks summary (same logic as status endpoint)
      let checks = null;
      let checkRunsOut = undefined;
      const sha = prData.head?.sha;
      if (sha) {
        try {
          const runs = await octokit.rest.checks.listForRef({ owner: repo.owner, repo: repo.repo, ref: sha, per_page: 100 });
          const checkRuns = Array.isArray(runs?.data?.check_runs) ? runs.data.check_runs : [];
          if (checkRuns.length > 0) {
            const parsedJobs = new Map();
            const parsedAnnotations = new Map();
            if (includeCheckDetails) {
              // Prefetch actions jobs per runId.
              const runIds = new Set();
              const jobIds = new Map();
              for (const run of checkRuns) {
                const details = typeof run.details_url === 'string' ? run.details_url : '';
                const match = details.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
                if (match) {
                  const runId = Number(match[1]);
                  const jobId = match[2] ? Number(match[2]) : null;
                  if (Number.isFinite(runId) && runId > 0) {
                    runIds.add(runId);
                    if (jobId && Number.isFinite(jobId) && jobId > 0) {
                      jobIds.set(details, { runId, jobId });
                    } else {
                      jobIds.set(details, { runId, jobId: null });
                    }
                  }
                }
              }

              for (const runId of runIds) {
                try {
                  const jobsResp = await octokit.rest.actions.listJobsForWorkflowRun({
                    owner: repo.owner,
                    repo: repo.repo,
                    run_id: runId,
                    per_page: 100,
                  });
                  const jobs = Array.isArray(jobsResp?.data?.jobs) ? jobsResp.data.jobs : [];
                  parsedJobs.set(runId, jobs);
                } catch {
                  parsedJobs.set(runId, []);
                }
              }

              for (const run of checkRuns) {
                const runConclusion = typeof run?.conclusion === 'string' ? run.conclusion.toLowerCase() : '';
                const shouldLoadAnnotations = Boolean(
                  run?.id
                  && runConclusion
                  && !['success', 'neutral', 'skipped'].includes(runConclusion)
                );
                if (!shouldLoadAnnotations) {
                  continue;
                }

                const checkRunId = Number(run.id);
                if (!Number.isFinite(checkRunId) || checkRunId <= 0) {
                  continue;
                }

                const annotations = [];
                for (let page = 1; page <= 3; page += 1) {
                  try {
                    const annotationsResp = await octokit.rest.checks.listAnnotations({
                      owner: repo.owner,
                      repo: repo.repo,
                      check_run_id: checkRunId,
                      per_page: 50,
                      page,
                    });
                    const chunk = Array.isArray(annotationsResp?.data) ? annotationsResp.data : [];
                    annotations.push(...chunk);
                    if (chunk.length < 50) {
                      break;
                    }
                  } catch {
                    break;
                  }
                }

                if (annotations.length > 0) {
                  parsedAnnotations.set(checkRunId, annotations);
                }
              }
            }

            checkRunsOut = checkRuns.map((run) => {
              const detailsUrl = typeof run.details_url === 'string' ? run.details_url : undefined;
              let job = undefined;
              if (includeCheckDetails && detailsUrl) {
                const match = detailsUrl.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
                const runId = match ? Number(match[1]) : null;
                const jobId = match && match[2] ? Number(match[2]) : null;
                if (runId && Number.isFinite(runId)) {
                  const jobs = parsedJobs.get(runId) || [];
                  const matched = jobId
                    ? jobs.find((j) => j.id === jobId)
                    : null;
                  const picked = matched || jobs.find((j) => j.name === run.name) || null;
                  if (picked) {
                    job = {
                      runId,
                      jobId: picked.id,
                      url: picked.html_url,
                      name: picked.name,
                      conclusion: picked.conclusion,
                          steps: Array.isArray(picked.steps)
                            ? picked.steps.map((s) => ({
                                name: s.name,
                                status: s.status,
                                conclusion: s.conclusion,
                                number: s.number,
                                startedAt: s.started_at || undefined,
                                completedAt: s.completed_at || undefined,
                              }))
                            : undefined,
                    };
                  } else {
                    job = { runId, ...(jobId ? { jobId } : {}), url: detailsUrl };
                  }
                }
              }

              return {
                id: run.id,
                name: run.name,
                app: run.app
                  ? {
                      name: run.app.name || undefined,
                      slug: run.app.slug || undefined,
                    }
                  : undefined,
                status: run.status,
                conclusion: run.conclusion,
                detailsUrl,
                output: run.output
                  ? {
                      title: run.output.title || undefined,
                      summary: run.output.summary || undefined,
                      text: run.output.text || undefined,
                    }
                  : undefined,
                ...(job ? { job } : {}),
                ...(run.id && parsedAnnotations.has(run.id)
                  ? {
                      annotations: parsedAnnotations.get(run.id).map((a) => ({
                        path: a.path || undefined,
                        startLine: typeof a.start_line === 'number' ? a.start_line : undefined,
                        endLine: typeof a.end_line === 'number' ? a.end_line : undefined,
                        level: a.annotation_level || undefined,
                        message: a.message || '',
                        title: a.title || undefined,
                        rawDetails: a.raw_details || undefined,
                      })).filter((a) => a.message),
                    }
                  : {}),
              };
            });
            const counts = { success: 0, failure: 0, pending: 0 };
            for (const run of checkRuns) {
              const status = run?.status;
              const conclusion = run?.conclusion;
              if (status === 'queued' || status === 'in_progress') {
                counts.pending += 1;
                continue;
              }
              if (!conclusion) {
                counts.pending += 1;
                continue;
              }
              if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
                counts.success += 1;
              } else {
                counts.failure += 1;
              }
            }
            const total = counts.success + counts.failure + counts.pending;
            const state = counts.failure > 0 ? 'failure' : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
            checks = { state, total, ...counts };
          }
        } catch {
          // ignore and fall back
        }
        if (!checks) {
          try {
            const combined = await octokit.rest.repos.getCombinedStatusForRef({ owner: repo.owner, repo: repo.repo, ref: sha });
            const statuses = Array.isArray(combined?.data?.statuses) ? combined.data.statuses : [];
            const counts = { success: 0, failure: 0, pending: 0 };
            statuses.forEach((s) => {
              if (s.state === 'success') counts.success += 1;
              else if (s.state === 'failure' || s.state === 'error') counts.failure += 1;
              else if (s.state === 'pending') counts.pending += 1;
            });
            const total = counts.success + counts.failure + counts.pending;
            const state = counts.failure > 0 ? 'failure' : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
            checks = { state, total, ...counts };
          } catch {
            checks = null;
          }
        }
      }

      let diff = undefined;
      if (includeDiff) {
        const diffResp = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          headers: { accept: 'application/vnd.github.v3.diff' },
        });
        diff = typeof diffResp?.data === 'string' ? diffResp.data : undefined;
      }

      return res.json({
        connected: true,
        repo,
        pr,
        issueComments,
        reviewComments,
        reviews,
        requestedReviewers,
        files,
        ...(diff ? { diff } : {}),
        checks,
        ...(Array.isArray(checkRunsOut) ? { checkRuns: checkRunsOut } : {}),
      });
    } catch (error) {
      if (error?.status === 401) {
        const { clearGitHubAuth } = await getGitHubLibraries();
        clearGitHubAuth();
        return res.json({ connected: false });
      }
      console.error('Failed to load GitHub PR context:', error);
      return res.status(500).json({ error: error.message || 'Failed to load GitHub PR context' });
    }
  });

  app.get('/api/github/pr/protection', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const baseBranch = typeof req.query?.baseBranch === 'string' ? req.query.baseBranch.trim() : '';
      if (!directory || !baseBranch) {
        return res.status(400).json({ ok: false, error: { code: 'bad_input', message: 'directory and baseBranch are required' } });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ ok: false, error: { code: 'not_authenticated', message: 'GitHub not authenticated' } });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Repo not found' } });
      }

      let protection = null;
      try {
        const protResp = await octokit.rest.repos.getBranchProtection({
          owner: repo.owner,
          repo: repo.repo,
          branch: baseBranch,
        });
        const data = protResp?.data;
        if (data) {
          const requiredStatusChecks = data.required_status_checks
            ? {
                strict: data.required_status_checks.strict,
                contexts: data.required_status_checks.contexts || [],
              }
            : null;
          const requiredReviews = data.required_pull_request_reviews
            ? {
                requiredApprovingReviewCount: data.required_pull_request_reviews.required_approving_review_count || 0,
                dismissStaleReviews: data.required_pull_request_reviews.dismiss_stale_reviews,
                requireCodeOwnerReviews: data.required_pull_request_reviews.require_code_owner_reviews,
              }
            : null;
          protection = {
            enabled: true,
            requiredStatusChecks,
            requiredReviews,
            enforceAdmins: Boolean(data.enforce_admins?.enabled),
          };
        }
      } catch (error) {
        if (error?.status === 404) {
          protection = { enabled: false };
        } else {
          throw error;
        }
      }

      return res.json({ ok: true, data: { protection } });
    } catch (error) {
      console.error('Failed to load branch protection:', error);
      return res.status(500).json({ ok: false, error: { code: 'internal', message: error.message || 'Failed to load branch protection' } });
    }
  });
}
