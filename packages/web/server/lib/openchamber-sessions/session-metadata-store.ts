import { asNonEmptyString } from '../shared/guards.js';
import {
  isJsonObject,
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';
import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { createOpenCodeClient as createOpenCodeClientDefault } from './opencode-client.js';
import { hasCode, hasMessage, hasTag } from './contracts.js';
import type { FileStoreOptions } from './contracts.js';
import type { JsonValue } from '@opencode/client';

const LEGACY_FILE_NAME = 'sessions-metadata.json';

const metadataSchema = z.looseObject({});
export type SessionMetadata = z.infer<typeof metadataSchema>;

const isPlainObject = (value: unknown): value is SessionMetadata => value !== null && typeof value === 'object' && !Array.isArray(value);

export const mergeMetadataPatch = (current: SessionMetadata | JsonValue | undefined, patch: SessionMetadata | JsonValue): SessionMetadata => {
  const base: SessionMetadata = isPlainObject(current) ? { ...current } : {};
  if (!isPlainObject(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    if (isPlainObject(value)) {
      const previous = base[key];
      base[key] = mergeMetadataPatch(isPlainObject(previous) ? previous : undefined, value);
    } else {
      base[key] = value;
    }
  }
  return base;
};

export const isSessionNotFound = (error: unknown): error is { _tag: 'SessionNotFoundError' } =>
  hasTag(error) && error._tag === 'SessionNotFoundError';

const sessionNotFound = (id: string) =>
  Object.assign(new Error(`session ${id} was not found`), { _tag: 'SessionNotFoundError' as const });

export interface MetadataReadOptions {
  directory?: string;
  signal?: AbortSignal | undefined;
}

export interface OpenCodeSessionMetadata {
  read: (sessionID: string, options?: MetadataReadOptions) => Promise<SessionMetadata | null>;
  write: (sessionID: string, metadata: SessionMetadata | undefined, options?: { directory?: string }) => Promise<void>;
}

interface OpenCodeMetadataOptions {
  buildOpenCodeUrl: (route: string, query: string) => string;
  getOpenCodeAuthHeaders: () => NonNullable<Parameters<typeof createOpenCodeClientDefault>[0]['headers']>;
  createOpenCodeClient?: typeof createOpenCodeClientDefault;
}

export const createOpenCodeSessionMetadata = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  createOpenCodeClient = createOpenCodeClientDefault,
}: OpenCodeMetadataOptions): OpenCodeSessionMetadata => {
  const clientFor = (directory: string) => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });
  return {
    read: async (sessionID, { directory = '', signal } = {}) => {
      let session;
      try {
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

interface SessionMetadataStoreOptions extends FileStoreOptions {
  openCode: OpenCodeSessionMetadata;
}

export type MetadataDecider = (current: SessionMetadata | undefined) => SessionMetadata | null;

export async function compareAndSetMetadata(
  expected: SessionMetadata,
  patch: SessionMetadata,
  update: (decide: MetadataDecider) => Promise<{ metadata: SessionMetadata | undefined }>,
) {
  let conflict = false;
  const result = await update((current) => {
    if (!isDeepStrictEqual(current, expected)) {
      conflict = true;
      return null;
    }
    return patch;
  });
  return { metadata: result.metadata, conflict };
}

export const createSessionMetadataStore = ({
  dataDir,
  openCode,
  fsPromises = fsDefault.promises,
  path = pathDefault,
}: SessionMetadataStoreOptions) => {
  const legacyPath = path.join(dataDir, LEGACY_FILE_NAME);

  const unmigrated = new Map<string, SessionMetadata>();
  let legacyLoad: Promise<void> | null = null;

  const sessionChains = new Map<string, Promise<void>>();
  const runForSession = <Result>(id: string, work: () => Promise<Result>) => {
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
  const runFileWrite = <Result>(work: () => Promise<Result>) => {
    const next = fileChain.then(work, work);
    fileChain = next.then(() => undefined, () => undefined);
    return next;
  };

  // The value judgement stays this store's: a JSON object (judged by the
  // primitive's reader via isJsonObject) whose entries are plain-object
  // metadata keyed by a non-empty session id; any other entry is dropped.
  const parseLegacy = (parsed: Record<string, unknown>) => {
    const result = new Map<string, Record<string, unknown>>();
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asNonEmptyString(sessionID);
      if (id && isPlainObject(value)) result.set(id, value);
    }
    return result;
  };

  const durableOptions = () => ({ fs: fsPromises, validateValue: isJsonObject });

  const loadLegacy = () => {
    if (!legacyLoad) {
      legacyLoad = (async () => {
        // Up to three attempts: a preserve that answers 'replaced' means a
        // valid file landed while the malformed bytes were being judged -
        // read that file instead of answering from the stale judgement.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let result;
          try {
            result = await readDurableJsonFile(legacyPath, durableOptions());
          } catch (error) {
            // A read failure other than absence (absence is 'missing') is
            // not evidence that the file holds nothing: refuse, and let the
            // next call retry once the file can be seen again.
            throw new Error(`session metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
          // No file yet (or an empty one) is the normal first run.
          if (result.state === 'missing') return;
          if (result.state === 'valid') {
            for (const [id, metadata] of parseLegacy(result.value)) unmigrated.set(id, metadata);
            return;
          }
          // Malformed bytes are preserved aside by the shared primitive
          // under its collision-proof name; there is nothing to migrate.
          // The raw bytes are never logged: a parse error can quote the file.
          const preservation = await preserveMalformedJsonFile(legacyPath, durableOptions());
          if (preservation.outcome === 'replaced') continue;
          if (preservation.outcome === 'failed') {
            // Fail closed (the primitive's contract): the bytes are still
            // live at the path and a later write or retire would destroy
            // them. Refuse like an unreadable file; a later load can retry.
            throw new Error('session metadata is unavailable: the unreadable legacy file could not be preserved');
          }
          if (preservation.preserved) {
            console.warn(`[openchamber-sessions] legacy session metadata was unreadable and was moved to ${preservation.preservedPath}`);
          }
          return;
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
        if (!hasCode(error) || error.code !== 'ENOENT') throw error;
      });
      return;
    }
    // Preserve-before-write, fail-closed (the primitive's contract): a
    // malformed file that appeared after the load must be preserved before
    // any write replaces it, and a failed preservation refuses the write.
    const preservation = await preserveMalformedJsonFile(legacyPath, durableOptions());
    if (preservation.outcome === 'failed') {
      throw new Error('could not preserve the unreadable legacy session metadata file; refusing to overwrite it');
    }
    if (preservation.preserved) {
      console.warn(`[openchamber-sessions] legacy session metadata was unreadable and was preserved at ${preservation.preservedPath}`);
    }
    // Atomic write through the primitive, at this store's previous
    // effective mode (0o666, umask-governed): session metadata is
    // per-session state, not secret-bearing.
    await writeDurableJsonFile(legacyPath, JSON.stringify(Object.fromEntries(unmigrated)), {
      fs: fsPromises,
      mode: 0o666,
    });
  });

  const forgetLegacy = async (id: string) => {
    unmigrated.delete(id);
    await persistLegacy().catch((error) => {
      console.warn('[openchamber-sessions] could not update the legacy session metadata file:', (hasMessage(error) ? error.message : undefined) ?? error);
    });
  };

  const loadLegacyForReader = async (signal: AbortSignal | undefined) => {
    if (!signal) return loadLegacy();
    signal.throwIfAborted();
    let onAbort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([loadLegacy(), cancelled]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };

  const get = async (sessionID: string | null, { directory = '', signal }: MetadataReadOptions = {}) => {
    signal?.throwIfAborted();
    const id = asNonEmptyString(sessionID);
    if (!id) return {};
    await loadLegacyForReader(signal);
    signal?.throwIfAborted();
    if (unmigrated.has(id)) return unmigrated.get(id);
    return (await openCode.read(id, { directory, signal })) ?? {};
  };

  const setSessionMetadata = async (sessionID: string, patch: SessionMetadata, { directory = '' }: MetadataReadOptions = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    if (!isPlainObject(patch)) throw new Error('a session metadata patch must be an object');
    await loadLegacy();

    return runForSession(id, async () => {
      const fromLegacy = unmigrated.has(id);
      const current = fromLegacy ? unmigrated.get(id) : await openCode.read(id, { directory });
      if (current === null) throw sessionNotFound(id);
      const merged = mergeMetadataPatch(current, patch);
      await openCode.write(id, merged, { directory });
      if (fromLegacy) await forgetLegacy(id);
      return merged;
    });
  };

  const updateSessionMetadata = async (sessionID: string, decide: MetadataDecider, { directory = '' }: MetadataReadOptions = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    await loadLegacy();

    return runForSession(id, async () => {
      const fromLegacy = unmigrated.has(id);
      const current = fromLegacy ? unmigrated.get(id) : await openCode.read(id, { directory });
      if (current === null) throw sessionNotFound(id);
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
          console.warn(`[openchamber-sessions] could not migrate metadata for ${id}:`, (hasMessage(error) ? error.message : undefined) ?? error);
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
