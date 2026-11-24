import os from 'node:os';
import path from 'node:path';
import { createBindingService } from './binding-service.js';
import { createBindingStore } from './binding-storage.js';
import { createChangeRequestWorktreeSource } from './change-request-worktree.js';
import { createGitIdentityProvisioning } from '../git/identity-provisioning.js';
import { createProfile, getProfiles, updateProfile } from '../git/identity-storage.js';
import { resolveRepositoryIdentity } from './repository-identity.js';
import { redactSensitiveText } from './url-redaction.js';
import { isPlainObject, isString } from '../shared/guards.js';
import { createOAuthFlowRegistry } from './oauth-flow-registry.js';
import { createMutationStore } from './mutation-storage.js';
import { createMutationExecutor } from './mutation-executor.js';
import { createSourceControlAuthStore } from './auth-storage.js';
import {
  MAX_INSTANCE_ALIASES, createInstanceAliasStore, instanceHostname, normalizeInstanceAlias,
} from './instance-aliases.js';
import { createSourceControlProviders } from './provider-registry.js';
import { registerProviderRoutes } from './provider-routes.js';
import { publicProviderDescriptor } from './provider-descriptors.js';
import type { QueryValue, Request, Response, Router } from '../shared/http-contracts.js';
import type { AccountIdentity, ConnectedAccount, ProviderDescriptor, ProviderId } from './provider-contract.js';
import type { AccountEventPayloads, BuiltInHostServices } from './provider-registry.js';
import type { BindingIntentRequest, BindingRead, BindingServiceOptions } from './binding-service-contracts.js';
import type { InstanceAliasSnapshot } from './instance-aliases.js';
import type { AuditRuntime, createSourceControlAuditStore } from './audit-storage.js';

type BindingService = ReturnType<typeof createBindingService>;
type ProviderRouteOptions = Parameters<typeof registerProviderRoutes>[1];
type TransportAccountLookup = NonNullable<BindingServiceOptions['readTransportAccount']>;
type Invalidation = AccountEventPayloads['invalidated'];
interface ProviderAccountCallbacks {
  onAccountInvalidated?(identity: Invalidation): void | Promise<void>;
  onAccountRemoved?(identity: AccountIdentity): void | Promise<void>;
}
type ProviderDependencies = {
  readonly [Id in keyof BuiltInHostServices]?: NonNullable<BuiltInHostServices[Id]> & ProviderAccountCallbacks;
};
export type SourceControlRouteOptions = ProviderDependencies
  & Pick<ProviderRouteOptions, 'onMutationSucceeded' | 'onMutationStarting' | 'mutationExecutor' | 'oauthFlowRegistry'>
  & Pick<BindingServiceOptions, 'resolveTransportRepository' | 'validateManagedSshCredential' | 'readManagedSshCredentialPresentation' | 'resolveCheckoutAuxiliary'>
  & {
    configRoot?: string;
    providers?: ReturnType<typeof createSourceControlProviders>;
    bindingService?: BindingService;
    mutationStore?: ReturnType<typeof createMutationStore>;
    identityProvisioning?: ReturnType<typeof createGitIdentityProvisioning>;
    auditStore?: ReturnType<typeof createSourceControlAuditStore>;
    runtimeIdentity?: AuditRuntime;
    instanceAliasStore?: ReturnType<typeof createInstanceAliasStore>;
    readTransportAccount?: TransportAccountLookup;
    onRepositoryTransportChanged?(directory: BindingIntentRequest['directory'], read: BindingRead): void | Promise<void>;
  };
type Aliases = InstanceAliasSnapshot['providers'];
interface ListedInstance {
  provider: ProviderId; instance: string; instanceSshUrl?: string; instanceAliases?: string[];
}
interface BindingFailure {
  code?: unknown; message?: unknown; status?: unknown; current?: unknown; reason?: unknown; alias?: unknown;
}
const hasErrorFields = (value: unknown): value is BindingFailure => value != null;
const hasProviderEntry = <Options extends object>(options: Options, key: string): options is Options & Record<string, unknown> => key in options;
const hasCallbackFields = (value: unknown): value is { onAccountInvalidated?: unknown; onAccountRemoved?: unknown } => value != null;
const isAccountCallback = (value: unknown): value is (identity: Invalidation) => void | Promise<void> => typeof value === 'function';
const errorFields = (cause: unknown): BindingFailure => hasErrorFields(cause) ? cause : {};
const hasCodeMethod = (value: unknown): value is { startsWith?: unknown } => value != null;
const isPrefixMethod = (value: unknown): value is (prefix: string) => BindingFailure['code'] => typeof value === 'function';
const isLockCode = (code: BindingFailure['code']) => {
  if (!hasCodeMethod(code)) return false;
  const method = code.startsWith;
  if (!isPrefixMethod(method)) throw new TypeError('error?.code?.startsWith is not a function');
  return Boolean(method.call(code, 'SOURCE_CONTROL_LOCK_'));
};
const bodyDirectory = (body: Request['body']) => {
  const hasDirectory = (value: unknown): value is { directory?: unknown } => value != null;
  return hasDirectory(body) ? body.directory : undefined;
};

