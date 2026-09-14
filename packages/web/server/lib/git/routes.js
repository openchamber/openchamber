import { createGitRedactor, redactGitText } from './redaction.js';
import { redactRemoteUrl } from '../source-control/url-redaction.js';
import { parsePublicGitIdentityProfile, toPublicGitIdentityProfile } from './identity-storage.js';

const NETWORK_OPERATION_ID = /^[A-Za-z0-9_-]{1,200}$/;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const toGitIdentitySummary = (identity) => identity ? {
  userName: identity.userName ?? null,
  userEmail: identity.userEmail ?? null,
} : null;
const toGitRemoteSummary = (remote) => ({
  name: String(remote?.name || ''),
  fetchUrl: redactRemoteUrl(remote?.fetchUrl),
  pushUrl: redactRemoteUrl(remote?.pushUrl),
});

export function registerGitRoutes(app, {
  networkOperations, managedSshInventory, getSourceControlBinding, contributorProvenance, resolveChangeRequestSource,
  backfillIdentities,
  createHttpsCredentialReference, resolveSourceControlAccount, errorRedactionSecrets = [], worktreeBootstrapStore,
  emitWorktreeChanged,
} = {}) {
  let gitLibraries = null;
  const getGitLibraries = async () => {
    if (!gitLibraries) {
      gitLibraries = await import('./index.js');
      if (emitWorktreeChanged) {
        gitLibraries.subscribeWorktreeTopologyChanges(emitWorktreeChanged);
      }
    }
    return gitLibraries;
  };

  const resolveDirectoryQuery = (value, preserveWhitespace = false) => {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') {
      return null;
    }
    const normalized = preserveWhitespace ? raw : raw.trim();
    return normalized || null;
  };

  const extractGitErrorText = (error) => {
    const message = typeof error?.message === 'string' ? error.message : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const fallback = !message && error != null ? String(error) : '';
    return [message, stderr, stdout, fallback]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join('\n');
  };

  const isNonRepoGitError = (error) => /not a git repository/i.test(extractGitErrorText(error));

  const nonRepoStatusPayload = () => ({
    isGitRepository: false,
    files: [],
    branch: null,
    ahead: 0,
    behind: 0,
  });

  const sendNetworkOperationError = (req, res, error) => {
    const code = isString(error?.code) ? error.code : 'UNKNOWN';
    const storageFailure = code === 'GIT_NETWORK_OPERATION_STORAGE_INVALID';
    let status = 500;
    if (Number.isInteger(error?.status)) status = error.status;
    else if (code === 'GIT_NETWORK_OPERATION_NOT_FOUND') status = 404;
    else if (!storageFailure && code.includes('INVALID')) status = 400;
    else if (code.includes('STALE') || code.includes('CHANGED') || code.includes('CONFLICT')) status = 409;
    else if (code === 'AUTHENTICATION_REQUIRED') status = 401;
    else if (code === 'ACKNOWLEDGEMENT_REQUIRED') status = 409;
    else if (code === 'DESTINATION_SELECTION_REQUIRED' || code === 'CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED') status = 409;
    else if (code === 'RUNTIME_UNSUPPORTED') status = 501;

    const preservedCodes = [
      'STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED',
      'AUTHENTICATION_REQUIRED', 'ACKNOWLEDGEMENT_REQUIRED', 'TIMEOUT', 'RUNTIME_UNSUPPORTED',
      'DESTINATION_SELECTION_REQUIRED', 'CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED',
    ];
    let publicCode;
    if (code === 'GIT_NETWORK_OPERATION_NOT_FOUND') publicCode = 'NOT_FOUND';
    else if (code === 'SOURCE_CONTROL_BINDING_STALE') publicCode = 'STALE_BINDING';
    else if (code === 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY') publicCode = 'STALE_REPOSITORY';
    else if (code === 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED') publicCode = 'REMOTE_CHANGED';
    if (!publicCode && !storageFailure && code.includes('INVALID')) publicCode = 'INVALID_REQUEST';
    if (!publicCode && preservedCodes.includes(code)) publicCode = code;
    publicCode ??= 'UNKNOWN';
    const requestPaths = [req.body?.directory, req.body?.destinationPath].filter(isString);
    const redactor = createGitRedactor({ secrets: [...errorRedactionSecrets, ...requestPaths] });
    const messages = {
      NOT_FOUND: 'Git network operation was not found',
      INVALID_REQUEST: 'Invalid Git network operation request',
      STALE_REPOSITORY: 'Git repository authority changed',
      STALE_BINDING: 'Source control binding changed',
      STALE_CONFIG: 'Git repository configuration changed',
      REMOTE_CHANGED: 'Git remote or transport binding changed',
      AUTHENTICATION_REQUIRED: 'Git authentication is required',
      ACKNOWLEDGEMENT_REQUIRED: 'System Git transport acknowledgement is required',
      DESTINATION_SELECTION_REQUIRED: 'Contributor push destination selection is required',
      CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED: 'Contributor transfers require managed credentials',
      TIMEOUT: 'Git network operation timed out',
      RUNTIME_UNSUPPORTED: 'Git network operations are unavailable',
      UNKNOWN: 'Git network operation request failed',
    };
    console.error('Git network operation request failed:', redactor.error(error, messages[publicCode]));
    return res.status(status).json({ error: messages[publicCode], code: publicCode });
  };
  const operationId = (req) => isString(req.params?.id) && NETWORK_OPERATION_ID.test(req.params.id)
    ? req.params.id : null;
  const hasEmptyBody = (req) => req.body === undefined
    || (req.body && Object.getPrototypeOf(req.body) === Object.prototype && Object.keys(req.body).length === 0);
  app.post('/api/git/managed-ssh-credentials', async (req, res) => {
    const input = req.body;
    const keys = input?.operation === 'import' ? ['operation', 'candidateId', 'expectedFingerprint', 'confirmed'] : ['operation'];
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || !['inventory', 'discover', 'import'].includes(input.operation)
      || Object.keys(input).length !== keys.length || !keys.every((key) => Object.hasOwn(input, key))
      || (input.operation === 'import' && (input.confirmed !== true || !isString(input.candidateId)
        || !/^[A-Za-z0-9_-]{1,200}$/.test(input.candidateId) || !isString(input.expectedFingerprint)
        || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(input.expectedFingerprint)))) {
      return res.status(400).json({ code: 'INVALID_REQUEST', error: 'Invalid managed SSH inventory request' });
    }
    res.set('Cache-Control', 'no-store');
    if (!managedSshInventory) return res.status(501).json({ code: 'RUNTIME_UNSUPPORTED', error: 'Managed SSH inventory is unavailable' });
    try {
      return res.json(await managedSshInventory[input.operation](input));
    } catch {
      const errors = {
        inventory: 'Managed SSH inventory could not be read',
        discover: 'Managed SSH keys could not be discovered',
        import: 'Managed SSH key could not be imported',
      };
      return res.status(500).json({ code: 'UNKNOWN', error: errors[input.operation] });
    }
  });
  const hasClientContributorAuthority = (body) => body?.contributorFork !== undefined
    || (body?.changeRequestSource && body?.ensureRemoteUrl !== undefined);
  const worktreeInputForSource = (input, source) => ({
    ...input,
    changeRequestSource: undefined,
    contributorFork: source.classification === 'contributor-fork',
    ensureRemoteName: source.requestedRemoteName,
    ensureRemoteUrl: source.endpoint,
    expectedRevision: source.headSha,
  });
  const rejectLegacyNetworkOperation = async (directory, res) => {
    if (contributorProvenance?.read instanceof Function) {
      try {
        const record = await contributorProvenance.read(directory);
        if (record.provenance?.kind === 'contributor-fork') {
          res.status(409).json({
            error: 'Contributor worktrees require an exact managed destination selection',
            code: 'DESTINATION_SELECTION_REQUIRED',
          });
          return true;
        }
      } catch {
        res.status(500).json({ error: 'Failed to verify contributor worktree provenance', code: 'UNKNOWN' });
        return true;
      }
    }
    res.status(409).json({
      error: 'Git network operations require the planned operation API',
      code: 'GIT_NETWORK_OPERATION_REQUIRED',
    });
    return true;
  };

  app.post('/api/git/network-operations', async (req, res) => {
    if (!networkOperations) return res.status(501).json({ error: 'Git network operations are unavailable', code: 'RUNTIME_UNSUPPORTED' });
    try {
      return res.status(201).json(await networkOperations.plan(req.body));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.post('/api/git/contributor-destinations', async (req, res) => {
    if (!(networkOperations?.issueContributorDestination instanceof Function)) {
      return res.status(501).json({ error: 'Contributor destination selection is unavailable', code: 'RUNTIME_UNSUPPORTED' });
    }
    try {
      return res.status(201).json(await networkOperations.issueContributorDestination(req.body));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.get('/api/git/contributor-destinations', async (req, res) => {
    const directory = resolveDirectoryQuery(req.query?.directory);
    if (!directory || !(getSourceControlBinding instanceof Function)
      || !(contributorProvenance?.read instanceof Function)) {
      return res.status(501).json({ error: 'Contributor destination selection is unavailable', code: 'RUNTIME_UNSUPPORTED' });
    }
    try {
      const [record, bindingRead] = await Promise.all([
        contributorProvenance.read(directory), getSourceControlBinding(directory),
      ]);
      if (record.provenance?.kind !== 'contributor-fork') {
        return res.json({ kind: 'ordinary' });
      }
      const binding = bindingRead.binding;
      if (!binding || binding.repositoryId !== record.repositoryId
        || binding.repositoryId !== bindingRead.repository.repositoryId || binding.revision !== bindingRead.revision) {
        return res.status(409).json({ error: 'Contributor push destination selection is required', code: 'DESTINATION_SELECTION_REQUIRED' });
      }
      const accountCache = new Map();
      const accountFor = async (provider) => {
        const key = `${provider.provider}\0${provider.instance}\0${provider.accountId}`;
        if (!accountCache.has(key)) {
          accountCache.set(key, resolveSourceControlAccount instanceof Function
            ? Promise.resolve(resolveSourceControlAccount(provider)).catch(() => null)
            : Promise.resolve(null));
        }
        return accountCache.get(key);
      };
      const currentRemotes = new Map(bindingRead.repository.remotes.map((remote) => [remote.name, remote]));
      const candidates = await Promise.all(binding.remotes
        .filter((remote) => {
          const current = currentRemotes.get(remote.name);
          return remote.mode === 'managed' && remote.credentialId && remote.readiness === 'ready' && current
            && remote.fetch.fingerprint === current.fetch.fingerprint && remote.push.fingerprint === current.push.fingerprint;
        })
        .map(async (remote) => {
          let classification = 'other';
          const providers = binding.providers.filter((provider) => provider.primaryRemote === remote.name
            && provider.readiness === 'ready' && provider.endpoint?.fingerprint === remote.fetch.fingerprint);
          const boundRepository = providers.some((provider) => provider.provider === record.provenance.provider
            && provider.instance === record.provenance.instance
            && provider.accountId === record.provenance.accountId
            && remote.name === record.provenance.primaryRemote);
          if (remote.push.fingerprint === record.provenance.endpointFingerprint) {
            classification = 'contributor-fork';
          } else if (boundRepository) {
            classification = 'bound-repository';
          } else {
            for (const provider of providers) {
              const account = await accountFor(provider);
              const login = String(account?.user?.login || account?.user?.username || '').toLowerCase();
              if (login && provider.repository?.owner?.toLowerCase() === login) {
                classification = 'own-fork';
                break;
              }
            }
          }
          return {
            remote: { name: remote.name, endpoint: remote.push },
            transportMode: 'managed',
            classification,
          };
        }));
      if (!candidates.length) {
        return res.status(409).json({ error: 'Contributor push destination selection is required', code: 'DESTINATION_SELECTION_REQUIRED' });
      }
      return res.json({
        kind: 'contributor',
        repositoryId: binding.repositoryId,
        bindingRevision: binding.revision,
        configRevision: bindingRead.repository.configRevision,
        provenanceRevision: record.revision,
        candidates,
      });
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.get('/api/git/worktrees/checkout-trust', async (req, res) => {
    const directory = resolveDirectoryQuery(req.query?.directory);
    if (!directory || !(contributorProvenance?.read instanceof Function)) {
      return res.status(400).json({ error: 'Contributor worktree is required', code: 'INVALID_REQUEST' });
    }
    try {
      const { inspectContributorCheckoutActions } = await getGitLibraries();
      const record = await contributorProvenance.read(directory);
      if (record.provenance?.kind !== 'contributor-fork') {
        return res.status(409).json({ error: 'Contributor worktree is required', code: 'STALE_CONFIG' });
      }
      const inspection = await inspectContributorCheckoutActions(directory, record.provenance);
      return res.json({
        state: inspection.state,
        digest: inspection.digest,
        actions: inspection.actions.map((action) => ({
          kind: action.kind,
          label: action.kind === 'post-checkout-hook' ? 'post-checkout' : action.command,
        })),
      });
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.post('/api/git/worktrees/checkout-trust', async (req, res) => {
    const directory = resolveDirectoryQuery(req.query?.directory);
    if (!directory || !isString(req.body?.digest) || !['run', 'skip'].includes(req.body?.decision)
      || Object.keys(req.body || {}).some((key) => !['digest', 'decision'].includes(key))) {
      return res.status(400).json({ error: 'Invalid checkout trust decision', code: 'INVALID_REQUEST' });
    }
    try {
      const { inspectContributorCheckoutActions } = await getGitLibraries();
      const record = await contributorProvenance.read(directory);
      if (record.provenance?.kind !== 'contributor-fork') {
        return res.status(409).json({ error: 'Contributor worktree changed', code: 'STALE_CONFIG' });
      }
      const result = await networkOperations.decideCheckoutTrust({
        directory,
        repositoryId: record.repositoryId,
        digest: req.body.digest,
        decision: req.body.decision,
        headSha: record.provenance.sourceSha,
        nullRef: '0'.repeat(40),
        inspect: () => inspectContributorCheckoutActions(directory, record.provenance),
      });
      return res.json(result);
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.post('/api/git/network-operations/:id/execute', async (req, res) => {
    const id = operationId(req);
    if (!id || !hasEmptyBody(req)) return res.status(400).json({ error: 'Invalid Git network operation request', code: 'INVALID_REQUEST' });
    if (!networkOperations) return res.status(501).json({ error: 'Git network operations are unavailable', code: 'RUNTIME_UNSUPPORTED' });
    try {
      return res.json(await networkOperations.execute(id));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.get('/api/git/network-operations/:id', async (req, res) => {
    const id = operationId(req);
    if (!id) return res.status(400).json({ error: 'Invalid Git network operation ID', code: 'INVALID_REQUEST' });
    if (!networkOperations) return res.status(501).json({ error: 'Git network operations are unavailable', code: 'RUNTIME_UNSUPPORTED' });
    try {
      return res.json(await networkOperations.get(id));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.post('/api/git/network-operations/:id/cancel', async (req, res) => {
    const id = operationId(req);
    if (!id || !hasEmptyBody(req)) return res.status(400).json({ error: 'Invalid Git network operation request', code: 'INVALID_REQUEST' });
    if (!networkOperations) return res.status(501).json({ error: 'Git network operations are unavailable', code: 'RUNTIME_UNSUPPORTED' });
    try {
      return res.json(await networkOperations.cancel(id));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  let identitiesBackfilled = false;
  app.get('/api/git/identities', async (req, res) => {
    const { getProfiles } = await getGitLibraries();
    try {
      if (!identitiesBackfilled && backfillIdentities instanceof Function) {
        identitiesBackfilled = true;
        await backfillIdentities();
      }
      const profiles = getProfiles();
      res.set('Cache-Control', 'no-store');
      res.json(profiles.map(toPublicGitIdentityProfile));
    } catch {
      console.error('Failed to list git identity profiles');
      res.status(500).json({ error: 'Failed to list git identity profiles' });
    }
  });

  app.post('/api/git/identities', async (req, res) => {
    const { createProfile } = await getGitLibraries();
    try {
      const profile = createProfile(parsePublicGitIdentityProfile(req.body));
      res.json(toPublicGitIdentityProfile(profile));
    } catch {
      console.error('Failed to create git identity profile');
      res.status(400).json({ error: 'Failed to create git identity profile' });
    }
  });

  app.put('/api/git/identities/:id', async (req, res) => {
    const { updateProfile } = await getGitLibraries();
    try {
      const profile = updateProfile(req.params.id, parsePublicGitIdentityProfile(req.body, req.params.id));
      res.json(toPublicGitIdentityProfile(profile));
    } catch {
      console.error('Failed to update git identity profile');
      res.status(400).json({ error: 'Failed to update git identity profile' });
    }
  });

  app.delete('/api/git/identities/:id', async (req, res) => {
    const { deleteProfile } = await getGitLibraries();
    try {
      deleteProfile(req.params.id);
      res.json({ success: true });
    } catch {
      console.error('Failed to delete git identity profile');
      res.status(400).json({ error: 'Failed to delete git identity profile' });
    }
  });

  app.get('/api/git/global-identity', async (req, res) => {
    const { getGlobalIdentity } = await getGitLibraries();
    try {
      const identity = await getGlobalIdentity();
      res.json(toGitIdentitySummary(identity));
    } catch (error) {
      console.error('Failed to get global git identity:', error);
      res.status(500).json({ error: 'Failed to get global git identity' });
    }
  });

  app.get('/api/git/check', async (req, res) => {
    const { isGitRepository } = await getGitLibraries();
    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const isRepo = await isGitRepository(directory);
      res.json({ isGitRepository: isRepo });
    } catch (error) {
      if (isNonRepoGitError(error)) {
        console.warn('Git check treated non-repository path as not a git repo:', extractGitErrorText(error));
        return res.json({ isGitRepository: false });
      }
      console.error('Failed to check git repository:', error);
      res.status(500).json({ error: 'Failed to check git repository' });
    }
  });

  app.get('/api/git/remote-url', async (req, res) => {
    const { getRemoteUrl } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const remote = req.query.remote || 'origin';

      const url = await getRemoteUrl(directory, remote);
      const displayUrl = url ? redactRemoteUrl(url) : '';
      res.json({ url: displayUrl || null });
    } catch (error) {
      console.error('Failed to get remote url:', error);
      res.status(500).json({ error: 'Failed to get remote url' });
    }
  });

  app.get('/api/git/current-identity', async (req, res) => {
    const { getCurrentIdentity } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const identity = await getCurrentIdentity(directory);
      res.json(toGitIdentitySummary(identity));
    } catch (error) {
      console.error('Failed to get current git identity:', error);
      res.status(500).json({ error: 'Failed to get current git identity' });
    }
  });

  app.get('/api/git/has-local-identity', async (req, res) => {
    const { hasLocalIdentity } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const hasLocal = await hasLocalIdentity(directory);
      res.json({ hasLocalIdentity: hasLocal });
    } catch (error) {
      console.error('Failed to check local git identity:', error);
      res.status(500).json({ error: 'Failed to check local git identity' });
    }
  });

  app.post('/api/git/set-identity', async (req, res) => {
    const { getProfile, setLocalIdentity, clearLocalIdentity, getGlobalIdentity } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const body = req.body;
      const profileId = isPlainObject(body) && Object.keys(body).length === 1 && isString(body.profileId)
        ? body.profileId.trim() : '';
      if (!profileId) {
        return res.status(400).json({ error: 'profileId is required' });
      }

      let profile = null;

      if (profileId === 'global') {
        // The system identity is the absence of an override, not a copy of it:
        // the repository stops naming an author and reads the machine's, which
        // is what keeps it following later changes there. A machine with no
        // author of its own can still say "no override applies here", so this
        // answers with the author it found, or with none.
        await clearLocalIdentity(directory);
        const globalIdentity = await getGlobalIdentity();
        const profile = globalIdentity?.userName && globalIdentity?.userEmail
          ? toPublicGitIdentityProfile({
            id: 'global',
            name: globalIdentity.userName,
            userName: globalIdentity.userName,
            userEmail: globalIdentity.userEmail,
          })
          : null;
        return res.json({ success: true, profile });
      } else {
        profile = getProfile(profileId);
        if (!profile) {
          return res.status(404).json({ error: 'Profile not found' });
        }
      }

      const publicProfile = toPublicGitIdentityProfile(profile);
      await setLocalIdentity(directory, publicProfile);
      res.json({ success: true, profile: publicProfile });
    } catch (error) {
      console.error('Failed to set git identity:', error);
      res.status(500).json({ error: error.message || 'Failed to set git identity' });
    }
  });

  app.get('/api/git/status', async (req, res) => {
    const { getStatus, isGitRepository, observeWorktreeTopology } = await getGitLibraries();

    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const isRepo = await isGitRepository(directory);
      if (!isRepo) {
        return res.json(nonRepoStatusPayload());
      }

      // Clients ask for status while they work in a repository, so this is
      // where an externally added or removed worktree gets noticed. It runs
      // beside the status call and never delays or fails the response.
      void observeWorktreeTopology(directory);

      const mode = req.query.mode === 'light' ? 'light' : undefined;
      const status = await getStatus(directory, { mode });
      res.json(status);
    } catch (error) {
      // Non-repo / GitError must not abort callers that enumerate projects or
      // sessions (e.g. sidebar discovery). Log a warning and continue.
      if (isNonRepoGitError(error)) {
        console.warn('Git status skipped for non-repository path:', extractGitErrorText(error));
        return res.json(nonRepoStatusPayload());
      }
      console.error('Failed to get git status:', error);
      res.status(500).json({ error: error.message || 'Failed to get git status' });
    }
  });

  app.get('/api/git/primary-root', async (req, res) => {
    const { resolvePrimaryWorktreeRoot } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const result = await resolvePrimaryWorktreeRoot(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to resolve git primary root:', error);
      res.status(500).json({ error: error.message || 'Failed to resolve git primary root' });
    }
  });

  app.get('/api/git/toplevel', async (req, res) => {
    const { resolveWorktreeTopLevel } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const result = await resolveWorktreeTopLevel(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to resolve git worktree toplevel:', error);
      res.status(500).json({ error: error.message || 'Failed to resolve git worktree toplevel' });
    }
  });

  app.post('/api/git/commit-summaries', async (req, res) => {
    const { getCommitSummaries } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const result = await getCommitSummaries(directory, req.body?.shas);
      res.json(result);
    } catch (error) {
      console.error('Failed to get git commit summaries:', error);
      res.status(400).json({ error: error.message || 'Failed to get git commit summaries' });
    }
  });

  const handleIntegrateAction = (action, loadHandler) => {
    app.post(`/api/git/integrate/${action}`, async (req, res) => {
      try {
        const handler = await loadHandler();
        const result = await handler(req.body || {});
        res.json(result);
      } catch (error) {
        console.error(`Failed to run git integrate ${action}:`, error);
        res.status(400).json({ error: error.message || `Failed to run git integrate ${action}` });
      }
    });
  };

  handleIntegrateAction('plan', async () => {
    const { computeIntegratePlan } = await getGitLibraries();
    return (body) => computeIntegratePlan(body);
  });

  handleIntegrateAction('conflict-details', async () => {
    const { getIntegrateConflictDetails } = await getGitLibraries();
    return (body) => getIntegrateConflictDetails(body?.tempWorktreePath);
  });

  handleIntegrateAction('cherry-pick-status', async () => {
    const { isCherryPickInProgress } = await getGitLibraries();
    return (body) => isCherryPickInProgress(body?.tempWorktreePath);
  });

  handleIntegrateAction('run', async () => {
    const { integrateWorktreeCommits } = await getGitLibraries();
    return (body) => integrateWorktreeCommits(body?.plan);
  });

  handleIntegrateAction('abort', async () => {
    const { abortIntegrate } = await getGitLibraries();
    return (body) => abortIntegrate(body?.state);
  });

  handleIntegrateAction('continue', async () => {
    const { continueIntegrate } = await getGitLibraries();
    return (body) => continueIntegrate(body?.state);
  });

  app.get('/api/git/diff', async (req, res) => {
    const { getDiff } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const path = req.query.path;
      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const staged = req.query.staged === 'true';
      const context = req.query.context ? parseInt(String(req.query.context), 10) : undefined;

      const diff = await getDiff(directory, {
        path,
        staged,
        contextLines: Number.isFinite(context) ? context : 3,
      });

      res.json({ diff });
    } catch (error) {
      console.error('Failed to get git diff:', error);
      res.status(500).json({ error: error.message || 'Failed to get git diff' });
    }
  });

  app.get('/api/git/file-diff', async (req, res) => {
    const { getFileDiff } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const pathParam = req.query.path;
      if (!pathParam || typeof pathParam !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const staged = req.query.staged === 'true';

      const result = await getFileDiff(directory, {
        path: pathParam,
        staged,
      });

      res.json({
        original: result.original,
        modified: result.modified,
        path: result.path,
        isBinary: Boolean(result.isBinary),
      });
    } catch (error) {
      console.error('Failed to get git file diff:', error);
      res.status(500).json({ error: error.message || 'Failed to get git file diff' });
    }
  });

  app.get('/api/git/range-diff', async (req, res) => {
    const { getRangeDiff } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const base = req.query.base;
      const head = req.query.head;
      if (!base || typeof base !== 'string' || !head || typeof head !== 'string') {
        return res.status(400).json({ error: 'base and head parameters are required' });
      }

      const pathParam = typeof req.query.path === 'string' && req.query.path ? req.query.path : undefined;
      const context = req.query.context ? parseInt(String(req.query.context), 10) : undefined;

      const diff = await getRangeDiff(directory, {
        base,
        head,
        includeWorkingTree: req.query.includeWorkingTree === 'true',
        path: pathParam,
        contextLines: Number.isFinite(context) ? context : 3,
      });

      res.json({ diff });
    } catch (error) {
      console.error('Failed to get git range diff:', error);
      res.status(500).json({ error: error.message || 'Failed to get git range diff' });
    }
  });

  app.get('/api/git/branch-base', async (req, res) => {
    const { getBranchBase } = await getGitLibraries();
    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const branch = resolveDirectoryQuery(req.query.branch);
      if (!branch) {
        return res.status(400).json({ error: 'branch parameter is required' });
      }

      const result = await getBranchBase(directory, branch);
      res.json(result);
    } catch (error) {
      console.error('Failed to get branch base:', error);
      res.status(500).json({ error: error.message || 'Failed to get branch base' });
    }
  });

  app.get('/api/git/range-files', async (req, res) => {
    const { getRangeFiles } = await getGitLibraries();
    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const base = resolveDirectoryQuery(req.query.base);
      const head = resolveDirectoryQuery(req.query.head);
      if (!base || !head) {
        return res.status(400).json({ error: 'base and head parameters are required' });
      }

      const files = await getRangeFiles(directory, { base, head, includeWorkingTree: req.query.includeWorkingTree === 'true' });
      res.json({ files });
    } catch (error) {
      console.error('Failed to get git range files:', error);
      res.status(500).json({ error: error.message || 'Failed to get git range files' });
    }
  });

  app.post('/api/git/revert', async (req, res) => {
    const { revertFile } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path, scope } = req.body || {};
      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await revertFile(directory, path, { scope });
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to revert git file:', error);
      res.status(500).json({ error: error.message || 'Failed to revert git file' });
    }
  });

  app.post('/api/git/stage', async (req, res) => {
    const { stageFiles } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path, paths } = req.body || {};
      const filePaths = Array.isArray(paths) ? paths : [path];
      if (!filePaths.some((value) => typeof value === 'string' && value.trim())) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await stageFiles(directory, filePaths);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to stage git file:', error);
      res.status(500).json({ error: error.message || 'Failed to stage git file' });
    }
  });

  app.post('/api/git/unstage', async (req, res) => {
    const { unstageFiles } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path, paths } = req.body || {};
      const filePaths = Array.isArray(paths) ? paths : [path];
      if (!filePaths.some((value) => typeof value === 'string' && value.trim())) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await unstageFiles(directory, filePaths);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to unstage git file:', error);
      res.status(500).json({ error: error.message || 'Failed to unstage git file' });
    }
  });

  app.post('/api/git/apply-hunk', async (req, res) => {
    const { applyHunk } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path: filePath, patch, action } = req.body || {};
      if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }
      if (typeof patch !== 'string' || !patch.trim()) {
        return res.status(400).json({ error: 'patch is required' });
      }
      if (action !== 'stage' && action !== 'unstage' && action !== 'discard') {
        return res.status(400).json({ error: 'action must be stage, unstage, or discard' });
      }

      await applyHunk(directory, filePath, { patch, action });
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to apply git hunk:', error);
      res.status(500).json({ error: error.message || 'Failed to apply git hunk' });
    }
  });

  app.post('/api/git/pull', async (req, res) => {
    const directory = req.query.directory;
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    await rejectLegacyNetworkOperation(directory, res);
  });

  app.post('/api/git/push', async (req, res) => {
    const directory = req.query.directory;
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    await rejectLegacyNetworkOperation(directory, res);
  });

  app.get('/api/git/stashes', async (req, res) => {
    const { listStashes } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json({ stashes: await listStashes(directory) });
    } catch (error) {
      console.error('Failed to list stashes:', error);
      res.status(500).json({ error: error.message || 'Failed to list stashes' });
    }
  });

  app.post('/api/git/stashes/file-counts', async (req, res) => {
    const { countStashFiles } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json({ counts: await countStashFiles(directory, req.body?.refs) });
    } catch (error) {
      console.error('Failed to count stash files:', error);
      res.status(500).json({ error: error.message || 'Failed to count stash files' });
    }
  });

  app.post('/api/git/stash', async (req, res) => {
    const { stashPush } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await stashPush(directory, req.body));
    } catch (error) {
      console.error('Failed to stash changes:', error);
      res.status(500).json({ error: error.message || 'Failed to stash changes' });
    }
  });

  app.post('/api/git/stash/apply', async (req, res) => {
    const { stashApply } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await stashApply(directory, req.body));
    } catch (error) {
      console.error('Failed to apply stash:', error);
      res.status(500).json({ error: error.message || 'Failed to apply stash' });
    }
  });

  app.post('/api/git/stash/pop', async (req, res) => {
    const { stashPop } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await stashPop(directory, req.body));
    } catch (error) {
      console.error('Failed to pop stash:', error);
      res.status(500).json({ error: error.message || 'Failed to pop stash' });
    }
  });

  app.post('/api/git/stash/drop', async (req, res) => {
    const { stashDrop } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await stashDrop(directory, req.body));
    } catch (error) {
      console.error('Failed to drop stash:', error);
      res.status(500).json({ error: error.message || 'Failed to drop stash' });
    }
  });

  app.post('/api/git/fetch', async (req, res) => {
    const directory = req.query.directory;
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    await rejectLegacyNetworkOperation(directory, res);
  });

  app.get('/api/git/remotes', async (req, res) => {
    const { getRemotes } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const remotes = await getRemotes(directory);
      res.json(remotes.map(toGitRemoteSummary));
    } catch (error) {
      console.error('Failed to get remotes:', error);
      res.status(500).json({ error: error.message || 'Failed to get remotes' });
    }
  });

  app.delete('/api/git/remotes', async (req, res) => {
    const { removeRemote } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const remote = String(req.body?.remote || '').trim();
      if (!remote) {
        return res.status(400).json({ error: 'remote is required' });
      }

      const result = await removeRemote(directory, { remote });
      res.json(result);
    } catch (error) {
      console.error('Failed to remove remote:', error);
      res.status(500).json({ error: error.message || 'Failed to remove remote' });
    }
  });

  app.post('/api/git/rebase', async (req, res) => {
    const { rebase } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await rebase(directory, req.body);
      res.json(result);
    } catch (error) {
      console.error('Failed to rebase:', error);
      res.status(500).json({ error: error.message || 'Failed to rebase' });
    }
  });

  app.post('/api/git/rebase/abort', async (req, res) => {
    const { abortRebase } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await abortRebase(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to abort rebase:', error);
      res.status(500).json({ error: error.message || 'Failed to abort rebase' });
    }
  });

  app.post('/api/git/merge', async (req, res) => {
    const { merge } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await merge(directory, req.body);
      res.json(result);
    } catch (error) {
      console.error('Failed to merge:', error);
      res.status(500).json({ error: error.message || 'Failed to merge' });
    }
  });

  app.post('/api/git/merge/abort', async (req, res) => {
    const { abortMerge } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await abortMerge(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to abort merge:', error);
      res.status(500).json({ error: error.message || 'Failed to abort merge' });
    }
  });

  app.post('/api/git/rebase/continue', async (req, res) => {
    const { continueRebase } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await continueRebase(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to continue rebase:', error);
      res.status(500).json({ error: error.message || 'Failed to continue rebase' });
    }
  });

  app.post('/api/git/merge/continue', async (req, res) => {
    const { continueMerge } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await continueMerge(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to continue merge:', error);
      res.status(500).json({ error: error.message || 'Failed to continue merge' });
    }
  });

  app.get('/api/git/conflict-details', async (req, res) => {
    const { getConflictDetails } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await getConflictDetails(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to get conflict details:', error);
      res.status(500).json({ error: error.message || 'Failed to get conflict details' });
    }
  });

  app.post('/api/git/commit', async (req, res) => {
    const { commit } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { message, addAll, files, stageFiles } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }

      const result = await commit(directory, message, {
        addAll,
        files,
        stageFiles,
      });
      res.json(result);
    } catch (error) {
      console.error('Failed to commit:', error);
      res.status(500).json({ error: error.message || 'Failed to create commit' });
    }
  });

  app.get('/api/git/branches', async (req, res) => {
    const { getBranches } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const branches = await getBranches(directory);
      res.json(branches);
    } catch (error) {
      console.error('Failed to get branches:', error);
      res.status(500).json({ error: error.message || 'Failed to get branches' });
    }
  });

  app.post('/api/git/branch-push-status', async (req, res) => {
    const { getUnpushedBranchCounts } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      const branches = req.body?.branches;
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      if (!Array.isArray(branches) || branches.some((branch) => typeof branch !== 'string')) {
        return res.status(400).json({ error: 'branches must be an array of branch names' });
      }
      res.json(await getUnpushedBranchCounts(directory, branches));
    } catch (error) {
      console.error('Failed to get branch push status:', error);
      res.status(500).json({ error: error.message || 'Failed to get branch push status' });
    }
  });

  app.post('/api/git/branches', async (req, res) => {
    const { createBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { name, startPoint } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      const result = await createBranch(directory, name, { startPoint });
      res.json(result);
    } catch (error) {
      console.error('Failed to create branch:', error);
      res.status(500).json({ error: error.message || 'Failed to create branch' });
    }
  });

  app.delete('/api/git/branches', async (req, res) => {
    const { deleteBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch, force } = req.body;
      if (!branch) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await deleteBranch(directory, branch, { force });
      res.json(result);
    } catch (error) {
      console.error('Failed to delete branch:', error);
      res.status(500).json({ error: error.message || 'Failed to delete branch' });
    }
  });


  app.put('/api/git/branches/rename', async (req, res) => {
    const { renameBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { oldName, newName } = req.body;
      if (!oldName) {
        return res.status(400).json({ error: 'oldName is required' });
      }
      if (!newName) {
        return res.status(400).json({ error: 'newName is required' });
      }

      const result = await renameBranch(directory, oldName, newName);
      res.json(result);
    } catch (error) {
      console.error('Failed to rename branch:', error);
      res.status(500).json({ error: error.message || 'Failed to rename branch' });
    }
  });
  app.delete('/api/git/remote-branches', async (req, res) => {
    const directory = req.query.directory;
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    await rejectLegacyNetworkOperation(directory, res);
  });

  app.post('/api/git/checkout', async (req, res) => {
    const { checkoutBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch } = req.body;
      if (!branch) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await checkoutBranch(directory, branch);
      res.json(result);
    } catch (error) {
      console.error('Failed to checkout branch:', error);
      res.status(500).json({ error: error.message || 'Failed to checkout branch' });
    }
  });

  app.post('/api/git/checkout-commit', async (req, res) => {
    const { checkoutCommit } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash } = req.body;
      if (!req.body.hash || typeof req.body.hash !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(req.body.hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      const result = await checkoutCommit(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to checkout commit:', error);
      res.status(500).json({ error: error.message || 'Failed to checkout commit' });
    }
  });

  app.post('/api/git/cherry-pick', async (req, res) => {
    const { cherryPick } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash } = req.body;
      if (!req.body.hash || typeof req.body.hash !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(req.body.hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      const result = await cherryPick(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to cherry-pick:', error);
      res.status(500).json({ error: error.message || 'Failed to cherry-pick' });
    }
  });

  app.post('/api/git/revert-commit', async (req, res) => {
    const { revertCommit } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash } = req.body;
      if (!req.body.hash || typeof req.body.hash !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(req.body.hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      const result = await revertCommit(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to revert commit:', error);
      res.status(500).json({ error: error.message || 'Failed to revert commit' });
    }
  });

  app.post('/api/git/reset-to-commit', async (req, res) => {
    const { resetToCommit } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash, mode, force } = req.body;
      if (!req.body.hash || typeof req.body.hash !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(req.body.hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      if (!['soft', 'mixed', 'hard'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be soft, mixed, or hard' });
      }
      const result = await resetToCommit(directory, hash, mode, force === true);
      res.json(result);
    } catch (error) {
      console.error('Failed to reset to commit:', error);
      res.status(500).json({ error: error.message || 'Failed to reset' });
    }
  });

  app.get('/api/git/worktrees', async (req, res) => {
    const { getWorktrees, observeWorktreeTopology } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const worktrees = await getWorktrees(directory);
      if (contributorProvenance?.readMany instanceof Function) {
        const records = await contributorProvenance.readMany(worktrees.map((worktree) => worktree.path));
        for (let index = 0; index < worktrees.length; index += 1) {
          const worktree = worktrees[index];
          const record = records[index];
          if (record.provenance?.kind === 'contributor-fork') {
            worktree.provenance = {
              kind: 'contributor-fork', revision: record.revision,
              trust: 'untrusted', push: 'destination-selection-required',
            };
          }
        }
      }
      // A repository always lists at least its primary worktree; an empty
      // list means "not a repository" and has no topology to track.
      if (worktrees.length > 0) {
        void observeWorktreeTopology(directory);
      }
      res.json(worktrees);
    } catch (error) {
      if (error?.code === 'CONTRIBUTOR_PROVENANCE_STORE_INVALID') {
        return res.status(500).json({ error: 'Failed to verify contributor worktree provenance', code: 'UNKNOWN' });
      }
      // A directory outside any repository still answers `[]` from getWorktrees.
      // Anything else is a real failure the client must not mistake for "no
      // worktrees", or it would drop the ones it already knows.
      console.error('Failed to get worktrees:', error);
      res.status(500).json({ error: error.message || 'Failed to get worktrees' });
    }
  });

  app.post('/api/git/worktrees/validate', async (req, res) => {
    const { validateWorktreeCreate } = await getGitLibraries();
    if (typeof validateWorktreeCreate !== 'function') {
      return res.status(501).json({ error: 'Worktree validation is not available' });
    }

    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      if (hasClientContributorAuthority(req.body)) {
        return res.status(400).json({ error: 'Invalid contributor worktree request', code: 'INVALID_CONTRIBUTOR_WORKTREE' });
      }
      let input = req.body || {};
      if (input.changeRequestSource) {
        if (!(resolveChangeRequestSource instanceof Function)) return res.status(501).json({ error: 'Contributor worktrees are unavailable', code: 'RUNTIME_UNSUPPORTED' });
        const source = await resolveChangeRequestSource(input.changeRequestSource);
        input = worktreeInputForSource(input, source);
      }
      const result = await validateWorktreeCreate(directory, input);
      res.json(result);
    } catch (error) {
      console.error('Failed to validate worktree creation:', error);
      res.status(500).json({ error: error.message || 'Failed to validate worktree creation' });
    }
  });

  app.post('/api/git/worktrees', async (req, res) => {
    const { createWorktree, validateWorktreeCreate } = await getGitLibraries();
    if (typeof createWorktree !== 'function' || typeof validateWorktreeCreate !== 'function') {
      return res.status(501).json({ error: 'Worktree creation is not available' });
    }
    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      if (hasClientContributorAuthority(req.body)) {
        return res.status(400).json({ error: 'Invalid contributor worktree request', code: 'INVALID_CONTRIBUTOR_WORKTREE' });
      }
      if (!(networkOperations?.hydrateBoundCheckout instanceof Function)
        || !(worktreeBootstrapStore?.read instanceof Function)
        || !(worktreeBootstrapStore?.write instanceof Function)) {
        return res.status(501).json({ error: 'Worktree checkout bootstrap is not available' });
      }
      let input = req.body || {};
      let source = null;
      if (input.changeRequestSource) {
        if (!(resolveChangeRequestSource instanceof Function)
          || !(createHttpsCredentialReference instanceof Function)
          || !(resolveSourceControlAccount instanceof Function)
          || !(networkOperations?.transferContributorHead instanceof Function)) {
          return res.status(501).json({ error: 'Contributor worktrees are unavailable', code: 'RUNTIME_UNSUPPORTED' });
        }
        source = await resolveChangeRequestSource(input.changeRequestSource);
        const headBranch = source.headRef.slice('refs/heads/'.length);
        const destinationRef = `refs/remotes/${source.requestedRemoteName}/${headBranch}`;
        input = {
          ...worktreeInputForSource(input, source),
          existingBranch: destinationRef.slice('refs/'.length),
          setUpstream: false,
        };
        const validation = await validateWorktreeCreate(directory, input);
        if (!validation.ok && !validation.errors.every((entry) => entry.code === 'contributor_transfer_unavailable')) {
          return res.status(409).json(validation);
        }
        const account = await resolveSourceControlAccount(source.context);
        if (account?.credentialId !== source.context.accountId || account?.status !== 'valid'
          || !Number.isSafeInteger(account?.credentialRevision) || account.credentialRevision < 1
          || Object.prototype.toString.call(account?.providerUserId) !== '[object String]' || !account.providerUserId) {
          throw Object.assign(new Error('Contributor credential is unavailable'), { code: 'AUTHENTICATION_REQUIRED', status: 409 });
        }
        const credentialId = createHttpsCredentialReference({
          provider: source.context.provider,
          instance: source.context.instance,
          credentialId: account.credentialId,
          credentialRevision: account.credentialRevision,
          providerUserId: account.providerUserId,
        });
        const transfer = await networkOperations.transferContributorHead({
          directory,
          sourceRequest: req.body.changeRequestSource,
          source,
          destinationRef,
          credentialId,
        });
        if (transfer.state !== 'succeeded') {
          const status = transfer.error?.code === 'AUTHENTICATION_REQUIRED' ? 401 : 409;
          return res.status(status).json({ error: transfer.error?.message || 'Contributor head transfer failed', code: transfer.error?.code || 'UNKNOWN' });
        }
        input.contributorTransferComplete = true;
      }
      const bindingRead = getSourceControlBinding instanceof Function
        ? await getSourceControlBinding(directory)
        : null;
      const repositoryAuthority = bindingRead?.binding ? {
        repositoryId: bindingRead.repository.repositoryId,
        bindingRevision: bindingRead.revision,
        configRevision: bindingRead.repository.configRevision,
      } : null;
      const hydrateCheckout = ({ directory: checkoutDirectory, parentRemoteName }) => networkOperations.hydrateBoundCheckout({
        directory: checkoutDirectory,
        parentRemoteName,
        parentEndpoint: source?.endpoint,
        repositoryAuthority,
      });
      const created = await createWorktree(directory, input, {
        contributorProvenance,
        contributorSource: source,
        hydrateCheckout,
        bootstrapStore: worktreeBootstrapStore,
      });
      res.json(created);
    } catch (error) {
      console.error('Failed to create worktree:', error);
      if (error?.code === 'CONTRIBUTOR_REMOTE_COLLISION') {
        return res.status(409).json({
          error: 'Contributor remote name is already used by a different endpoint',
          code: 'CONTRIBUTOR_REMOTE_COLLISION',
          remoteName: error.remoteName,
        });
      }
      res.status(Number.isInteger(error?.status) ? error.status : 500).json({
        error: error.message || 'Failed to create worktree',
        code: error?.code,
      });
    }
  });

  app.post('/api/git/worktrees/preview', async (req, res) => {
    const { previewWorktreeCreate } = await getGitLibraries();
    if (typeof previewWorktreeCreate !== 'function') {
      return res.status(501).json({ error: 'Worktree preview is not available' });
    }

    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const preview = await previewWorktreeCreate(directory, req.body || {});
      res.json(preview);
    } catch (error) {
      console.error('Failed to preview worktree:', error);
      res.status(500).json({ error: error.message || 'Failed to preview worktree' });
    }
  });

  app.get('/api/git/worktrees/bootstrap-status', async (req, res) => {
    const { getWorktreeBootstrapStatus } = await getGitLibraries();
    if (typeof getWorktreeBootstrapStatus !== 'function') {
      return res.status(501).json({ error: 'Worktree bootstrap status is not available' });
    }

    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!(worktreeBootstrapStore?.read instanceof Function)
        || !(worktreeBootstrapStore?.write instanceof Function)) {
        return res.status(501).json({ error: 'Worktree bootstrap storage is not available' });
      }

      const status = await getWorktreeBootstrapStatus(directory, { bootstrapStore: worktreeBootstrapStore });
      res.json(status);
    } catch (error) {
      console.error('Failed to get worktree bootstrap status:', error);
      res.status(500).json({ error: error.message || 'Failed to get worktree bootstrap status' });
    }
  });

  app.delete('/api/git/worktrees', async (req, res) => {
    const { removeWorktree } = await getGitLibraries();
    if (typeof removeWorktree !== 'function') {
      return res.status(501).json({ error: 'Worktree removal is not available' });
    }

    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const worktreeDirectory = typeof req.body?.directory === 'string' ? req.body.directory : '';
      if (!worktreeDirectory) {
        return res.status(400).json({ error: 'worktree directory is required' });
      }
      if (!(worktreeBootstrapStore?.remove instanceof Function)) {
        return res.status(501).json({ error: 'Worktree bootstrap storage is not available' });
      }

      const result = await removeWorktree(directory, {
        directory: worktreeDirectory,
        deleteLocalBranch: req.body?.deleteLocalBranch === true,
      }, {
        bootstrapStore: worktreeBootstrapStore,
      });
      res.json({ success: Boolean(result) });
    } catch (error) {
      console.error('Failed to remove worktree:', error);
      res.status(500).json({ error: error.message || 'Failed to remove worktree' });
    }
  });

  app.get('/api/git/worktree-type', async (req, res) => {
    const { isLinkedWorktree } = await getGitLibraries();
    try {
      const { directory } = req.query;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const linked = await isLinkedWorktree(directory);
      res.json({ linked });
    } catch (error) {
      console.error('Failed to determine worktree type:', error);
      res.status(500).json({ error: error.message || 'Failed to determine worktree type' });
    }
  });

  app.post('/api/git/validate-directory', async (req, res) => {
    const { validateWorktreeDirectory } = await getGitLibraries();
    if (typeof validateWorktreeDirectory !== 'function') {
      return res.status(501).json({ error: 'validateWorktreeDirectory is not available' });
    }
    try {
      const { directory, worktreeRoot } = req.body || {};
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }
      if (!worktreeRoot || typeof worktreeRoot !== 'string') {
        return res.status(400).json({ error: 'worktreeRoot is required' });
      }
      const result = await validateWorktreeDirectory(directory, worktreeRoot);
      res.json(result);
    } catch (error) {
      console.error('Failed to validate worktree directory:', error);
      res.status(500).json({ error: error.message || 'Failed to validate worktree directory' });
    }
  });

  app.post('/api/git/canonicalize-worktree-state', async (req, res) => {
    const { canonicalizeWorktreeState } = await getGitLibraries();
    if (typeof canonicalizeWorktreeState !== 'function') {
      return res.status(501).json({ error: 'canonicalizeWorktreeState is not available' });
    }
    try {
      const { directory } = req.body || {};
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }
      const result = await canonicalizeWorktreeState(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to canonicalize worktree state:', error);
      res.status(500).json({ error: error.message || 'Failed to canonicalize worktree state' });
    }
  });

  app.get('/api/git/log', async (req, res) => {
    const { getLog } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { maxCount, from, to, file } = req.query;
      const all = req.query.all === 'true';
      const log = await getLog(directory, {
        maxCount: maxCount ? parseInt(maxCount) : undefined,
        from,
        to,
        file,
        all
      });
      res.json(log);
    } catch (error) {
      console.error('Failed to get log:', error);
      res.status(500).json({ error: error.message || 'Failed to get commit log' });
    }
  });

  app.get('/api/git/commit-files', async (req, res) => {
    const { getCommitFiles } = await getGitLibraries();
    try {
      const { directory, hash } = req.query;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!hash) {
        return res.status(400).json({ error: 'hash parameter is required' });
      }

      const result = await getCommitFiles(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to get commit files:', error);
      res.status(500).json({ error: error.message || 'Failed to get commit files' });
    }
  });

  app.get('/api/git/commit-diff', async (req, res) => {
    const { getCommitDiff } = await getGitLibraries();
    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      const hash = resolveDirectoryQuery(req.query.hash);
      if (!directory || !hash) return res.status(400).json({ error: 'directory and hash are required' });
      const context = Number(req.query.context ?? 3);
      const diff = await getCommitDiff(directory, {
        hash,
        path: resolveDirectoryQuery(req.query.path, true) ?? undefined,
        previousPath: resolveDirectoryQuery(req.query.previousPath, true) ?? undefined,
        contextLines: Number.isFinite(context) ? context : 3,
      });
      res.json({ diff });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to get commit diff' });
    }
  });

  app.get('/api/git/commit-file-diff', async (req, res) => {
    const { getCommitFileDiff } = await getGitLibraries();
    try {
      const { directory, hash, path: filePath } = req.query;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!hash || typeof hash !== 'string') {
        return res.status(400).json({ error: 'hash parameter is required' });
      }
      if (!/^[0-9a-fA-F]{7,40}$/.test(hash)) {
        return res.status(400).json({ error: 'hash must be a valid commit SHA' });
      }
      if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const isBinary = req.query.binary === 'true';
      const result = await getCommitFileDiff(directory, hash, filePath, isBinary);
      res.json(result);
    } catch (error) {
      console.error('Failed to get commit file diff:', error);
      res.status(500).json({ error: error.message || 'Failed to get commit file diff' });
    }
  });

}
