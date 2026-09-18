import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseGitCredentialQuery } from './credential-broker.js';
import { parseGitCredentialReference } from './credential-resolver.js';

const HELPER_PATH = fileURLToPath(new URL('./agent-credential-helper.js', import.meta.url));
const MAX_QUERY_BYTES = 64 * 1024;
const NONE = Object.freeze({ mode: 'none' });

const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const isLoopback = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

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

/**
 * The grant that answers for this origin, or null.
 *
 * A grant only answers while the binding still matches the repository's own
 * remotes, which is the same readiness the Git panel shows. A repository the
 * binding no longer vouches for gets nothing rather than the last credential
 * it happened to hold.
 */
const grantForOrigin = (read, origin) => {
  const current = new Map(read.repository.remotes.map((remote) => [remote.name, remote]));
  for (const grant of read.binding?.remotes ?? []) {
    const remote = current.get(grant.name);
    if (!remote || grant.readiness !== 'ready') continue;
    if (grant.fetch.fingerprint !== remote.fetch.fingerprint
      || grant.push.fingerprint !== remote.push.fingerprint) continue;
    const matched = [grant.fetch.displayUrl, grant.push.displayUrl].find((url) => httpsOrigin(url) === origin);
    if (matched) return { grant, endpointUrl: matched };
  }
  return null;
};

/**
 * The endpoint to resolve the credential against.
 *
 * Git asks without a path unless `credential.useHttpPath` is on, and turning
 * that on would change how the person's own helpers key their entries. The
 * repository's own remote URL carries the path already, and the grant is what
 * decides the account, so the endpoint comes from there.
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
 * OpenChamber answering Git for the agent's own shell.
 *
 * The managed OpenCode process is started by OpenChamber, so its environment
 * can say that for the hosts OpenChamber holds bindings on, this helper is the
 * credential chain. A bound repository then acts as its bound account even when
 * the agent runs `git push` itself; a repository bound to System Git keeps
 * using the person's own chain; and a repository nothing is bound for gets no
 * credential at all, instead of quietly borrowing the person's.
 *
 * Nothing is written to any repository and nothing is persisted: the token
 * lives in one child process's environment and dies with it. Outside that
 * process — the person's own terminal — nothing changes.
 */
export function createGitAgentCredentialRuntime({
  readBinding,
  listRemoteGrants,
  credentialResolver,
  isRepositoryEnabled = null,
  getActivePort,
  helperPath = HELPER_PATH,
  nodePath = process.execPath,
  randomBytes = crypto.randomBytes,
  env = process.env,
}) {
  if (!(readBinding instanceof Function) || !(listRemoteGrants instanceof Function)
    || !credentialResolver || !(getActivePort instanceof Function)) {
    throw new TypeError('Git agent credential runtime dependencies are invalid');
  }
  let activeToken = null;

  const managedOrigins = async () => {
    const grants = await listRemoteGrants();
    const origins = new Set();
    for (const grant of grants) {
      // SSH grants do not travel through a credential helper, and anonymous
      // ones deliberately carry no credential, so neither claims a host.
      if (grant.mode !== 'managed' && grant.mode !== 'system') continue;
      const origin = httpsOrigin(grant.displayUrl);
      if (origin) origins.add(origin);
    }
    return [...origins];
  };

  const answer = async (payload) => {
    const cwd = isString(payload?.cwd) ? payload.cwd : '';
    const rawQuery = isString(payload?.query) ? payload.query : '';
    if (!cwd || !rawQuery || rawQuery.length > MAX_QUERY_BYTES) return NONE;
    let origin;
    try { origin = queryOrigin(parseGitCredentialQuery(rawQuery)); }
    catch { return NONE; }
    if (!origin) return NONE;
    let read;
    try { read = await readBinding(cwd); }
    catch { return NONE; }
    if (read.status === 'missing' || !read.binding) return NONE;
    const matched = grantForOrigin(read, origin);
    if (!matched) return NONE;
    const { grant, endpointUrl } = matched;
    // Excluded repositories are handed back the same way System Git is: this
    // host's chain is severed for the whole process, so answering nothing would
    // leave them without the setup they asked to keep.
    const repositoryId = read.repository?.repositoryId;
    if (isRepositoryEnabled && !(await isRepositoryEnabled(repositoryId))) return { mode: 'system' };
    // The person decided this repository may use whatever the machine holds.
    if (grant.mode === 'system') return { mode: 'system' };
    if (grant.mode !== 'managed' || !grant.credentialId) return NONE;
    try {
      if (parseGitCredentialReference(grant.credentialId).transport !== 'https') return NONE;
      const credential = await credentialResolver.resolve({
        mode: 'managed',
        credentialId: grant.credentialId,
        endpoint: credentialEndpoint(endpointUrl),
        operationId: `git_agent_${randomBytes(8).toString('hex')}`,
        deadline: Date.now() + 15_000,
      });
      if (credential?.transport !== 'https' || !credential.username || !credential.password) return NONE;
      return { mode: 'managed', username: credential.username, password: credential.password };
    } catch {
      return NONE;
    }
  };

  const authorize = (req) => {
    if (!activeToken || !isLoopback(req.socket?.remoteAddress)) return false;
    const header = isString(req.headers?.authorization) ? req.headers.authorization : '';
    if (!header.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(activeToken);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };

  return Object.freeze({
    /**
     * Git configuration for the managed OpenCode child, or nothing.
     *
     * Nothing is injected while no binding names an HTTPS host: a person who
     * only uses their own Git setup should not have OpenChamber step into it.
     */
    prepareManagedOpenCodeEnv: async () => {
      const port = getActivePort();
      const origins = Number.isInteger(port) && port > 0 ? await managedOrigins() : [];
      if (!origins.length) {
        activeToken = null;
        return {};
      }
      activeToken = randomBytes(32).toString('base64url');
      const helper = `!${shellQuote(nodePath)} ${shellQuote(helperPath)}`;
      // Command-scope entries outrank every configuration file, and an empty
      // value severs the chain for that host — the same pair `gh auth
      // setup-git` writes, scoped to one process tree instead of the machine.
      const inherited = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
      let index = Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 0;
      const config = {};
      for (const origin of origins) {
        config[`GIT_CONFIG_KEY_${index}`] = `credential.${origin}.helper`;
        config[`GIT_CONFIG_VALUE_${index}`] = '';
        index += 1;
        config[`GIT_CONFIG_KEY_${index}`] = `credential.${origin}.helper`;
        config[`GIT_CONFIG_VALUE_${index}`] = helper;
        index += 1;
      }
      return {
        ...config,
        GIT_CONFIG_COUNT: String(index),
        OPENCHAMBER_GIT_CREDENTIAL_URL: `http://127.0.0.1:${port}/api/git/agent-credential`,
        OPENCHAMBER_GIT_CREDENTIAL_TOKEN: activeToken,
      };
    },
    registerRoutes: (app) => {
      app.post('/api/git/agent-credential', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!authorize(req)) return res.status(403).end();
        return res.json(await answer(req.body ?? {}));
      });
    },
  });
}
