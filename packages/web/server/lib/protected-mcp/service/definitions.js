import { createHash } from 'node:crypto';
import path from 'node:path';
import { isBoolean, isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError, isConnectionName } from './contract.js';
import { parseRedirectUri } from './oauth-redirect.js';

const SLOT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BIN_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const TOOL_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}\*?$/;
const OAUTH_SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/;
/** Hosts where plain `http` stays on this machine; every other address needs `https`. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const MAX_ITEMS = 64;
const MAX_TEXT = 4096;
const MAX_TOOLS = 512;

/** Variables that make an interpreter load code from a path; set by the service or not at all. */
const RESERVED_ENVIRONMENT = new Set([
  'PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'LD_AUDIT', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PERL5LIB', 'PERL5OPT', 'RUBYLIB', 'RUBYOPT',
  'BASH_ENV', 'ENV', 'GIT_EXEC_PATH', 'GCONV_PATH',
]);
/** Headers the HTTP transport owns. */
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'accept', 'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'proxy-authorization', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id',
]);

const fail = (code, field) => {
  throw new ProtectedMcpError(code, { message: field ? `${code}: ${field}` : code });
};

const plainText = (value, field, { max = MAX_TEXT } = {}) => {
  if (!isString(value) || value.length > max || value.includes('\0')) fail('invalid_definition', field);
  return value;
};

const relativeStatePath = (value, field) => {
  const text = plainText(value, field, { max: 512 });
  const normalized = path.posix.normalize(text);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) fail('invalid_state_path', field);
  return normalized;
};

const slotReference = (value, key, field) => {
  if (!SLOT.test(value[key] ?? '')) fail('invalid_secret_slot', field);
  return value[key];
};

const onlyKeys = (value, allowed, field) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('invalid_definition', `${field}.${key}`);
  }
};

const parseArgument = (value, field) => {
  if (isString(value)) return plainText(value, field);
  if (!isPlainObject(value)) fail('invalid_definition', field);
  if ('secret' in value || 'secretFile' in value) fail('secret_in_arguments', field);
  onlyKeys(value, ['state'], field);
  return { state: relativeStatePath(value.state, field) };
};

const parseEnvironmentValue = (value, field) => {
  if (isString(value)) return plainText(value, field);
  if (!isPlainObject(value)) fail('invalid_definition', field);
  const [kind] = Object.keys(value);
  if (Object.keys(value).length !== 1) fail('invalid_definition', field);
  if (kind === 'secret') return { secret: slotReference(value, 'secret', field) };
  if (kind === 'secretFile') return { secretFile: slotReference(value, 'secretFile', field) };
  if (kind === 'state') return { state: relativeStatePath(value.state, field) };
  return fail('invalid_definition', field);
};

const parseCommand = (value) => {
  if (isString(value)) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) fail('invalid_command', 'stdio.command');
    return value;
  }
  if (!isPlainObject(value)) fail('invalid_command', 'stdio.command');
  onlyKeys(value, ['package', 'version', 'bin'], 'stdio.command');
  if (!PACKAGE_NAME.test(value.package ?? '') || value.package.length > 214) fail('invalid_package', 'stdio.command.package');
  if (!EXACT_VERSION.test(value.version ?? '')) fail('invalid_package', 'stdio.command.version');
  if (!BIN_NAME.test(value.bin ?? '')) fail('invalid_package', 'stdio.command.bin');
  return { package: value.package, version: value.version, bin: value.bin };
};

const parseStdio = (value) => {
  if (!isPlainObject(value)) fail('invalid_definition', 'stdio');
  onlyKeys(value, ['command', 'args', 'env'], 'stdio');
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ITEMS) fail('invalid_definition', 'stdio.args');
  const env = value.env ?? {};
  if (!isPlainObject(env) || Object.keys(env).length > MAX_ITEMS) fail('invalid_definition', 'stdio.env');
  const parsedEnv = {};
  for (const [name, item] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) fail('invalid_definition', `stdio.env.${name}`);
    if (RESERVED_ENVIRONMENT.has(name) || name.startsWith('DYLD_')) fail('reserved_environment', `stdio.env.${name}`);
    parsedEnv[name] = parseEnvironmentValue(item, `stdio.env.${name}`);
  }
  return {
    command: parseCommand(value.command),
    args: args.map((item, index) => parseArgument(item, `stdio.args.${index}`)),
    env: parsedEnv,
  };
};

const parseUrl = (value, field) => {
  let url;
  try {
    url = new URL(plainText(value, field, { max: 2048 }));
  } catch {
    return fail('invalid_url', field);
  }
  if (url.username || url.password || url.hash) fail('insecure_url', field);
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.href;
  return fail('insecure_url', field);
};

const parseHeaderValue = (value, field) => {
  const noLineBreak = (text) => {
    if (/[\r\n]/.test(text)) fail('invalid_definition', field);
    return text;
  };
  if (isString(value)) return noLineBreak(plainText(value, field));
  if (!isPlainObject(value)) fail('invalid_definition', field);
  onlyKeys(value, ['secret', 'prefix'], field);
  const result = { secret: slotReference(value, 'secret', field) };
  if (value.prefix !== undefined) result.prefix = noLineBreak(plainText(value.prefix, field, { max: 64 }));
  return result;
};

