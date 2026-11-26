import { isPlainObject } from '../shared/guards.js';
import {
  assertExactStrings, assertRequiredString, bindingInputError, isOneOf, mutationContextError, readContextError, requiredString,
} from './binding-input.js';
import { isSourceControlString as isString, isSourceControlInteger as isSafeInteger } from './input-guards.js';
import { normalizeSourceControlProviderInstance } from './provider-instance.js';
import { isExtensionProviderId, isProviderId, isProviderUsername } from './provider-id.js';
import { sourceControlProviderDescriptors } from './provider-descriptors.js';
import { resolvePrivateRepositoryIdentity } from './repository-identity.js';
import { fingerprintRemoteUrl, redactRemoteUrl } from './url-redaction.js';
import { carriedOverAuxiliaryGrant, credentialServesEndpoint, savedAuxiliaryGrant } from './saved-auxiliary-grant.js';
import { createHttpsCredentialReference, endpointIsInstanceOrigin, normalizeGitRemoteEndpoint, parseGitCredentialReference } from '../git/credential-resolver.js';
import { scpRemoteReaches, sshHostNameOf, sshHostReaches, sshUserOf, withSshHostNames } from '../git/ssh-host-alias.js';
import { bindingSummary, isSafeRepositoryEndpoint, resolveBindingReadiness } from './binding-contract.js';
import { allowsTopLevelProjects, splitProjectPath } from './project-path.js';
import { parseSshUrl } from './ssh-url.js';
import type { BindingDraft } from './binding-contract.js';
import type { SourceControlRepositoryEndpoint, SourceControlRepositoryRemote, SourceControlManagedCredentialPresentation } from './binding-types.js';
import type { AccountIdentity, ReadContextRequest } from './provider-contract.js';
import type {
  BindingServiceOptions, RepositoryIdentity, PlannedRemote, RepositoryResolver, BindingRead, BindingIntent,
  TransportContextInput, AuxiliaryContextInput, TransportAuthority, AuxiliaryAuthority,
  CloneBindingInput, BindingMutationTarget, PresentedBinding, BindingIntentRequest, MutationContextBody, AccountIdentityRequest,
  RemoteBindingInput, AuxiliaryBindingInput,
} from './binding-service-contracts.js';

const safePresentationText = (value: unknown, maximum = 512): value is string => isString(value) && value.length > 0
  && value.length <= maximum && value.trim() === value && !/[\0\r\n]/.test(value);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const hasExactKeys = <Value extends object>(value: Value, required: string[], optional: string[] = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};

const requiredIdentityString = <Value>(value: Value, name: string, provider: string, makeError = bindingInputError) => {
  if (!isExtensionProviderId(provider)) return requiredString(value, name, makeError);
  if (!isString(value) || !value.length) throw makeError(`${name} is required`);
  return value;
};

const providerOrigin = (provider: string, instance: string) => {
  const descriptor = sourceControlProviderDescriptors.get(provider);
  if (!descriptor) throw bindingInputError('provider is unavailable');
  return descriptor.instance.origin(instance);
};

const providerRepositoryForEndpoint = async (provider: string, instance: string, endpoint: SourceControlRepositoryEndpoint,
  { reachesInstance = sshHostReaches, sshUrl = null }: { reachesInstance?: typeof sshHostReaches; sshUrl?: string | null } = {}) => {
  if (!isSafeRepositoryEndpoint(endpoint)) throw bindingInputError('provider endpoint is invalid');
  let normalized;
  try { normalized = normalizeGitRemoteEndpoint(endpoint.displayUrl); }
  catch { throw bindingInputError('provider endpoint is invalid'); }
  const origin = providerOrigin(provider, instance);
  const hostname = origin.hostname.toLowerCase();
  const expectedPort = Number(origin.port || (origin.protocol === 'http:' ? 80 : 443));
  const configuredSsh = parseSshUrl(sshUrl);
  const hostMatches = normalized.host === hostname
    || (normalized.protocol === 'ssh' && !endpoint.displayUrl.includes('://')
      && await reachesInstance(normalized.host, hostname, sshUserOf(endpoint.displayUrl)))
    || (normalized.protocol === 'ssh' && configuredSsh !== null
      && normalized.host === configuredSsh.host && normalized.port === configuredSsh.port);
  if (!hostMatches || (normalized.protocol !== 'ssh' && normalized.port !== expectedPort)) {
    throw bindingInputError('provider instance does not match the selected remote host');
  }
  const descriptor = sourceControlProviderDescriptors.get(provider);
  const path = descriptor?.projectPathOfRemote instanceof Function
    ? descriptor.projectPathOfRemote({ protocol: normalized.protocol, path: normalized.path })
    : normalized.path.replace(/\.git$/i, '');
  const parts = isString(path) ? path.split('/') : [];
  const minimum = allowsTopLevelProjects(descriptor) ? 1 : 2;
  if (parts.length < minimum || parts.some((part) => !part)) throw bindingInputError('provider repository path is invalid');
  return splitProjectPath(path);
};

const assignRepository = (association: { repository?: { owner: string; name: string } }, repository: { owner: string; name: string }) => {
  if (repository.owner) association.repository = repository;
  else delete association.repository;
};

interface ProviderParsingOptions {
  reachesInstance?: typeof sshHostReaches;
  sshUrls?: Map<string, string | null>;
}
type ProviderBinding = BindingDraft['providers'][number];
async function parseProviders(value: [unknown], repositoryRemotes: SourceControlRepositoryRemote[], options?: ProviderParsingOptions): Promise<[ProviderBinding]>;
async function parseProviders(value: readonly unknown[], repositoryRemotes: SourceControlRepositoryRemote[], options?: ProviderParsingOptions): Promise<ProviderBinding[]>;
async function parseProviders(value: readonly unknown[], repositoryRemotes: SourceControlRepositoryRemote[],
  { reachesInstance = sshHostReaches, sshUrls = new Map() }: ProviderParsingOptions = {}) {
  if (!Array.isArray(value)) throw bindingInputError('providers must be an array');
  const availableRemotes = new Set(repositoryRemotes.map((remote) => remote.name));
  const bindings = await Promise.all(value.map(async (provider) => {
    if (!isPlainObject(provider) || !hasExactKeys(provider,
      ['provider', 'instance', 'accountId', 'primaryRemote'], ['repository'])) throw bindingInputError('provider binding is invalid');
    const name = requiredString(provider.provider, 'provider');
    if (!sourceControlProviderDescriptors.has(name)) throw bindingInputError('provider is unavailable');
    const primaryRemote = requiredString(provider.primaryRemote, 'primaryRemote');
    if (!availableRemotes.has(primaryRemote)) throw bindingInputError(`remote ${primaryRemote} does not exist`);
    const endpoint = repositoryRemotes.find((remote) => remote.name === primaryRemote)?.fetch;
    if (!endpoint) throw bindingInputError(`remote ${primaryRemote} does not have a fetch endpoint`);
    const instance = normalizeProviderInstance(name, provider.instance);
    const repository = await providerRepositoryForEndpoint(name, instance, endpoint,
      { reachesInstance, sshUrl: sshUrls.get(`${name}\0${instance}`) ?? null });
    const result: BindingDraft['providers'][number] = {
      provider: name,
      instance,
      accountId: requiredIdentityString(provider.accountId, 'accountId', name),
      primaryRemote,
      readiness: 'ready',
      endpoint: { displayUrl: endpoint.displayUrl, fingerprint: endpoint.fingerprint },
    };
    assignRepository(result, repository);
    if (provider.repository !== undefined) {
      if (!isPlainObject(provider.repository) || !hasExactKeys(provider.repository, ['owner', 'name'])) {
        throw bindingInputError('provider repository is invalid');
      }
      const topLevel = allowsTopLevelProjects(sourceControlProviderDescriptors.get(name)) && provider.repository.owner === '';
      const requestedRepository = {
        owner: topLevel ? '' : requiredString(provider.repository.owner, 'repository owner'),
        name: requiredString(provider.repository.name, 'repository name'),
      };
      if (requestedRepository.owner !== repository.owner || requestedRepository.name !== repository.name) {
        throw bindingInputError('provider repository does not match the selected remote');
      }
    }
    return result;
  }));
  const keys = bindings.map((binding) => `${binding.provider}\0${binding.instance}\0${binding.primaryRemote}`);
  if (new Set(keys).size !== keys.length) throw bindingInputError('provider bindings must be unique');
  return bindings;
}

