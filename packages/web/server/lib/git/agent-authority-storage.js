import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from '../source-control/file-lock.js';

const VERSION = 1;
const DEFAULT_MAX_REPOSITORIES = 4096;

const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const isRepositoryId = (value) => isString(value) && /^repo_[A-Za-z0-9_-]{43}$/.test(value);

const invalidStore = () => Object.assign(new Error('Git agent authority store is invalid'), {
  code: 'GIT_AGENT_AUTHORITY_STORE_INVALID',
});

const parseState = (value, maxRepositories) => {
  if (!isPlainObject(value) || value.version !== VERSION
    || !Array.isArray(value.excluded) || value.excluded.length > maxRepositories
    || Object.keys(value).length !== 2) throw invalidStore();
  const excluded = value.excluded.map((entry) => {
    if (!isRepositoryId(entry)) throw invalidStore();
    return entry;
  });
  if (new Set(excluded).size !== excluded.length) throw invalidStore();
  return Object.freeze({ version: VERSION, excluded: Object.freeze(excluded) });
};

/**
 * Repositories the person told OpenChamber to keep out of.
 *
 * Only exclusions are stored, because the switch can only be an opt-out: when
 * the machine-wide setting is off nothing is put into the agent's environment
 * at all, so a per-repository "yes" would have nothing to attach to. Absent
 * means the machine-wide answer applies.
 */
export function createGitAgentAuthorityStore({
  filePath,
  fsImpl = fs,
  maxRepositories = DEFAULT_MAX_REPOSITORIES,
  lockWaitMs = 2_000,
} = {}) {
  if (!isString(filePath) || !path.isAbsolute(filePath)
    || !Number.isSafeInteger(maxRepositories) || maxRepositories < 1) {
    throw new TypeError('Git agent authority store options are invalid');
  }
  let writes = Promise.resolve();
  const enqueue = (operation) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const readState = async () => {
    let encoded;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ version: VERSION, excluded: Object.freeze([]) });
      throw error;
    }
    let value;
    try { value = JSON.parse(encoded); }
    catch { throw invalidStore(); }
    return parseState(value, maxRepositories);
  };
  const writeState = async (state) => {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsImpl.rename(temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };

  return Object.freeze({
    /** True while OpenChamber may answer Git for this repository. */
    isEnabled: async (repositoryId) => {
      if (!isRepositoryId(repositoryId)) return false;
      // An unreadable store must not silently hand the agent an identity the
      // person may have excluded, so a broken file keeps OpenChamber out.
      try { return !(await enqueue(readState)).excluded.includes(repositoryId); }
      catch { return false; }
    },
    setEnabled: (repositoryId, enabled) => enqueue(async () => {
      if (!isRepositoryId(repositoryId)) throw invalidStore();
      const state = await readState();
      const excluded = state.excluded.filter((entry) => entry !== repositoryId);
      if (!enabled) {
        if (excluded.length >= maxRepositories) throw invalidStore();
        excluded.push(repositoryId);
      }
      if (excluded.length !== state.excluded.length) await writeState({ version: VERSION, excluded });
      return enabled;
    }),
  });
}

const isDirectory = (value) => isString(value) && value.trim().length > 0;

/**
 * Reading and setting the per-repository answer.
 *
 * Addressed by directory, like every other repository route, and resolved to
 * the repository identity by the binding service so a worktree and its parent
 * answer the same way.
 */
export function registerGitAgentAuthorityRoutes(app, { store, resolveRepositoryId }) {
  const resolve = async (value) => {
    const directory = Array.isArray(value) ? value[0] : value;
    if (!isDirectory(directory)) return null;
    try { return await resolveRepositoryId(directory.trim()); }
    catch { return null; }
  };
  app.get('/api/git/agent-authority', async (req, res) => {
    const repositoryId = await resolve(req.query?.directory);
    if (!repositoryId) return res.status(404).json({ error: 'Directory is not a supported Git repository' });
    return res.json({ enabled: await store.isEnabled(repositoryId) });
  });
  app.put('/api/git/agent-authority', async (req, res) => {
    const enabled = req.body?.enabled;
    if (enabled !== true && enabled !== false) {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const repositoryId = await resolve(req.body?.directory);
    if (!repositoryId) return res.status(404).json({ error: 'Directory is not a supported Git repository' });
    try {
      return res.json({ enabled: await store.setEnabled(repositoryId, enabled) });
    } catch (error) {
      return res.status(500).json({ error: error?.message ?? 'Failed to store the Git agent authority' });
    }
  });
}
