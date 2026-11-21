import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalDirectoryPath } from '../fs/canonical-path.js';
import type { createOpenCodeClient } from '../openchamber-sessions/opencode-client.js';
import type { TranslatedEvent } from '../event-stream/translate-v2.js';
import type { JsonValue } from '../shared/json-values.js';

export interface ChatDirectoryCleanupOptions<Owner> {
  roots: string[];
  createClient: () => { session: Pick<ReturnType<typeof createOpenCodeClient>['session'], 'list' | 'get'> };
  getOwner: () => Owner | null;
  logger?: Pick<Console, 'warn'>;
}

interface CapturedDirectory {
  root: string;
  target: string;
  parent: string;
  identity: BigIntStats;
  parentIdentity: BigIntStats;
  aliases: string[];
}

interface ClaimedDirectory {
  quarantine: string;
  path: string;
  target: string;
}

interface ForkRead {
  state: 'reading' | 'deleted';
  promise?: Promise<void>;
}

interface DirectoryClaim {
  directory: string;
  captured: CapturedDirectory;
  claimed: ClaimedDirectory;
}

interface ErrorDetails {
  code?: unknown;
  _tag?: unknown;
  message?: unknown;
}

const canReadErrorDetails = (value: unknown): value is ErrorDetails => value !== null && value !== undefined;
const errorProperty = (cause: unknown, key: keyof ErrorDetails) => {
  if (!canReadErrorDetails(cause)) throw new TypeError(`Cannot read properties of ${cause} (reading '${key}')`);
  return cause[key];
};

const hasEventType = (value: unknown): value is { type: string } => value !== null
  && typeof value === 'object' && 'type' in value && typeof value.type === 'string';

const PAGE_SIZE = 200;
const MAX_PAGES = 1_000;
const READ_TIMEOUT_MS = 10_000;
const QUARANTINE_PREFIX = '.reclaiming-';
const SESSION_EVENTS = new Set(['session.created', 'session.forked', 'session.updated', 'session.deleted']);
const CHAT_DIRECTORY = /^\d{4}-\d{2}-\d{2}[/\\]session-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+-[a-z0-9]+)$/i;
const absolutePath = z.string().min(1).refine(path.isAbsolute);
const sessionRecord = z.object({ id: z.string().min(1), location: z.object({ directory: absolutePath }) });
const sessionPage = z.object({
  data: z.array(sessionRecord),
  cursor: z.object({ next: z.string().min(1).nullish() }),
});
const wireSessionEvent = z.object({ data: z.object({ sessionID: z.string().min(1) }) });
const sessionEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['session.created', 'session.updated']),
    properties: z.object({ info: z.object({ id: z.string().min(1), directory: absolutePath }) }),
  }),
  z.object({
    type: z.literal('session.forked'),
    properties: z.object({ sessionID: z.string().min(1) }),
  }),
  z.object({
    type: z.literal('session.deleted'),
    properties: z.object({ sessionID: z.string().min(1) }),
  }),
]);

const isMissing = (cause: unknown) => errorProperty(cause, 'code') === 'ENOENT' || errorProperty(cause, 'code') === 'ENOTDIR';
const isSessionNotFound = (cause: unknown) => cause != null && errorProperty(cause, '_tag') === 'SessionNotFoundError';
const sameDirectory = (left: BigIntStats, right: BigIntStats) => right.isDirectory()
  && left.dev === right.dev && left.ino === right.ino;
