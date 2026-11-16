import { isString } from '../shared/guards.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCallbackAddress } from '../agent-tool/callback-address.js';
import { parseGitCredentialQuery } from './credential-broker.js';
import { parseGitCredentialReference } from './credential-resolver.js';
import { helperShellCommand } from './helper-launch.js';
import { isLoopbackHost } from './loopback-http.js';

const HELPER_PATH = fileURLToPath(new URL('./repository-credential-helper.js', import.meta.url));
const MAX_QUERY_BYTES = 64 * 1024;
const NONE = Object.freeze({ mode: 'none' });
const SYSTEM = Object.freeze({ mode: 'system' });

const transferOrigin = (displayUrl) => {
  try {
    const url = new URL(displayUrl);
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname)) ? url.origin : null;
  } catch {
    return null;
  }
};

const queryOrigin = (query) => {
  const protocol = isString(query.protocol) ? query.protocol : '';
  const host = isString(query.host) ? query.host : '';
  if (!['https', 'http'].includes(protocol) || !host) return null;
  return transferOrigin(`${protocol}://${host}`);
};

const repositoryPath = (value) => value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');

const pathMatches = (queryPath, displayUrl) => {
  const own = repositoryPath(new URL(displayUrl).pathname);
  const asked = queryPath.replace(/^\/+|\/+$/g, '');
  return repositoryPath(asked) === own || asked.startsWith(`${own}/`) || asked.startsWith(`${own}.git/`);
};

const grantForEndpoint = (read, origin, queryPath) => {
  const current = new Map(read.repository.remotes.map((remote) => [remote.name, remote]));
  const matches = [];
  for (const grant of read.binding?.remotes ?? []) {
    const urls = [grant.fetch.displayUrl, grant.push.displayUrl]
      .filter((url) => transferOrigin(url) === origin && (!queryPath || pathMatches(queryPath, url)));
    if (urls.length === 0) continue;
    const remote = current.get(grant.name);
    const vouched = remote && grant.readiness === 'ready'
      && grant.fetch.fingerprint === remote.fetch.fingerprint
      && grant.push.fingerprint === remote.push.fingerprint;
    matches.push(vouched || grant.mode === 'system' ? { grant, endpointUrl: urls[0] } : 'unavailable');
  }
  if (matches.length === 0) return null;
  if (matches.includes('unavailable')) return 'unavailable';
  const [first] = matches;
  const sameAnswer = matches.every(({ grant }) => grant.mode === first.grant.mode && grant.credentialId === first.grant.credentialId);
  return sameAnswer ? first : 'unavailable';
};

const credentialEndpoint = (endpointUrl) => {
  const url = new URL(endpointUrl);
  const protocol = url.protocol === 'http:' ? 'http' : 'https';
  return {
    protocol,
    host: url.hostname.toLowerCase(),
    port: Number(url.port || (protocol === 'http' ? 80 : 443)),
    path: url.pathname,
  };
};

export function createGitRepositoryCredentialRuntime({
  readBinding,
  credentialResolver,
  dataDir,
  fsPromises,
  getActivePort,
  getActiveHost = () => null,
  helperPath = HELPER_PATH,
  helperLaunch,
  randomBytes = crypto.randomBytes,
}) {
  if (!(readBinding instanceof Function) || !credentialResolver || !isString(dataDir)
    || !fsPromises || !(getActivePort instanceof Function)) {
    throw new TypeError('Git repository credential runtime dependencies are invalid');
  }
  const { callbackHost, isSameMachineAddress } = createCallbackAddress(getActiveHost);
  const endpointFilePath = path.join(dataDir, 'git-credential-endpoint.json');
  const launcherPath = path.join(dataDir, 'bin', 'git-credential-openchamber');
  let activeSecret = null;

  const answer = async (payload) => {
    const cwd = isString(payload?.cwd) ? payload.cwd : '';
    const rawQuery = isString(payload?.query) ? payload.query : '';
    if (!cwd || !rawQuery || rawQuery.length > MAX_QUERY_BYTES) return NONE;
    let origin;
    let queryPath;
    try {
      const query = parseGitCredentialQuery(rawQuery);
      origin = queryOrigin(query);
      queryPath = isString(query.path) ? query.path : '';
    } catch { return NONE; }
    if (!origin) return NONE;
    let read;
    try { read = await readBinding(cwd); }
    catch { return NONE; }
    if (!read.binding) return SYSTEM;
    const matched = grantForEndpoint(read, origin, queryPath);
    if (!matched) return SYSTEM;
    if (matched === 'unavailable') return NONE;
    const { grant, endpointUrl } = matched;
    if (grant.mode === 'system') return SYSTEM;
    if (grant.mode !== 'managed' || !grant.credentialId) return NONE;
    try {
      if (parseGitCredentialReference(grant.credentialId).transport !== 'https') return NONE;
      const credential = await credentialResolver.resolve({
        mode: 'managed',
        credentialId: grant.credentialId,
        endpoint: credentialEndpoint(endpointUrl),
        operationId: `git_repo_${randomBytes(8).toString('hex')}`,
        deadline: Date.now() + 15_000,
      });
      if (credential?.transport !== 'https' || !credential.username || !credential.password) return NONE;
      return { mode: 'managed', username: credential.username, password: credential.password };
    } catch {
      return NONE;
    }
  };

  const authorize = (req) => {
    if (!activeSecret || !isSameMachineAddress(req.socket?.remoteAddress)) return false;
    const header = isString(req.headers?.authorization) ? req.headers.authorization : '';
    if (!header.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(activeSecret);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };

  const writePrivate = async (target, content, mode) => {
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fsPromises.writeFile(temporary, content, { encoding: 'utf8', mode });
    await fsPromises.chmod(temporary, mode);
    await fsPromises.rename(temporary, target);
  };

  return Object.freeze({
    helperCommand: () => `!'${launcherPath.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`,
    publish: async () => {
      const port = getActivePort();
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error('OpenChamber listener port is unavailable for the Git credential helper');
      }
      activeSecret = randomBytes(32).toString('base64url');
      const url = `http://${callbackHost()}:${port}/api/git/repository-credential`;
      await writePrivate(endpointFilePath, `${JSON.stringify({ version: 1, url, secret: activeSecret })}\n`, 0o600);
      const script = `#!/bin/sh\n${helperShellCommand(path.resolve(helperPath), [endpointFilePath], helperLaunch)} "$@"\n`;
      await writePrivate(launcherPath, script, 0o700);
    },
    registerRoutes: (app) => {
      app.post('/api/git/repository-credential', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!authorize(req)) return res.status(403).end();
        return res.json(await answer(req.body ?? {}));
      });
    },
  });
}
