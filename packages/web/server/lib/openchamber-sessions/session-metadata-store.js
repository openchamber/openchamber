// external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 OpenCode replaces the whole metadata object on PATCH.

import { asNonEmptyString } from '../shared/guards.js';
import fsDefault from 'node:fs';
import pathDefault from 'node:path';

import { createOpenCodeClient as createOpenCodeClientDefault } from './opencode-client.js';

const LEGACY_FILE_NAME = 'sessions-metadata.json';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// external: https://www.rfc-editor.org/rfc/rfc7386 Nested objects merge and null removes a key.
export const mergeMetadataPatch = (current, patch) => {
  const base = isPlainObject(current) ? { ...current } : {};
  if (!isPlainObject(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    base[key] = isPlainObject(value) ? mergeMetadataPatch(base[key], value) : value;
  }
  return base;
};

const isSessionNotFound = (error) => error?._tag === 'SessionNotFoundError';

export const createOpenCodeSessionMetadata = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  createOpenCodeClient = createOpenCodeClientDefault,
}) => {
  const clientFor = (directory) => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });
  return {
    read: async (sessionID, { directory = '', signal } = {}) => {
      let session;
      try {
        // external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 The client returns the session record without a data envelope.
        session = await clientFor(directory).session.get({ sessionID }, { signal });
      } catch (error) {
        if (isSessionNotFound(error)) return null;
        throw error;
      }
      return isPlainObject(session?.metadata) ? session.metadata : {};
    },
    write: (sessionID, metadata, { directory = '' } = {}) =>
      clientFor(directory).session.update({ sessionID, metadata }),
  };
};

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory; holds the legacy file.
 * @param {{ read: Function, write: Function }} options.openCode See {@link createOpenCodeSessionMetadata}.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 */
export const createSessionMetadataStore = ({
  dataDir,
  openCode,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
}) => {
  const legacyPath = path.join(dataDir, LEGACY_FILE_NAME);

  const unmigrated = new Map();
  let legacyLoad = null;

  const sessionChains = new Map();
  const runForSession = (id, work) => {
    const previous = sessionChains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    sessionChains.set(id, settled);
    void settled.then(() => {
      if (sessionChains.get(id) === settled) sessionChains.delete(id);
    });
    return next;
  };

  let fileChain = Promise.resolve();
  const runFileWrite = (work) => {
    const next = fileChain.then(work, work);
    fileChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const parseLegacy = (raw) => {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('session metadata file is not a JSON object');
    const result = new Map();
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asNonEmptyString(sessionID);
      if (id && isPlainObject(value)) result.set(id, value);
    }
    return result;
  };

  const loadLegacy = () => {
    if (!legacyLoad) {
      legacyLoad = (async () => {
        let raw;
        try {
          raw = await fsPromises.readFile(legacyPath, 'utf8');
        } catch (error) {
          if (error?.code === 'ENOENT') return;
          throw new Error(`session metadata is unavailable: ${error?.message ?? error}`);
        }
        try {
          for (const [id, metadata] of parseLegacy(raw)) unmigrated.set(id, metadata);
        } catch (error) {
          const backup = `${legacyPath}.corrupt-${now()}`;
          await fsPromises.rename(legacyPath, backup).catch(() => undefined);
          console.warn(`[openchamber-sessions] legacy session metadata was unreadable and was moved to ${backup}: ${error?.message ?? error}`);
        }
      })().catch((error) => {
        legacyLoad = null;
        throw error;
      });
    }
    return legacyLoad;
  };

  const persistLegacy = () => runFileWrite(async () => {
    if (unmigrated.size === 0) {
      await fsPromises.rename(legacyPath, `${legacyPath}.migrated`).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      return;
    }
    const tmpPath = `${legacyPath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(Object.fromEntries(unmigrated)), 'utf8');
    await fsPromises.rename(tmpPath, legacyPath);
  });

  const forgetLegacy = async (id) => {
    unmigrated.delete(id);
    await persistLegacy().catch((error) => {
      console.warn('[openchamber-sessions] could not update the legacy session metadata file:', error?.message ?? error);
    });
  };

  const loadLegacyForReader = async (signal) => {
    if (!signal) return loadLegacy();
    signal.throwIfAborted();
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([loadLegacy(), cancelled]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };

  const get = async (sessionID, { directory = '', signal } = {}) => {
    signal?.throwIfAborted();
    const id = asNonEmptyString(sessionID);
    if (!id) return {};
    await loadLegacyForReader(signal);
    signal?.throwIfAborted();
    if (unmigrated.has(id)) return unmigrated.get(id);
    return (await openCode.read(id, { directory, signal })) ?? {};
  };

  const setSessionMetadata = async (sessionID, patch, { directory = '' } = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    if (!isPlainObject(patch)) throw new Error('a session metadata patch must be an object');
    await loadLegacy();

    return runForSession(id, async () => {
      const fromLegacy = unmigrated.has(id);
      const current = fromLegacy ? unmigrated.get(id) : await openCode.read(id, { directory });
      if (current === null) throw new Error(`session ${id} was not found`);
      const merged = mergeMetadataPatch(current, patch);
      await openCode.write(id, merged, { directory });
      if (fromLegacy) await forgetLegacy(id);
      return merged;
    });
  };

  const updateSessionMetadata = async (sessionID, decide, { directory = '' } = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    await loadLegacy();

    return runForSession(id, async () => {
      const fromLegacy = unmigrated.has(id);
      const current = fromLegacy ? unmigrated.get(id) : await openCode.read(id, { directory });
      if (current === null) throw new Error(`session ${id} was not found`);
      const patch = decide(current);
      if (!isPlainObject(patch)) return { metadata: current, changed: false };
      const merged = mergeMetadataPatch(current, patch);
      await openCode.write(id, merged, { directory });
      if (fromLegacy) await forgetLegacy(id);
      return { metadata: merged, changed: true };
    });
  };

  const migrateLegacy = async () => {
    await loadLegacy();
    const pending = [...unmigrated.keys()];
    if (pending.length === 0) return 0;
    let changed = false;
    await Promise.all(pending.map((id) => runForSession(id, async () => {
      if (!unmigrated.has(id)) return;
      try {
        await openCode.write(id, unmigrated.get(id));
      } catch (error) {
        if (!isSessionNotFound(error)) {
          console.warn(`[openchamber-sessions] could not migrate metadata for ${id}:`, error?.message ?? error);
          return;
        }
      }
      unmigrated.delete(id);
      changed = true;
    })));
    if (changed) await persistLegacy();
    return unmigrated.size;
  };

  const listUnmigrated = async () => {
    await loadLegacy();
    return Object.fromEntries(unmigrated);
  };

  return {
    get,
    setSessionMetadata,
    updateSessionMetadata,
    migrateLegacy,
    listUnmigrated,
    legacyPath,
  };
};