const parseRemotes = (value: RemoteBindingInput[], repositoryRemotes: SourceControlRepositoryRemote[]) => {
  if (!Array.isArray(value)) throw bindingInputError('remotes must be an array');
  const available = new Map(repositoryRemotes.map((remote) => [remote.name, remote]));
  const bindings = value.map((remote) => {
    if (!isPlainObject(remote)) throw bindingInputError('remote binding is invalid');
    const name = requiredString(remote.name, 'remote name');
    const resolved = available.get(name);
    if (!resolved) throw bindingInputError(`remote ${name} does not exist`);
    if (!['managed', 'system', 'anonymous'].includes(remote.mode)) throw bindingInputError('remote mode is invalid');
    if (!hasExactKeys(remote, ['name', 'mode'], remote.mode === 'managed' ? ['credentialId'] : ['unverifiedConfirmed'])) {
      throw bindingInputError('remote binding is invalid');
    }
    if (remote.mode === 'anonymous' && (!hasExactKeys(remote, ['name', 'mode'])
      || normalizeGitRemoteEndpoint(resolved.fetch.displayUrl).protocol !== 'https')) throw bindingInputError('Anonymous transport requires credential-free HTTPS read authority');
    if (remote.mode === 'system' && remote.credentialId !== undefined) {
      throw bindingInputError('credentialId is not allowed for system remote');
    }
    const result: BindingDraft['remotes'][number] = { name, fetch: resolved.fetch, push: resolved.push, mode: remote.mode,
      readiness: remote.mode !== 'system' || remote.unverifiedConfirmed === true ? 'ready' : 'confirmation-required' };
    if (remote.credentialId !== undefined && remote.credentialId !== null) {
      result.credentialId = requiredString(remote.credentialId, 'credentialId');
    }
    if (remote.mode === 'managed' && !result.credentialId) {
      throw bindingInputError('credentialId is required for managed remote');
    }
    return result;
  });
  const names = bindings.map((binding) => binding.name);
  if (new Set(names).size !== names.length) throw bindingInputError('remote bindings must be unique');
  return bindings;
};

const parseAuxiliary = (value: AuxiliaryBindingInput[] | undefined) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw bindingInputError('auxiliary must be a bounded array');
  const bindings = value.map((entry) => {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ['kind', 'endpoint', 'mode'], ['credentialId', 'unverifiedConfirmed'])
      || !['submodule', 'lfs'].includes(entry.kind)
      || !isPlainObject(entry.endpoint)
      || !hasExactKeys(entry.endpoint, ['displayUrl', 'fingerprint'])
      || !isSafeRepositoryEndpoint(entry.endpoint)) {
      throw bindingInputError('auxiliary binding is invalid');
    }
    if (!['managed', 'system', 'anonymous'].includes(entry.mode)
      || !hasExactKeys(entry, ['kind', 'endpoint', 'mode'], entry.mode === 'managed' ? ['credentialId']
        : entry.mode === 'system' ? ['unverifiedConfirmed'] : [])) {
      throw bindingInputError('auxiliary binding is invalid');
    }
    const result: BindingDraft['auxiliary'][number] = {
      kind: entry.kind,
      endpoint: {
        displayUrl: requiredString(entry.endpoint.displayUrl, 'auxiliary endpoint displayUrl'),
        fingerprint: requiredString(entry.endpoint.fingerprint, 'auxiliary endpoint fingerprint'),
      },
      mode: entry.mode,
      readiness: entry.mode !== 'system' || entry.unverifiedConfirmed === true ? 'ready' : 'confirmation-required',
    };
    if (result.mode === 'anonymous' && (!hasExactKeys(entry, ['kind', 'endpoint', 'mode'])
      || normalizeGitRemoteEndpoint(result.endpoint.displayUrl).protocol !== 'https')) throw bindingInputError('Anonymous auxiliary transport requires credential-free HTTPS authority');
    if (result.mode === 'managed') result.credentialId = requiredString(entry.credentialId, 'auxiliary credentialId');
    else if (entry.credentialId !== undefined) throw bindingInputError('credentialId is not allowed for system auxiliary binding');
    return result;
  });
  const keys = bindings.map((entry) => `${entry.kind}\0${entry.endpoint.fingerprint}`);
  if (new Set(keys).size !== keys.length) throw bindingInputError('auxiliary bindings must be unique');
  return bindings;
};

const inheritedAuxiliaryGrant = (binding: PresentedBinding | null, parentRemote: string | undefined, rawEndpoint: string): {
  mode: 'system' | 'managed' | 'anonymous'; readiness: 'ready'; credentialId?: string;
} | null => {
  if (!binding) return { mode: 'system', readiness: 'ready' };
  const parent = parentRemote ? binding.remotes.find((entry) => entry.name === parentRemote) : null;
  if (!parent || parent.readiness !== 'ready') return null;
  if (parent.mode === 'system') return { mode: 'system', readiness: 'ready' };
  let endpointHost;
  let parentHost;
  try {
    endpointHost = normalizeGitRemoteEndpoint(rawEndpoint).host;
    parentHost = normalizeGitRemoteEndpoint(parent.fetch.displayUrl).host;
  } catch {
    return null;
  }
  if (!endpointHost || endpointHost !== parentHost) return null;
  if (parent.mode === 'managed') {
    return parent.credentialId && credentialServesEndpoint(parent.credentialId, rawEndpoint)
      ? { mode: 'managed', readiness: 'ready', credentialId: parent.credentialId }
      : null;
  }
  return { mode: parent.mode, readiness: 'ready' };
};

const identityRemoteGrant = (binding: PresentedBinding) => {
  const ready = binding.remotes.filter((entry) => entry.readiness === 'ready');
  const primary = binding.providers[0]?.primaryRemote;
  return ready.find((entry) => entry.name === primary)
    ?? ready.find((entry) => entry.name === 'origin')
    ?? ready[0] ?? null;
};

const endpointAuthority = (url: string) => {
  try {
    const { protocol, host, port } = normalizeGitRemoteEndpoint(url);
    return `${protocol}://${host}:${port}`;
  } catch {
    return null;
  }
};

const inheritedRemoteGrant = (binding: PresentedBinding, remote: RepositoryIdentity['remotes'][number]) => {
  const parent = identityRemoteGrant(binding);
  if (!parent || !remote.fetch || !remote.push) return null;
  if (parent.mode !== 'system') {
    const origin = endpointAuthority(parent.fetch.displayUrl);
    const reachable = [remote.fetch, remote.push]
      .every((endpoint) => origin && endpointAuthority(endpoint.rawUrl ?? endpoint.displayUrl) === origin);
    if (!reachable) return null;
  }
  const grant: BindingDraft['remotes'][number] & { inherited: true } = {
    name: remote.name,
    fetch: { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint },
    push: { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint },
    mode: parent.mode,
    readiness: 'ready',
    inherited: true,
  };
  if (parent.mode === 'managed') grant.credentialId = parent.credentialId;
  return Object.freeze(grant);
};

const implicitSystemRemote = (remote: RepositoryIdentity['remotes'][number]): {
  name: string; mode: 'system'; readiness: 'ready'; credentialId?: never;
  fetch: { fingerprint: string | undefined }; push: { fingerprint: string | undefined };
} => Object.freeze({
  name: remote.name, mode: 'system' as const, readiness: 'ready' as const,
  fetch: { fingerprint: remote.fetch?.fingerprint }, push: { fingerprint: remote.push?.fingerprint },
});

const publicContext = (context: RepositoryIdentity) => {
  const remotes = context.remotes.map((remote) => {
    const fetch = { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint };
    const push = { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint };
    if (!isSafeRepositoryEndpoint(fetch) || !isSafeRepositoryEndpoint(push)) {
      throw bindingInputError('repository endpoint metadata is invalid');
    }
    return { name: remote.name, fetch, push };
  });
  return {
    supported: true,
    repositoryId: context.repositoryId,
    configRevision: context.configRevision,
    bare: context.bare,
    remotes,
  };
};

