import os from 'node:os';
import path from 'node:path';
import { createBindingService } from './binding-service.js';
import { createBindingStore } from './binding-storage.js';
import { createChangeRequestWorktreeSource } from './change-request-worktree.js';
import { createGitIdentityProvisioning } from '../git/identity-provisioning.js';
import { createProfile, getProfiles, updateProfile } from '../git/identity-storage.js';
import { resolveRepositoryIdentity } from './repository-identity.js';
import { redactSensitiveText } from './url-redaction.js';
import { createOAuthFlowRegistry } from './oauth-flow-registry.js';
import { createMutationStore } from './mutation-storage.js';
import { createMutationExecutor } from './mutation-executor.js';
import { createSourceControlAuthStore } from './auth-storage.js';
import { createSourceControlProviders } from './provider-registry.js';
import { registerProviderRoutes } from './provider-routes.js';
import { publicProviderDescriptor, sourceControlProviderDescriptors } from './provider-descriptors.js';

const defaultConfigRoot = () => process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const resolveDirectoryQuery = (value) => {
  const directory = Array.isArray(value) ? value[0] : value;
  return Object.prototype.toString.call(directory) === '[object String]' ? directory : '';
};

const sendBindingError = (res, error) => {
  if (error?.code?.startsWith('SOURCE_CONTROL_LOCK_')) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error?.code === 'RUNTIME_UNSUPPORTED') {
    return res.status(501).json({ error: error.message || 'Source control operation is unavailable', code: error.code });
  }
  if (error?.code === 'SOURCE_CONTROL_BINDING_STALE'
    || error?.code === 'SOURCE_CONTROL_BINDING_REPOSITORY_MISMATCH') {
    return res.status(409).json({ error: error.message, code: error.code, current: error.current });
  }
  if (error?.code === 'SOURCE_CONTROL_BINDING_CONFLICT') {
    return res.status(409).json({
      error: 'Source control binding changed',
      code: error.code,
      current: error.current,
    });
  }
  if (error?.code === 'INVALID_SOURCE_CONTROL_BINDING') {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  if (error?.code === 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY') {
    return res.status(422).json({ error: error.message, code: error.code, reason: error.reason });
  }
  console.error('Source control binding request failed:', redactSensitiveText(error?.message));
  return res.status(500).json({ error: 'Source control binding request failed' });
};

/**
 * Registers the source-control module: every provider's routes on the shared
 * shell, the provider and
 * instance lists, and the repository binding routes, then a catch-all so an
 * unknown provider or path under `/api/source-control/` never reaches the
 * OpenCode proxy.
 *
 * `dependencies.providers` is the runtime's provider registry. Without one, a
 * registry is built here over `configRoot`; `dependencies.<provider id>` then
 * holds that provider's construction-time services (its auth store section,
 * fetch, settings reader, test doubles) and its account callbacks.
 */
