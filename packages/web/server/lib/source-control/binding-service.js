import { normalizeSourceControlProviderInstance } from './provider-instance.js';
import { resolvePrivateRepositoryIdentity } from './repository-identity.js';
import { fingerprintRemoteUrl, redactRemoteUrl } from './url-redaction.js';
import { createHttpsCredentialReference, normalizeGitRemoteEndpoint, parseGitCredentialReference } from '../git/credential-resolver.js';
import { bindingSummary, isSafeRepositoryEndpoint, resolveBindingReadiness } from './binding-contract.js';

const bindingInputError = (message) => {
  const error = new Error(message);
  error.code = 'INVALID_SOURCE_CONTROL_BINDING';
  error.status = 400;
  return error;
};

const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const safePresentationText = (value, maximum = 512) => isString(value) && value.length > 0
  && value.length <= maximum && value.trim() === value && !/[\0\r\n]/.test(value);
const safeProviderUsername = (value) => safePresentationText(value, 255) && /^[A-Za-z0-9_.-]+$/.test(value);
const hasExactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};

const requiredString = (value, name, makeError = bindingInputError) => {
  if (!isString(value) || !value.trim()) throw makeError(`${name} is required`);
  return value.trim();
};

const providerRepositoryForEndpoint = (provider, instance, endpoint) => {
  if (!isSafeRepositoryEndpoint(endpoint)) throw bindingInputError('provider endpoint is invalid');
  let normalized;
  try { normalized = normalizeGitRemoteEndpoint(endpoint.displayUrl); }
  catch { throw bindingInputError('provider endpoint is invalid'); }
  const origin = new URL(provider === 'github' ? 'https://github.com' : instance);
  const expectedPort = Number(origin.port || (origin.protocol === 'http:' ? 80 : 443));
  if (normalized.host !== origin.hostname.toLowerCase()
    || (normalized.protocol !== 'ssh' && normalized.port !== expectedPort)) {
    throw bindingInputError('provider instance does not match the selected remote host');
  }
  const parts = normalized.path.replace(/\.git$/i, '').split('/');
  if (parts.length < 2 || parts.some((part) => !part)) throw bindingInputError('provider repository path is invalid');
  return { owner: parts.slice(0, -1).join('/'), name: parts.at(-1) };
};

const parseProviders = (value, repositoryRemotes) => {
  if (!Array.isArray(value)) throw bindingInputError('providers must be an array');
  const availableRemotes = new Set(repositoryRemotes.map((remote) => remote.name));
  const bindings = value.map((provider) => {
    if (!isPlainObject(provider) || !hasExactKeys(provider,
      ['provider', 'instance', 'accountId', 'primaryRemote'], ['repository'])) throw bindingInputError('provider binding is invalid');
    const name = requiredString(provider.provider, 'provider');
    if (name !== 'github' && name !== 'gitlab') throw bindingInputError('provider is unsupported');
    const primaryRemote = requiredString(provider.primaryRemote, 'primaryRemote');
    if (!availableRemotes.has(primaryRemote)) throw bindingInputError(`remote ${primaryRemote} does not exist`);
    const endpoint = repositoryRemotes.find((remote) => remote.name === primaryRemote)?.fetch;
    if (!endpoint) throw bindingInputError(`remote ${primaryRemote} does not have a fetch endpoint`);
    const instance = normalizeProviderInstance(name, provider.instance);
    const repository = providerRepositoryForEndpoint(name, instance, endpoint);
    const result = {
      provider: name,
      instance,
      accountId: requiredString(provider.accountId, 'accountId'),
      primaryRemote,
      readiness: 'ready',
      endpoint: { displayUrl: endpoint.displayUrl, fingerprint: endpoint.fingerprint },
      repository,
    };
    if (provider.repository !== undefined) {
      if (!isPlainObject(provider.repository) || !hasExactKeys(provider.repository, ['owner', 'name'])) {
        throw bindingInputError('provider repository is invalid');
      }
      const requestedRepository = {
        owner: requiredString(provider.repository.owner, 'repository owner'),
        name: requiredString(provider.repository.name, 'repository name'),
      };
      if (requestedRepository.owner !== repository.owner || requestedRepository.name !== repository.name) {
        throw bindingInputError('provider repository does not match the selected remote');
      }
    }
    return result;
  });
  const keys = bindings.map((binding) => `${binding.provider}\0${binding.instance}\0${binding.primaryRemote}`);
  if (new Set(keys).size !== keys.length) throw bindingInputError('provider bindings must be unique');
  return bindings;
};