const normalizeProviderInstance = <Instance>(provider: string, instance: Instance, makeError = bindingInputError) => {
  const value = requiredString(instance, 'instance', makeError);
  try {
    return normalizeSourceControlProviderInstance(provider, value);
  } catch {
    throw makeError('instance is invalid');
  }
};

const providerInstanceKey = <Instance>(provider: string, instance: Instance, makeError = bindingInputError) => (
  sourceControlProviderDescriptors.has(provider)
    ? normalizeProviderInstance(provider, instance, makeError)
    : requiredString(instance, 'instance', makeError)
);

const unavailableProviderError = () => {
  const error = Object.assign(new Error('Source control provider is unavailable'), { code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE', status: 422 });
  return error;
};

export const hostOf = (value: string | null | undefined) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  try { return new URL(text.includes('://') ? text : `https://${text}`).hostname.toLowerCase() || null; }
  catch {
    const scp = text.match(/^(?:[^@/:\s]+@)?([^/:\s]+):/);
    return scp?.[1]?.toLowerCase() ?? null;
  }
};

const staleBindingError = (message: string, current: BindingRead) => {
  const error = readContextError('SOURCE_CONTROL_BINDING_STALE', message, 409);
  return Object.assign(error, { current });
};

const transportContextError = (message: string) => readContextError(
  'INVALID_GIT_TRANSPORT_CONTEXT',
  message,
  400,
);

const parseTarget = <Value>(value: Value, provider: string) => {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['project'], ['number', 'head', 'base', 'headSha'])
    || !isPlainObject(value.project)
    || !hasExactKeys(value.project, ['owner', 'name'])) {
    throw mutationContextError('Source control mutation target is invalid');
  }
  const target: BindingMutationTarget = {
    project: {
      owner: allowsTopLevelProjects(sourceControlProviderDescriptors.get(provider)) && value.project.owner === ''
        ? '' : requiredString(value.project.owner, 'target project owner', mutationContextError),
      name: requiredString(value.project.name, 'target project name', mutationContextError),
    },
  };
  if (value.number !== undefined) {
    if (!isSafeInteger(value.number) || value.number < 1) throw mutationContextError('target number is invalid');
    target.number = value.number;
  }
  for (const key of ['head', 'base', 'headSha'] as const) {
    if (value[key] !== undefined) target[key] = requiredString(value[key], `target ${key}`, mutationContextError);
  }
  return target;
};