const contains = (root: string, directory: string) => {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const relativeChatDirectory = (root: string, directory: string) => {
  const relative = path.relative(root, directory).split(path.sep).slice(0, 2).join(path.sep);
  return CHAT_DIRECTORY.test(relative) ? relative : null;
};
const resolveReferences = async (sessions: ReadonlyMap<string, string>) => Promise.all([...new Set(sessions.values())].map(async (directory): Promise<string[]> => (
  [directory, await canonicalDirectoryPath(directory, fs, path)]
))).then((directories) => directories.flat());
const isReferenced = (captured: CapturedDirectory, references: string[]) => references.some((reference) => (
  captured.aliases.some((alias) => contains(alias, reference))
));

const captureDirectory = async (directory: string, roots: string[]): Promise<CapturedDirectory | null> => {
  const canonicalDirectory: string = await canonicalDirectoryPath(directory, fs, path);
  let rootError;
  for (const root of roots) {
    let canonicalRoot;
    try {
      canonicalRoot = await fs.realpath(root);
    } catch (error) {
      if (!isMissing(error)) rootError = error;
      continue;
    }
    const relative = relativeChatDirectory(root, directory) ?? relativeChatDirectory(canonicalRoot, directory)
      ?? relativeChatDirectory(canonicalRoot, canonicalDirectory);
    if (!relative) continue;
    const target = path.join(canonicalRoot, relative);
    const parent = path.dirname(target);
    try {
      const [identity, parentIdentity] = await Promise.all([fs.lstat(target, { bigint: true }), fs.lstat(parent, { bigint: true })]);
      if (!identity.isDirectory() || !parentIdentity.isDirectory()) return null;
      return {
        root: canonicalRoot, target, parent, identity, parentIdentity, aliases: [target, path.join(root, relative), directory],
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  if (rootError) throw rootError;
  return null;
};

export const createChatDirectoryCleanupRuntime = <Owner>({ roots, createClient, getOwner, logger = console }: ChatDirectoryCleanupOptions<Owner>) => {
  const managedRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  const controller = new AbortController();
  let owner: Owner | null = null;
  let connected = false;
  let directoriesBySession = new Map<string, string>();
  let touched: Set<string> | null = null;
  const forkReads = new Map<string, ForkRead>();
  const pending = new Map<string, CapturedDirectory | null>();
  const failedRemovals = new Set<string>();
  let revision = 0;
  let requested: 'connect' | 'delete' | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const adoptOwner = () => {
    const next = getOwner();
    if (next !== owner) {
      owner = next;
      directoriesBySession.clear();
      forkReads.clear();
      pending.clear();
      revision += 1;
    }
    return owner;
  };

  const readSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);

  const listSessions = async (client: ReturnType<typeof createClient>) => {
    const sessions = new Map<string, string>();
    const cursors = new Set<string>();
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      if (++pages > MAX_PAGES) throw new Error('Session list pagination did not settle');
      const page = sessionPage.parse(await client.session.list(
        cursor ? { cursor, limit: PAGE_SIZE } : { order: 'asc', limit: PAGE_SIZE },
        { signal: readSignal() },
      ));
      for (const session of page.data) sessions.set(session.id, path.resolve(session.location.directory));
      cursor = page.cursor.next;
      if (cursor && (cursors.has(cursor) || page.data.length === 0)) {
        throw new Error('Session list pagination did not complete');
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return sessions;
  };

  const readInventory = async () => {
    const client = createClient();
    touched = new Set();
    try {
      const sessions = await listSessions(client);
      for (const id of touched) {
        if (sessions.has(id)) continue;
        try {
          const record = sessionRecord.parse(await client.session.get({ sessionID: id }, { signal: readSignal() }));
          sessions.set(record.id, path.resolve(record.location.directory));
        } catch (error) {
          if (!isSessionNotFound(error)) throw error;
        }
      }
      return sessions;
    } finally {
      touched = null;
    }
  };

  const claim = async (captured: CapturedDirectory) => {
    const [identity, parentIdentity] = await Promise.all([
      fs.lstat(captured.target, { bigint: true }), fs.lstat(captured.parent, { bigint: true }),
    ]);
    if (!sameDirectory(captured.identity, identity) || !sameDirectory(captured.parentIdentity, parentIdentity)) return null;
    const quarantine = await fs.mkdtemp(path.join(captured.root, QUARANTINE_PREFIX));
    const claimed = { quarantine, path: path.join(quarantine, path.basename(captured.target)), target: captured.target };
    try {
      await fs.rename(captured.target, claimed.path);
    } catch (error) {
      await fs.rmdir(quarantine);
      throw error;
    }
    try {
      if (sameDirectory(captured.identity, await fs.lstat(claimed.path, { bigint: true }))) return claimed;
    } catch (error) {
      await release(claimed);
      throw error;
    }
    await release(claimed);
    return null;
  };

  const release = async (claimed: ClaimedDirectory) => {
    try {
      await fs.mkdir(claimed.target);
      try {
        await fs.rename(claimed.path, claimed.target);
      } catch {
        await fs.rmdir(claimed.target);
        await fs.rename(claimed.path, claimed.target);
      }
    } catch (error) {
      logger.warn(`[chat-directories] kept a chat folder at ${claimed.path} because its path is in use:`, errorProperty(error, 'message'));
      return;
    }
    await fs.rmdir(claimed.quarantine).catch((error) => {
      logger.warn('[chat-directories] could not remove an empty cleanup folder:', errorProperty(error, 'message'));
    });
  };

  const remove = async (quarantine: string) => {
    try {
      await fs.rm(quarantine, { recursive: true });
    } catch (error) {
      if (!isMissing(error)) {
        failedRemovals.add(quarantine);
        logger.warn(`[chat-directories] could not finish removing ${quarantine}; retrying on the next check:`, errorProperty(error, 'message'));
        return;
      }
    }
    failedRemovals.delete(quarantine);
  };

  const refresh = (reason: 'connect' | 'delete'): Promise<void> => {
    if (requested !== 'connect') requested = reason;
    if (running) return running;
    running = Promise.resolve().then(async () => {
      while (requested && !stopped && connected && adoptOwner()) {
        const reason = requested;
        requested = null;
        const readOwner = owner;
        const readRevision = revision;
        const retry = () => { requested ??= reason; };
        const isCurrent = () => !stopped && connected && getOwner() === readOwner && revision === readRevision;
        const ownsCandidate = (directory: string, candidate: CapturedDirectory | null) => !stopped && getOwner() === readOwner
          && pending.get(directory) === candidate;
        const claims: DirectoryClaim[] = [];
        try {
          for (const quarantine of failedRemovals) await remove(quarantine);
          for (const [directory, captured] of pending) {
            if (captured) continue;
            try {
              const entry = await captureDirectory(directory, managedRoots);
              if (!ownsCandidate(directory, captured)) break;
              if (entry) pending.set(directory, entry);
              else pending.delete(directory);
            } catch (error) {
              if (!ownsCandidate(directory, captured)) break;
              pending.delete(directory);
              logger.warn('[chat-directories] could not inspect a deleted chat folder:', errorProperty(error, 'message'));
            }
          }
          if (!isCurrent()) { retry(); continue; }
          if (pending.size === 0 && reason !== 'connect') continue;
          const sessions = await readInventory();
          if (!isCurrent()) { retry(); continue; }
          directoriesBySession = sessions;
          for (const [id, entry] of forkReads) {
            if (entry.state === 'reading' && sessions.has(id)) forkReads.delete(id);
          }
          if (pending.size === 0) continue;

          const references = await resolveReferences(sessions);
          for (const [directory, captured] of pending) {
            if (!isCurrent()) { retry(); break; }
            if (!captured) continue;
            if (isReferenced(captured, references)) {
              pending.delete(directory);
              continue;
            }
            try {
              const claimed = await claim(captured);
              if (claimed) claims.push({ directory, captured, claimed });
              if (!ownsCandidate(directory, captured)) { retry(); break; }
              if (!claimed) pending.delete(directory);
            } catch (error) {
              if (!ownsCandidate(directory, captured)) { retry(); break; }
              if (isMissing(error)) pending.delete(directory);
              else logger.warn('[chat-directories] deleted chat folder cleanup failed:', errorProperty(error, 'message'));
            }
          }
          if (claims.length === 0) continue;
          if (!isCurrent()) { retry(); continue; }

          const fresh = await resolveReferences(await readInventory());
          while (claims.length > 0) {
            if (!isCurrent()) { retry(); break; }
            const next = claims.shift();
            if (!next) throw new Error('Missing chat directory claim');
            const { directory, captured, claimed } = next;
            pending.delete(directory);
            if (isReferenced(captured, fresh)) await release(claimed);
            else await remove(claimed.quarantine);
          }
        } catch (error) {
          if (!stopped) logger.warn('[chat-directories] could not verify chat folder references:', errorProperty(error, 'message'));
        } finally {
          for (const { claimed } of claims.splice(0)) await release(claimed);
        }
      }
    }).finally(() => {
      running = null;
      if (requested && !stopped && connected && getOwner()) void refresh(requested);
    });
    return running;
  };

  const readFork = async (id: string, entry: ForkRead) => {
    const readOwner = owner;
    try {
      const record = sessionRecord.parse(await createClient().session.get({ sessionID: id }, { signal: readSignal() }));
      if (stopped || getOwner() !== readOwner || forkReads.get(id) !== entry) return;
      if (record.id !== id) throw new Error('Fork lookup returned another session');
      const directory = path.resolve(record.location.directory);
      revision += 1;
      if (entry.state === 'deleted') {
        if (!pending.has(directory)) pending.set(directory, null);
        await refresh('delete');
      } else directoriesBySession.set(id, directory);
    } catch (error) {
      if (!stopped && getOwner() === readOwner) logger.warn('[chat-directories] could not read a fork directory:', errorProperty(error, 'message'));
    } finally {
      if (forkReads.get(id) === entry) forkReads.delete(id);
    }
  };

  return {
    onConnected() {
      if (stopped || !adoptOwner()) return;
      connected = true;
      revision += 1;
      return refresh('connect');
    },
    onDisconnected() {
      connected = false;
      revision += 1;
    },
    observeWirePayload(payload: JsonValue | undefined) {
      if (!touched) return;
      const parsed = wireSessionEvent.safeParse(payload);
      if (parsed.success) touched.add(parsed.data.data.sessionID);
    },
    processPayload(payload: TranslatedEvent | undefined) {
      if (stopped || !hasEventType(payload) || !SESSION_EVENTS.has(payload.type) || !adoptOwner()) return;
      const parsed = sessionEvent.safeParse(payload);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === 'session.forked') {
        revision += 1;
        const id = event.properties.sessionID;
        if (directoriesBySession.has(id)) return;
        const reading = forkReads.get(id);
        if (reading) return reading.promise;
        const entry: ForkRead = { state: 'reading' };
        forkReads.set(id, entry);
        entry.promise = readFork(id, entry);
        return entry.promise;
      }
      if (event.type !== 'session.deleted') {
        const { id, directory } = event.properties.info;
        forkReads.delete(id);
        const normalized = path.resolve(directory);
        if (directoriesBySession.get(id) === normalized) return;
        directoriesBySession.set(id, normalized);
        revision += 1;
        return;
      }
      const id = event.properties.sessionID;
      const directory = directoriesBySession.get(id);
      directoriesBySession.delete(id);
      revision += 1;
      const reading = forkReads.get(id);
      if (reading) {
        reading.state = 'deleted';
        return reading.promise;
      }
      if (!directory) return;
      if (!pending.has(directory)) pending.set(directory, null);
      return refresh('delete');
    },
    stop() {
      stopped = true;
      controller.abort();
      return Promise.all([running, ...Array.from(forkReads.values(), (entry) => entry.promise)]);
    },
  };
};