const parseOAuth = (value) => {
  if (!isPlainObject(value)) fail('invalid_definition', 'http.oauth');
  onlyKeys(value, ['scopes', 'clientId', 'clientSecret', 'issuer', 'redirectUri'], 'http.oauth');
  const scopes = value.scopes ?? [];
  if (!Array.isArray(scopes) || scopes.length > MAX_ITEMS || !scopes.every((scope) => OAUTH_SCOPE.test(scope ?? ''))) {
    fail('invalid_definition', 'http.oauth.scopes');
  }
  const result = { scopes: [...scopes] };
  if (value.clientId !== undefined) result.clientId = plainText(value.clientId, 'http.oauth.clientId', { max: 512 });
  if (value.issuer !== undefined) result.issuer = parseUrl(value.issuer, 'http.oauth.issuer');
  if (value.redirectUri !== undefined) result.redirectUri = parseRedirectUri(value.redirectUri, 'http.oauth.redirectUri');
  if (value.clientSecret !== undefined) {
    if (!isPlainObject(value.clientSecret)) fail('invalid_definition', 'http.oauth.clientSecret');
    onlyKeys(value.clientSecret, ['secret'], 'http.oauth.clientSecret');
    result.clientSecret = { secret: slotReference(value.clientSecret, 'secret', 'http.oauth.clientSecret') };
  }
  return result;
};

const parseHttp = (value) => {
  if (!isPlainObject(value)) fail('invalid_definition', 'http');
  onlyKeys(value, ['url', 'headers', 'oauth'], 'http');
  const headers = value.headers ?? {};
  if (!isPlainObject(headers) || Object.keys(headers).length > MAX_ITEMS) fail('invalid_definition', 'http.headers');
  const parsedHeaders = {};
  for (const [name, item] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) fail('reserved_header', `http.headers.${name}`);
    if (Object.keys(parsedHeaders).some((existing) => existing.toLowerCase() === name.toLowerCase())) fail('invalid_definition', `http.headers.${name}`);
    parsedHeaders[name] = parseHeaderValue(item, `http.headers.${name}`);
  }
  const result = { url: parseUrl(value.url, 'http.url'), headers: parsedHeaders };
  if (value.oauth !== undefined) {
    if (Object.keys(parsedHeaders).some((name) => name.toLowerCase() === 'authorization')) fail('conflicting_authorization', 'http.headers.Authorization');
    result.oauth = parseOAuth(value.oauth);
  }
  return result;
};

const parseToolList = (value, field) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TOOLS || !value.every((item) => TOOL_PATTERN.test(item ?? ''))) fail('invalid_definition', field);
  return [...new Set(value)];
};

const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

const parsePolicy = (value) => {
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail('invalid_definition', 'policy');
  onlyKeys(value, ['allowTools', 'denyTools', 'defaultArguments'], 'policy');
  const result = {};
  const allowTools = parseToolList(value.allowTools, 'policy.allowTools');
  const denyTools = parseToolList(value.denyTools, 'policy.denyTools');
  if (allowTools) result.allowTools = allowTools;
  if (denyTools) result.denyTools = denyTools;
  if (value.defaultArguments !== undefined) {
    const defaults = value.defaultArguments;
    if (!isPlainObject(defaults) || Object.keys(defaults).length > MAX_ITEMS) fail('invalid_definition', 'policy.defaultArguments');
    for (const [name, item] of Object.entries(defaults)) {
      if (!ARGUMENT_NAME.test(name)) fail('invalid_definition', `policy.defaultArguments.${name}`);
      plainText(item, `policy.defaultArguments.${name}`, { max: 512 });
    }
    result.defaultArguments = { ...defaults };
  }
  return result;
};

/**
 * A connection definition as the administrator submitted it, validated and
 * normalized. Ids and revisions belong to the store, never to the submission.
 */
export function parseDefinition(input) {
  if (!isPlainObject(input)) fail('invalid_definition');
  onlyKeys(input, ['name', 'enabled', 'transport', 'stdio', 'http', 'policy'], 'definition');
  if (!isConnectionName(input.name)) fail('invalid_name', 'name');
  if (input.enabled !== undefined && !isBoolean(input.enabled)) fail('invalid_definition', 'enabled');
  const definition = { name: input.name, enabled: input.enabled !== false, transport: input.transport };
  if (input.transport === 'stdio') {
    if (input.http !== undefined) fail('invalid_definition', 'http');
    definition.stdio = parseStdio(input.stdio);
  } else if (input.transport === 'http') {
    if (input.stdio !== undefined) fail('invalid_definition', 'stdio');
    definition.http = parseHttp(input.http);
  } else {
    fail('invalid_transport', 'transport');
  }
  definition.policy = parsePolicy(input.policy);
  return definition;
}

/** Every secret slot a definition refers to, sorted. */
export function secretSlots(definition) {
  const slots = new Set();
  const collect = (value) => {
    if (!isPlainObject(value)) return;
    if (isString(value.secret)) slots.add(value.secret);
    if (isString(value.secretFile)) slots.add(value.secretFile);
  };
  if (definition.transport === 'stdio') Object.values(definition.stdio.env).forEach(collect);
  else {
    Object.values(definition.http.headers).forEach(collect);
    collect(definition.http.oauth?.clientSecret);
  }
  return [...slots].sort();
}

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * A hash of everything that decides where a credential goes and what runs with
 * it. Stored credentials are bound to it; a different hash means a different
 * destination, and the credentials no longer apply.
 */
export function destinationFingerprint(definition) {
  const destination = definition.transport === 'stdio'
    ? { transport: 'stdio', command: definition.stdio.command, args: definition.stdio.args, env: definition.stdio.env }
    : { transport: 'http', url: definition.http.url, headers: definition.http.headers, oauth: definition.http.oauth ?? null };
  return createHash('sha256').update(canonicalJson(destination)).digest('hex');
}