export function createBindingService({
  store,
  resolveRepository,
  resolveTransportRepository = resolvePrivateRepositoryIdentity,
  readTransportAccount,
  validateManagedSshCredential,
  readManagedSshCredentialPresentation,
  resolveCheckoutAuxiliary,
  sshHostReaches: reachesInstance = sshHostReaches,
  sshHostName: resolveHostName = sshHostNameOf,
  readProviderSshUrl,
}: BindingServiceOptions) {
  const resolveWith = async <Directory>(directory: Directory, resolver: RepositoryResolver, plannedRemote?: PlannedRemote) => {
    const normalizedDirectory = requiredString(directory, 'directory');
    const context = await resolver(normalizedDirectory, plannedRemote);
    if (!context.supported) {
      const error = Object.assign(new Error('Directory is not a supported Git repository'), {
        code: 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY', reason: context.reason,
      });
      throw error;
    }
    return context;
  };
  const resolve = <Directory>(directory: Directory, plannedRemote?: PlannedRemote) => resolveWith(directory, resolveRepository, plannedRemote);
  const readSshUrls = async (pairs: Array<readonly [unknown, unknown]>) => {
    const urls = new Map<string, string | null>();
    if (!(readProviderSshUrl instanceof Function)) return urls;
    for (const [provider, instance] of pairs) {
      const key = `${provider}\0${instance}`;
      if (urls.has(key)) continue;
      let sshUrl = null;
      try { sshUrl = await readProviderSshUrl({ provider, instance }); }
      catch { sshUrl = null; }
      urls.set(key, sshUrl);
    }
    return urls;
  };
  const sshUrlsFor = async (providers: ReadonlyArray<{ provider: unknown; instance: unknown }>) => (Array.isArray(providers) ? readSshUrls(providers.map((entry): [unknown, unknown] => {
    let instance = entry.instance;
    if (isString(entry.provider)) {
      try { instance = normalizeProviderInstance(entry.provider, entry.instance); }
      catch { instance = entry.instance; }
    }
    return [entry.provider, instance];
  })) : new Map());
  const endpointMatchesSshUrl = (displayUrl: string, sshUrl: string | null) => {
    if (!sshUrl) return false;
    const configured = parseSshUrl(sshUrl);
    if (!configured) return false;
    try {
      const endpoint = normalizeGitRemoteEndpoint(displayUrl);
      return endpoint.protocol === 'ssh' && endpoint.host === configured.host && endpoint.port === configured.port;
    } catch {
      return false;
    }
  };
  const readCurrent = async (context: RepositoryIdentity): Promise<BindingRead> => {
    const record = await store.read(context.repositoryId);
    return { repository: publicContext(context), revision: record.revision,
      binding: record.binding ? resolveBindingReadiness(record.binding, context) : null };
  };
  const unavailablePresentation = (): SourceControlManagedCredentialPresentation => ({ status: 'unavailable' });
  const resolveCredentialPresentation = async (credentialId: string | undefined, deadline: number): Promise<SourceControlManagedCredentialPresentation> => {
    if (!isString(credentialId)) return unavailablePresentation();
    let reference;
    try { reference = parseGitCredentialReference(credentialId); }
    catch { return unavailablePresentation(); }
    try {
      if (reference.transport === 'ssh') {
        const metadata = await readManagedSshCredentialPresentation?.(credentialId, deadline);
        return metadata && isString(metadata.fingerprint) && /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(metadata.fingerprint)
          ? { status: 'available', transport: 'ssh', fingerprint: metadata.fingerprint }
          : unavailablePresentation();
      }
      if (reference.transport !== 'https' || reference.version !== 2 || !reference.providerUserId) {
        return unavailablePresentation();
      }
      const instance = normalizeProviderInstance(reference.provider, reference.instance);
      const account = await readTransportAccount?.({
        provider: reference.provider,
        instance,
        accountId: reference.credentialId,
        credentialRevision: reference.credentialRevision,
      });
      if (account?.credentialId !== reference.credentialId
        || account.credentialRevision !== reference.credentialRevision
        || account.providerUserId !== reference.providerUserId
        || !safePresentationText(account.providerUserId)
        || account.status !== 'valid' || !['oauth', 'pat', 'cli'].includes(account.source)
        || !(isExtensionProviderId(reference.provider) && isString(account.user?.id)
          ? account.user.id.length > 0 && account.user.id.length <= 256
          : isInteger(account.user?.id) && account.user.id >= 0)
        || !isProviderUsername(account.user.login)
        || account.providerUserId !== `${instance}#${account.user.id}`) return unavailablePresentation();
      return {
        status: 'available', transport: 'https', provider: reference.provider, instance,
        source: account.source, username: account.user.login, providerUserId: account.providerUserId,
      };
    } catch {
      return unavailablePresentation();
    }
  };
  const presentRead = async (stored: BindingRead) => {
    if (!stored.binding) return { ...stored, repository: await withSshHostNames(stored.repository, resolveHostName) };
    const binding = stored.binding;
    const granted = new Set(binding.remotes.map((remote) => remote.name));
    const inherited = (stored.repository?.remotes ?? [])
      .filter((remote) => !granted.has(remote.name))
      .map((remote) => inheritedRemoteGrant(binding, remote))
      .filter((remote) => remote !== null);
    const read = inherited.length
      ? { ...stored, binding: { ...stored.binding, remotes: [...stored.binding.remotes, ...inherited] } }
      : { ...stored, binding };
    const managed = [...new Set(read.binding.remotes
      .filter((remote) => remote.mode === 'managed')
      .map((remote) => remote.credentialId))];
    const presentations = new Map<string | undefined, SourceControlManagedCredentialPresentation>();
    const deadline = Date.now() + 10_000;
    for (let index = 0; index < Math.min(managed.length, 256); index += 8) {
      const batch = managed.slice(index, index + 8);
      await Promise.all(batch.map(async (credentialId) => {
        presentations.set(credentialId, await resolveCredentialPresentation(credentialId, deadline));
      }));
    }
    return { ...read, repository: await withSshHostNames(read.repository, resolveHostName), binding: { ...read.binding,
      remotes: read.binding.remotes.map((remote) => {
        if (remote.mode !== 'managed') return remote;
        const presentation = presentations.get(remote.credentialId) ?? unavailablePresentation();
        return { ...remote, presentation };
      }),
    } };
  };
  const validateAuthority = async (input: ReadContextRequest | MutationContextBody, makeContextError: typeof bindingInputError, makeRequiredFieldError = makeContextError) => {
    if (!isPlainObject(input)) throw makeContextError('Source control read context is required');
    const directory = requiredString(input.directory, 'directory', makeRequiredFieldError);
    const repositoryId = requiredString(input.repositoryId, 'repositoryId', makeRequiredFieldError);
    const provider = requiredString(input.provider, 'provider', makeRequiredFieldError);
    if (!isProviderId(provider)) throw makeContextError('Source control provider is invalid');
    if (!sourceControlProviderDescriptors.has(provider)) throw unavailableProviderError();
    const instance = normalizeProviderInstance(provider, input.instance, makeRequiredFieldError);
    const accountId = requiredIdentityString(input.accountId, 'accountId', provider, makeRequiredFieldError);
    const primaryRemote = requiredString(input.primaryRemote, 'primaryRemote', makeRequiredFieldError);
    const bindingRevision = input.bindingRevision;
    if (!isInteger(bindingRevision) || bindingRevision < 0) throw makeContextError('bindingRevision is required');

    const context = await resolve(directory);
    if (context.repositoryId !== repositoryId) {
      throw readContextError('SOURCE_CONTROL_BINDING_REPOSITORY_MISMATCH', 'Source control repository binding does not match this directory', 409);
    }
    const current = await readCurrent(context);
    if (current.revision !== bindingRevision || (current.binding && current.binding.revision !== bindingRevision)) {
      throw staleBindingError('Source control repository binding changed', current);
    }
    const providers = current.binding?.providers ?? [];
    const boundProvider = providers.find((candidate) => candidate.provider === provider
      && normalizeProviderInstance(candidate.provider, candidate.instance) === instance
      && candidate.accountId === accountId
      && candidate.primaryRemote === primaryRemote);
    if (!boundProvider) {
      const boundToHost = providers.some((candidate) => candidate.provider === provider
        && candidate.readiness !== 'account-unavailable'
        && normalizeProviderInstance(candidate.provider, candidate.instance) === instance);
      const remote = context.remotes.find((candidate) => candidate.name === primaryRemote);
      const remoteHost = remote ? hostOf(remote.fetch.displayUrl) : null;
      const onWebHost = Boolean(remoteHost) && remoteHost === hostOf(instance);
      if (!onWebHost && remote && !(await scpRemoteReaches(remote.fetch.displayUrl, hostOf(instance), reachesInstance))) {
        const sshUrl = (await readSshUrls([[provider, instance]])).get(`${provider}\0${instance}`) ?? null;
        if (!endpointMatchesSshUrl(remote.fetch.displayUrl, sshUrl)) {
          throw readContextError('SOURCE_CONTROL_BINDING_CONTEXT_MISMATCH', 'Source control repository binding context does not match', 409);
        }
      }
      if (boundToHost || !remoteHost) {
        throw readContextError('SOURCE_CONTROL_BINDING_CONTEXT_MISMATCH', 'Source control repository binding context does not match', 409);
      }
      return { directory, repositoryId, provider, instance, accountId, bindingRevision, primaryRemote };
    }
    if (boundProvider.readiness === 'config-changed') throw staleBindingError('Source control repository remote changed', current);
    if (boundProvider.readiness !== 'ready') {
      throw readContextError('SOURCE_CONTROL_BINDING_NEEDS_ATTENTION', 'Source control provider binding needs attention', 409);
    }
    if (!context.remotes.some((remote) => remote.name === primaryRemote)) {
      throw staleBindingError('Source control repository remote changed', current);
    }
    return { directory, repositoryId, provider, instance, accountId, bindingRevision, primaryRemote };
  };
  const invalidReadInput = (message: string) => readContextError('INVALID_SOURCE_CONTROL_READ_CONTEXT', message, 400);
  const parseProviderTarget = <Target>(target: Target) => {
    if (!isPlainObject(target) || !hasExactKeys(target, ['provider', 'instance', 'accountId', 'primaryRemote'])) {
      throw bindingInputError('Provider binding target is invalid');
    }
    const provider = requiredString(target.provider, 'provider');
    if (!isProviderId(provider)) throw bindingInputError('provider is unsupported');
    return {
      provider,
      instance: providerInstanceKey(provider, target.instance),
      accountId: requiredIdentityString(target.accountId, 'accountId', provider),
      primaryRemote: requiredString(target.primaryRemote, 'primaryRemote'),
    };
  };
  const validateGitTransportContext = async (input: TransportContextInput) => {
    const requiredKeys = ['directory', 'repositoryId', 'bindingRevision', 'configRevision', 'remote', 'endpointKind'];
    if (!isPlainObject(input) || !hasExactKeys(input, requiredKeys)) {
      throw transportContextError('Git transport context is invalid');
    }
    const directory = requiredString(input.directory, 'directory', transportContextError);
    const repositoryId = requiredString(input.repositoryId, 'repositoryId', transportContextError);
    const configRevision = requiredString(input.configRevision, 'configRevision', transportContextError);
    const remote = requiredString(input.remote, 'remote', transportContextError);
    const endpointKind = input.endpointKind;
    if (endpointKind !== 'fetch' && endpointKind !== 'push') {
      throw transportContextError('endpointKind is invalid');
    }
    const bindingRevision = input.bindingRevision;
    if (!Number.isInteger(bindingRevision) || bindingRevision < 0) {
      throw transportContextError('bindingRevision is required');
    }

    const context = await resolveWith(directory, resolveTransportRepository);
    const transportRevision = requiredString(context.transportRevision, 'transportRevision', transportContextError);
    const current = await readCurrent(context);
    const conflict = (message: string) => staleBindingError(message, current);
    if (context.repositoryId !== repositoryId) throw conflict('Git transport repository changed');
    if (current.revision !== bindingRevision || (current.binding && current.binding.revision !== bindingRevision)) {
      throw conflict('Git transport binding changed');
    }
    if (context.configRevision !== configRevision) {
      throw conflict('Git transport repository remotes changed');
    }
    const repositoryRemote = context.remotes.find((candidate) => candidate.name === remote);
    const boundRemote = current.binding
      ? current.binding.remotes.find((candidate) => candidate.name === remote)
        ?? (repositoryRemote ? inheritedRemoteGrant(current.binding, repositoryRemote) : null)
      : (repositoryRemote ? implicitSystemRemote(repositoryRemote) : null);
    if (!repositoryRemote || !boundRemote) throw conflict('Git transport remote binding changed');
    if (boundRemote.readiness !== 'ready') {
      throw Object.assign(conflict('Git transport remote binding needs attention'), { reason: 'needs-attention' });
    }
    const endpoint = repositoryRemote[endpointKind];
    const boundEndpoint = boundRemote[endpointKind];
    if (!endpoint?.rawUrl || !endpoint.fingerprint || boundEndpoint?.fingerprint !== endpoint.fingerprint) {
      throw conflict('Git transport endpoint changed');
    }
    if (boundRemote.mode === 'managed' && !boundRemote.credentialId) {
      throw conflict('Managed Git transport credential is missing');
    }
    if (boundRemote.mode === 'anonymous') {
      if (endpointKind === 'push') throw readContextError('INVALID_REQUEST', 'Anonymous Git transport is read-only', 400);
      if (normalizeGitRemoteEndpoint(endpoint.rawUrl).protocol !== 'https') throw readContextError('RUNTIME_UNSUPPORTED', 'Anonymous Git transport requires HTTPS', 501);
    }

    const authority: TransportAuthority = {
      directory,
      repositoryId,
      bindingRevision,
      configRevision,
      transportRevision,
      remote,
      endpointKind,
      endpoint: endpoint.rawUrl,
      endpointFingerprint: endpoint.fingerprint,
      transportMode: boundRemote.mode,
    };
    if (boundRemote.credentialId) authority.credentialId = boundRemote.credentialId;
    const primaryOf = (current.binding?.providers ?? [])
      .filter((candidate) => candidate.primaryRemote === remote && candidate.readiness === 'ready')
      .map((candidate) => candidate.provider);
    if (primaryOf.length) authority.primaryOf = primaryOf;
    return Object.freeze(authority);
  };
  const validateGitAuxiliaryContext = async (input: AuxiliaryContextInput) => {
    const requiredKeys = ['directory', 'repositoryId', 'bindingRevision', 'configRevision', 'kind', 'rawEndpoint'];
    if (!isPlainObject(input) || !hasExactKeys(input, requiredKeys, ['parentRemote', 'derivedFromRemote'])
      || !['submodule', 'lfs'].includes(input.kind)) {
      throw transportContextError('Git auxiliary transport context is invalid');
    }
    const directory = requiredString(input.directory, 'directory', transportContextError);
    const repositoryId = requiredString(input.repositoryId, 'repositoryId', transportContextError);
    const configRevision = requiredString(input.configRevision, 'configRevision', transportContextError);
    const rawEndpoint = requiredString(input.rawEndpoint, 'rawEndpoint', transportContextError);
    if (!Number.isInteger(input.bindingRevision) || input.bindingRevision < 0) {
      throw transportContextError('bindingRevision is required');
    }
    const context = await resolveWith(directory, resolveTransportRepository);
    const current = await readCurrent(context);
    const conflict = (message: string) => staleBindingError(message, current);
    if (context.repositoryId !== repositoryId || context.configRevision !== configRevision) {
      throw conflict('Git auxiliary repository authority changed');
    }
    if (current.revision !== input.bindingRevision
      || (current.binding && current.binding.revision !== input.bindingRevision)) {
      throw conflict('Git auxiliary binding changed');
    }
    const fingerprint = fingerprintRemoteUrl(rawEndpoint);
    const saved = savedAuxiliaryGrant(current.binding?.auxiliary ?? [], input.kind, rawEndpoint, isString(input.derivedFromRemote) ? input.derivedFromRemote : undefined);
    const grant = saved === undefined ? inheritedAuxiliaryGrant(current.binding, input.parentRemote, rawEndpoint) : saved;
    if (!grant || grant.readiness !== 'ready') throw readContextError('GIT_AUXILIARY_AUTHORIZATION_REQUIRED', 'Git auxiliary endpoint authorization is required', 409);
    const authority: AuxiliaryAuthority = {
      directory, repositoryId, bindingRevision: input.bindingRevision, configRevision,
      transportRevision: requiredString(context.transportRevision, 'transportRevision', transportContextError),
      kind: input.kind, endpoint: rawEndpoint, endpointFingerprint: fingerprint,
      transportMode: grant.mode,
    };
    if (grant.credentialId) authority.credentialId = grant.credentialId;
    return Object.freeze(authority);
  };

  return {
    resolveContext: async <Directory>(directory: Directory) => withSshHostNames(publicContext(await resolve(directory)), resolveHostName),
    listRemoteGrants: () => store.listRemoteGrants(),
    get: async <Directory>(directory: Directory, plannedRemote?: PlannedRemote) => presentRead(await readCurrent(await resolve(directory, plannedRemote))),
    present: presentRead,
    validateReadContext: (input: ReadContextRequest) => validateAuthority(input, invalidReadInput, bindingInputError),
    validateMutationContext: async (input: MutationContextBody) => {
      const context = await validateAuthority(input, mutationContextError);
      const repository = await resolve(context.directory);
      const current = await readCurrent(repository);
      if (current.binding?.remotes.some((grant) => grant.readiness === 'config-changed')) {
        throw staleBindingError('Source control repository remotes changed', current);
      }
      return {
        ...context,
        idempotencyKey: requiredString(isPlainObject(input) ? input.idempotencyKey : undefined, 'idempotencyKey', mutationContextError),
        target: parseTarget(isPlainObject(input) ? input.target : undefined, context.provider),
      };
    },
    validateGitTransportContext,
    validateGitAuxiliaryContext,
    bindClonedRepository: async ({ directory, approvedEndpoint, transportMode, credentialId, unverifiedConfirmed, providerAccount, auxiliaryGrants = [] }: CloneBindingInput) => {
      if (!['system', 'managed', 'anonymous'].includes(transportMode)
        || (transportMode === 'anonymous' && (credentialId !== undefined || unverifiedConfirmed !== undefined
          || normalizeGitRemoteEndpoint(approvedEndpoint).protocol !== 'https'))
        || (transportMode === 'system' && (unverifiedConfirmed !== true || credentialId !== undefined))
        || (transportMode === 'managed' && !credentialId)) throw bindingInputError('Clone transport authority is invalid');
      if (transportMode === 'managed') {
        try {
          if (unverifiedConfirmed !== undefined || parseGitCredentialReference(credentialId).transport !== normalizeGitRemoteEndpoint(approvedEndpoint).protocol) {
            throw bindingInputError('Clone credential protocol does not match');
          }
        } catch { throw bindingInputError('Clone credential protocol does not match'); }
      }
      const context = await resolveWith(directory, resolveTransportRepository);
      const remote = context.remotes.find((entry) => entry.name === 'origin');
      const fingerprint = fingerprintRemoteUrl(approvedEndpoint);
      if (!remote || [remote.fetch, remote.push].some((endpoint) => endpoint.rawUrl !== approvedEndpoint
        || endpoint.fingerprint !== fingerprint)) {
        throw bindingInputError('Cloned endpoints differ from the approved endpoint');
      }
      const endpoint = { displayUrl: redactRemoteUrl(approvedEndpoint), fingerprint };
      const selected: BindingDraft['remotes'][number] = { name: 'origin', fetch: endpoint, push: endpoint, mode: transportMode, readiness: 'ready' };
      if (credentialId) selected.credentialId = credentialId;
      const auxiliary = parseAuxiliary(auxiliaryGrants.map((grant) => {
        const input: NonNullable<Parameters<typeof parseAuxiliary>[0]>[number] = { kind: grant.kind, endpoint: grant.endpoint, mode: grant.transportMode };
        if (grant.credentialId) input.credentialId = grant.credentialId;
        if (grant.transportMode === 'system') input.unverifiedConfirmed = grant.unverifiedConfirmed;
        return input;
      }));
      const cloneSshUrls = providerAccount ? await sshUrlsFor([providerAccount]) : new Map();
      const providers = providerAccount
        ? await parseProviders([{ ...providerAccount, primaryRemote: 'origin' }], [{ name: 'origin', fetch: endpoint, push: endpoint }],
          { reachesInstance, sshUrls: cloneSshUrls })
        : [];
      return store.compareAndSwap(context.repositoryId, 0, {
        configRevision: context.configRevision, providers, remotes: [selected], auxiliary,
        state: bindingSummary({ providers, remotes: [selected], auxiliary }),
      });
    },
    configureTransportBinding: async (input: BindingIntentRequest) => {
      const keys = ['directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision',
        'expectedFetchFingerprint', 'expectedPushFingerprint', 'remote', 'transport'];
      if (!isPlainObject(input) || !isOneOf(['system', 'https', 'ssh', 'anonymous'] as const, input.transport)
        || !hasExactKeys(input, [...keys, ...(input.transport === 'system' ? ['unverifiedConfirmed']
          : input.transport === 'https' ? ['credentialAccount'] : input.transport === 'ssh' ? ['sshCredentialId'] : [])])) {
        throw bindingInputError('Git transport binding intent is invalid');
      }
      if (input.transport === 'system' && input.unverifiedConfirmed !== true) {
        throw bindingInputError('Explicit confirmation of unverified System Git is required');
      }
      assertExactStrings(input, ['expectedRepositoryId', 'expectedConfigRevision', 'expectedFetchFingerprint', 'expectedPushFingerprint', 'remote'] as const);
      if (!isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw bindingInputError('expectedRevision is required');
      }
      const context = await resolveWith(input.directory, resolveTransportRepository);
      const current = await readCurrent(context);
      const conflict = (authority = current) => staleBindingError('Repository transport authority changed. Reload before editing.', authority);
      if (context.repositoryId !== input.expectedRepositoryId || current.revision !== input.expectedRevision
        || context.configRevision !== input.expectedConfigRevision) throw conflict();
      const remote = context.remotes.find((candidate) => candidate.name === input.remote);
      if (!remote || !remote.fetch || !remote.push
        || remote.fetch.fingerprint !== input.expectedFetchFingerprint
        || remote.push.fingerprint !== input.expectedPushFingerprint) throw conflict();
      const binding = current.binding;
      if (input.transport === 'anonymous' && normalizeGitRemoteEndpoint(remote.fetch.rawUrl).protocol !== 'https') {
        throw readContextError('RUNTIME_UNSUPPORTED', 'Anonymous Git transport requires HTTPS', 501);
      }
      let credentialId;
      if (input.transport === 'ssh') {
        for (const endpoint of [remote.fetch, remote.push]) {
          if (normalizeGitRemoteEndpoint(endpoint.rawUrl).protocol !== 'ssh') throw bindingInputError('Managed SSH credentials require SSH endpoints');
        }
        if (!(validateManagedSshCredential instanceof Function)) throw readContextError('RUNTIME_UNSUPPORTED', 'Managed SSH inventory is unavailable', 501);
        credentialId = requiredString(input.sshCredentialId, 'SSH credential reference');
        try { await validateManagedSshCredential(credentialId); }
        catch { throw bindingInputError('Selected managed SSH credential is unavailable'); }
      }
      if (input.transport === 'https') {
        const account = input.credentialAccount;
        if (!isPlainObject(account) || !hasExactKeys(account, ['provider', 'instance', 'accountId'])
          || !isString(account.provider) || !sourceControlProviderDescriptors.has(account.provider)) throw bindingInputError('Credential account is invalid');
        const reference = {
          provider: account.provider,
          instance: normalizeProviderInstance(account.provider, account.instance),
          accountId: requiredString(account.accountId, 'credential accountId'),
        };
        if (reference.accountId !== account.accountId) throw bindingInputError('Credential account is invalid');
        const origin = providerOrigin(reference.provider, reference.instance);
        for (const endpoint of [remote.fetch, remote.push]) {
          let parsed;
          try { parsed = normalizeGitRemoteEndpoint(endpoint.rawUrl); }
          catch { throw bindingInputError('Managed HTTPS endpoint is invalid'); }
          if (!endpointIsInstanceOrigin(sourceControlProviderDescriptors.get(reference.provider), origin, parsed)) {
            throw bindingInputError('Credential account does not match the HTTPS endpoint');
          }
        }
        const resolved = await readTransportAccount?.(reference);
        const id = resolved?.credentialId;
        const revision = resolved?.credentialRevision;
        const providerUserId = resolved?.providerUserId;
        const secret = resolved?.secret;
        if (id !== reference.accountId || resolved?.status !== 'valid'
          || !isSafeInteger(revision) || revision < 1
          || !isString(providerUserId) || !providerUserId.startsWith(`${reference.instance}#`)
          || !isString(secret) || !secret || /[\r\n\0]/.test(secret)) {
          throw bindingInputError('Selected credential account is unavailable');
        }
        credentialId = createHttpsCredentialReference({
          provider: reference.provider,
          instance: reference.instance,
          credentialId: id,
          credentialRevision: revision,
          providerUserId,
        });
      }
      const selected: BindingDraft['remotes'][number] = { name: remote.name,
        fetch: { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint },
        push: { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint },
        mode: input.transport === 'anonymous' ? 'anonymous' : input.transport === 'system' ? 'system' : 'managed',
        readiness: 'ready',
      };
      if (credentialId) selected.credentialId = credentialId;
      const remotes: BindingDraft['remotes'] = [...(binding?.remotes ?? [])];
      const index = remotes.findIndex((entry) => entry.name === selected.name);
      if (index < 0) remotes.push(selected);
      else remotes[index] = selected;
      const latest = await resolveWith(input.directory, resolveTransportRepository);
      if (latest.repositoryId !== context.repositoryId || latest.configRevision !== context.configRevision) {
        throw conflict(await readCurrent(latest));
      }
      const latestRemote = latest.remotes.find((entry) => entry.name === remote.name);
      if (!latestRemote || !latestRemote.fetch || !latestRemote.push
        || latestRemote.fetch.fingerprint !== remote.fetch.fingerprint
        || latestRemote.push.fingerprint !== remote.push.fingerprint) throw conflict(await readCurrent(latest));
      const record = await store.compareAndSwap(context.repositoryId, input.expectedRevision, {
        ...(binding ?? { providers: [], auxiliary: [], state: 'bound' }),
        configRevision: context.configRevision, remotes,
      });
      return { repository: publicContext(context), ...record, binding: resolveBindingReadiness(record.binding, context) };
    },
    removeTransportBinding: async (input: BindingIntentRequest) => {
      const keys = ['directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision',
        'expectedFetchFingerprint', 'expectedPushFingerprint', 'remote'];
      if (!isPlainObject(input) || !hasExactKeys(input, keys)) {
        throw bindingInputError('Git transport binding removal intent is invalid');
      }
      assertExactStrings(input, ['expectedRepositoryId', 'expectedConfigRevision', 'expectedFetchFingerprint', 'expectedPushFingerprint', 'remote'] as const);
      if (!isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw bindingInputError('expectedRevision is required');
      }
      const context = await resolveWith(input.directory, resolveTransportRepository);
      const current = await readCurrent(context);
      const conflict = (authority = current) => staleBindingError('Repository transport authority changed. Reload before removing it.', authority);
      if (context.repositoryId !== input.expectedRepositoryId || context.configRevision !== input.expectedConfigRevision
        || current.revision !== input.expectedRevision || !current.binding) throw conflict();
      const remote = context.remotes.find((candidate) => candidate.name === input.remote);
      const grant = current.binding.remotes.find((candidate) => candidate.name === input.remote);
      if (!remote || !remote.fetch || !remote.push
        || remote.fetch.fingerprint !== input.expectedFetchFingerprint
        || remote.push.fingerprint !== input.expectedPushFingerprint
        || !grant || grant.fetch.fingerprint !== input.expectedFetchFingerprint
        || grant.push.fingerprint !== input.expectedPushFingerprint) throw conflict();
      const latest = await resolveWith(input.directory, resolveTransportRepository);
      if (latest.repositoryId !== context.repositoryId || latest.configRevision !== context.configRevision) {
        throw conflict(await readCurrent(latest));
      }
      const latestRemote = latest.remotes.find((candidate) => candidate.name === input.remote);
      if (!latestRemote || !latestRemote.fetch || !latestRemote.push
        || latestRemote.fetch.fingerprint !== remote.fetch.fingerprint
        || latestRemote.push.fingerprint !== remote.push.fingerprint) throw conflict(await readCurrent(latest));
      const remotes = current.binding.remotes.filter((candidate) => candidate.name !== input.remote);
      const record = await store.compareAndSwap(context.repositoryId, input.expectedRevision, {
        ...current.binding,
        remotes,
        state: bindingSummary({ ...current.binding, remotes }),
      });
      return { repository: publicContext(context), ...record, binding: resolveBindingReadiness(record.binding, context) };
    },
    configureAuxiliaryBinding: async (input: BindingIntentRequest) => {
      const commonKeys = [
        'operation', 'directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision',
        'parentRemote', 'expectedParentFingerprint', 'kind', 'path', 'expectedEndpointFingerprint',
      ];
      const extraKeys = input?.operation === 'configure'
        ? input.transport === 'system' ? ['transport', 'unverifiedConfirmed']
          : input.transport === 'https' ? ['transport', 'credentialAccount']
            : input.transport === 'ssh' ? ['transport', 'sshCredentialId'] : ['transport']
        : [];
      if (!isPlainObject(input) || !isOneOf(['configure', 'remove'] as const, input.operation)
        || input.operation === 'configure' && !isOneOf(['system', 'https', 'ssh', 'anonymous'] as const, input.transport)
        || !hasExactKeys(input, commonKeys, extraKeys)
        || !isOneOf(['submodule', 'lfs'] as const, input.kind)
        || !(resolveCheckoutAuxiliary instanceof Function)) {
        throw bindingInputError('Git auxiliary binding intent is invalid');
      }
      if (!isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw bindingInputError('expectedRevision is required');
      }
      assertExactStrings(input, ['expectedRepositoryId', 'expectedConfigRevision', 'parentRemote',
        'expectedParentFingerprint', 'expectedEndpointFingerprint'] as const);
      const checkoutPath = requiredString(input.path, 'path');
      if (checkoutPath !== input.path || checkoutPath.length > 4096 || new RegExp(String.raw`[\0-\x1f\x7f]`).test(checkoutPath)
        || checkoutPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(checkoutPath)
        || checkoutPath.includes('\\') || checkoutPath === '..' || checkoutPath.startsWith('../')
        || checkoutPath.includes('/../')) throw bindingInputError('path is invalid');
      if (input.operation === 'configure' && input.transport === 'system' && input.unverifiedConfirmed !== true) {
        throw bindingInputError('Explicit confirmation of unverified System Git is required');
      }
      assertRequiredString(input.directory, 'directory');
      const context = await resolveWith(input.directory, resolveTransportRepository);
      const current = await readCurrent(context);
      const conflict = (authority = current) => staleBindingError('Repository auxiliary authority changed. Reload before editing.', authority);
      if (context.repositoryId !== input.expectedRepositoryId || context.configRevision !== input.expectedConfigRevision
        || current.revision !== input.expectedRevision || !current.binding) throw conflict();
      const parent = context.remotes.find((entry) => entry.name === input.parentRemote);
      if (!parent || !parent.fetch || parent.fetch.fingerprint !== input.expectedParentFingerprint) throw conflict();
      const parentAuthority = await validateGitTransportContext({
        directory: input.directory,
        repositoryId: input.expectedRepositoryId,
        bindingRevision: input.expectedRevision,
        configRevision: input.expectedConfigRevision,
        remote: input.parentRemote,
        endpointKind: 'fetch',
      });
      const { directory, parentRemote, kind } = input;
      const discover = () => resolveCheckoutAuxiliary({
        directory,
        parentEndpoint: parentAuthority.endpoint,
        parentRemoteName: parentRemote,
        kind,
        path: checkoutPath,
      });
      const discovered = await discover();
      if (!discovered || discovered.kind !== input.kind || discovered.path !== checkoutPath
        || discovered.endpoint?.fingerprint !== input.expectedEndpointFingerprint
        || !isSafeRepositoryEndpoint(discovered.endpoint)) throw conflict();

      const auxiliary: BindingDraft['auxiliary'] = [...current.binding.auxiliary];
      const exactIndex = auxiliary.findIndex((entry) => entry.kind === input.kind
        && entry.endpoint.fingerprint === discovered.endpoint.fingerprint);
      const carried = exactIndex < 0 && discovered.rawEndpoint
        ? carriedOverAuxiliaryGrant(auxiliary, input.kind, discovered.rawEndpoint, discovered.derivedFromRemote) : undefined;
      const targetIndex = carried ? auxiliary.indexOf(carried) : exactIndex;
      if (input.operation === 'remove') {
        if (targetIndex < 0) throw conflict();
        auxiliary.splice(targetIndex, 1);
      } else {
        const endpointProtocol = normalizeGitRemoteEndpoint(discovered.endpoint.displayUrl).protocol;
        if (input.transport === 'anonymous' && endpointProtocol !== 'https') {
          throw readContextError('RUNTIME_UNSUPPORTED', 'Anonymous auxiliary transport requires HTTPS', 501);
        }
        let credentialId;
        if (input.transport === 'ssh') {
          if (endpointProtocol !== 'ssh') throw bindingInputError('Managed SSH credentials require an SSH endpoint');
          if (!(validateManagedSshCredential instanceof Function)) {
            throw readContextError('RUNTIME_UNSUPPORTED', 'Managed SSH inventory is unavailable', 501);
          }
          credentialId = requiredString(input.sshCredentialId, 'SSH credential reference');
          try { await validateManagedSshCredential(credentialId); }
          catch { throw bindingInputError('Selected managed SSH credential is unavailable'); }
        } else if (input.transport === 'https') {
          if (!['https', 'http'].includes(endpointProtocol)) throw bindingInputError('Managed HTTPS credentials require an HTTPS endpoint');
          const account = input.credentialAccount;
          if (!isPlainObject(account) || !hasExactKeys(account, ['provider', 'instance', 'accountId'])
            || !isString(account.provider) || !sourceControlProviderDescriptors.has(account.provider)) throw bindingInputError('Credential account is invalid');
          const reference = {
            provider: account.provider,
            instance: normalizeProviderInstance(account.provider, account.instance),
            accountId: requiredString(account.accountId, 'credential accountId'),
          };
          if (reference.accountId !== account.accountId) throw bindingInputError('Credential account is invalid');
          const origin = providerOrigin(reference.provider, reference.instance);
          const endpoint = normalizeGitRemoteEndpoint(discovered.endpoint.displayUrl);
          if (!endpointIsInstanceOrigin(sourceControlProviderDescriptors.get(reference.provider), origin, endpoint)) {
            throw bindingInputError('Credential account does not match the HTTPS endpoint');
          }
          const resolved = await readTransportAccount?.(reference);
          const secret = resolved?.secret;
          if (resolved?.credentialId !== reference.accountId || resolved?.status !== 'valid'
            || !Number.isSafeInteger(resolved?.credentialRevision) || resolved.credentialRevision < 1
            || !isString(resolved?.providerUserId) || !resolved.providerUserId.startsWith(`${reference.instance}#`)
            || !isString(secret) || !secret || /[\r\n\0]/.test(secret)) {
            throw bindingInputError('Selected credential account is unavailable');
          }
          credentialId = createHttpsCredentialReference({
            provider: reference.provider,
            instance: reference.instance,
            credentialId: resolved.credentialId,
            credentialRevision: resolved.credentialRevision,
            providerUserId: resolved.providerUserId,
          });
        }
        const selected: BindingDraft['auxiliary'][number] = {
          kind: input.kind,
          endpoint: discovered.endpoint,
          mode: input.transport === 'system' ? 'system' : input.transport === 'anonymous' ? 'anonymous' : 'managed',
          readiness: 'ready',
        };
        if (credentialId) selected.credentialId = credentialId;
        if (targetIndex < 0) auxiliary.push(selected);
        else auxiliary[targetIndex] = selected;
      }
      const latest = await resolveWith(input.directory, resolveTransportRepository);
      if (latest.repositoryId !== context.repositoryId || latest.configRevision !== context.configRevision) {
        throw conflict(await readCurrent(latest));
      }
      const latestParent = latest.remotes.find((entry) => entry.name === input.parentRemote);
      if (!latestParent || !latestParent.fetch
        || latestParent.fetch.fingerprint !== parent.fetch.fingerprint) throw conflict(await readCurrent(latest));
      const rediscovered = await discover();
      if (!rediscovered || rediscovered.kind !== input.kind || rediscovered.path !== checkoutPath
        || rediscovered.endpoint?.fingerprint !== discovered.endpoint.fingerprint
        || rediscovered.endpoint?.displayUrl !== discovered.endpoint.displayUrl) throw conflict(await readCurrent(latest));
      const record = await store.compareAndSwap(context.repositoryId, input.expectedRevision, {
        ...current.binding,
        auxiliary,
        state: bindingSummary({ ...current.binding, auxiliary }),
      });
      return { repository: publicContext(context), ...record, binding: resolveBindingReadiness(record.binding, context) };
    },
    mutateProvider: async (input: BindingIntentRequest) => {
      if (!isPlainObject(input) || !isOneOf(['add', 'replace', 'remove'] as const, input.operation)
        || !hasExactKeys(input, ['directory', 'expectedRepositoryId', 'expectedRevision', 'operation',
          ...(input.operation === 'add' ? [] : ['target']),
          ...(input.operation === 'remove' ? [] : ['provider'])])) {
        throw bindingInputError('Provider binding mutation is invalid');
      }
      const expectedRepositoryId = requiredString(input.expectedRepositoryId, 'expectedRepositoryId');
      if (expectedRepositoryId !== input.expectedRepositoryId) throw bindingInputError('expectedRepositoryId is invalid');
      if (!isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw bindingInputError('expectedRevision is required');
      }
      const context = await resolve(input.directory);
      if (context.repositoryId !== expectedRepositoryId) {
        throw readContextError('SOURCE_CONTROL_BINDING_REPOSITORY_MISMATCH',
          'Repository identity changed. Reload the repository before editing its provider binding.', 409);
      }
      const current = await readCurrent(context);
      if (current.revision !== input.expectedRevision) {
        throw staleBindingError('Source control repository binding changed. Reload before editing.', current);
      }
      const binding = current.binding;
      const providers = [...(binding?.providers ?? [])];
      let targetIndex = -1;
      if (input.operation !== 'add') {
        const parsedTarget = parseProviderTarget(input.target);
        targetIndex = providers.findIndex((candidate) => candidate.provider === parsedTarget.provider
          && providerInstanceKey(candidate.provider, candidate.instance) === parsedTarget.instance
          && candidate.accountId === parsedTarget.accountId && candidate.primaryRemote === parsedTarget.primaryRemote);
        if (targetIndex < 0) throw staleBindingError('The edited provider association changed. Reload before editing.', current);
      }
      if (input.operation === 'remove') {
        providers.splice(targetIndex, 1);
      } else {
        if (!isPlainObject(input.provider)
          || !hasExactKeys(input.provider, ['provider', 'instance', 'accountId', 'primaryRemote'], ['repository'])
          || (input.provider.repository !== undefined && (!isPlainObject(input.provider.repository)
            || !hasExactKeys(input.provider.repository, ['owner', 'name'])))) {
          throw bindingInputError('Provider binding is invalid');
        }
        const sshUrls = await sshUrlsFor([{ provider: input.provider.provider, instance: input.provider.instance }]);
        const [provider] = await parseProviders([input.provider], context.remotes, { reachesInstance, sshUrls });
        const previous = providers[targetIndex];
        if (previous?.endpoint && previous.primaryRemote === provider.primaryRemote) {
          provider.endpoint = previous.endpoint;
          assignRepository(provider, await providerRepositoryForEndpoint(provider.provider, provider.instance, previous.endpoint,
            { reachesInstance, sshUrl: sshUrls.get(`${provider.provider}\0${provider.instance}`) ?? null }));
        }
        if (providers.some((candidate, index) => index !== targetIndex && candidate.provider === provider.provider
          && normalizeProviderInstance(candidate.provider, candidate.instance) === provider.instance
          && candidate.primaryRemote === provider.primaryRemote)) {
          throw staleBindingError('A provider association already exists for this remote. Edit that association instead.', current);
        }
        if (input.operation === 'add') providers.push(provider);
        else providers[targetIndex] = provider;
      }
      const latest = await resolve(input.directory);
      if (latest.repositoryId !== context.repositoryId || latest.configRevision !== context.configRevision) {
        throw staleBindingError('Repository provider authority changed. Reload before editing.', current);
      }
      const record = await store.compareAndSwap(context.repositoryId, input.expectedRevision, resolveBindingReadiness({
        ...(binding ?? { remotes: [], auxiliary: [], state: 'bound', configRevision: context.configRevision }),
        providers,
      }, context));
      return { repository: publicContext(context), ...record, binding: resolveBindingReadiness(record.binding, context) };
    },
    set: async (input: Pick<BindingIntent, 'directory' | 'expectedRepositoryId' | 'expectedRevision' | 'expectedConfigRevision' | 'binding'>) => {
      if (!isPlainObject(input) || !hasExactKeys(input, [
        'directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision', 'binding',
      ])) throw bindingInputError('Whole source control binding replacement is invalid');
      const { directory, expectedRepositoryId, expectedRevision, expectedConfigRevision, binding } = input;
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw bindingInputError('expectedRevision is required');
      if (!isPlainObject(binding) || !hasExactKeys(binding, ['providers', 'remotes', 'state'], ['auxiliary'])) {
        throw bindingInputError('binding is required');
      }
      const context = await resolve(directory);
      const current = await readCurrent(context);
      const conflict = () => staleBindingError('Repository binding authority changed. Reload before replacing it.', current);
      const repositoryAuthority = requiredString(expectedRepositoryId, 'expectedRepositoryId');
      const configAuthority = requiredString(expectedConfigRevision, 'expectedConfigRevision');
      if (repositoryAuthority !== expectedRepositoryId || configAuthority !== expectedConfigRevision
        || repositoryAuthority !== context.repositoryId || configAuthority !== context.configRevision
        || current.revision !== expectedRevision) throw conflict();
      if (binding.state !== 'bound' && binding.state !== 'needs-attention') throw bindingInputError('binding state is invalid');
      const state = binding.state;
      const sshUrls = await sshUrlsFor(binding.providers);
      const providers = await parseProviders(binding.providers, context.remotes, { reachesInstance, sshUrls });
      const remotes = parseRemotes(binding.remotes, context.remotes);
      const auxiliary = parseAuxiliary(binding.auxiliary);
      const latest = await resolve(directory);
      if (latest.repositoryId !== context.repositoryId || latest.configRevision !== context.configRevision) throw conflict();
      const record = await store.compareAndSwap(context.repositoryId, expectedRevision, {
        providers,
        remotes,
        auxiliary,
        state,
        configRevision: context.configRevision,
      });
      return { repository: publicContext(context), ...record };
    },
    resetRepositoryBinding: async (input: BindingIntentRequest) => {
      if (!isPlainObject(input) || !hasExactKeys(input, [
        'directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision', 'confirmed',
      ]) || input.confirmed !== true) throw bindingInputError('Explicit confirmation is required to reset a source control binding');
      const { directory, expectedRepositoryId, expectedRevision, expectedConfigRevision } = input;
      if (!isInteger(expectedRevision) || expectedRevision < 0) throw bindingInputError('expectedRevision is required');
      const context = await resolve(directory);
      const current = await readCurrent(context);
      const conflict = () => staleBindingError('Repository binding authority changed. Reload before resetting it.', current);
      const repositoryAuthority = requiredString(expectedRepositoryId, 'expectedRepositoryId');
      const configAuthority = requiredString(expectedConfigRevision, 'expectedConfigRevision');
      if (repositoryAuthority !== expectedRepositoryId || configAuthority !== expectedConfigRevision
        || repositoryAuthority !== context.repositoryId || configAuthority !== context.configRevision
        || current.revision !== expectedRevision || !current.binding) throw conflict();
      const latest = await resolve(directory);
      if (latest.repositoryId !== context.repositoryId || latest.configRevision !== context.configRevision) throw conflict();
      const record = await store.compareAndSwap(context.repositoryId, expectedRevision, null);
      return { repository: publicContext(context), ...record };
    },
    accountConnected: async (identity: AccountIdentity & { credentialRevision: number; providerUserId: string }) => {
      if (!isPlainObject(identity)) throw bindingInputError('account identity is required');
      const provider = requiredString(identity.provider, 'provider');
      if (!isProviderId(provider)) throw bindingInputError('provider is unsupported');
      if (!sourceControlProviderDescriptors.has(provider) || !(store.adoptAccount instanceof Function)) return [];
      return store.adoptAccount({
        provider,
        instance: normalizeProviderInstance(provider, identity.instance),
        accountId: requiredIdentityString(identity.accountId, 'accountId', provider),
        credentialRevision: identity.credentialRevision,
        providerUserId: requiredIdentityString(identity.providerUserId, 'providerUserId', provider),
      });
    },
    accountUnavailable: async (identity: AccountIdentityRequest) => {
      if (!isPlainObject(identity)) throw bindingInputError('account identity is required');
      const provider = requiredString(identity.provider, 'provider');
      if (!isProviderId(provider)) throw bindingInputError('provider is unsupported');
      if (!sourceControlProviderDescriptors.has(provider)) return [];
      return store.reconcileAccount({
        provider,
        instance: normalizeProviderInstance(provider, identity.instance),
        accountId: requiredIdentityString(identity.accountId, 'accountId', provider),
      });
    },
  };
}