export function registerSourceControlRoutes(app, dependencies = {}) {
  const configRoot = dependencies.configRoot ?? defaultConfigRoot();
  const providers = dependencies.providers ?? createSourceControlProviders({
    // One server token store: GitLab's origins, GitHub Enterprise hosts, and
    // an origin-keyed section per further provider.
    authStore: createSourceControlAuthStore({ filePath: path.join(configRoot, 'source-control-auth.json') }),
    configRoot,
    hostServices: Object.fromEntries(sourceControlProviderDescriptors.list()
      .map((descriptor) => [descriptor.id, dependencies[descriptor.id] ?? {}])),
  });
  const readTransportAccount = dependencies.readTransportAccount ?? (({
    provider, instance, accountId, credentialRevision,
  }) => providers.readTransportCredential({ provider, instance, credentialId: accountId, credentialRevision }));
  const bindingService = dependencies.bindingService ?? createBindingService({
    store: createBindingStore({ filePath: path.join(configRoot, 'source-control-bindings.json') }),
    resolveRepository: resolveRepositoryIdentity,
    resolveTransportRepository: dependencies.resolveTransportRepository,
    validateManagedSshCredential: dependencies.validateManagedSshCredential,
    readManagedSshCredentialPresentation: dependencies.readManagedSshCredentialPresentation,
    resolveCheckoutAuxiliary: dependencies.resolveCheckoutAuxiliary,
    readTransportAccount,
  });
  // Connecting an account is the moment every part of an identity is known, so
  // the identity is made there instead of being asked for again later.
  const identityProvisioning = dependencies.identityProvisioning ?? createGitIdentityProvisioning({
    store: { createProfile, getProfiles, updateProfile },
  });
  const oauthFlowRegistry = dependencies.oauthFlowRegistry ?? createOAuthFlowRegistry();
  /** Every provider's valid stored accounts; one unreadable provider store leaves its accounts for next time. */
  const listConnectedAccounts = async () => {
    const entries = [];
    for (const descriptor of providers.list()) {
      try {
        const impl = await providers.implementation(descriptor.id);
        entries.push(...(await impl?.auth.listConnectedAccounts?.()) ?? []);
      } catch { /* as above */ }
    }
    return entries;
  };
  /**
   * Identities for accounts connected before identities carried one.
   *
   * Deliberately not run while routes are registered, and deliberately not
   * reaching for the default stores: registering routes must not read, and
   * must not lock, a data directory the caller did not name. The owner of the
   * real stores calls this once the server is up.
   */
  const backfillConnectedIdentities = async () => {
    const entries = (await listConnectedAccounts()).map(({ account, user }) => ({ account, user }));
    try { identityProvisioning.backfillAccountIdentities(entries); }
    catch (error) { console.warn('Failed to backfill Git identities for connected accounts:', error?.message ?? error); }
  };
  const mutationExecutor = dependencies.mutationExecutor ?? createMutationExecutor({
    store: dependencies.mutationStore ?? createMutationStore({
      filePath: path.join(configRoot, 'source-control-mutations.json'),
    }),
    auditStore: dependencies.auditStore,
    runtimeIdentity: dependencies.runtimeIdentity,
  });
  // Signing in again as a new credential leaves bindings on the gone one; the
  // new account takes them over, Git transport grants included, so pushes and
  // fetches keep working without reconfiguring the repository.
  const adoptConnectedAccount = (account, credential) => {
    if (!credential?.providerUserId || !Number.isSafeInteger(credential.credentialRevision)) return;
    // Only who the account is travels on; the credential's secret never does.
    const { credentialRevision, providerUserId } = credential;
    bindingService.accountConnected({ ...account, credentialRevision, providerUserId }).catch((error) => {
      console.warn('Failed to move repository bindings to the connected account:', error?.message ?? error);
    });
  };
  const accountConnected = ({ account, user, renews = [], credential }) => {
    try {
      for (const previous of renews) identityProvisioning.repointAccountIdentities({ from: previous, to: account });
      identityProvisioning.ensureAccountIdentity({ account, user });
    } catch (error) {
      console.warn('Failed to provision a Git identity for the connected account:', error?.message ?? error);
    }
    adoptConnectedAccount(account, credential);
  };
  // Bindings let go of the exact account before the provider changes its store.
  const accountUnavailable = async (identity, callback) => {
    await bindingService.accountUnavailable(identity);
    if (callback) await callback(identity);
  };
  providers.events.subscribe({
    connected: accountConnected,
    invalidated: (identity) => accountUnavailable(identity, dependencies[identity.provider]?.onAccountInvalidated),
    removed: (identity) => accountUnavailable(identity, dependencies[identity.provider]?.onAccountRemoved),
  });
  const shell = registerProviderRoutes(app, {
    providers,
    validateReadContext: bindingService.validateReadContext,
    validateMutationContext: bindingService.validateMutationContext,
    mutationExecutor,
    oauthFlowRegistry,
  });
  /** The instances of one provider the user can work with: its defaults first, then the ones it knows of. */
  const instancesOf = async (descriptor) => {
    const impl = await providers.implementation(descriptor.id);
    const defaults = [...descriptor.instance.defaultInstances];
    const known = (await impl?.auth.listInstances?.()) ?? [];
    return [...new Set([...defaults, ...known])];
  };
  app.get('/api/source-control/providers', (_req, res) => {
    // Built-ins in priority order, then extension providers sorted by id
    // (the facade's order), each marked with the extension that serves it.
    res.json({ providers: providers.list().map((descriptor, order) => publicProviderDescriptor(descriptor, order, descriptor.extension)) });
  });
  // A provider that fails to load or list is named in `unavailableProviders`
  // instead of failing the answer, so the others still list their instances.
  app.get('/api/source-control/instances', async (_req, res) => {
    const instances = [];
    const unavailableProviders = [];
    for (const descriptor of providers.list()) {
      try {
        for (const instance of await instancesOf(descriptor)) instances.push({ provider: descriptor.id, instance });
      } catch (error) {
        unavailableProviders.push(descriptor.id);
        console.warn(`Failed to list ${descriptor.label} instances:`, redactSensitiveText(error?.message));
      }
    }
    return res.json(unavailableProviders.length ? { instances, unavailableProviders } : { instances });
  });
  app.get('/api/source-control/repository-context', async (req, res) => {
    try {
      return res.json(await bindingService.resolveContext(resolveDirectoryQuery(req.query?.directory)));
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  app.get('/api/source-control/binding', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      return res.json(await bindingService.get(resolveDirectoryQuery(req.query?.directory)));
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  app.post('/api/source-control/binding/provider', async (req, res) => {
    try {
      const result = await bindingService.mutateProvider(req.body ?? {});
      return res.json(bindingService.present ? await bindingService.present(result) : result);
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  // A remote grant decides how the repository's own `.git/config` pushes
  // and pulls, so every change to one is followed there.
  // The binding is already committed when `.git/config` is written, so a
  // failure there is reported as a partial result: shell git still uses the
  // previous credentials and the client must not show the change as applied.
  const afterTransportChange = async (directory, read) => {
    if (!(dependencies.onRepositoryTransportChanged instanceof Function)) return true;
    try {
      await dependencies.onRepositoryTransportChanged(directory, read);
      return true;
    } catch (error) {
      console.warn('Repository transport configuration was not updated:', redactSensitiveText(error?.message));
      return false;
    }
  };
  const sendTransportConfigPartial = (res) => res.status(500).json({
    error: 'The repository binding was saved, but its Git configuration could not be updated. Git in a terminal still uses the previous credentials; retry to apply it.',
    code: 'SOURCE_CONTROL_TRANSPORT_CONFIG_PARTIAL',
    committed: true,
  });
  app.post('/api/source-control/binding/transport', async (req, res) => {
    try {
      const result = await bindingService.configureTransportBinding(req.body ?? {});
      if (!await afterTransportChange(req.body?.directory, result)) return sendTransportConfigPartial(res);
      return res.json(bindingService.present ? await bindingService.present(result) : result);
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  app.post('/api/source-control/binding/transport/remove', async (req, res) => {
    try {
      const result = await bindingService.removeTransportBinding(req.body ?? {});
      if (!await afterTransportChange(req.body?.directory, result)) return sendTransportConfigPartial(res);
      return res.json(bindingService.present ? await bindingService.present(result) : result);
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  app.post('/api/source-control/binding/reset', async (req, res) => {
    try {
      const result = await bindingService.resetRepositoryBinding(req.body ?? {});
      if (!await afterTransportChange(req.body?.directory, result)) return sendTransportConfigPartial(res);
      return res.json(result);
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  app.post('/api/source-control/binding/auxiliary', async (req, res) => {
    try {
      const result = await bindingService.configureAuxiliaryBinding(req.body ?? {});
      return res.json(bindingService.present ? await bindingService.present(result) : result);
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  // Extension providers' routers, after every literal route and before the catch-all.
  app.use(shell.extensionDispatcher);
  // Nothing under the module's prefix reaches the OpenCode proxy: an unknown
  // provider or an unregistered path answers here.
  app.use('/api/source-control', (_req, res) => {
    res.status(404).json({ error: 'Source control provider is unavailable', code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' });
  });
  // Bindings left on a gone account before connected accounts took them over
  // are repaired once at start; repeating it changes nothing.
  void (async () => {
    for (const { account, credential } of await listConnectedAccounts()) adoptConnectedAccount(account, credential);
  })().catch((error) => console.warn('Failed to repair repository bindings of connected accounts:', error?.message ?? error));

  return Object.freeze({
    ...bindingService,
    backfillConnectedIdentities,
    /**
     * Serves an extension's Git host (`extension-providers.js` decides when):
     * the registry builds its implementation, the shell mounts its routes,
     * and bindings left on its accounts' earlier credentials move over, as
     * they do for built-ins at start.
     */
    registerExtensionProvider: ({ descriptor, guest }) => {
      providers.registerExtension({ descriptor, guest });
      shell.mountExtension(descriptor);
      void (async () => {
        const impl = await providers.implementation(descriptor.id);
        for (const { account, credential } of (await impl?.auth.listConnectedAccounts()) ?? []) adoptConnectedAccount(account, credential);
      })().catch((error) => console.warn('Failed to repair repository bindings of an extension provider:', redactSensitiveText(error?.message)));
    },
    /** Its routes 404 and bindings naming it answer as an unavailable provider; its accounts stay. */
    unregisterExtensionProvider: (id) => {
      shell.unmountExtension(id);
      providers.unregisterExtension(id);
    },
    // Change request reads for the comparison view, walkthroughs and tracked
    // items; the caller passes a read context it has already validated.
    readChangeRequestPatch: shell.readChangeRequestPatch,
    readChangeRequestFile: shell.readChangeRequestFile,
    readLiveSummaries: shell.readLiveSummaries,
    resolveChangeRequestSource: shell.resolveChangeRequestSource,
    // The Change-Id amend (`POST /api/git/change-id`) rewrites a branch tip.
    invalidateBranchStatus: shell.invalidateBranchStatus,
    // A worktree from a pull or merge request given by number (session.create).
    resolveChangeRequestWorktreeSource: createChangeRequestWorktreeSource({
      readBinding: bindingService.get,
      providers,
      readCurrentAccountId: async ({ provider, instance }) => {
        const impl = await providers.implementation(provider);
        return impl ? impl.auth.readCurrentAccountId({ instance }) : null;
      },
      readChangeRequestHead: shell.readChangeRequestHead,
    }),
  });
}
