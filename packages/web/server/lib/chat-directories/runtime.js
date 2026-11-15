import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalDirectoryPath } from '../fs/canonical-path.js';

const PAGE_SIZE = 200;
// A session written on every page moves past the cursor each time; give up
// rather than chase it forever.
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

const isMissing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const isSessionNotFound = (error) => error?._tag === 'SessionNotFoundError';
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
const resolveReferences = async (sessions) => Promise.all([...new Set(sessions.values())].map(async (directory) => (
  [directory, await canonicalDirectoryPath(directory, fs, path)]
))).then((directories) => directories.flat());
const isReferenced = (captured, references) => references.some((reference) => (
  captured.aliases.some((alias) => contains(alias, reference))
));

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

export const createChatDirectoryCleanupRuntime = ({ roots, createClient, getOwner, logger = console }) => {
  const managedRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  const controller = new AbortController();
  let owner = null;
  let connected = false;
  let directoriesBySession = new Map();
  // Session ids the host stream named while an inventory read was running.
  let touched = null;
  const forkReads = new Map();
  const pending = new Map();
  // Claimed folders already sentenced whose removal failed; retried by their
  // private quarantine path, never by the reusable chat path.
  const failedRemovals = new Set();
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

  const readSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);

  // Oldest first: OpenCode orders pages by update time, so a session written
  // during the read moves past the cursor and is read again instead of being
  // skipped. The later copy wins.
  const listSessions = async (client) => {
    const sessions = new Map();
    const cursors = new Set();
    let cursor;
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

  // A complete list, plus every session the stream wrote to during it that the
  // list missed: a write moves a session across the cursor, and most writes
  // (archives, messages) never reach the translated events.
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

  // Moves the folder out of its reusable pathname, so nothing destroyed later
  // can be a folder that took the name after the identity check.
  const claim = async (captured) => {
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

  // Puts a claimed folder back without replacing whatever took its name: mkdir
  // takes the free name, and a rename replaces only that still-empty folder.
  // Windows cannot rename onto a folder, so there the placeholder goes first.
  const release = async (claimed) => {
    try {
      await fs.mkdir(claimed.target);
      try {
        await fs.rename(claimed.path, claimed.target);
      } catch {
        await fs.rmdir(claimed.target);
        await fs.rename(claimed.path, claimed.target);
      }
    } catch (error) {
      logger.warn(`[chat-directories] kept a chat folder at ${claimed.path} because its path is in use:`, error.message);
      return;
    }
    await fs.rmdir(claimed.quarantine).catch((error) => {
      logger.warn('[chat-directories] could not remove an empty cleanup folder:', error.message);
    });
  };

  const remove = async (quarantine) => {
    try {
      await fs.rm(quarantine, { recursive: true });
    } catch (error) {
      if (!isMissing(error)) {
        failedRemovals.add(quarantine);
        logger.warn(`[chat-directories] could not finish removing ${quarantine}; retrying on the next check:`, error.message);
        return;
      }
    }
    failedRemovals.delete(quarantine);
  };

  const refresh = (reason) => {
    if (requested !== 'connect') requested = reason;
    if (running) return running;
    // Defer the read so a cascade's deletion events share one inventory.
    running = Promise.resolve().then(async () => {
      while (requested && !stopped && connected && adoptOwner()) {
        const reason = requested;
        requested = null;
        const readOwner = owner;
        const readRevision = revision;
        const retry = () => { requested ??= reason; };
        const isCurrent = () => !stopped && connected && getOwner() === readOwner && revision === readRevision;
        const ownsCandidate = (directory, candidate) => !stopped && getOwner() === readOwner
          && pending.get(directory) === candidate;
        const claims = [];
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
              logger.warn('[chat-directories] could not inspect a deleted chat folder:', error.message);
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
              else logger.warn('[chat-directories] deleted chat folder cleanup failed:', error.message);
            }
          }
          if (claims.length === 0) continue;
          if (!isCurrent()) { retry(); continue; }

          // A session that took a claimed folder meanwhile gets it back.
          const fresh = await resolveReferences(await readInventory());
          while (claims.length > 0) {
            if (!isCurrent()) { retry(); break; }
            const { directory, captured, claimed } = claims.shift();
            pending.delete(directory);
            if (isReferenced(captured, fresh)) await release(claimed);
            else await remove(claimed.quarantine);
          }
        } catch (error) {
          if (!stopped) logger.warn('[chat-directories] could not verify chat folder references:', error.message);
        } finally {
          // Lost authority or a failed check: nothing claimed is destroyed.
          for (const { claimed } of claims.splice(0)) await release(claimed);
        }
      }
    }).finally(() => {
      running = null;
      if (requested && !stopped && connected && getOwner()) void refresh(requested);
    });
    return running;
  };

  const readFork = async (id, entry) => {
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
      if (!stopped && getOwner() === readOwner) logger.warn('[chat-directories] could not read a fork directory:', error.message);
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
    // Events missed while the stream is down can add references, so removal
    // waits for the next connection and its complete inventory.
    onDisconnected() {
      connected = false;
      revision += 1;
    },
    observeWirePayload(payload) {
      if (!touched) return;
      const parsed = wireSessionEvent.safeParse(payload);
      if (parsed.success) touched.add(parsed.data.data.sessionID);
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
