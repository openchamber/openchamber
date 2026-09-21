import { normalizeDiscoveryEndpoint } from './discovery-endpoint.js';

export const SUBMODULE_DISCOVERY_LIMITS = Object.freeze({
  maxManifestBytes: 256 * 1024,
  maxGitlinkBytes: 256 * 1024,
  maxModules: 256,
  maxPathDepth: 16,
  maxRecursionDepth: 8,
  maxPublicRecords: 256,
});

const CONFIG_KEY_PATTERN = /^submodule\.(.+)\.(path|url|update)$/i;
const GITLINK_PATTERN = /^160000 (?:(?:commit )?([0-9a-f]{40}|[0-9a-f]{64})|([0-9a-f]{40}|[0-9a-f]{64}) 0)\t(.+)$/i;
const CONTROL_PATTERN = /[\0-\x1f\x7f]/;
const UPDATE_MODES = new Set(['checkout', 'merge', 'rebase', 'none']);
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

const manifestError = (message, code = 'INVALID_SUBMODULE_MANIFEST') => Object.assign(new Error(message), { code });

const boundedText = (value, maxBytes, label) => {
  if (!(isString(value) || Buffer.isBuffer(value))) throw manifestError(`${label} is invalid`);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.byteLength > maxBytes) throw manifestError(`${label} exceeds its byte limit`, 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED');
  const text = bytes.toString('utf8');
  if (text.includes('\ufffd')) throw manifestError(`${label} is not valid UTF-8`);
  return text;
};

const nullRecords = (text, label) => {
  if (!text) return [];
  if (!text.endsWith('\0')) throw manifestError(`${label} is incomplete`);
  const records = text.slice(0, -1).split('\0');
  if (records.some((record) => !record)) throw manifestError(`${label} contains an empty record`);
  return records;
};

const validateModulePath = (value, limits) => {
  if (!value || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes('\\') || CONTROL_PATTERN.test(value)) {
    throw manifestError('Submodule path is unsafe');
  }
  const parts = value.split('/');
  if (parts.length > limits.maxPathDepth) {
    throw manifestError('Submodule path exceeds its depth limit', 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED');
  }
  if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw manifestError('Submodule path is unsafe');
  }
  return value;
};

const validateModuleUrl = (value) => {
  if (/^(?:\.\.?\/)/.test(value)) {
    if (CONTROL_PATTERN.test(value) || value.includes('\\') || /[?#]/.test(value)) {
      throw manifestError('Submodule URL is unsafe');
    }
    return value;
  }
  try {
    return normalizeDiscoveryEndpoint(value).endpoint;
  } catch {
    throw manifestError('Submodule URL is unsafe');
  }
};

export function parseSubmoduleManifest({ gitmodulesConfig, gitlinks, recursionDepth = 0 }, limitOverrides = {}) {
  const limits = { ...SUBMODULE_DISCOVERY_LIMITS, ...limitOverrides };
  if (!Number.isInteger(recursionDepth) || recursionDepth < 0 || recursionDepth > limits.maxRecursionDepth) {
    throw manifestError('Submodule recursion exceeds its depth limit', 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED');
  }
  const configRecords = nullRecords(
    boundedText(gitmodulesConfig, limits.maxManifestBytes, '.gitmodules config output'),
    '.gitmodules config output',
  );
  const entries = new Map();
  for (const record of configRecords) {
    const separator = record.indexOf('\n');
    if (separator <= 0) throw manifestError('.gitmodules config record is malformed');
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    const match = key.match(CONFIG_KEY_PATTERN);
    if (!match || !value || CONTROL_PATTERN.test(match[1])) throw manifestError('.gitmodules config record is malformed');
    const name = match[1];
    const field = match[2].toLowerCase();
    const entry = entries.get(name) || { name };
    if (entry[field] !== undefined) throw manifestError(`Submodule ${name} has duplicate ${field}`);
    entry[field] = value;
    entries.set(name, entry);
    if (entries.size > limits.maxModules || entries.size > limits.maxPublicRecords) {
      throw manifestError('Submodule manifest exceeds its record limit', 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED');
    }
  }

  const gitlinkRecords = nullRecords(
    boundedText(gitlinks, limits.maxGitlinkBytes, 'Gitlink output'),
    'Gitlink output',
  );
  const gitlinksByPath = new Map();
  for (const record of gitlinkRecords) {
    const match = record.match(GITLINK_PATTERN);
    if (!match) throw manifestError('Gitlink record is malformed');
    const modulePath = validateModulePath(match[3], limits);
    if (gitlinksByPath.has(modulePath)) throw manifestError(`Gitlink path ${modulePath} is duplicated`);
    gitlinksByPath.set(modulePath, (match[1] || match[2]).toLowerCase());
    if (gitlinksByPath.size > limits.maxModules) {
      throw manifestError('Gitlink output exceeds its record limit', 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED');
    }
  }

  const seenPaths = new Set();
  const modules = [];
  for (const entry of entries.values()) {
    if (entry.path === undefined || entry.url === undefined) throw manifestError(`Submodule ${entry.name} is incomplete`);
    const modulePath = validateModulePath(entry.path, limits);
    if (seenPaths.has(modulePath)) throw manifestError(`Submodule path ${modulePath} is duplicated`);
    seenPaths.add(modulePath);
    const commit = gitlinksByPath.get(modulePath);
    if (!commit) throw manifestError(`Submodule ${entry.name} has no matching gitlink`);
    const update = entry.update?.toLowerCase() ?? 'checkout';
    if (entry.update !== undefined) {
      if (entry.update.startsWith('!') || !UPDATE_MODES.has(update)) {
        throw manifestError(`Submodule ${entry.name} has an unsafe update mode`);
      }
    }
    modules.push(Object.freeze({
      name: entry.name,
      path: modulePath,
      url: validateModuleUrl(entry.url),
      update,
      gitlink: commit,
    }));
  }
  if (modules.length !== gitlinksByPath.size) throw manifestError('Gitlink output contains an undeclared submodule');
  return Object.freeze({ recursionDepth, modules: Object.freeze(modules) });
}