const parseRemotes = (value, repositoryRemotes) => {
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
    const result = { name, fetch: resolved.fetch, push: resolved.push, mode: remote.mode,
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

const parseAuxiliary = (value) => {
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
    const result = {
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

const publicContext = (context) => {
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

const normalizeProviderInstance = (provider, instance, makeError = bindingInputError) => {
  const value = requiredString(instance, 'instance', makeError);
  try {
    return normalizeSourceControlProviderInstance(provider, value);
  } catch {
    throw makeError('instance is invalid');
  }
};

const readContextError = (code, message, status) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const mutationContextError = (message) => readContextError(
  'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
  message,
  400,
);

const staleBindingError = (message, current) => {
  const error = readContextError('SOURCE_CONTROL_BINDING_STALE', message, 409);
  error.current = current;
  return error;
};

const transportContextError = (message) => readContextError(
  'INVALID_GIT_TRANSPORT_CONTEXT',
  message,
  400,
);

const parseTarget = (value) => {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['project'], ['number', 'head', 'base', 'headSha'])
    || !isPlainObject(value.project)
    || !hasExactKeys(value.project, ['owner', 'name'])) {
    throw mutationContextError('Source control mutation target is invalid');
  }
  const target = {
    project: {
      owner: requiredString(value.project.owner, 'target project owner', mutationContextError),
      name: requiredString(value.project.name, 'target project name', mutationContextError),
    },
  };
  if (value.number !== undefined) {
    if (!Number.isSafeInteger(value.number) || value.number < 1) throw mutationContextError('target number is invalid');
    target.number = value.number;
  }
  for (const key of ['head', 'base', 'headSha']) {
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
}) {
  const resolveWith = async (directory, resolver) => {
    const normalizedDirectory = requiredString(directory, 'directory');
    const context = await resolver(normalizedDirectory);
    if (!context.supported) {
      const error = new Error('Directory is not a supported Git repository');
      error.code = 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY';
      error.reason = context.reason;
      throw error;
    }
    return context;
  };
  const resolve = (directory) => resolveWith(directory, resolveRepository);
  const readCurrent = async (context) => {
    const record = await store.read(context.repositoryId);
    return { repository: publicContext(context), revision: record.revision,
      binding: record.binding ? resolveBindingReadiness(record.binding, context) : null };
  };
  const unavailablePresentation = () => ({ status: 'unavailable' });
  const resolveCredentialPresentation = async (credentialId, deadline) => {
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
        || account.status !== 'valid' || !['oauth', 'pat', 'cli'].includes(account.source)
        || !Number.isInteger(account.user?.id) || account.user.id < 0
        || !safeProviderUsername(account.user.login)
        || account.providerUserId !== (reference.provider === 'github'
          ? `github.com#${account.user.id}` : `${instance}#${account.user.id}`)) return unavailablePresentation();
      return {
        status: 'available', transport: 'https', provider: reference.provider, instance,
        source: account.source, username: account.user.login, providerUserId: account.providerUserId,
      };
    } catch {
      return unavailablePresentation();
    }
  };
  const presentRead = async (read) => {
    if (!read.binding) return read;
    const managed = [...new Set(read.binding.remotes
      .filter((remote) => remote.mode === 'managed')
      .map((remote) => remote.credentialId))];
    const presentations = new Map();
    const deadline = Date.now() + 10_000;
    for (let index = 0; index < Math.min(managed.length, 256); index += 8) {
      const batch = managed.slice(index, index + 8);
      await Promise.all(batch.map(async (credentialId) => {
        presentations.set(credentialId, await resolveCredentialPresentation(credentialId, deadline));
      }));
    }
    return { ...read, binding: { ...read.binding,
      remotes: read.binding.remotes.map((remote) => {
        if (remote.mode !== 'managed') return remote;
        const presentation = presentations.get(remote.credentialId) ?? unavailablePresentation();
        return { ...remote, presentation };
      }),
    } };
  };
  const validateAuthority = async (input, makeContextError, makeRequiredFieldError = makeContextError) => {
    if (!isPlainObject(input)) throw makeContextError('Source control read context is required');
    const directory = requiredString(input.directory, 'directory', makeRequiredFieldError);
    const repositoryId = requiredString(input.repositoryId, 'repositoryId', makeRequiredFieldError);
    const provider = requiredString(input.provider, 'provider', makeRequiredFieldError);
    if (provider !== 'github' && provider !== 'gitlab') throw makeContextError('Source control provider is invalid');
    const instance = normalizeProviderInstance(provider, input.instance, makeRequiredFieldError);
    const accountId = requiredString(input.accountId, 'accountId', makeRequiredFieldError);
    const primaryRemote = requiredString(input.primaryRemote, 'primaryRemote', makeRequiredFieldError);
    const bindingRevision = input.bindingRevision;
    if (!Number.isInteger(bindingRevision) || bindingRevision < 1) throw makeContextError('bindingRevision is required');

    const context = await resolve(directory);
    if (context.repositoryId !== repositoryId) {
      throw readContextError('SOURCE_CONTROL_BINDING_REPOSITORY_MISMATCH', 'Source control repository binding does not match this directory', 409);
    }
    const current = await readCurrent(context);
    if (!current.binding) throw readContextError('SOURCE_CONTROL_BINDING_MISSING', 'Source control repository is not bound', 409);
    if (current.revision !== bindingRevision || current.binding.revision !== bindingRevision) {
      throw staleBindingError('Source control repository binding changed', current);
    }
    if (current.binding.configRevision !== context.configRevision) {
      throw staleBindingError('Source control repository remotes changed', current);
    }
    const boundProvider = current.binding.providers.find((candidate) => candidate.provider === provider
      && normalizeProviderInstance(candidate.provider, candidate.instance) === instance
      && candidate.accountId === accountId
      && candidate.primaryRemote === primaryRemote);
    if (!boundProvider) {
      throw readContextError('SOURCE_CONTROL_BINDING_CONTEXT_MISMATCH', 'Source control repository binding context does not match', 409);
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
  const invalidReadInput = (message) => readContextError('INVALID_SOURCE_CONTROL_READ_CONTEXT', message, 400);
  const parseProviderTarget = (target) => {
    if (!isPlainObject(target) || !hasExactKeys(target, ['provider', 'instance', 'accountId', 'primaryRemote'])) {
      throw bindingInputError('Provider binding target is invalid');
    }
    const provider = requiredString(target.provider, 'provider');
    if (provider !== 'github' && provider !== 'gitlab') throw bindingInputError('provider is unsupported');
    return {
      provider,
      instance: normalizeProviderInstance(provider, target.instance),
      accountId: requiredString(target.accountId, 'accountId'),
      primaryRemote: requiredString(target.primaryRemote, 'primaryRemote'),
    };
  };
  const validateGitTransportContext = async (input) => {
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
    if (!Number.isInteger(bindingRevision) || bindingRevision < 1) {
      throw transportContextError('bindingRevision is required');
    }

    const context = await resolveWith(directory, resolveTransportRepository);
    const transportRevision = requiredString(context.transportRevision, 'transportRevision', transportContextError);
    const current = await readCurrent(context);
    const conflict = (message) => staleBindingError(message, current);
    if (context.repositoryId !== repositoryId) throw conflict('Git transport repository changed');
    if (!current.binding) throw conflict('Git transport repository is not bound');
    if (current.revision !== bindingRevision || current.binding.revision !== bindingRevision) {
      throw conflict('Git transport binding changed');
    }
    if (context.configRevision !== configRevision) {
      throw conflict('Git transport repository remotes changed');
    }
    const repositoryRemote = context.remotes.find((candidate) => candidate.name === remote);
    const boundRemote = current.binding.remotes.find((candidate) => candidate.name === remote);
    if (!repositoryRemote || !boundRemote) throw conflict('Git transport remote binding changed');
    if (boundRemote.readiness !== 'ready') throw conflict('Git transport remote binding needs attention');
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

    const authority = {
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
    return Object.freeze(authority);
  };
  const validateGitAuxiliaryContext = async (input) => {
    const requiredKeys = ['directory', 'repositoryId', 'bindingRevision', 'configRevision', 'kind', 'rawEndpoint'];
    if (!isPlainObject(input) || !hasExactKeys(input, requiredKeys)
      || !['submodule', 'lfs'].includes(input.kind)) {
      throw transportContextError('Git auxiliary transport context is invalid');
    }
    const directory = requiredString(input.directory, 'directory', transportContextError);
    const repositoryId = requiredString(input.repositoryId, 'repositoryId', transportContextError);
    const configRevision = requiredString(input.configRevision, 'configRevision', transportContextError);
    const rawEndpoint = requiredString(input.rawEndpoint, 'rawEndpoint', transportContextError);
    if (!Number.isInteger(input.bindingRevision) || input.bindingRevision < 1) {
      throw transportContextError('bindingRevision is required');
    }
    const context = await resolveWith(directory, resolveTransportRepository);
    const current = await readCurrent(context);
    const conflict = (message) => staleBindingError(message, current);
    if (context.repositoryId !== repositoryId || context.configRevision !== configRevision) {
      throw conflict('Git auxiliary repository authority changed');
    }
    if (!current.binding || current.revision !== input.bindingRevision
      || current.binding.revision !== input.bindingRevision) {
      throw conflict('Git auxiliary binding changed');
    }
    const fingerprint = fingerprintRemoteUrl(rawEndpoint);
    const displayUrl = redactRemoteUrl(rawEndpoint);
    const grant = current.binding.auxiliary.find((entry) => entry.kind === input.kind
      && entry.endpoint.fingerprint === fingerprint && entry.endpoint.displayUrl === displayUrl);
    if (!grant || grant.readiness !== 'ready') throw readContextError('GIT_AUXILIARY_AUTHORIZATION_REQUIRED', 'Git auxiliary endpoint authorization is required', 409);
    const authority = {
      directory, repositoryId, bindingRevision: input.bindingRevision, configRevision,
      transportRevision: requiredString(context.transportRevision, 'transportRevision', transportContextError),
      kind: input.kind, endpoint: rawEndpoint, endpointFingerprint: fingerprint,
      transportMode: grant.mode,
    };
    if (grant.credentialId) authority.credentialId = grant.credentialId;
    return Object.freeze(authority);
  };

  return {
    resolveContext: async (directory) => publicContext(await resolve(directory)),
    // Endpoints and modes only: the caller decides which hosts OpenChamber
    // answers for, and learns nothing else about any repository.
    listRemoteGrants: () => store.listRemoteGrants(),
    get: async (directory) => presentRead(await readCurrent(await resolve(directory))),
    present: presentRead,
    validateReadContext: (input) => validateAuthority(input, invalidReadInput, bindingInputError),
    validateMutationContext: async (input) => {
      const context = await validateAuthority(input, mutationContextError);
      return {
        ...context,
        idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey', mutationContextError),
        target: parseTarget(input.target),
      };
    },
    validateGitTransportContext,
    validateGitAuxiliaryContext,
    // Only the clone executor can transfer its captured grant to a newly published checkout.
    bindClonedRepository: async ({ directory, approvedEndpoint, transportMode, credentialId, unverifiedConfirmed, providerAccount, auxiliaryGrants = [] }) => {
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
      const selected = { name: 'origin', fetch: endpoint, push: endpoint, mode: transportMode, readiness: 'ready' };
      if (credentialId) selected.credentialId = credentialId;
      const auxiliary = parseAuxiliary(auxiliaryGrants.map((grant) => {
        const input = { kind: grant.kind, endpoint: grant.endpoint, mode: grant.transportMode };
        if (grant.credentialId) input.credentialId = grant.credentialId;
        if (grant.transportMode === 'system') input.unverifiedConfirmed = grant.unverifiedConfirmed;
        return input;
      }));
      // The account chosen while cloning is the account this repository acts
      // as. Persisting it here is what stops the setup asking for the same
      // answer a second time before issues and change requests work.
      // The transport resolver carries the raw URL alongside the redacted
      // endpoint; the provider contract accepts only the redacted pair.
      const providers = providerAccount
        ? parseProviders([{ ...providerAccount, primaryRemote: 'origin' }], [{ name: 'origin', fetch: endpoint, push: endpoint }])
        : [];
      return store.compareAndSwap(context.repositoryId, 0, {
        configRevision: context.configRevision, providers, remotes: [selected], auxiliary,
        state: bindingSummary({ providers, remotes: [selected], auxiliary }),
      });
    },
    configureTransportBinding: async (input) => {
      const keys = ['directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision',
        'expectedFetchFingerprint', 'expectedPushFingerprint', 'remote', 'transport'];
      if (!isPlainObject(input) || !['system', 'https', 'ssh', 'anonymous'].includes(input.transport)
        || !hasExactKeys(input, [...keys, ...(input.transport === 'system' ? ['unverifiedConfirmed']
          : input.transport === 'https' ? ['credentialAccount'] : input.transport === 'ssh' ? ['sshCredentialId'] : [])])) {
        throw bindingInputError('Git transport binding intent is invalid');
      }
      if (input.transport === 'system' && input.unverifiedConfirmed !== true) {
        throw bindingInputError('Explicit confirmation of unverified System Git is required');
      }
      for (const key of ['expectedRepositoryId', 'expectedConfigRevision', 'expectedFetchFingerprint', 'expectedPushFingerprint', 'remote']) {
        if (requiredString(input[key], key) !== input[key]) throw bindingInputError(`${key} is invalid`);
      }
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
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
          || !['github', 'gitlab'].includes(account.provider)) throw bindingInputError('Credential account is invalid');
        const reference = {
          provider: account.provider,
          instance: normalizeProviderInstance(account.provider, account.instance),
          accountId: requiredString(account.accountId, 'credential accountId'),
        };
        if (reference.accountId !== account.accountId) throw bindingInputError('Credential account is invalid');
        const origin = new URL(reference.provider === 'github' ? 'https://github.com' : reference.instance);
        for (const endpoint of [remote.fetch, remote.push]) {
          let parsed;
          try { parsed = normalizeGitRemoteEndpoint(endpoint.rawUrl); }
          catch { throw bindingInputError('Managed HTTPS endpoint is invalid'); }
          if (origin.protocol !== 'https:' || parsed.protocol !== 'https' || parsed.host !== origin.hostname
            || parsed.port !== Number(origin.port || 443)) throw bindingInputError('Credential account does not match the HTTPS endpoint');
        }
        const resolved = await readTransportAccount?.(reference);
        const id = resolved?.credentialId;
        const revision = resolved?.credentialRevision;
        const providerUserId = resolved?.providerUserId;
        const secret = reference.provider === 'github' ? resolved?.accessToken : resolved?.token;
        if (id !== reference.accountId || resolved?.status !== 'valid'
          || !Number.isSafeInteger(revision) || revision < 1
          || !isString(providerUserId) || !providerUserId
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
      const selected = { name: remote.name,
        fetch: { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint },
        push: { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint },
        mode: input.transport === 'anonymous' ? 'anonymous' : input.transport === 'system' ? 'system' : 'managed',
        readiness: 'ready',
      };
      if (credentialId) selected.credentialId = credentialId;
      const remotes = [...(binding?.remotes ?? [])];
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
    removeTransportBinding: async (input) => {
      const keys = ['directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision',
        'expectedFetchFingerprint', 'expectedPushFingerprint', 'remote'];
      if (!isPlainObject(input) || !hasExactKeys(input, keys)) {
        throw bindingInputError('Git transport binding removal intent is invalid');
      }
      for (const key of ['expectedRepositoryId', 'expectedConfigRevision', 'expectedFetchFingerprint', 'expectedPushFingerprint', 'remote']) {
        if (requiredString(input[key], key) !== input[key]) throw bindingInputError(`${key} is invalid`);
      }
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
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
    configureAuxiliaryBinding: async (input) => {
      const commonKeys = [
        'operation', 'directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision',
        'parentRemote', 'expectedParentFingerprint', 'kind', 'path', 'expectedEndpointFingerprint',
      ];
      const extraKeys = input?.operation === 'configure'
        ? input.transport === 'system' ? ['transport', 'unverifiedConfirmed']
          : input.transport === 'https' ? ['transport', 'credentialAccount']
            : input.transport === 'ssh' ? ['transport', 'sshCredentialId'] : ['transport']
        : [];
      if (!isPlainObject(input) || !['configure', 'remove'].includes(input.operation)
        || input.operation === 'configure' && !['system', 'https', 'ssh', 'anonymous'].includes(input.transport)
        || !hasExactKeys(input, commonKeys, extraKeys)
        || !['submodule', 'lfs'].includes(input.kind)
        || !(resolveCheckoutAuxiliary instanceof Function)) {
        throw bindingInputError('Git auxiliary binding intent is invalid');
      }
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw bindingInputError('expectedRevision is required');
      }
      for (const key of ['expectedRepositoryId', 'expectedConfigRevision', 'parentRemote',
        'expectedParentFingerprint', 'expectedEndpointFingerprint']) {
        if (requiredString(input[key], key) !== input[key]) throw bindingInputError(`${key} is invalid`);
      }
      const checkoutPath = requiredString(input.path, 'path');
      if (checkoutPath !== input.path || checkoutPath.length > 4096 || /[\0-\x1f\x7f]/.test(checkoutPath)
        || checkoutPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(checkoutPath)
        || checkoutPath.includes('\\') || checkoutPath === '..' || checkoutPath.startsWith('../')
        || checkoutPath.includes('/../')) throw bindingInputError('path is invalid');
      if (input.operation === 'configure' && input.transport === 'system' && input.unverifiedConfirmed !== true) {
        throw bindingInputError('Explicit confirmation of unverified System Git is required');
      }
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
      const discover = () => resolveCheckoutAuxiliary({
        directory: input.directory,
        parentEndpoint: parentAuthority.endpoint,
        parentRemoteName: input.parentRemote,
        kind: input.kind,
        path: checkoutPath,
      });
      const discovered = await discover();
      if (!discovered || discovered.kind !== input.kind || discovered.path !== checkoutPath
        || discovered.endpoint?.fingerprint !== input.expectedEndpointFingerprint
        || !isSafeRepositoryEndpoint(discovered.endpoint)) throw conflict();

      const auxiliary = [...current.binding.auxiliary];
      const targetIndex = auxiliary.findIndex((entry) => entry.kind === input.kind
        && entry.endpoint.fingerprint === discovered.endpoint.fingerprint);
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
          if (endpointProtocol !== 'https') throw bindingInputError('Managed HTTPS credentials require an HTTPS endpoint');
          const account = input.credentialAccount;
          if (!isPlainObject(account) || !hasExactKeys(account, ['provider', 'instance', 'accountId'])
            || !['github', 'gitlab'].includes(account.provider)) throw bindingInputError('Credential account is invalid');
          const reference = {
            provider: account.provider,
            instance: normalizeProviderInstance(account.provider, account.instance),
            accountId: requiredString(account.accountId, 'credential accountId'),
          };
          if (reference.accountId !== account.accountId) throw bindingInputError('Credential account is invalid');
          const origin = new URL(reference.provider === 'github' ? 'https://github.com' : reference.instance);
          const endpoint = normalizeGitRemoteEndpoint(discovered.endpoint.displayUrl);
          if (origin.protocol !== 'https:' || endpoint.host !== origin.hostname
            || endpoint.port !== Number(origin.port || 443)) throw bindingInputError('Credential account does not match the HTTPS endpoint');
          const resolved = await readTransportAccount?.(reference);
          const secret = reference.provider === 'github' ? resolved?.accessToken : resolved?.token;
          if (resolved?.credentialId !== reference.accountId || resolved?.status !== 'valid'
            || !Number.isSafeInteger(resolved?.credentialRevision) || resolved.credentialRevision < 1
            || !isString(resolved?.providerUserId) || !resolved.providerUserId
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
        const selected = {
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
    mutateProvider: async (input) => {
      if (!isPlainObject(input) || !['add', 'replace', 'remove'].includes(input.operation)
        || !hasExactKeys(input, ['directory', 'expectedRepositoryId', 'expectedRevision', 'operation',
          ...(input.operation === 'add' ? [] : ['target']),
          ...(input.operation === 'remove' ? [] : ['provider'])])) {
        throw bindingInputError('Provider binding mutation is invalid');
      }
      const expectedRepositoryId = requiredString(input.expectedRepositoryId, 'expectedRepositoryId');
      if (expectedRepositoryId !== input.expectedRepositoryId) throw bindingInputError('expectedRepositoryId is invalid');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
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
          && normalizeProviderInstance(candidate.provider, candidate.instance) === parsedTarget.instance
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
        const [provider] = parseProviders([input.provider], context.remotes);
        const previous = providers[targetIndex];
        // Account repair retains the approved endpoint. A changed destination needs a new association.
        if (previous?.endpoint && previous.primaryRemote === provider.primaryRemote) {
          provider.endpoint = previous.endpoint;
          provider.repository = providerRepositoryForEndpoint(provider.provider, provider.instance, previous.endpoint);
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
    set: async (input) => {
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
      const providers = parseProviders(binding.providers, context.remotes);
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
    resetRepositoryBinding: async (input) => {
      if (!isPlainObject(input) || !hasExactKeys(input, [
        'directory', 'expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision', 'confirmed',
      ]) || input.confirmed !== true) throw bindingInputError('Explicit confirmation is required to reset a source control binding');
      const { directory, expectedRepositoryId, expectedRevision, expectedConfigRevision } = input;
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw bindingInputError('expectedRevision is required');
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
    accountUnavailable: async (identity) => {
      if (!isPlainObject(identity)) throw bindingInputError('account identity is required');
      const provider = requiredString(identity.provider, 'provider');
      if (provider !== 'github' && provider !== 'gitlab') throw bindingInputError('provider is unsupported');
      return store.reconcileAccount({
        provider,
        instance: normalizeProviderInstance(provider, identity.instance),
        accountId: requiredString(identity.accountId, 'accountId'),
      });
    },
  };
}
