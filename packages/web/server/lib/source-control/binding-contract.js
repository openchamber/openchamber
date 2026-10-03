const plain = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]'
  && Object.getPrototypeOf(value) === Object.prototype;
const string = (value) => Object.prototype.toString.call(value) === '[object String]';
const text = (value) => string(value) && value.length > 0;
const safePresentationText = (value, maximum = 512) => text(value) && value.length <= maximum
  && value.trim() === value && !/[\0\r\n]/.test(value);
const safeProviderUsername = (value) => safePresentationText(value, 255) && /^[A-Za-z0-9_.-]+$/.test(value);
const normalizedPresentationInstance = (value) => {
  if (value.provider === 'github') return value.instance === 'github.com';
  try {
    const parsed = new URL(value.instance);
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase());
    return parsed.origin === value.instance && !parsed.username && !parsed.password
      && ['', '/'].includes(parsed.pathname) && !parsed.search && !parsed.hash
      && (parsed.protocol === 'https:' || parsed.protocol === 'http:' && loopback);
  } catch { return false; }
};
const providerUserIdentityMatches = (value) => value.provider === 'github'
  ? /^github\.com#\d+$/.test(value.providerUserId)
  : value.providerUserId.startsWith(`${value.instance}#`)
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
      && value.transport === 'https' && ['github', 'gitlab'].includes(value.provider)
      && ['oauth', 'pat', 'cli'].includes(value.source) && safePresentationText(value.instance, 2048)
      && safeProviderUsername(value.username) && safePresentationText(value.providerUserId)
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
      || !['github', 'gitlab'].includes(entry.provider) || !text(entry.instance) || !text(entry.accountId) || !text(entry.primaryRemote)
      || entry.repository !== undefined && (!keys(entry.repository, ['owner', 'name']) || !text(entry.repository.owner) || !text(entry.repository.name))
      || !['ready', 'confirmation-required', 'account-unavailable', 'config-changed'].includes(entry.readiness)
      || !(entry.endpoint === null && entry.readiness !== 'ready' || endpoint(entry.endpoint))) throw invalid();
  }
  for (const entry of value.remotes) {
    if (!keys(entry, ['name', 'fetch', 'push', 'mode', 'readiness'], [
      'credentialId', ...(allowPresentation && entry.mode === 'managed' ? ['presentation'] : []),
    ])
      || !text(entry.name) || !endpoint(entry.fetch) || !endpoint(entry.push) || !credentialMatches(entry)
      || entry.presentation !== undefined && !credentialPresentation(entry.presentation)
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
  result.state = binding.configRevision !== repository.configRevision ? 'needs-attention' : bindingSummary(result);
  return result;
};