const defaultConfigRoot = () => process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const resolveDirectoryQuery = (value: QueryValue | undefined): QueryValue | undefined => {
  const directory = Array.isArray(value) ? value[0] : value;
  return Object.prototype.toString.call(directory) === '[object String]' ? directory : '';
};

const sendBindingError = (res: Response, cause: unknown) => {
  const error = errorFields(cause);
  if (isLockCode(error.code)) {
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

export function registerSourceControlRoutes(app: Router, dependencies: SourceControlRouteOptions = {}) {
  const configRoot = dependencies.configRoot ?? defaultConfigRoot();
  const callbacksFor = (provider: ProviderId) => {
    const entry = hasProviderEntry(dependencies, provider) ? dependencies[provider] : undefined;
    return hasCallbackFields(entry) ? entry : undefined;
  };
  const providers = dependencies.providers ?? createSourceControlProviders({
    authStore: createSourceControlAuthStore({ filePath: path.join(configRoot, 'source-control-auth.json') }),
    configRoot,
    hostServices: {
      github: dependencies.github ?? {},
      gitlab: dependencies.gitlab ?? {},
      gitea: dependencies.gitea ?? {},
      gerrit: dependencies.gerrit ?? {},
      forgejo: dependencies.forgejo ?? {},
    },
  });
  const readTransportAccount: TransportAccountLookup = dependencies.readTransportAccount ?? (({
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
    readProviderSshUrl: async ({ provider, instance }) => {
      try {
        if (!isString(provider) || !isString(instance)) return null;
        const impl = await providers.implementation(provider);
        return (await impl?.auth?.readSshUrl?.({ instance })) ?? null;
      } catch {
        return null;
      }
    },
  });
  const identityProvisioning = dependencies.identityProvisioning ?? createGitIdentityProvisioning({
    store: { createProfile, getProfiles, updateProfile },
  });
  const oauthFlowRegistry = dependencies.oauthFlowRegistry ?? createOAuthFlowRegistry();
  const listConnectedAccounts = async () => {
    const entries = [];
    for (const descriptor of providers.list()) {
      try {
        const impl = await providers.implementation(descriptor.id);
        entries.push(...(await impl?.auth.listConnectedAccounts?.()) ?? []);
      } catch { continue; }
    }
    return entries;
  };
  const backfillConnectedIdentities = async () => {
    const entries = (await listConnectedAccounts()).map(({ account, user }) => ({ account, user }));
    try { identityProvisioning.backfillAccountIdentities(entries); }
    catch (error) { console.warn('Failed to backfill Git identities for connected accounts:', errorFields(error).message ?? error); }
  };
  const mutationExecutor = dependencies.mutationExecutor ?? createMutationExecutor({
    store: dependencies.mutationStore ?? createMutationStore({
      filePath: path.join(configRoot, 'source-control-mutations.json'),
    }),
    auditStore: dependencies.auditStore,
    runtimeIdentity: dependencies.runtimeIdentity,
  });
  const adoptConnectedAccount = (account: AccountIdentity, credential: ConnectedAccount['credential']) => {
    if (!credential?.providerUserId || !Number.isSafeInteger(credential.credentialRevision)) return;
    const { credentialRevision, providerUserId } = credential;
    bindingService.accountConnected({ ...account, credentialRevision, providerUserId }).catch((error) => {
      console.warn('Failed to move repository bindings to the connected account:', errorFields(error).message ?? error);
    });
  };
  const accountConnected = ({ account, user, renews = [], credential }: AccountEventPayloads['connected']) => {
    try {
      for (const previous of renews) identityProvisioning.repointAccountIdentities({ from: previous, to: account });
      identityProvisioning.ensureAccountIdentity({ account, user });
    } catch (error) {
      console.warn('Failed to provision a Git identity for the connected account:', errorFields(error).message ?? error);
    }
    adoptConnectedAccount(account, credential);
  };
  const accountUnavailable = async (identity: Invalidation, callback: NonNullable<ReturnType<typeof callbacksFor>>['onAccountInvalidated']) => {
    await bindingService.accountUnavailable(identity);
    if (!callback) return;
    if (!isAccountCallback(callback)) throw new TypeError('callback is not a function');
    await callback(identity);
  };
  providers.events.subscribe({
    connected: accountConnected,
    invalidated: (identity) => accountUnavailable(identity, callbacksFor(identity.provider)?.onAccountInvalidated),
    removed: (identity) => accountUnavailable(identity, callbacksFor(identity.provider)?.onAccountRemoved),
  });
  const shell = registerProviderRoutes(app, {
    providers,
    validateReadContext: bindingService.validateReadContext,
    validateMutationContext: bindingService.validateMutationContext,
    mutationExecutor,
    oauthFlowRegistry,
    onMutationSucceeded: dependencies.onMutationSucceeded,
    onMutationStarting: dependencies.onMutationStarting,
  });
  const instanceAliases = dependencies.instanceAliasStore ?? createInstanceAliasStore({
    filePath: path.join(configRoot, 'source-control-instance-aliases.json'),
  });
  const instancesOf = async (descriptor: ProviderDescriptor, aliases: Aliases = {}) => {
    const impl = await providers.implementation(descriptor.id);
    const defaults = [...descriptor.instance.defaultInstances];
    const known = (await impl?.auth.listInstances?.()) ?? [];
    const sshHosts = new Map(((await impl?.auth.listSshHosts?.()) ?? [])
      .map((entry) => [entry.instance, entry.sshUrl]));
    return [...new Set([...defaults, ...known])]
      .map((instance) => {
        const entry: ListedInstance = { provider: descriptor.id, instance };
        const sshUrl = sshHosts.get(instance);
        if (sshUrl !== undefined) entry.instanceSshUrl = sshUrl;
        const instanceAliasList = defaults.includes(instance) ? undefined : aliases[descriptor.id]?.[instance];
        if (instanceAliasList?.length) entry.instanceAliases = [...instanceAliasList];
        return entry;
      });
  };
  const readInstanceAliases = async () => {
    try {
      return await instanceAliases.list();
    } catch (error) {
      console.warn('Failed to read source control instance aliases:', redactSensitiveText(errorFields(error).message));
      return {};
    }
  };
  app.get('/api/source-control/providers', (_req, res) => {
    res.json({ providers: providers.list().map((descriptor, order) => publicProviderDescriptor(descriptor, order, descriptor.extension)) });
  });
  app.get('/api/source-control/instances', async (_req, res) => {
    const instances = [];
    const unavailableProviders = [];
    const aliases = await readInstanceAliases();
    for (const descriptor of providers.list()) {
      try {
        instances.push(...await instancesOf(descriptor, aliases));
      } catch (error) {
        unavailableProviders.push(descriptor.id);
        console.warn(`Failed to list ${descriptor.label} instances:`, redactSensitiveText(errorFields(error).message));
      }
    }
    return res.json(unavailableProviders.length ? { instances, unavailableProviders } : { instances });
  });
  app.post('/api/source-control/instances/aliases', async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const descriptor = providers.list().find((candidate) => candidate.id === body.provider);
    if (!descriptor) {
      return res.status(404).json({ error: 'Source control provider is unavailable', code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' });
    }
    let instance;
    try { instance = descriptor.instance.normalize(String(body.instance ?? '')); }
    catch { return res.status(400).json({ error: 'Source control instance is invalid', code: 'INVALID_SOURCE_CONTROL_INSTANCE' }); }
    if (!Array.isArray(body.aliases) || body.aliases.length > MAX_INSTANCE_ALIASES) {
      return res.status(400).json({ error: `At most ${MAX_INSTANCE_ALIASES} aliases`, code: 'INVALID_INSTANCE_ALIAS' });
    }
    let aliases;
    try {
      aliases = [...new Set(body.aliases.map((alias) => normalizeInstanceAlias(descriptor.instance.form, alias)))];
    } catch (cause) {
      const error = errorFields(cause);
      return res.status(400).json({ error: error.message, code: 'INVALID_INSTANCE_ALIAS', alias: error.alias });
    }
    const listed: ListedInstance[] = [];
    for (const candidate of providers.list()) {
      try { listed.push(...await instancesOf(candidate)); }
      catch { continue; }
    }
    const isTarget = (entry: ListedInstance) => entry.provider === descriptor.id && entry.instance === instance;
    if (descriptor.instance.defaultInstances.includes(instance) || !listed.some(isTarget)) {
      return res.status(404).json({ error: 'Source control instance is unknown', code: 'SOURCE_CONTROL_INSTANCE_UNKNOWN' });
    }
    try {
      const saved = await instanceAliases.set(descriptor.id, instance, aliases, (stored) => {
        const occupied = new Set([instanceHostname(instance)]);
        for (const entry of listed) {
          if (isTarget(entry)) continue;
          occupied.add(instanceHostname(entry.instance));
          for (const alias of stored[entry.provider]?.[entry.instance] ?? []) occupied.add(instanceHostname(alias));
        }
        const taken = aliases.find((alias) => occupied.has(instanceHostname(alias)));
        if (taken) {
          throw Object.assign(new Error(`${taken} is already the address of an instance`), { code: 'INSTANCE_ALIAS_TAKEN', alias: taken });
        }
      });
      return res.json({ aliases: saved });
    } catch (cause) {
      const error = errorFields(cause);
      if (error?.code === 'INSTANCE_ALIAS_TAKEN') {
        return res.status(409).json({ error: error.message, code: error.code, alias: error.alias });
      }
      if (isLockCode(error.code)) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.warn('Failed to save source control instance aliases:', redactSensitiveText(error?.message));
      return res.status(500).json({ error: 'Failed to save instance aliases', code: error?.code ?? 'INSTANCE_ALIASES_FAILED' });
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
  const afterTransportChange = async (directory: BindingIntentRequest['directory'], read: BindingRead) => {
    if (!(dependencies.onRepositoryTransportChanged instanceof Function)) return true;
    try {
      await dependencies.onRepositoryTransportChanged(directory, read);
      return true;
    } catch (error) {
      console.warn('Repository transport configuration was not updated:', redactSensitiveText(errorFields(error).message));
      return false;
    }
  };
  const sendTransportConfigPartial = (res: Response) => res.status(500).json({
    error: 'The repository binding was saved, but its Git configuration could not be updated. Git in a terminal still uses the previous credentials; retry to apply it.',
    code: 'SOURCE_CONTROL_TRANSPORT_CONFIG_PARTIAL',
    committed: true,
  });
  app.post('/api/source-control/binding/transport', async (req, res) => {
    try {
      const result = await bindingService.configureTransportBinding(req.body ?? {});
      if (!await afterTransportChange(bodyDirectory(req.body), result)) return sendTransportConfigPartial(res);
      return res.json(bindingService.present ? await bindingService.present(result) : result);
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  app.post('/api/source-control/binding/transport/remove', async (req, res) => {
    try {
      const result = await bindingService.removeTransportBinding(req.body ?? {});
      if (!await afterTransportChange(bodyDirectory(req.body), result)) return sendTransportConfigPartial(res);
      return res.json(bindingService.present ? await bindingService.present(result) : result);
    } catch (error) {
      return sendBindingError(res, error);
    }
  });
  app.post('/api/source-control/binding/reset', async (req, res) => {
    try {
      const result = await bindingService.resetRepositoryBinding(req.body ?? {});
      if (!await afterTransportChange(bodyDirectory(req.body), result)) return sendTransportConfigPartial(res);
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
  app.use(shell.extensionDispatcher);
  app.use('/api/source-control', (_req, res) => {
    res.status(404).json({ error: 'Source control provider is unavailable', code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE' });
  });
  void (async () => {
    for (const { account, credential } of await listConnectedAccounts()) adoptConnectedAccount(account, credential);
  })().catch((cause: unknown) => console.warn('Failed to repair repository bindings of connected accounts:', errorFields(cause).message ?? cause));

  return Object.freeze({
    ...bindingService,
    backfillConnectedIdentities,
    registerExtensionProvider: ({ descriptor, guest }: Parameters<typeof providers.registerExtension>[0]) => {
      providers.registerExtension({ descriptor, guest });
      shell.mountExtension(descriptor);
      void (async () => {
        const impl = await providers.implementation(descriptor.id);
        for (const { account, credential } of (await impl?.auth.listConnectedAccounts()) ?? []) adoptConnectedAccount(account, credential);
      })().catch((cause: unknown) => console.warn('Failed to repair repository bindings of an extension provider:', redactSensitiveText(errorFields(cause).message)));
    },
    unregisterExtensionProvider: (id: ProviderId) => {
      shell.unmountExtension(id);
      providers.unregisterExtension(id);
    },
    readChangeRequestPatch: shell.readChangeRequestPatch,
    readChangeRequestFile: shell.readChangeRequestFile,
    readLiveSummaries: shell.readLiveSummaries,
    resolveChangeRequestSource: shell.resolveChangeRequestSource,
    invalidateBranchStatus: shell.invalidateBranchStatus,
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
