import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprintRemoteUrl, redactRemoteUrl } from '../source-control/url-redaction.js';
import { normalizeSourceControlProviderInstance } from '../source-control/provider-instance.js';
import { createHttpsCredentialReference, normalizeGitRemoteEndpoint } from './credential-resolver.js';

const OPERATIONS = ['push', 'fetch', 'pull', 'delete-remote-branch', 'sync', 'clone', 'checkout-hydration'];
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const REF_COMPONENT_PATTERN = /^(?!\.)(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))(?!.*[~^:?*[\\\s])(?!.*\/$)(?!.*\/\/)[^\0-\x20\x7f]+$/;
const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const isBoolean = (value) => Object.prototype.toString.call(value) === '[object Boolean]'
  && (value === true || value === false);
const hasExactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
const cloneAndFreeze = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  if (!isPlainObject(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneAndFreeze(child)]),
  ));
};

const planError = (message, status = 400, code = 'INVALID_GIT_NETWORK_OPERATION') => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};
const requiredString = (value, name) => {
  if (!isString(value) || !value.trim()) throw planError(`${name} is required`);
  const result = value.trim();
  if (result.startsWith('-') || /[\0\r\n]/.test(result)) throw planError(`${name} is invalid`);
  return result;
};
const parseSha = (value, name) => {
  const sha = requiredString(value, name);
  if (!SHA_PATTERN.test(sha)) throw planError(`${name} is invalid`);
  return sha.toLowerCase();
};
const parseFingerprint = (value, name) => {
  const fingerprint = requiredString(value, name);
  if (!/^[A-Za-z0-9_-]{43}$/.test(fingerprint)) throw planError(`${name} is invalid`);
  return fingerprint;
};
const parseRemote = (value) => {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['name', 'endpoint'])
    || !isPlainObject(value.endpoint)
    || !hasExactKeys(value.endpoint, ['displayUrl', 'fingerprint'])) {
    throw planError('remote is invalid');
  }
  return {
    name: requiredString(value.name, 'remote name'),
    endpoint: {
      displayUrl: requiredString(value.endpoint.displayUrl, 'remote displayUrl'),
      fingerprint: requiredString(value.endpoint.fingerprint, 'remote fingerprint'),
    },
  };
};
const parseCheckoutPath = (value, name = 'checkout path') => {
  const result = requiredString(value, name);
  if (result !== value || result.length > 4096 || /[\0-\x1f\x7f]/.test(result)
    || path.isAbsolute(result) || /^[A-Za-z]:[\\/]/.test(result) || result.includes('\\')
    || result === '..' || result.startsWith('../') || result.includes('/../')) throw planError(`${name} is invalid`);
  return result;
};
const parseHydrationRequirements = (value) => {
  if (!Array.isArray(value) || value.length > 256) throw planError('checkout hydration requirements are invalid');
  const requirements = value.map((entry) => {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ['kind', 'path', 'endpoint'])
      || !['submodule', 'lfs'].includes(entry.kind) || !isPlainObject(entry.endpoint)
      || !hasExactKeys(entry.endpoint, ['displayUrl', 'fingerprint'])) {
      throw planError('checkout hydration requirement is invalid');
    }
    assertSafeExistingEndpoint(entry.endpoint.displayUrl);
    return {
      kind: entry.kind,
      path: parseCheckoutPath(entry.path),
      endpoint: {
        displayUrl: requiredString(entry.endpoint.displayUrl, 'auxiliary endpoint displayUrl'),
        fingerprint: parseFingerprint(entry.endpoint.fingerprint, 'auxiliary endpoint fingerprint'),
      },
    };
  });
  const keys = requirements.map((entry) => `${entry.kind}\0${entry.path}\0${entry.endpoint.fingerprint}`);
  if (new Set(keys).size !== keys.length) throw planError('checkout hydration requirements must be unique');
  return requirements;
};
const parseHydrationTransfers = (value, requirements) => {
  if (!Array.isArray(value) || value.length > 256) throw planError('checkout hydration transfers are invalid');
  const transfers = value.map((entry) => {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ['kind', 'path', 'endpoint', 'rawEndpoint'])
      || !['submodule', 'lfs'].includes(entry.kind) || !isPlainObject(entry.endpoint)
      || !hasExactKeys(entry.endpoint, ['displayUrl', 'fingerprint'])) {
      throw planError('checkout hydration transfer is invalid');
    }
    const rawEndpoint = requiredString(entry.rawEndpoint, 'auxiliary raw endpoint');
    assertSafeExistingEndpoint(rawEndpoint);
    const transfer = {
      kind: entry.kind,
      path: parseCheckoutPath(entry.path),
      endpoint: {
        displayUrl: requiredString(entry.endpoint.displayUrl, 'auxiliary endpoint displayUrl'),
        fingerprint: parseFingerprint(entry.endpoint.fingerprint, 'auxiliary endpoint fingerprint'),
      },
      rawEndpoint,
    };
    if (redactRemoteUrl(rawEndpoint) !== transfer.endpoint.displayUrl
      || fingerprintRemoteUrl(rawEndpoint) !== transfer.endpoint.fingerprint) {
      throw planError('checkout hydration transfer endpoint is invalid');
    }
    return transfer;
  });
  const requirementKeys = new Set(requirements.map((entry) => JSON.stringify(entry)));
  if (transfers.some(({ rawEndpoint: _rawEndpoint, ...entry }) => !requirementKeys.has(JSON.stringify(entry)))) {
    throw planError('checkout hydration transfers do not match requirements');
  }
  const transferKeys = transfers.map((entry) => `${entry.kind}\0${entry.path}\0${entry.endpoint.fingerprint}`);
  if (new Set(transferKeys).size !== transferKeys.length) throw planError('checkout hydration transfers must be unique');
  return transfers;
};
/**
 * The provider account a cloned repository is associated with, for issues and
 * change requests. Separate from the transport credential — a repository can
 * fetch over SSH and still answer to a GitHub account — so it is accepted for
 * every transport and checked only against the endpoint it will be bound to.
 */
