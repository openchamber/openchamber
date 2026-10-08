import { isString } from '../shared/guards.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCallbackAddress } from '../agent-tool/callback-address.js';
import { parseGitCredentialQuery } from './credential-broker.js';
import { parseGitCredentialReference } from './credential-resolver.js';
import { helperShellCommand } from './helper-launch.js';

const HELPER_PATH = fileURLToPath(new URL('./repository-credential-helper.js', import.meta.url));
const MAX_QUERY_BYTES = 64 * 1024;
const NONE = Object.freeze({ mode: 'none' });
const SYSTEM = Object.freeze({ mode: 'system' });

/** The origin a redacted remote URL points at, or null when it is not HTTPS. */
const httpsOrigin = (displayUrl) => {
  try {
    const url = new URL(displayUrl);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

const queryOrigin = (query) => {
  const protocol = isString(query.protocol) ? query.protocol : '';
  const host = isString(query.host) ? query.host : '';
  if (protocol !== 'https' || !host) return null;
  return httpsOrigin(`https://${host}`);
};

/** A repository path without its slashes or `.git`, so `o/r` and `/o/r.git` compare equal. */
const repositoryPath = (value) => value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');

/**
 * Whether Git's query path names this remote URL's repository. git-lfs asks
 * for the LFS endpoint under it (`o/r.git/info/lfs`), which is the same
 * repository.
 */
const pathMatches = (queryPath, displayUrl) => {
  const own = repositoryPath(new URL(displayUrl).pathname);
  const asked = queryPath.replace(/^\/+|\/+$/g, '');
  return repositoryPath(asked) === own || asked.startsWith(`${own}/`) || asked.startsWith(`${own}.git/`);
};

/**
 * The grant that answers for this endpoint: `{ grant, endpointUrl }`, the
 * string `'unavailable'`, or null when no grant names the endpoint.
 *
 * Git sends the repository path because the repository's `.git/config` turns
 * on `credential.useHttpPath`, so an origin and a fork on the same host, bound
 * to different accounts, each get their own. A repository configured before
 * that sends no path; it is answered only when every grant on the host agrees.
 *
 * A grant only answers while the binding still matches the repository's own
 * remotes and is ready, which is the same readiness the Git panel shows. A
 * grant that names the endpoint but is not ready (its account was
 * disconnected, or the remote changed) is unavailable rather than absent:
 * handing it to the machine's own chain would push as another account while
 * the panel says this one needs repair.
 */
const grantForEndpoint = (read, origin, queryPath) => {
  const current = new Map(read.repository.remotes.map((remote) => [remote.name, remote]));
  const matches = [];
  for (const grant of read.binding?.remotes ?? []) {
    const urls = [grant.fetch.displayUrl, grant.push.displayUrl]
      .filter((url) => httpsOrigin(url) === origin && (!queryPath || pathMatches(queryPath, url)));
    if (urls.length === 0) continue;
    const remote = current.get(grant.name);
    const vouched = remote && grant.readiness === 'ready'
      && grant.fetch.fingerprint === remote.fetch.fingerprint
      && grant.push.fingerprint === remote.push.fingerprint;
    // System needs no acknowledgement to be what it already is: the machine.
    matches.push(vouched || grant.mode === 'system' ? { grant, endpointUrl: urls[0] } : 'unavailable');
  }
  if (matches.length === 0) return null;
  if (matches.includes('unavailable')) return 'unavailable';
  const [first] = matches;
  const sameAnswer = matches.every(({ grant }) => grant.mode === first.grant.mode && grant.credentialId === first.grant.credentialId);
  return sameAnswer ? first : 'unavailable';
};

/**
 * The endpoint to resolve the credential against.
 *
 * The repository's own remote URL is canonical: Git's query path may be an
 * LFS sub-path or missing (a repository configured before path matching), and
 * the grant is what decides the account, so the endpoint comes from there.
 */
const credentialEndpoint = (endpointUrl) => {
  const url = new URL(endpointUrl);
  return {
    protocol: 'https',
    host: url.hostname.toLowerCase(),
    port: Number(url.port || 443),
    path: url.pathname,
  };
};

/**
 * OpenChamber answering Git wherever a repository names it.
 *
 * A repository given an identity with an account has `.git/config` name this
 * helper as its credential chain, so `git push` acts as that account from
 * any shell: the person's terminal, the agent's, a script. The helper reaches
 * the server through an endpoint file in the data directory that the server
 * rewrites on every start, port and secret included, so a repository's
 * configuration stays valid across restarts and app updates.
 *
 * The server answers only for the repository the helper runs in: the grant
 * of that repository's own binding, resolved to a credential for this one
 * request. A repository bound to System Git, or nothing, is handed back to
 * the person's own chain by the helper itself. Nothing is persisted here
 * beyond the endpoint file, and no secret ever reaches a repository.
 */
export function createGitRepositoryCredentialRuntime({
  readBinding,
  credentialResolver,
  dataDir,
  fsPromises,
  getActivePort,
  getActiveHost = () => null,
  helperPath = HELPER_PATH,
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
    /** The command a repository's `.git/config` names as its credential helper. */
    helperCommand: () => `!'${launcherPath.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`,
    /**
     * Writes what Git needs to reach this server: the launcher, which pins
     * this executable and tells Electron to run as Node, and the endpoint
     * file with the port and a fresh secret. Called once the server listens;
     * a repository configured against an earlier start keeps working.
     */
    publish: async () => {
      const port = getActivePort();
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error('OpenChamber listener port is unavailable for the Git credential helper');
      }
      activeSecret = randomBytes(32).toString('base64url');
      const url = `http://${callbackHost()}:${port}/api/git/repository-credential`;
      await writePrivate(endpointFilePath, `${JSON.stringify({ version: 1, url, secret: activeSecret })}\n`, 0o600);
      const script = `#!/bin/sh\nexec ${helperShellCommand(path.resolve(helperPath), [endpointFilePath])} "$@"\n`;
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
