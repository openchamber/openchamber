import { isProviderId, isProviderUsername } from './provider-id.js';

// Persisted parsers validate a provider id's syntax only; the provider
// registry decides at read time whether that provider is available. A record
// written by a provider this build does not know therefore parses, survives
// every write untouched, and never fails the whole store.
const plain = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]'
  && Object.getPrototypeOf(value) === Object.prototype;
const string = (value) => Object.prototype.toString.call(value) === '[object String]';
const text = (value) => string(value) && value.length > 0;
const safePresentationText = (value, maximum = 512) => text(value) && value.length <= maximum
  && value.trim() === value && !/[\0\r\n]/.test(value);
// The same rule as `isLoopbackHost` in `../git/loopback-http.js` (localhost,
// 127.0.0.0/8, ::1), inlined because this file is bundled into the web client
// and stays dependency-free; `binding-contract.test.js` holds the two equal.
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const isPresentationLoopbackHost = (hostname) => {
  const value = hostname.toLowerCase();
  return value === 'localhost' || value === '::1' || value === '[::1]' || LOOPBACK_V4.test(value);
};
// An instance is either a bare lowercase hostname (GitHub's form) or a
// normalized origin (GitLab's form): HTTPS, or HTTP on a loopback host.
const normalizedPresentationInstance = (value) => {
  if (!value.instance.includes('://')) {
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.instance);
  }
  try {
    const parsed = new URL(value.instance);
    const loopback = isPresentationLoopbackHost(parsed.hostname);
    return parsed.origin === value.instance && !parsed.username && !parsed.password
      && ['', '/'].includes(parsed.pathname) && !parsed.search && !parsed.hash
      && (parsed.protocol === 'https:' || parsed.protocol === 'http:' && loopback);
  } catch { return false; }
};
// A provider user is `<instance>#<numeric id>` on every provider.
const providerUserIdentityMatches = (value) => value.providerUserId.startsWith(`${value.instance}#`)
  && /^\d+$/.test(value.providerUserId.slice(value.instance.length + 1));
const keys = (value, required, optional = []) => plain(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const safeEndpointPath = (pathname) => {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return false; }
  const normalized = decoded.replace(/^\/+|\/+$/g, '');
  return Boolean(normalized && !/[\0\r\n]/.test(normalized)
    && !normalized.split('/').some((part) => !part || part === '.' || part === '..'));
};
const safeDisplayUrl = (value) => {
  if (!text(value) || value.trim() !== value || value.length > 4096 || /[\0\r\n]/.test(value)) return false;
  if (!value.includes('://')) {
    const match = value.match(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:([^\s:\\]+)$/);
    return Boolean(match && !/[?#]/.test(value) && !match[1].startsWith('-')
      && safeEndpointPath(`/${match[1]}`));
  }
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'ssh:'].includes(parsed.protocol) && Boolean(parsed.hostname)
      && (!parsed.username || parsed.protocol === 'ssh:') && !parsed.password && !parsed.search && !parsed.hash
      && safeEndpointPath(parsed.pathname);
  } catch {
    return false;
  }
};
export const isSafeRepositoryEndpoint = (value) => keys(value, ['displayUrl', 'fingerprint'])
  && safeDisplayUrl(value.displayUrl)
  && text(value.fingerprint)
  && value.fingerprint.length <= 128
  && /^[A-Za-z0-9_-]+$/.test(value.fingerprint);
const endpoint = isSafeRepositoryEndpoint;
const credentialMatches = (entry) => ['managed', 'system', 'anonymous'].includes(entry.mode)
  && (entry.mode === 'managed' ? text(entry.credentialId) : !Object.hasOwn(entry, 'credentialId'));
const credentialPresentation = (value) => plain(value) && Object.hasOwn(value, 'status') && (value.status === 'unavailable'
  && keys(value, ['status']) || value.status === 'available' && (
    keys(value, ['status', 'transport', 'fingerprint']) && value.transport === 'ssh'
      && /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value.fingerprint)
    || keys(value, ['status', 'transport', 'provider', 'instance', 'source', 'username', 'providerUserId'])
      && value.transport === 'https' && isProviderId(value.provider)
      && ['oauth', 'pat', 'cli'].includes(value.source) && safePresentationText(value.instance, 2048)
      && isProviderUsername(value.username) && safePresentationText(value.providerUserId)
      && normalizedPresentationInstance(value) && providerUserIdentityMatches(value)
  ));