const parseCloneProviderAccount = (value, parsedEndpoint) => {
  if (value === undefined) return null;
  if (!isPlainObject(value) || !hasExactKeys(value, ['provider', 'instance', 'accountId'])
    || !['github', 'gitlab'].includes(value.provider)) throw planError('Provider account is invalid');
  let instance;
  try { instance = normalizeSourceControlProviderInstance(value.provider, value.instance); }
  catch { throw planError('Provider account instance is invalid'); }
  const origin = new URL(value.provider === 'github' ? 'https://github.com' : instance);
  if (origin.hostname !== parsedEndpoint.host) throw planError('Provider account does not match the clone endpoint');
  const accountId = requiredString(value.accountId, 'provider accountId');
  if (accountId !== value.accountId || /[\0\r\n]/.test(accountId)) throw planError('Provider account is invalid');
  return { provider: value.provider, instance, accountId };
};

const parseAuxiliaryGrants = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw planError('auxiliaryGrants is invalid');
  const grants = value.map((grant) => {
    if (!isPlainObject(grant)
      || !hasExactKeys(grant, ['kind', 'endpoint', 'transportMode'], ['credentialId', 'unverifiedConfirmed'])
      || !['submodule', 'lfs'].includes(grant.kind)
      || !isPlainObject(grant.endpoint)
      || !hasExactKeys(grant.endpoint, ['displayUrl', 'fingerprint'])) {
      throw planError('auxiliary grant is invalid');
    }
    const transportMode = parseTransportMode(grant.transportMode);
    assertSafeExistingEndpoint(grant.endpoint.displayUrl);
    const parsed = {
      kind: grant.kind,
      endpoint: {
        displayUrl: requiredString(grant.endpoint.displayUrl, 'auxiliary endpoint displayUrl'),
        fingerprint: parseFingerprint(grant.endpoint.fingerprint, 'auxiliary endpoint fingerprint'),
      },
      transportMode,
    };
    if (transportMode === 'managed') parsed.credentialId = requiredString(grant.credentialId, 'auxiliary credentialId');
    else if (Object.hasOwn(grant, 'credentialId')) throw planError('credentialId is not allowed for credential-free auxiliary grant');
    if (transportMode === 'system') {
      if (grant.unverifiedConfirmed !== true) throw planError('Explicit confirmation of unverified System Git is required for every auxiliary grant');
      parsed.unverifiedConfirmed = true;
    } else if (Object.hasOwn(grant, 'unverifiedConfirmed')) {
      throw planError('System confirmation is not allowed for this auxiliary grant');
    }
    if (transportMode === 'anonymous' && normalizeGitRemoteEndpoint(parsed.endpoint.displayUrl).protocol !== 'https') {
      throw planError('Anonymous Git transport requires HTTPS', 501, 'RUNTIME_UNSUPPORTED');
    }
    return parsed;
  });
  const keys = grants.map((grant) => `${grant.kind}\0${grant.endpoint.fingerprint}`);
  if (new Set(keys).size !== keys.length) throw planError('auxiliary grants must be unique');
  return grants;
};
const assertSafeExistingEndpoint = (endpoint) => {
  const value = requiredString(endpoint, 'Git endpoint');
  if (value.length > 4096) throw planError('Git endpoint is invalid');
  if (!value.includes('://')) {
    const match = value.match(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:([^\s:\\]+)$/);
    if (!match || /[?#]/.test(value) || match[1].startsWith('-')
      || match[1].split('/').some((part) => !part || part === '.' || part === '..')) {
      throw planError('Git endpoint is invalid');
    }
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw planError('Git endpoint is invalid');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    throw planError('Git endpoint is invalid');
  }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || !parsed.hostname || !parsed.pathname || parsed.pathname === '/'
    || /[\0-\x20\x7f\\]/.test(pathname)
    || pathname.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) {
    throw planError('Git endpoint is invalid');
  }
};
const parseExactRef = (value, name, namespaces) => {
  const ref = requiredString(value, name);
  if (ref.startsWith('+') || ref.includes(':') || ref.endsWith('.') || ref.includes('@{') || ref === '@'
    || !REF_COMPONENT_PATTERN.test(ref)
    || !namespaces.some((namespace) => ref.startsWith(namespace) && ref.length > namespace.length)) {
    throw planError(`${name} is invalid`);
  }
  return ref;
};

