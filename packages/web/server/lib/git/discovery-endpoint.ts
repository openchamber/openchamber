import { isString } from '../shared/guards.js';
import path from 'node:path';

const CONTROL_PATTERN = /[\0-\x20\x7f]/;
const PATH_CONTROL_PATTERN = /[^\x20-\x7e\u0080-\uffff]/;
const SCP_PATTERN = /^(?:([^@/:\s]+)@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):([^\\]+)$/;

interface EndpointOptions {
  ownRemote?: boolean;
  trailingSlash?: boolean;
}

const RAW_URL_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/.*)$/;

interface ParsedEndpoint {
  kind: 'ssh' | 'https';
  style: 'scp' | 'url';
  user: string | null;
  host: string;
  port: string | null;
  endpointPath: string;
  rawPath: string;
  endpoint: string;
}

const discoveryError = (message: string) => Object.assign(new Error(message), {
  code: 'INVALID_GIT_DISCOVERY_ENDPOINT',
});

const decodePath = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw discoveryError('Git discovery endpoint path is malformed');
  }
};

const validatePath = (value: string, { absolute, allowSpace }: { absolute: boolean; allowSpace: boolean }) => {
  const decoded = decodePath(value);
  const parts = decoded.split('/');
  const content = absolute ? parts.slice(1) : parts;
  if ((allowSpace ? PATH_CONTROL_PATTERN : CONTROL_PATTERN).test(decoded) || decoded.includes('\\') || !content.length
    || content.some((part) => !part || part === '.' || part === '..')) {
    throw discoveryError('Git discovery endpoint path is unsafe');
  }
  return decoded;
};

const stripTrailingSlash = (value: string, parsed: URL) => {
  const rawPath = value.match(RAW_URL_PATH_PATTERN)?.[1];
  if (!rawPath || /[?#\\]/.test(value)) throw discoveryError('Git discovery endpoint is unsafe');
  validatePath(rawPath.slice(0, -1), { absolute: true, allowSpace: true });
  parsed.pathname = parsed.pathname.slice(0, -1);
};

const parseEndpoint = (value: string, { ownRemote = false, trailingSlash = false }: EndpointOptions = {}): ParsedEndpoint => {
  if (!isString(value) || !value || value.trim() !== value
    || value.startsWith('-') || CONTROL_PATTERN.test(value) || value.includes('::')) {
    throw discoveryError('Git discovery endpoint is invalid');
  }

  const scp = value.match(SCP_PATTERN);
  if (scp && !value.includes('://')) {
    if (/[?#]/.test(value)) throw discoveryError('Git discovery endpoint is unsafe');
    const [, user, host = '', remotePath = ''] = scp;
    const endpointPath = validatePath(remotePath, { absolute: false, allowSpace: false });
    return {
      kind: 'ssh',
      style: 'scp',
      user: user || null,
      host: host.toLowerCase(),
      port: null,
      endpointPath,
      rawPath: remotePath,
      endpoint: `${user ? `${user}@` : ''}${host.toLowerCase()}:${remotePath}`,
    };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw discoveryError('Git discovery endpoint is invalid');
  }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname
    || parsed.password || parsed.search || parsed.hash
    || (parsed.protocol === 'https:' && parsed.username && !ownRemote)) {
    throw discoveryError('Git discovery endpoint is unsafe');
  }
  if (parsed.protocol === 'https:') parsed.username = '';
  if (trailingSlash && value.endsWith('/')) stripTrailingSlash(value, parsed);
  const endpointPath = validatePath(parsed.pathname, { absolute: true, allowSpace: true });
  parsed.hostname = parsed.hostname.toLowerCase();
  const endpoint = parsed.toString().replace(/\/$/, '');
  return {
    kind: parsed.protocol === 'https:' ? 'https' : 'ssh',
    style: 'url',
    user: parsed.username || null,
    host: parsed.hostname,
    port: parsed.port || null,
    endpointPath,
    rawPath: parsed.pathname,
    endpoint,
  };
};

const pathRelationship = (parentPath: string, childPath: string) => {
  parentPath = parentPath.replace(/^\//, '');
  childPath = childPath.replace(/^\//, '');
  if (parentPath === childPath) return 'same';
  const parentDirectory = path.posix.dirname(parentPath);
  const childDirectory = path.posix.dirname(childPath);
  if (parentDirectory === childDirectory) return 'sibling';
  if (childPath.startsWith(`${parentPath}/`)) return 'descendant';
  if (parentPath.startsWith(`${childPath}/`)) return 'ancestor';
  return 'unrelated';
};

const joinRelativePath = (parentPath: string, relative: string) => {
  if (!/^(?:\.\.?\/)/.test(relative) || CONTROL_PATTERN.test(relative)
    || relative.includes('\\') || /[?#]/.test(relative)) {
    throw discoveryError('Relative Git discovery endpoint is invalid');
  }
  const stack = parentPath.split('/').filter(Boolean);
  for (const component of relative.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (!stack.length) throw discoveryError('Relative Git discovery endpoint escapes its authority');
      stack.pop();
      continue;
    }
    stack.push(component);
  }
  if (!stack.length) throw discoveryError('Relative Git discovery endpoint is invalid');
  return `${parentPath.startsWith('/') ? '/' : ''}${stack.join('/')}`;
};

const formatRelativeEndpoint = (parent: ParsedEndpoint, rawPath: string) => {
  if (parent.style === 'scp') {
    return `${parent.user ? `${parent.user}@` : ''}${parent.host}:${rawPath}`;
  }
  const authority = `${parent.user ? `${parent.user}@` : ''}${parent.host}${parent.port ? `:${parent.port}` : ''}`;
  return `${parent.kind}://${authority}${rawPath}`;
};

const publicEndpoint = <Extra extends object>(parsed: ParsedEndpoint, extra: Extra) => Object.freeze({
  kind: parsed.kind,
  endpoint: parsed.endpoint,
  host: parsed.host,
  port: parsed.port,
  path: parsed.endpointPath,
  ...extra,
});

export function normalizeDiscoveryEndpoint(value: string, options?: EndpointOptions) {
  return publicEndpoint(parseEndpoint(value, options), {});
}

export function resolveGitRelativeEndpoint(value: string, parentRemoteUrl: string, { trailingSlash = false } = {}) {
  const parent = parseEndpoint(parentRemoteUrl, { ownRemote: true, trailingSlash });
  const resolved = /^(?:\.\.?\/)/.test(value)
    ? parseEndpoint(formatRelativeEndpoint(parent, joinRelativePath(parent.rawPath, value)))
    : parseEndpoint(value, { trailingSlash });
  return publicEndpoint(resolved, {
    relationship: Object.freeze({
      sameHost: parent.host === resolved.host,
      samePort: parent.port === resolved.port,
      path: pathRelationship(parent.endpointPath, resolved.endpointPath),
    }),
  });
}
