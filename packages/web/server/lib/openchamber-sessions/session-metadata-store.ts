import { asNonEmptyString } from '../shared/guards.js';
import fsDefault from 'node:fs';
import pathDefault from 'node:path';
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

const isSessionNotFound = (error: unknown): error is { _tag: 'SessionNotFoundError' } =>
  hasTag(error) && error._tag === 'SessionNotFoundError';

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

export const createSessionMetadataStore = ({
  dataDir,
  openCode,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
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

  const parseLegacy = (raw: string) => {
    const parsed: unknown = JSON.parse(raw);
    if (!metadataSchema.safeParse(parsed).success || !isPlainObject(parsed)) throw new Error('session metadata file is not a JSON object');
    const result = new Map<string, SessionMetadata>();
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
          if (hasCode(error) && error.code === 'ENOENT') return;
          throw new Error(`session metadata is unavailable: ${(hasMessage(error) ? error.message : undefined) ?? error}`);
        }
        try {
          for (const [id, metadata] of parseLegacy(raw)) unmigrated.set(id, metadata);
        } catch (error) {
          const backup = `${legacyPath}.corrupt-${now()}`;
          await fsPromises.rename(legacyPath, backup).catch(() => undefined);
          console.warn(`[openchamber-sessions] legacy session metadata was unreadable and was moved to ${backup}: ${(hasMessage(error) ? error.message : undefined) ?? error}`);
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
    const tmpPath = `${legacyPath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(Object.fromEntries(unmigrated)), 'utf8');
    await fsPromises.rename(tmpPath, legacyPath);
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
      if (current === null) throw new Error(`session ${id} was not found`);
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
