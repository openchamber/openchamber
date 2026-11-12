import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlainObject } from '../../shared/guards.js';
import { isConnectionId, ProtectedMcpError } from './contract.js';
import { parseDefinition } from './definitions.js';

/** Read definitions without taking the state lock or changing any files. */
export async function readDefinitions(stateDir) {
  const definitions = new Map();
  const stored = await readJson(path.join(stateDir, 'state.json'));
  if (stored === null) return definitions;
  if (!isPlainObject(stored) || stored.version !== 1 || !Array.isArray(stored.connections)) throw new ProtectedMcpError('state_unreadable');
  for (const entry of stored.connections) {
    if (!isPlainObject(entry) || !isConnectionId(entry.id) || !Number.isSafeInteger(entry.revision)) throw new ProtectedMcpError('state_unreadable');
    const { id, revision, ...definition } = entry;
    definitions.set(id, { id, revision, ...parseDefinition(definition) });
  }
  return definitions;
}

export async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

/** Replacement committed, but its durability could not be confirmed. Never roll it back in memory. */
export class StateDurabilityError extends ProtectedMcpError {
  constructor() {
    super('state_durability_unverified', { status: 500 });
    this.name = 'StateDurabilityError';
  }
}

/** Same-directory temporary file, flushed, then renamed over the target, mode 0600. */
export async function writePrivateFile(filename, content, onCommit = () => {}) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let replaced = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, filename);
    replaced = true;
    onCommit();
    try {
      const directory = await fs.open(path.dirname(filename), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new StateDurabilityError();
    }
  } finally {
    if (!replaced) await fs.rm(temporary, { force: true });
  }
}

/** The parsed file, or null when it does not exist. */
export async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** One owner at a time: the running service, or migration while the service is stopped. */
export async function lockState(stateDir) {
  const lockFile = path.join(stateDir, '.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => fs.rm(lockFile, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await fs.readFile(lockFile, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(owner) && owner > 0 && processAlive(owner)) {
        throw new ProtectedMcpError('state_locked', { status: 500, message: `state_locked: process ${owner} owns ${stateDir}` });
      }
      await fs.rm(lockFile, { force: true });
    }
  }
  throw new ProtectedMcpError('state_locked', { status: 500 });
}
