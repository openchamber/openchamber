import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGitCredentialEndpoint } from './credential-resolver.js';

const DEFAULT_CAPACITY = 64;
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const HELPER_PATH = fileURLToPath(new URL('./credential-helper.js', import.meta.url));
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

/**
 * Git's credential wire format: `key=value` lines, one per attribute. Exported
 * so everything that answers git parses the same shape.
 */
export const parseGitCredentialQuery = (value) => {
  const result = {};
  for (const line of String(value).split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('Invalid credential query');
    const key = line.slice(0, separator);
    if (Object.hasOwn(result, key)) {
      if (['protocol', 'host', 'path'].includes(key)) throw new Error('Invalid credential query');
      continue;
    }
    result[key] = line.slice(separator + 1);
  }
  return result;
};

const endpointFromQuery = (query) => {
  const protocol = query.protocol;
  const rawHost = query.host;
  if (!protocol || !rawHost || !query.path) throw new Error('Incomplete credential query');
  return normalizeGitCredentialEndpoint({ protocol, host: rawHost, path: query.path });
};

const sameEndpoint = (left, right) => left.protocol === right.protocol
  && left.host === right.host
  && left.port === right.port
  && left.path === right.path;

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function createGitCredentialBroker({
  capacity = DEFAULT_CAPACITY,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  helperPath = HELPER_PATH,
  createServer = http.createServer,
} = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new Error('Invalid Git credential broker limits');
  }
  const leases = new Map();
  const operationOwners = new Map();
  let server = null;
  let brokerUrl = null;

  const remove = (nonce) => {
    const lease = leases.get(nonce);
    if (!lease) return false;
    leases.delete(nonce);
    if (operationOwners.get(lease.operationId) === nonce) operationOwners.delete(lease.operationId);
    return true;
  };
  const cleanup = () => {
    const current = now();
    for (const [nonce, lease] of leases) {
      if (lease.expiresAt <= current) remove(nonce);
    }
  };
  const handle = (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-security-policy', "default-src 'none'");
    if (request.method !== 'POST' || request.url !== '/credential') {
      response.writeHead(404).end();
      return;
    }
    const nonce = request.headers['x-openchamber-git-nonce'];
    const operation = request.headers['x-openchamber-git-operation'];
    cleanup();
    const lease = isString(nonce) ? leases.get(nonce) : null;
    if (!lease || operation !== 'get' || lease.used) {
      response.writeHead(403).end();
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        if (leases.get(nonce) !== lease || lease.used || lease.expiresAt <= now()) {
          remove(nonce);
          throw new Error('Credential lease is no longer active');
        }
        const endpoint = endpointFromQuery(parseGitCredentialQuery(Buffer.concat(chunks).toString('utf8')));
        if (!lease.endpoints.some((candidate) => sameEndpoint(endpoint, candidate))) throw new Error('Credential endpoint mismatch');
        lease.used = true;
        const body = `username=${lease.username}\npassword=${lease.password}\n\n`;
        response.writeHead(200, { 'content-type': 'application/x-git-credential', 'content-length': Buffer.byteLength(body) });
        response.end(body);
        remove(nonce);
      } catch {
        response.writeHead(403).end();
      }
    });
  };

  return Object.freeze({
    start: async () => {
      if (server) return;
      const candidate = createServer(handle);
      try {
        await new Promise((resolve, reject) => {
          candidate.once('error', reject);
          candidate.listen(0, '127.0.0.1', resolve);
        });
      } catch (error) {
        candidate.close();
        throw error;
      }
      candidate.removeAllListeners('error');
      candidate.on('error', () => {});
      candidate.unref();
      const address = candidate.address();
      server = candidate;
      brokerUrl = `http://127.0.0.1:${address.port}/credential`;
    },
    issue: ({ operationId, credential, endpointAliases = [] }) => {
      if (!server || !brokerUrl) throw new Error('Git credential broker is not started');
      if (!isString(operationId) || !operationId || operationId.includes('\0')) throw new Error('Invalid Git operation ID');
      if (credential?.mode !== 'managed' || credential.transport !== 'https') throw new Error('HTTPS credential snapshot is required');
      if (!Array.isArray(endpointAliases)) throw new Error('Invalid Git credential endpoint aliases');
      if (!isString(credential.username) || !credential.username || /[\r\n\0]/.test(credential.username)
        || !isString(credential.password) || !credential.password || /[\r\n\0]/.test(credential.password)) {
        throw new Error('Invalid HTTPS credential snapshot');
      }
      cleanup();
      if (operationOwners.has(operationId)) throw new Error('Git operation already owns a credential');
      if (leases.size >= capacity) throw new Error('Git credential broker capacity exceeded');
      const nonce = randomBytes(32).toString('base64url');
      if (!nonce || leases.has(nonce)) throw new Error('Failed to allocate Git credential');
      const expiresAt = now() + ttlMs;
      leases.set(nonce, {
        operationId,
        endpoints: Object.freeze([
          normalizeGitCredentialEndpoint(credential.allowedEndpoint),
          ...endpointAliases.map((alias) => normalizeGitCredentialEndpoint(alias)),
        ]),
        username: credential.username,
        password: credential.password,
        expiresAt,
        used: false,
      });
      operationOwners.set(operationId, nonce);
      const helperCommand = `!${shellQuote(process.execPath)} ${shellQuote(path.resolve(helperPath))} ${shellQuote(brokerUrl)} ${shellQuote(nonce)}`;
      return Object.freeze({
        gitConfigArgs: Object.freeze([
          '-c', 'credential.helper=',
          '-c', 'credential.useHttpPath=true',
          '-c', `credential.helper=${helperCommand}`,
        ]),
        expiresAt,
        redactionSecrets: Object.freeze([nonce, brokerUrl, helperCommand]),
        revoke: () => remove(nonce),
      });
    },
    revoke: (operationId) => {
      const nonce = operationOwners.get(operationId);
      return nonce ? remove(nonce) : false;
    },
    cleanup,
    snapshot: () => {
      cleanup();
      return Object.freeze({ activeOperations: leases.size, capacity, ttlMs, listening: Boolean(server) });
    },
    close: async () => {
      leases.clear();
      operationOwners.clear();
      const active = server;
      server = null;
      brokerUrl = null;
      if (active) await new Promise((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
    },
  });
}