const parseRemoteFetchMapping = (remoteName, output) => {
  if (remoteName.length > 512) throw planError('Remote Fetch remote name is invalid');
  parseExactRef(`refs/remotes/${remoteName}/branch`, 'remote name', ['refs/remotes/']);
  const mapping = `refs/heads/*:refs/remotes/${remoteName}/*`;
  if (output !== `${mapping}\0` && output !== `+${mapping}\0`) {
    throw planError('Remote Fetch requires one configured heads-to-remote-tracking mapping', 400, 'INVALID_REQUEST');
  }
  return { refspec: output.slice(0, -1), force: output.startsWith('+') };
};
const parseCloneEndpoint = (value) => {
  const endpoint = requiredString(value, 'remoteUrl');
  if (!endpoint.includes('://')
    && /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:[^\s:\\]+$/.test(endpoint)) {
    const separator = endpoint.indexOf(':');
    const repositoryPath = endpoint.slice(separator + 1);
    if (/[?#]/.test(endpoint) || repositoryPath.startsWith('-')
      || repositoryPath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw planError('remoteUrl is invalid');
    }
    return endpoint;
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw planError('remoteUrl is invalid');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    throw planError('remoteUrl is invalid');
  }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.password || parsed.search || parsed.hash
    || !parsed.hostname || !parsed.pathname || parsed.pathname === '/'
    || (parsed.protocol === 'https:' && parsed.username)
    || /[\0-\x20\x7f\\]/.test(pathname)
    || pathname.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) {
    throw planError('remoteUrl is invalid');
  }
  return endpoint;
};
const pathExists = async (target, fsImpl) => {
  try {
    await fsImpl.stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};
const parseTransportMode = (value) => {
  if (!['managed', 'system', 'anonymous'].includes(value)) throw planError('transportMode is invalid');
  return value;
};
const publicTransport = (mode) => mode === 'anonymous' ? { mode, verification: { status: 'anonymous' } } : mode === 'managed'
  ? { mode, verification: { status: 'verified', method: 'credential' } }
  : { mode, verification: { status: 'unverified', reason: 'system-credentials' } };
const assertRuntimeIdentity = (value) => {
  if (!isPlainObject(value) || !hasExactKeys(value, ['id', 'platform'], ['label'])) {
    throw new TypeError('Git network operation runtime identity is invalid');
  }
  requiredString(value.id, 'runtime identity id');
  requiredString(value.platform, 'runtime identity platform');
  if (value.label !== undefined) requiredString(value.label, 'runtime identity label');
};

export function createNetworkOperationPlanner({
  validateGitTransportContext,
  validateManagedSshCredential,
  resolveSourceControlAccount,
  systemPushAcknowledgements,
  contributorProvenance,
  resolveRef,
  resolveSymbolicRef = async () => null,
  resolveRemoteFetchMapping,
  inspectCheckoutHydration,
  runtimeIdentity,
  idFactory = () => `git_${crypto.randomUUID()}`,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  if (!(validateGitTransportContext instanceof Function)
    || !(systemPushAcknowledgements?.isAcknowledged instanceof Function)
    || !(systemPushAcknowledgements?.acknowledge instanceof Function)
    || !(resolveRef instanceof Function)
    || !(resolveSymbolicRef instanceof Function)
    || !(idFactory instanceof Function)) {
    throw new TypeError('Git network operation planner dependencies are invalid');
  }
  assertRuntimeIdentity(runtimeIdentity);
  const frozenRuntimeIdentity = cloneAndFreeze(runtimeIdentity);
  const contributorSelections = new Map();
  const pruneContributorSelections = () => {
    const now = Date.now();
    for (const [id, selection] of contributorSelections) {
      if (selection.expiresAt <= now) contributorSelections.delete(id);
    }
    while (contributorSelections.size >= 256) contributorSelections.delete(contributorSelections.keys().next().value);
  };
  const readContributor = async (directory) => {
    if (!(contributorProvenance?.read instanceof Function)) return null;
    const record = await contributorProvenance.read(directory);
    return record.provenance?.kind === 'contributor-fork' ? record : null;
  };
  const contributorError = (code, message) => planError(message, 409, code);
  const createOperationId = () => {
    const operationId = requiredString(idFactory(), 'operationId');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(operationId)) throw planError('operationId is invalid');
    return operationId;
  };

  const bundlePlans = ({ operationId, endpoint, transportMode, transport, target, internal }) => {
    const publicPlan = {
      operationId,
      runtimeIdentity: frozenRuntimeIdentity,
      transport: transport ?? publicTransport(transportMode),
      target,
      completedSteps: [],
      state: 'planned',
    };
    const internalPlan = { ...publicPlan, ...internal };
    if (endpoint) internalPlan.rawEndpoint = endpoint;
    return Object.freeze({
      internalPlan: cloneAndFreeze(internalPlan),
      publicPlan: cloneAndFreeze(publicPlan),
    });
  };

  const planSync = async (input) => {
    if (!hasExactKeys(input, [
      'operation', 'directory', 'repositoryId', 'bindingRevision', 'configRevision', 'fetch', 'pull', 'push',
    ])) throw planError('Git sync operation input is invalid');
    const directory = requiredString(input.directory, 'directory');
    const contributor = await readContributor(directory);
    if (contributor) {
      if (input.fetch?.transportMode === 'system' || input.push?.transportMode === 'system') {
        throw contributorError('CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED', 'Contributor transfers require managed credentials');
      }
      throw contributorError('DESTINATION_SELECTION_REQUIRED', 'Contributor push destination selection is required');
    }
    const repositoryId = requiredString(input.repositoryId, 'repositoryId');
    const configRevision = requiredString(input.configRevision, 'configRevision');
    if (!Number.isInteger(input.bindingRevision) || input.bindingRevision < 1) {
      throw planError('bindingRevision is required');
    }
    if (!isPlainObject(input.fetch)
      || !hasExactKeys(input.fetch, ['remote', 'sourceRef', 'destinationRef', 'transportMode'])
      || !isPlainObject(input.pull)
      || !hasExactKeys(input.pull, ['destinationRef'])
      || !isPlainObject(input.push)
      || !hasExactKeys(input.push, ['remote', 'sourceRef', 'destinationRef', 'transportMode'], [
        'forceWithLease', 'acknowledgeSystemTransport',
      ])) {
      throw planError('Git sync targets are invalid');
    }
    const fetchRemote = parseRemote(input.fetch.remote);
    const pushRemote = parseRemote(input.push.remote);
    const fetchSourceRef = parseExactRef(input.fetch.sourceRef, 'fetch sourceRef', ['refs/heads/', 'refs/tags/']);
    const fetchDestinationRef = parseExactRef(input.fetch.destinationRef, 'fetch destinationRef', ['refs/remotes/']);
    const pullDestinationRef = parseExactRef(input.pull.destinationRef, 'pull destinationRef', ['refs/heads/']);
    const pushSourceRef = parseExactRef(input.push.sourceRef, 'push sourceRef', ['refs/heads/']);
    const pushDestinationRef = parseExactRef(input.push.destinationRef, 'push destinationRef', ['refs/heads/', 'refs/tags/']);
    if (pullDestinationRef !== pushSourceRef) {
      throw planError('Sync pull destination and push source must match');
    }
    const fetchTransportMode = parseTransportMode(input.fetch.transportMode);
    const pushTransportMode = parseTransportMode(input.push.transportMode);
    if (pushTransportMode === 'anonymous') throw planError('Anonymous Git transport is read-only', 400, 'INVALID_REQUEST');
    if (input.push.acknowledgeSystemTransport !== undefined
      && !isBoolean(input.push.acknowledgeSystemTransport)) {
      throw planError('acknowledgeSystemTransport is invalid');
    }
    let forceWithLease;
    if (input.push.forceWithLease !== undefined) {
      if (!isPlainObject(input.push.forceWithLease)
        || !hasExactKeys(input.push.forceWithLease, ['expectedRemoteSha'])) {
        throw planError('forceWithLease is invalid');
      }
      forceWithLease = {
        expectedRemoteSha: parseSha(input.push.forceWithLease.expectedRemoteSha, 'expectedRemoteSha'),
      };
    }
    if (pushTransportMode === 'managed' && input.push.acknowledgeSystemTransport !== undefined) {
      throw planError('acknowledgeSystemTransport is not allowed for managed transport');
    }

    const authorityInput = (remote, endpointKind) => ({
      directory,
      repositoryId,
      bindingRevision: input.bindingRevision,
      configRevision,
      remote: remote.name,
      endpointKind,
    });
    const fetchAuthority = await validateGitTransportContext(authorityInput(fetchRemote, 'fetch'));
    const pushAuthority = await validateGitTransportContext(authorityInput(pushRemote, 'push'));
    const validateAuthority = (authority, remote, transportMode) => {
      const transportRevision = requiredString(authority.transportRevision, 'transportRevision');
      assertSafeExistingEndpoint(authority.endpoint);
      if (transportMode === 'anonymous' && (authority.credentialId !== undefined
        || normalizeGitRemoteEndpoint(authority.endpoint).protocol !== 'https')) {
        throw planError('Anonymous Git transport requires credential-free HTTPS', 501, 'RUNTIME_UNSUPPORTED');
      }
      if (authority.endpointFingerprint !== remote.endpoint.fingerprint
        || redactRemoteUrl(authority.endpoint) !== remote.endpoint.displayUrl
        || authority.transportMode !== transportMode
        || (transportMode === 'managed' && !authority.credentialId)) {
        throw planError('Git network operation authority changed', 409, 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED');
      }
      return transportRevision;
    };
    const fetchTransportRevision = validateAuthority(fetchAuthority, fetchRemote, fetchTransportMode);
    const pushTransportRevision = validateAuthority(pushAuthority, pushRemote, pushTransportMode);
    if (pushTransportMode === 'system') {
      const acknowledged = await systemPushAcknowledgements.isAcknowledged(
        repositoryId, pushRemote.name, pushAuthority.endpointFingerprint, pushTransportRevision,
      );
      if (!acknowledged && input.push.acknowledgeSystemTransport !== true) {
        throw planError('System Git transport acknowledgement is required', 409, 'ACKNOWLEDGEMENT_REQUIRED');
      }
      if (!acknowledged) {
        await systemPushAcknowledgements.acknowledge(
          repositoryId, pushRemote.name, pushAuthority.endpointFingerprint, pushTransportRevision,
        );
      }
    }
    const currentHeadRef = await resolveSymbolicRef(directory);
    if (currentHeadRef !== pullDestinationRef) {
      throw planError('Sync destination is not the checked out branch', 409, 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED');
    }
    const destinationSha = parseSha(await resolveRef(directory, pullDestinationRef), 'resolved destination ref');
    const operationId = createOperationId();
    const publicRemote = (remote, authority) => ({
      name: remote.name,
      endpoint: {
        displayUrl: redactRemoteUrl(authority.endpoint),
        fingerprint: authority.endpointFingerprint,
      },
    });
    const pushTarget = {
      ...publicRemote(pushRemote, pushAuthority),
      sourceRef: pushSourceRef,
      destinationRef: pushDestinationRef,
    };
    if (forceWithLease) pushTarget.forceWithLease = forceWithLease;
    const target = {
      operation: 'sync',
      repositoryId,
      bindingRevision: input.bindingRevision,
      configRevision,
      fetch: {
        ...publicRemote(fetchRemote, fetchAuthority),
        sourceRef: fetchSourceRef,
        destinationRef: fetchDestinationRef,
      },
      pull: { destinationRef: pullDestinationRef },
      push: pushTarget,
    };
    const internalTarget = (targetValue, authority, transportMode, transportRevision, endpointKind) => {
      const operationTarget = {
        operation: endpointKind === 'fetch' ? 'fetch' : 'push',
        repositoryId,
        bindingRevision: input.bindingRevision,
        configRevision,
        remote: targetValue.remote,
        sourceRef: targetValue.sourceRef,
        destinationRef: targetValue.destinationRef,
      };
      if (targetValue.forceWithLease) operationTarget.forceWithLease = targetValue.forceWithLease;
      const value = {
        directory,
        target: operationTarget,
        endpointKind,
        rawEndpoint: authority.endpoint,
        transportMode,
        transportRevision,
      };
      if (authority.credentialId) value.credentialId = authority.credentialId;
      return value;
    };
    return bundlePlans({
      operationId,
      transport: {
        fetch: publicTransport(fetchTransportMode),
        push: publicTransport(pushTransportMode),
      },
      target,
      internal: {
        directory,
        destinationSha,
        fetch: internalTarget(input.fetch, fetchAuthority, fetchTransportMode, fetchTransportRevision, 'fetch'),
        push: internalTarget({ ...input.push, forceWithLease }, pushAuthority, pushTransportMode, pushTransportRevision, 'push'),
      },
    });
  };

  const planExisting = async (input) => {
    const remoteFetch = input.operation === 'fetch' && input.fetchScope === 'remote';
    const pushMutation = input.operation === 'push' || input.operation === 'delete-remote-branch';
    const optional = input.operation === 'push'
      ? ['forceWithLease', 'configureUpstream', 'acknowledgeSystemTransport', 'destinationSelectionId'] : [];
    if (input.operation === 'delete-remote-branch') optional.push('acknowledgeSystemTransport');
    if (input.operation === 'fetch') optional.push('fetchScope');
    const required = [
      'operation', 'directory', 'repositoryId', 'bindingRevision', 'configRevision',
      'remote', 'transportMode',
    ];
    if (!remoteFetch) required.push('destinationRef');
    if (!remoteFetch && input.operation !== 'delete-remote-branch') required.push('sourceRef');
    if (!hasExactKeys(input, required, optional)) throw planError('Git network operation input is invalid');
    if (input.operation === 'fetch' && input.fetchScope !== undefined && !['ref', 'remote'].includes(input.fetchScope)) {
      throw planError('fetchScope is invalid');
    }
    const operation = input.operation;
    const directory = requiredString(input.directory, 'directory');
    const contributor = await readContributor(directory);
    const repositoryId = requiredString(input.repositoryId, 'repositoryId');
    const configRevision = requiredString(input.configRevision, 'configRevision');
    const remote = parseRemote(input.remote);
    const sourceNamespaces = ['refs/heads/', 'refs/tags/'];
    const destinationNamespaces = operation === 'fetch'
      ? ['refs/remotes/', 'refs/heads/', 'refs/tags/']
      : operation === 'pull' || operation === 'delete-remote-branch' ? ['refs/heads/'] : ['refs/heads/', 'refs/tags/'];
    const sourceRef = remoteFetch || operation === 'delete-remote-branch'
      ? undefined
      : parseExactRef(input.sourceRef, 'sourceRef', sourceNamespaces);
    const destinationRef = remoteFetch ? undefined : parseExactRef(input.destinationRef, 'destinationRef', destinationNamespaces);
    const transportMode = parseTransportMode(input.transportMode);
    if (pushMutation && transportMode === 'anonymous') throw planError('Anonymous Git transport is read-only', 400, 'INVALID_REQUEST');
    if (contributor && operation === 'delete-remote-branch') {
      throw contributorError('DESTINATION_SELECTION_REQUIRED', 'Contributor remote deletion requires an exact managed destination selection');
    }
    if (contributor && transportMode === 'system') {
      throw contributorError('CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED', 'Contributor transfers require managed credentials');
    }
    if (input.acknowledgeSystemTransport !== undefined
      && !isBoolean(input.acknowledgeSystemTransport)) {
      throw planError('acknowledgeSystemTransport is invalid');
    }
    if (input.configureUpstream !== undefined && !isBoolean(input.configureUpstream)) {
      throw planError('configureUpstream is invalid');
    }
    if (input.configureUpstream === true
      && (operation !== 'push' || !sourceRef.startsWith('refs/heads/') || !destinationRef.startsWith('refs/heads/'))) {
      throw planError('configureUpstream requires branch refs');
    }
    if (!Number.isInteger(input.bindingRevision) || input.bindingRevision < 1) {
      throw planError('bindingRevision is required');
    }
    let forceWithLease;
    if (input.forceWithLease !== undefined) {
      if (operation !== 'push'
        || !isPlainObject(input.forceWithLease)
        || !hasExactKeys(input.forceWithLease, ['expectedRemoteSha'])) {
        throw planError('forceWithLease is invalid');
      }
      forceWithLease = {
        expectedRemoteSha: parseSha(input.forceWithLease.expectedRemoteSha, 'expectedRemoteSha'),
      };
    }

    const endpointKind = pushMutation ? 'push' : 'fetch';
    const authority = await validateGitTransportContext({
      directory,
      repositoryId,
      bindingRevision: input.bindingRevision,
      configRevision,
      remote: remote.name,
      endpointKind,
    });
    const transportRevision = requiredString(authority.transportRevision, 'transportRevision');
    assertSafeExistingEndpoint(authority.endpoint);
    if (transportMode === 'anonymous' && (authority.credentialId !== undefined
      || normalizeGitRemoteEndpoint(authority.endpoint).protocol !== 'https')) {
      throw planError('Anonymous Git transport requires credential-free HTTPS', 501, 'RUNTIME_UNSUPPORTED');
    }
    if (authority.endpointFingerprint !== remote.endpoint.fingerprint
      || redactRemoteUrl(authority.endpoint) !== remote.endpoint.displayUrl
      || authority.transportMode !== transportMode) {
      throw planError('Git network operation authority changed', 409, 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED');
    }
    if (transportMode === 'managed' && !authority.credentialId) {
      throw planError('Managed Git transport credential is required', 409, 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED');
    }
    let fetchMapping;
    if (remoteFetch) {
      if (!(resolveRemoteFetchMapping instanceof Function)) throw planError('Remote Fetch mapping is unavailable', 409, 'STALE_CONFIG');
      fetchMapping = parseRemoteFetchMapping(remote.name, await resolveRemoteFetchMapping(directory, remote.name));
    }
    if (pushMutation) {
      if (transportMode === 'managed' && input.acknowledgeSystemTransport !== undefined) {
        throw planError('acknowledgeSystemTransport is not allowed for managed transport');
      }
      if (transportMode === 'system') {
        const acknowledged = await systemPushAcknowledgements.isAcknowledged(
          repositoryId, remote.name, authority.endpointFingerprint, transportRevision,
        );
        if (!acknowledged && input.acknowledgeSystemTransport !== true) {
          throw planError('System Git transport acknowledgement is required', 409, 'ACKNOWLEDGEMENT_REQUIRED');
        }
        if (!acknowledged) {
          await systemPushAcknowledgements.acknowledge(
            repositoryId, remote.name, authority.endpointFingerprint, transportRevision,
          );
        }
      }
    }
    const sourceSha = operation === 'push'
      ? parseSha(await resolveRef(directory, sourceRef), 'resolved source ref')
      : undefined;
    if (contributor && operation === 'push') {
      if (!input.destinationSelectionId) {
        throw contributorError('DESTINATION_SELECTION_REQUIRED', 'Contributor push destination selection is required');
      }
      const selectionId = requiredString(input.destinationSelectionId, 'destinationSelectionId');
      pruneContributorSelections();
      const selection = contributorSelections.get(selectionId);
      const exact = selection
        && selection.worktreeId === contributor.worktreeId
        && selection.provenanceRevision === contributor.revision
        && selection.repositoryId === repositoryId
        && selection.bindingRevision === input.bindingRevision
        && selection.configRevision === configRevision
        && selection.sourceSha === sourceSha
        && selection.remoteName === remote.name
        && selection.endpointFingerprint === authority.endpointFingerprint
        && selection.destinationRef === destinationRef;
      if (!exact) throw contributorError('DESTINATION_SELECTION_REQUIRED', 'Contributor push destination selection is required');
      contributorSelections.delete(selectionId);
    }
    let destinationSha;
    if (operation === 'pull') {
      const currentHeadRef = await resolveSymbolicRef(directory);
      if (currentHeadRef !== destinationRef) {
        throw planError('Pull destination is not the checked out branch', 409, 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED');
      }
      destinationSha = parseSha(await resolveRef(directory, destinationRef), 'resolved destination ref');
    }
    const operationId = createOperationId();
    const target = {
      operation,
      repositoryId,
      bindingRevision: input.bindingRevision,
      configRevision,
      remote: {
        name: remote.name,
        endpoint: {
          displayUrl: redactRemoteUrl(authority.endpoint),
          fingerprint: authority.endpointFingerprint,
        },
      },
    };
    if (remoteFetch) {
      target.fetchScope = 'remote';
      target.force = fetchMapping.force;
    } else {
      target.destinationRef = destinationRef;
      if (operation === 'fetch' && input.fetchScope === 'ref') target.fetchScope = 'ref';
    }
    if (sourceRef) target.sourceRef = sourceRef;
    if (forceWithLease) target.forceWithLease = forceWithLease;
    if (input.configureUpstream === true) target.configureUpstream = true;
    const internal = {
      directory,
      endpointKind,
      transportMode,
      transportRevision,
    };
    if (fetchMapping) internal.fetchRefspec = fetchMapping.refspec;
    if (sourceSha) internal.sourceSha = sourceSha;
    if (contributor) {
      internal.contributorAuthority = {
        worktreeId: contributor.worktreeId,
        revision: contributor.revision,
      };
    }
    if (destinationSha) internal.destinationSha = destinationSha;
    if (authority.credentialId) internal.credentialId = authority.credentialId;
    return bundlePlans({
      operationId,
      endpoint: authority.endpoint,
      transportMode,
      target,
      internal,
    });
  };

  const planClone = async (input) => {
    if (!hasExactKeys(
      input,
      ['operation', 'remoteUrl', 'destinationPath', 'transportMode'],
      ['credentialAccount', 'providerAccount', 'sshCredentialId', 'unverifiedConfirmed', 'gitIdentityId', 'auxiliaryGrants'],
    )) throw planError('Git clone input is invalid');
    const endpoint = parseCloneEndpoint(input.remoteUrl);
    const transportMode = parseTransportMode(input.transportMode);
    let credentialId;
    if (transportMode === 'system') {
      if (input.unverifiedConfirmed !== true || input.credentialAccount !== undefined || Object.hasOwn(input, 'sshCredentialId')) {
        throw planError('Explicit confirmation of unverified System Git is required');
      }
    } else if (transportMode === 'anonymous') {
      if (Object.hasOwn(input, 'credentialAccount') || Object.hasOwn(input, 'sshCredentialId') || Object.hasOwn(input, 'unverifiedConfirmed')) throw planError('Anonymous transport does not accept credentials or System confirmation');
      if (normalizeGitRemoteEndpoint(endpoint).protocol !== 'https') throw planError('Anonymous Git transport requires HTTPS', 501, 'RUNTIME_UNSUPPORTED');
    } else {
      if (input.unverifiedConfirmed !== undefined) throw planError('System confirmation is not allowed for managed transport');
      const parsedEndpoint = normalizeGitRemoteEndpoint(endpoint);
      if (parsedEndpoint.protocol === 'ssh') {
        if (Object.hasOwn(input, 'credentialAccount')) throw planError('Managed SSH clone requires a host credential reference, not a provider account');
        credentialId = requiredString(input.sshCredentialId, 'SSH credential reference');
        if (!(validateManagedSshCredential instanceof Function)) throw planError('Managed SSH inventory is unavailable', 501, 'RUNTIME_UNSUPPORTED');
        try { await validateManagedSshCredential(credentialId); }
        catch { throw planError('Selected managed SSH credential is unavailable', 400, 'INVALID_REQUEST'); }
      } else {
        if (Object.hasOwn(input, 'sshCredentialId')) throw planError('Managed SSH credentials require SSH');
        const account = input.credentialAccount;
        if (!isPlainObject(account) || !hasExactKeys(account, ['provider', 'instance', 'accountId'])
          || !['github', 'gitlab'].includes(account.provider)) throw planError('An explicit credential account is required');
        let instance;
        try { instance = normalizeSourceControlProviderInstance(account.provider, account.instance); }
        catch { throw planError('Credential account instance is invalid'); }
        const origin = new URL(account.provider === 'github' ? 'https://github.com' : instance);
        if (origin.protocol !== 'https:' || origin.hostname !== parsedEndpoint.host
          || Number(origin.port || 443) !== parsedEndpoint.port) throw planError('Credential account does not match the HTTPS endpoint');
        const accountId = requiredString(account.accountId, 'credential accountId');
        if (accountId !== account.accountId || /[\0\r\n]/.test(accountId)) throw planError('Credential account is invalid');
        if (!(resolveSourceControlAccount instanceof Function)) {
          throw planError('Managed HTTPS credential inventory is unavailable', 501, 'RUNTIME_UNSUPPORTED');
        }
        const resolved = await resolveSourceControlAccount({ provider: account.provider, instance, accountId });
        const secret = account.provider === 'github' ? resolved?.accessToken : resolved?.token;
        if (resolved?.credentialId !== accountId || resolved?.status !== 'valid'
          || !Number.isSafeInteger(resolved?.credentialRevision) || resolved.credentialRevision < 1
          || !isString(resolved?.providerUserId) || !resolved.providerUserId
          || !isString(secret) || !secret || /[\r\n\0]/.test(secret)) {
          throw planError('Selected managed HTTPS credential is unavailable', 400, 'INVALID_REQUEST');
        }
        credentialId = createHttpsCredentialReference({
          provider: account.provider,
          instance,
          credentialId: resolved.credentialId,
          credentialRevision: resolved.credentialRevision,
          providerUserId: resolved.providerUserId,
        });
      }
    }
    const operationId = createOperationId();
    const destination = pathImpl.resolve(requiredString(input.destinationPath, 'destinationPath'));
    const temporaryDirectory = pathImpl.join(
      pathImpl.dirname(destination),
      `.${pathImpl.basename(destination)}.openchamber-${operationId}.tmp`,
    );
    if (await pathExists(destination, fsImpl)) throw planError('Clone destination already exists');
    if (await pathExists(temporaryDirectory, fsImpl)) throw planError('Clone temporary directory already exists');
    const providerAccount = parseCloneProviderAccount(input.providerAccount, normalizeGitRemoteEndpoint(endpoint));
    const internal = { destination, temporaryDirectory, transportMode, auxiliaryGrants: parseAuxiliaryGrants(input.auxiliaryGrants) };
    if (providerAccount) internal.providerAccount = providerAccount;
    if (transportMode === 'system') internal.unverifiedConfirmed = true;
    if (credentialId) internal.credentialId = credentialId;
    if (input.gitIdentityId !== undefined) internal.gitIdentityId = requiredString(input.gitIdentityId, 'gitIdentityId');
    return bundlePlans({
      operationId,
      endpoint,
      transportMode,
      target: {
        operation: 'clone',
        remote: {
          displayUrl: redactRemoteUrl(endpoint),
          fingerprint: fingerprintRemoteUrl(endpoint),
        },
        destination: {
          displayName: pathImpl.basename(destination),
          fingerprint: crypto.createHash('sha256').update(destination).digest('base64url'),
        },
      },
      internal,
    });
  };

  const planCheckoutHydration = async (input) => {
    if (!hasExactKeys(input, [
      'operation', 'directory', 'repositoryId', 'bindingRevision', 'configRevision', 'remote',
    ])) throw planError('Git checkout hydration input is invalid');
    if (!(inspectCheckoutHydration instanceof Function)) {
      throw planError('Checkout hydration is unavailable', 501, 'RUNTIME_UNSUPPORTED');
    }
    const directory = requiredString(input.directory, 'directory');
    const repositoryId = requiredString(input.repositoryId, 'repositoryId');
    const configRevision = requiredString(input.configRevision, 'configRevision');
    if (!Number.isSafeInteger(input.bindingRevision) || input.bindingRevision < 1) {
      throw planError('bindingRevision is required');
    }
    const remote = parseRemote(input.remote);
    const authority = await validateGitTransportContext({
      directory,
      repositoryId,
      bindingRevision: input.bindingRevision,
      configRevision,
      remote: remote.name,
      endpointKind: 'fetch',
    });
    assertSafeExistingEndpoint(authority.endpoint);
    if (authority.endpointFingerprint !== remote.endpoint.fingerprint
      || redactRemoteUrl(authority.endpoint) !== remote.endpoint.displayUrl) {
      throw planError('Git checkout hydration source changed', 409, 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED');
    }
    const expectedHeadSha = parseSha(await resolveRef(directory, 'HEAD'), 'checkout HEAD');
    const inspection = await inspectCheckoutHydration({
      directory,
      parentEndpoint: authority.endpoint,
      parentRemoteName: remote.name,
    });
    if (inspection.headSha !== expectedHeadSha) {
      throw planError('Git checkout changed during hydration planning', 409, 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED');
    }
    const requirements = parseHydrationRequirements(inspection.requirements);
    const plannedTransfers = parseHydrationTransfers(inspection.transfers, requirements);
    const operationId = createOperationId();
    const target = {
      operation: 'checkout-hydration',
      repositoryId,
      bindingRevision: input.bindingRevision,
      configRevision,
      remote: {
        name: remote.name,
        endpoint: {
          displayUrl: redactRemoteUrl(authority.endpoint),
          fingerprint: authority.endpointFingerprint,
        },
      },
      requirements,
    };
    const internal = {
      directory,
      endpointKind: 'fetch',
      transportMode: authority.transportMode,
      transportRevision: requiredString(authority.transportRevision, 'transportRevision'),
      expectedHeadSha,
      plannedRequirements: requirements,
      plannedTransfers,
      plannedSourceRequired: inspection.sourceRequired === true,
      parentEndpoint: authority.endpoint,
      parentRemoteName: remote.name,
      repositoryAuthority: {
        directory,
        repositoryId,
        bindingRevision: input.bindingRevision,
        configRevision,
      },
    };
    if (authority.credentialId) internal.credentialId = authority.credentialId;
    return bundlePlans({
      operationId,
      endpoint: authority.endpoint,
      transportMode: authority.transportMode,
      target,
      internal,
    });
  };

  const planNetworkOperation = async (input) => {
    if (!isPlainObject(input) || !OPERATIONS.includes(input.operation)) {
      throw planError('Git network operation input is invalid');
    }
    if (input.operation === 'clone') return planClone(input);
    if (input.operation === 'checkout-hydration') return planCheckoutHydration(input);
    if (input.operation === 'sync') return planSync(input);
    return planExisting(input);
  };

  const issueContributorDestination = async (input) => {
    if (!isPlainObject(input) || !hasExactKeys(input, [
      'directory', 'repositoryId', 'bindingRevision', 'configRevision', 'provenanceRevision',
      'remote', 'sourceRef', 'destinationRef', 'transportMode',
    ])) throw planError('Contributor destination selection input is invalid');
    const directory = requiredString(input.directory, 'directory');
    const contributor = await readContributor(directory);
    if (!contributor || contributor.revision !== input.provenanceRevision) {
      throw contributorError('DESTINATION_SELECTION_REQUIRED', 'Contributor push destination selection is required');
    }
    if (input.transportMode !== 'managed') {
      throw contributorError('CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED', 'Contributor transfers require managed credentials');
    }
    const remote = parseRemote(input.remote);
    if (!Number.isInteger(input.bindingRevision) || input.bindingRevision < 1
      || !Number.isInteger(input.provenanceRevision) || input.provenanceRevision < 1) {
      throw planError('Contributor destination selection revisions are invalid');
    }
    const sourceRef = parseExactRef(input.sourceRef, 'sourceRef', ['refs/heads/']);
    const destinationRef = parseExactRef(input.destinationRef, 'destinationRef', ['refs/heads/', 'refs/tags/']);
    const authority = await validateGitTransportContext({
      directory,
      repositoryId: requiredString(input.repositoryId, 'repositoryId'),
      bindingRevision: input.bindingRevision,
      configRevision: requiredString(input.configRevision, 'configRevision'),
      remote: remote.name,
      endpointKind: 'push',
    });
    if (authority.transportMode !== 'managed' || !authority.credentialId
      || authority.endpointFingerprint !== remote.endpoint.fingerprint
      || redactRemoteUrl(authority.endpoint) !== remote.endpoint.displayUrl) {
      throw contributorError('GIT_NETWORK_OPERATION_AUTHORITY_CHANGED', 'Git network operation authority changed');
    }
    const sourceSha = parseSha(await resolveRef(directory, sourceRef), 'resolved source ref');
    pruneContributorSelections();
    const selectionId = `git_destination_${crypto.randomUUID()}`;
    contributorSelections.set(selectionId, Object.freeze({
      worktreeId: contributor.worktreeId,
      provenanceRevision: contributor.revision,
      repositoryId: input.repositoryId,
      bindingRevision: input.bindingRevision,
      configRevision: input.configRevision,
      sourceSha,
      remoteName: remote.name,
      endpointFingerprint: authority.endpointFingerprint,
      destinationRef,
      expiresAt: Date.now() + 15 * 60 * 1000,
    }));
    return Object.freeze({ selectionId, provenanceRevision: contributor.revision, sourceSha, expiresInMs: 15 * 60 * 1000 });
  };

  return { planNetworkOperation, issueContributorDestination };
}
