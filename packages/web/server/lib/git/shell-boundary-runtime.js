import crypto from 'node:crypto';
import { shellCommandTransfers } from './shell-boundary.js';

const ALLOW = Object.freeze({ blocked: false });
const MAX_COMMAND_BYTES = 128 * 1024;

const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const isLoopback = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

const REASON = 'This repository is configured in OpenChamber, so its transfers run as the account it is bound to.'
  + ' Use the openchamber tool — git.push, git.pull or git.fetch — instead of running this in the shell.'
  + ' If the repository needs something those cannot do, ask the user to run it from the Git panel.';

/**
 * Refusing raw Git transfers in the agent's shell.
 *
 * The credential answer already gives a bound repository its bound account and
 * an unbound one nothing, so this is not what makes the identity right. It is
 * what makes the failure legible: instead of an authentication error the agent
 * cannot interpret, it is told the managed action to use. It also covers what
 * a credential helper never sees — `gh`, `glab`, and SSH remotes.
 *
 * It only refuses where a managed alternative exists. A repository nobody
 * configured in OpenChamber is left alone, because there is nothing to send
 * the agent to instead.
 */
export function createGitShellBoundaryRuntime({
  readBinding,
  isRepositoryEnabled = null,
  getActivePort,
  randomBytes = crypto.randomBytes,
}) {
  if (!(readBinding instanceof Function) || !(getActivePort instanceof Function)) {
    throw new TypeError('Git shell boundary runtime dependencies are invalid');
  }
  let activeToken = null;

  const decide = async (payload) => {
    const command = isString(payload?.command) ? payload.command : '';
    const directory = isString(payload?.directory) ? payload.directory.trim() : '';
    if (!directory || !command || command.length > MAX_COMMAND_BYTES) return ALLOW;
    if (!shellCommandTransfers(command)) return ALLOW;
    let read;
    try { read = await readBinding(directory); }
    catch { return ALLOW; }
    // Nothing is bound here, so there is no managed path to send the agent to.
    const grants = read.status === 'missing' ? [] : read.binding?.remotes ?? [];
    // System Git is the person saying this repository may use whatever the
    // machine holds. The credential helper honours that by handing the request
    // back to their own chain, and refusing the same command here would
    // contradict it.
    if (!grants.length || grants.every((grant) => grant.mode === 'system')) return ALLOW;
    if (isRepositoryEnabled && !(await isRepositoryEnabled(read.repository?.repositoryId))) return ALLOW;
    return { blocked: true, reason: REASON };
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
    prepareManagedOpenCodeEnv: () => {
      const port = getActivePort();
      if (!Number.isInteger(port) || port <= 0) {
        activeToken = null;
        return {};
      }
      activeToken = randomBytes(32).toString('base64url');
      return {
        OPENCHAMBER_SHELL_BOUNDARY_URL: `http://127.0.0.1:${port}/api/git/shell-boundary`,
        OPENCHAMBER_SHELL_BOUNDARY_TOKEN: activeToken,
      };
    },
    registerRoutes: (app) => {
      app.post('/api/git/shell-boundary', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!authorize(req)) return res.status(403).end();
        return res.json(await decide(req.body ?? {}));
      });
    },
  });
}