const unique = (entries, key) => new Set(entries.map(key)).size === entries.length;
const invalid = () => Object.assign(new Error('Source control binding storage is invalid'), { code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
const validateBinding = (value, allowPresentation = false) => {
  if (!keys(value, ['repositoryId', 'revision', 'state', 'configRevision', 'providers', 'remotes'], ['auxiliary'])
    || !text(value.repositoryId) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !text(value.configRevision) || !['bound', 'needs-attention'].includes(value.state)
    || !Array.isArray(value.providers) || !Array.isArray(value.remotes)
    || !Array.isArray(value.auxiliary)) throw invalid();
  for (const entry of value.providers) {
    if (!keys(entry, ['provider', 'instance', 'accountId', 'primaryRemote', 'readiness', 'endpoint'], ['repository'])
      || !isProviderId(entry.provider) || !text(entry.instance) || !text(entry.accountId) || !text(entry.primaryRemote)
      || entry.repository !== undefined && (!keys(entry.repository, ['owner', 'name']) || !text(entry.repository.owner) || !text(entry.repository.name))
      || !['ready', 'confirmation-required', 'account-unavailable', 'config-changed'].includes(entry.readiness)
      || !(entry.endpoint === null && entry.readiness !== 'ready' || endpoint(entry.endpoint))) throw invalid();
  }
  for (const entry of value.remotes) {
    // `inherited` marks a grant derived from the repository's identity in a
    // response; persisted records never carry it.
    if (!keys(entry, ['name', 'fetch', 'push', 'mode', 'readiness'], [
      'credentialId', ...(allowPresentation && entry.mode === 'managed' ? ['presentation'] : []),
      ...(allowPresentation ? ['inherited'] : []),
    ])
      || !text(entry.name) || !endpoint(entry.fetch) || !endpoint(entry.push) || !credentialMatches(entry)
      || entry.presentation !== undefined && !credentialPresentation(entry.presentation)
      || entry.inherited !== undefined && (entry.inherited !== true || entry.readiness !== 'ready')
      || entry.mode === 'anonymous' && !entry.fetch.displayUrl.startsWith('https://')
      || !['ready', 'confirmation-required', 'config-changed'].includes(entry.readiness)) throw invalid();
  }
  for (const entry of value.auxiliary ?? []) {
    if (!keys(entry, ['kind', 'endpoint', 'mode', 'readiness'], ['credentialId'])
      || !['submodule', 'lfs'].includes(entry.kind) || !endpoint(entry.endpoint) || !credentialMatches(entry)
      || entry.mode === 'anonymous' && !entry.endpoint.displayUrl.startsWith('https://')
      || !['ready', 'confirmation-required'].includes(entry.readiness)) throw invalid();
  }
  if ((value.auxiliary?.length ?? 0) > 256 || !unique(value.remotes, (entry) => entry.name)
    || !unique(value.providers, (entry) => `${entry.provider}\0${entry.instance}\0${entry.primaryRemote}`)
    || !unique(value.auxiliary ?? [], (entry) => `${entry.kind}\0${entry.endpoint.fingerprint}`)) throw invalid();
};

export const bindingSummary = (binding) => [...binding.providers, ...binding.remotes, ...binding.auxiliary]
  .some((entry) => entry.readiness !== 'ready') ? 'needs-attention' : 'bound';

export const parseBinding = (value) => {
  validateBinding(value);
  return structuredClone(value);
};

export const parseBindingResponse = (value) => {
  validateBinding(value, true);
  return structuredClone(value);
};

export const parseBindingStore = (value) => {
  if (!keys(value, ['version', 'repositories']) || value.version !== 2 || !plain(value.repositories)) throw invalid();
  for (const [id, record] of Object.entries(value.repositories)) {
    if (!text(id) || !keys(record, ['revision', 'binding']) || !Number.isSafeInteger(record.revision) || record.revision < 1) throw invalid();
    if (record.binding !== null) {
      validateBinding(record.binding);
      if (record.binding.repositoryId !== id || record.binding.revision !== record.revision) throw invalid();
    }
  }
  return structuredClone(value);
};

export const resolveBindingReadiness = (binding, repository) => {
  const remotes = new Map(repository.remotes.map((entry) => [entry.name, entry]));
  const providers = binding.providers.map((entry) => entry.readiness === 'ready'
    && entry.endpoint?.fingerprint !== remotes.get(entry.primaryRemote)?.fetch.fingerprint
    ? { ...entry, readiness: 'config-changed' } : entry);
  const grants = binding.remotes.map((entry) => {
    const current = remotes.get(entry.name);
    return entry.readiness === 'ready' && (!current || entry.fetch.fingerprint !== current.fetch.fingerprint
      || entry.push.fingerprint !== current.push.fingerprint) ? { ...entry, readiness: 'config-changed' } : entry;
  });
  const result = { ...binding, providers, remotes: grants };
  // The summary follows what the grants still authorize: a remote added beside
  // the bound ones changes the config revision but nothing the binding relies on.
  result.state = bindingSummary(result);
  return result;
};
