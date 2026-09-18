import os from 'node:os';
import path from 'node:path';
import { registerGitHubRoutes } from '../github/routes.js';
import { registerGitLabRoutes } from '../gitlab/routes.js';
import { createBindingService } from './binding-service.js';
import { createBindingStore } from './binding-storage.js';
import { createGitIdentityProvisioning } from '../git/identity-provisioning.js';
import * as gitIdentityStore from '../git/identity-storage.js';
import { resolveRepositoryIdentity } from './repository-identity.js';
import { redactSensitiveText } from './url-redaction.js';
import { createOAuthFlowRegistry } from './oauth-flow-registry.js';
import { createMutationStore } from './mutation-storage.js';
import { createMutationExecutor } from './mutation-executor.js';
import { createSourceControlAuthStore } from '../gitlab/auth-storage.js';
import { getGitHubAuthAccounts, getGitHubAuthByAccountId } from '../github/auth.js';

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

export function registerSourceControlRoutes(app, dependencies = {}) {
  const configRoot = dependencies.configRoot ?? defaultConfigRoot();
  const gitlabStore = dependencies.gitlab?.store ?? createSourceControlAuthStore({
    filePath: path.join(configRoot, 'source-control-auth.json'),
  });
  const readTransportAccount = dependencies.readTransportAccount ?? (({
    provider, instance, accountId, credentialRevision,
  }) => provider === 'github'
    ? getGitHubAuthByAccountId(accountId, credentialRevision)
    : gitlabStore.readAccount(instance, accountId, credentialRevision));
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
    store: gitIdentityStore,
  });
  const listGitHubAccounts = dependencies.listGitHubAccounts ?? getGitHubAuthAccounts;
  const oauthFlowRegistry = dependencies.oauthFlowRegistry ?? createOAuthFlowRegistry();
  /**
   * Identities for accounts connected before identities carried one.
   *
   * Deliberately not run while routes are registered, and deliberately not
   * reaching for the default stores: registering routes must not read, and
   * must not lock, a data directory the caller did not name. The owner of the
   * real stores calls this once the server is up.
   */
  const backfillConnectedIdentities = async () => {
    const entries = [];
    try {
      for (const account of await listGitHubAccounts()) {
        if (account?.status === 'valid' && account.id) {
          entries.push({ account: { provider: 'github', instance: 'github.com', accountId: account.id }, user: account.user });
        }
      }
    } catch { /* an unreadable provider store leaves its accounts for next time */ }
    try {
      for (const origin of await gitlabStore.listInstances()) {
        const instance = await gitlabStore.readInstance(origin);
        for (const account of instance?.accounts ?? []) {
          if (account?.status === 'valid' && account.id) {
            entries.push({ account: { provider: 'gitlab', instance: origin, accountId: account.id }, user: account.user });
          }
        }
      }
    } catch { /* as above */ }
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
  const accountUnavailable = async (identity, callback) => {
    await bindingService.accountUnavailable(identity);
    if (callback) await callback(identity);
  };
  const github = registerGitHubRoutes(app, {
    ...dependencies.github,
    oauthFlowRegistry,
    onAccountConnected: ({ account, user, renews = [] }) => {
      try {
        for (const previous of renews) identityProvisioning.repointAccountIdentities({ from: previous, to: account });
        identityProvisioning.ensureAccountIdentity({ account, user });
      } catch (error) {
        console.warn('Failed to provision a Git identity for the connected account:', error?.message ?? error);
      }
    },
    onAccountInvalidated: (identity) => accountUnavailable(identity, dependencies.github?.onAccountInvalidated),
    onAccountRemoved: (identity) => accountUnavailable(identity, dependencies.github?.onAccountRemoved),
    validateReadContext: bindingService.validateReadContext,
    validateMutationContext: bindingService.validateMutationContext,
    mutationExecutor,
  });
  const gitlab = registerGitLabRoutes(app, {
    ...dependencies.gitlab,
    store: gitlabStore,
    oauthFlowRegistry,
    onAccountConnected: ({ account, user, renews = [] }) => {
      try {
        for (const previous of renews) identityProvisioning.repointAccountIdentities({ from: previous, to: account });
        identityProvisioning.ensureAccountIdentity({ account, user });
      } catch (error) {
        console.warn('Failed to provision a Git identity for the connected account:', error?.message ?? error);
      }
    },
    onAccountInvalidated: (identity) => accountUnavailable(identity, dependencies.gitlab?.onAccountInvalidated),
    onAccountRemoved: (identity) => accountUnavailable(identity, dependencies.gitlab?.onAccountRemoved),
    validateReadContext: bindingService.validateReadContext,
    validateMutationContext: bindingService.validateMutationContext,
    mutationExecutor,
  });
  app.get('/api/source-control/instances', async (_req, res) => {
    try {
      const configuredGitLabInstances = await gitlab.listInstances();
      return res.json({
        instances: [
          { provider: 'github', instance: 'github.com' },
          { provider: 'gitlab', instance: 'https://gitlab.com' },
          ...configuredGitLabInstances
            .filter((instance) => instance !== 'https://gitlab.com')
            .map((instance) => ({ provider: 'gitlab', instance })),
        ],
      });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to list source control instances' });
    }
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
  app.post('/api/source-control/binding/transport', async (req, res) => {
    try {
      const result = await bindingService.configureTransportBinding(req.body ?? {});
      return res.json(bindingService.present ? await bindingService.present(result) : result);
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  app.post('/api/source-control/binding/transport/remove', async (req, res) => {
    try {
      const result = await bindingService.removeTransportBinding(req.body ?? {});
      return res.json(bindingService.present ? await bindingService.present(result) : result);
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  app.post('/api/source-control/binding/reset', async (req, res) => {
    try {
      return res.json(await bindingService.resetRepositoryBinding(req.body ?? {}));
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
  return Object.freeze({
    ...bindingService,
    backfillConnectedIdentities,
    resolveChangeRequestSource: async (input) => {
      const provider = input?.context?.provider;
      if (provider === 'github') return github.resolveChangeRequestSource(input);
      if (provider === 'gitlab') return gitlab.resolveChangeRequestSource(input);
      throw Object.assign(new Error('Change request source provider is invalid'), {
        code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400,
      });
    },
  });
}
