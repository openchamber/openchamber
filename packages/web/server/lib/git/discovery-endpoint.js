import path from 'node:path';

const CONTROL_PATTERN = /[\0-\x20\x7f]/;
const SCP_PATTERN = /^(?:([^@/:\s]+)@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):([^\\]+)$/;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

const discoveryError = (message) => Object.assign(new Error(message), {
  code: 'INVALID_GIT_DISCOVERY_ENDPOINT',
});

const decodePath = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw discoveryError('Git discovery endpoint path is malformed');
  }
};

const validatePath = (value, { absolute }) => {
  const decoded = decodePath(value);
  const parts = decoded.split('/');
  const content = absolute ? parts.slice(1) : parts;
  if (CONTROL_PATTERN.test(decoded) || decoded.includes('\\') || !content.length
    || content.some((part) => !part || part === '.' || part === '..')) {
    throw discoveryError('Git discovery endpoint path is unsafe');
  }
  return decoded;
};

const parseEndpoint = (value) => {
  if (!isString(value) || !value || value.trim() !== value
    || value.startsWith('-') || CONTROL_PATTERN.test(value) || value.includes('::')) {
    throw discoveryError('Git discovery endpoint is invalid');
  }

  const scp = value.match(SCP_PATTERN);
  if (scp && !value.includes('://')) {
    if (/[?#]/.test(value)) throw discoveryError('Git discovery endpoint is unsafe');
    const endpointPath = validatePath(scp[3], { absolute: false });
    return {
      kind: 'ssh',
      style: 'scp',
      user: scp[1] || null,
      host: scp[2].toLowerCase(),
      port: null,
      endpointPath,
      endpoint: `${scp[1] ? `${scp[1]}@` : ''}${scp[2].toLowerCase()}:${scp[3]}`,
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
    || (parsed.protocol === 'https:' && parsed.username)) {
    throw discoveryError('Git discovery endpoint is unsafe');
  }
  const endpointPath = validatePath(parsed.pathname, { absolute: true });
  parsed.hostname = parsed.hostname.toLowerCase();
  const endpoint = parsed.toString().replace(/\/$/, '');
  return {
    kind: parsed.protocol === 'https:' ? 'https' : 'ssh',
    style: 'url',
    user: parsed.username || null,
    host: parsed.hostname,
    port: parsed.port || null,
    endpointPath,
    endpoint,
  };
};

const pathRelationship = (parentPath, childPath) => {
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

const joinRelativePath = (parentPath, relative) => {
  if (!/^(?:\.\.?\/)/.test(relative) || CONTROL_PATTERN.test(relative)
    || relative.includes('\\') || /[?#]/.test(relative)) {
    throw discoveryError('Relative Git discovery endpoint is invalid');
  }
  // Git treats the repository endpoint as a directory. Thus ../child.git,
  // rather than ./child.git, names a sibling of parent.git.
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

const formatRelativeEndpoint = (parent, endpointPath) => {
  if (parent.style === 'scp') {
    return `${parent.user ? `${parent.user}@` : ''}${parent.host}:${endpointPath}`;
  }
  const authority = `${parent.user ? `${parent.user}@` : ''}${parent.host}${parent.port ? `:${parent.port}` : ''}`;
  return `${parent.kind}://${authority}${endpointPath}`;
};

const publicEndpoint = (parsed, extra = {}) => Object.freeze({
  kind: parsed.kind,
  endpoint: parsed.endpoint,
  host: parsed.host,
  port: parsed.port,
  path: parsed.endpointPath,
  ...extra,
});

export function normalizeDiscoveryEndpoint(value) {
  return publicEndpoint(parseEndpoint(value));
}

export function resolveGitRelativeEndpoint(value, parentRemoteUrl) {
  const parent = parseEndpoint(parentRemoteUrl);
  const resolved = /^(?:\.\.?\/)/.test(value)
    ? parseEndpoint(formatRelativeEndpoint(parent, joinRelativePath(parent.endpointPath, value)))
    : parseEndpoint(value);
  return publicEndpoint(resolved, {
    relationship: Object.freeze({
      sameHost: parent.host === resolved.host,
      samePort: parent.port === resolved.port,
      path: pathRelationship(parent.endpointPath, resolved.endpointPath),
    }),
  });
}
