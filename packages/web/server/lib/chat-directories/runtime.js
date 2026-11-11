import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalDirectoryPath } from '../fs/canonical-path.js';

const PAGE_SIZE = 200;
const READ_TIMEOUT_MS = 10_000;
const SESSION_EVENTS = new Set(['session.created', 'session.forked', 'session.updated', 'session.deleted']);
const CHAT_DIRECTORY = /^\d{4}-\d{2}-\d{2}[/\\]session-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+-[a-z0-9]+)$/i;
const absolutePath = z.string().min(1).refine(path.isAbsolute);
const sessionRecord = z.object({ id: z.string().min(1), location: z.object({ directory: absolutePath }) });
const sessionPage = z.object({
  data: z.array(sessionRecord),
  cursor: z.object({ next: z.string().min(1).nullish() }),
});
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

const isMissing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const sameDirectory = (left, right) => right.isDirectory()
  && left.dev === right.dev && left.ino === right.ino;
const contains = (root, directory) => {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const relativeChatDirectory = (root, directory) => {
  const relative = path.relative(root, directory).split(path.sep).slice(0, 2).join(path.sep);
  return CHAT_DIRECTORY.test(relative) ? relative : null;
};

const captureDirectory = async (directory, roots) => {
  const canonicalDirectory = await canonicalDirectoryPath(directory, fs, path);
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
      return { target, parent, identity, parentIdentity, aliases: [target, path.join(root, relative), directory] };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  if (rootError) throw rootError;
  return null;
};

export const createChatDirectoryCleanupRuntime = ({ roots, createClient, getOwner, logger = console }) => {
  const managedRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  const controller = new AbortController();
  let owner = null;
  let directoriesBySession = new Map();
  const forkReads = new Map();
  const pending = new Map();
  let revision = 0;
  let requested = null;
  let running = null;
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

  const listSessions = async () => {
    const client = createClient();
    const sessions = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const page = sessionPage.parse(await client.session.list(
        cursor ? { cursor, limit: PAGE_SIZE } : { limit: PAGE_SIZE },
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) },
      ));
      for (const session of page.data) {
        if (sessions.has(session.id)) throw new Error('Session list repeated a session');
        sessions.set(session.id, path.resolve(session.location.directory));
      }
      cursor = page.cursor.next;
      if (cursor && (cursors.has(cursor) || page.data.length === 0)) {
        throw new Error('Session list pagination did not complete');
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return sessions;
  };

  const refresh = (reason) => {
    if (requested !== 'connect') requested = reason;
    if (running) return running;
    // Defer the read so a cascade's deletion events share one inventory.
    running = Promise.resolve().then(async () => {
      while (requested && !stopped && adoptOwner()) {
        const reason = requested;
        requested = null;
        const readOwner = owner;
        const readRevision = revision;
        const isCurrent = () => !stopped && getOwner() === readOwner && revision === readRevision;
        const ownsCandidate = (directory, candidate) => !stopped && getOwner() === readOwner
          && pending.get(directory) === candidate;
        try {
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
              logger.warn('[chat-directories] could not inspect a deleted chat folder:', error.message);
            }
          }
          if (!isCurrent()) { requested ??= reason; continue; }
          if (pending.size === 0 && reason !== 'connect') continue;
          const sessions = await listSessions();
          if (!isCurrent()) { requested ??= reason; continue; }
          directoriesBySession = sessions;
          for (const [id, entry] of forkReads) {
            if (entry.state === 'reading' && sessions.has(id)) forkReads.delete(id);
          }
          if (pending.size === 0) continue;

          const references = await Promise.all([...new Set(sessions.values())].map(async (directory) => (
            [directory, await canonicalDirectoryPath(directory, fs, path)]
          ))).then((directories) => directories.flat());
          for (const [directory, captured] of pending) {
            if (!isCurrent()) { requested ??= reason; break; }
            if (!captured) continue;
            if (references.some((reference) => captured.aliases.some((alias) => contains(alias, reference)))) {
              pending.delete(directory);
              continue;
            }
            try {
              const [identity, parentIdentity] = await Promise.all([
                fs.lstat(captured.target, { bigint: true }), fs.lstat(captured.parent, { bigint: true }),
              ]);
              if (!isCurrent()) { requested ??= reason; break; }
              if (sameDirectory(captured.identity, identity) && sameDirectory(captured.parentIdentity, parentIdentity)) {
                await fs.rm(captured.target, { recursive: true });
              }
              if (!ownsCandidate(directory, captured)) { requested ??= reason; break; }
              pending.delete(directory);
            } catch (error) {
              if (!ownsCandidate(directory, captured)) { requested ??= reason; break; }
              if (isMissing(error)) pending.delete(directory);
              else logger.warn('[chat-directories] deleted chat folder cleanup failed:', error.message);
            }
          }
        } catch (error) {
          if (!stopped) logger.warn('[chat-directories] could not verify chat folder references:', error.message);
        }
      }
    }).finally(() => {
      running = null;
      if (requested && !stopped && getOwner()) void refresh(requested);
    });
    return running;
  };

  const readFork = async (id, entry) => {
    const readOwner = owner;
    try {
      const record = sessionRecord.parse(await createClient().session.get(
        { sessionID: id },
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) },
      ));
      if (stopped || getOwner() !== readOwner || forkReads.get(id) !== entry) return;
      if (record.id !== id) throw new Error('Fork lookup returned another session');
      const directory = path.resolve(record.location.directory);
      revision += 1;
      if (entry.state === 'deleted') {
        if (!pending.has(directory)) pending.set(directory, null);
        await refresh('delete');
      } else directoriesBySession.set(id, directory);
    } catch (error) {
      if (!stopped && getOwner() === readOwner) logger.warn('[chat-directories] could not read a fork directory:', error.message);
    } finally {
      if (forkReads.get(id) === entry) forkReads.delete(id);
    }
  };

  return {
    onConnected() {
      if (stopped || !adoptOwner()) return;
      revision += 1;
      return refresh('connect');
    },
    processPayload(payload) {
      if (stopped || !SESSION_EVENTS.has(payload?.type) || !adoptOwner()) return;
      const parsed = sessionEvent.safeParse(payload);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === 'session.forked') {
        revision += 1;
        const id = event.properties.sessionID;
        if (directoriesBySession.has(id)) return;
        if (forkReads.has(id)) return forkReads.get(id).promise;
        const entry = { state: 'reading' };
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
