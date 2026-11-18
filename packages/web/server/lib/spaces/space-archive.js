
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';
import { requestedDirectories } from './dispatcher.js';

import { SpaceError } from './errors.js';
import { archivedChatOf, chatIdSchema } from './space-opencode.js';

export const ARCHIVE_MAX_CHATS = 1000;
const SAVE_TIMEOUT_MS = 30 * 60_000;
const TITLE_SHOWN_CHARACTERS = 200;

const spaceIdSchema = z.string().regex(/^[a-f0-9]{12}$/);

const archiveEntrySchema = z.object({
  version: z.literal(1),
  spaceId: spaceIdSchema,
  name: z.string().max(200),
  projectDirectory: z.string().nullable(),
  archivedAt: z.number().int().nonnegative(),
  chats: z.array(chatIdSchema),
});

const CHAT_ROUTES = [
  /^\/api\/session\/([^/]+)(\/.*)?$/i,
  /^\/api\/experimental\/session\/([^/]+)\/.+$/i,
  /^\/api\/openchamber\/sessions\/([^/]+)\/.+$/i,
  /^\/api\/message-queue\/sessions\/([^/]+)(\/.*)?$/i,
  /^\/api\/goals\/objective\/([^/]+)$/i,
  /^\/api\/permission-auto-accept\/sessions\/([^/]+)$/i,
];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_DELETE = /^\/api\/session\/[^/]+$/i;
const SESSION_CREATE = /^\/api\/session\/?$/i;
const directorySchema = z.string().min(1);

const listedTitleSchema = z.string().trim().min(1);
const titleShown = (title) => {
  const parsed = listedTitleSchema.safeParse(title);
  return parsed.success ? parsed.data.slice(0, TITLE_SHOWN_CHARACTERS) : null;
};

export function createSpaceArchive({ dataDir, hostOpenCode, logger = console, now = () => Date.now() }) {
  const root = path.join(dataDir, 'spaces', 'archive');
  const directoryOf = (spaceId) => path.join(root, spaceId);
  const entryFileOf = (spaceId) => path.join(root, `${spaceId}.json`);

  const readEntries = () => {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn?.(`[spaces] the chat archive could not be read: ${error?.code ?? error?.message ?? error}`);
      return new Map();
    }
    const entries = new Map();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = archiveEntrySchema.parse(JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
        entries.set(entry.spaceId, entry);
      } catch (error) {
        logger.warn?.(`[spaces] an archive entry could not be read: ${name}: ${error?.code ?? 'malformed'}`);
      }
    }
    return entries;
  };

  const entries = readEntries();
  let locked = new Set();
  const relock = () => { locked = new Set([...entries.values()].flatMap((entry) => entry.chats)); };
  relock();

  const writeEntry = (entry) => {
    const file = entryFileOf(entry.spaceId);
    if (entry.chats.length === 0) {
      fs.rmSync(file, { force: true });
      entries.delete(entry.spaceId);
    } else {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, file);
      entries.set(entry.spaceId, entry);
    }
    relock();
  };

  const listArchives = () => [...entries.values()].map((entry) => ({
    spaceId: entry.spaceId,
    name: entry.name,
    projectDirectory: entry.projectDirectory,
    directory: directoryOf(entry.spaceId),
    archivedAt: entry.archivedAt,
  }));

  const isArchivedChat = (id) => locked.has(id);

  const namedDirectories = (req) => requestedDirectories(req, new URL(req.originalUrl ?? req.url ?? req.path ?? '/', 'http://archive'));

  const isUnderRoot = (directory) => {
    const named = directorySchema.safeParse(directory);
    if (!named.success) return false;
    const resolved = path.resolve(named.data);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  };

  const guard = (req, res, next) => {
    if (READ_METHODS.has(req.method)) return next();
    if (req.method === 'POST' && SESSION_CREATE.test(req.path) && namedDirectories(req).some(isUnderRoot)) {
      res.status(409).json({ code: 'archive_directory_read_only', message: 'This folder holds the chats of a deleted space. Start the chat in a project.' });
      return undefined;
    }
    if (locked.size === 0) return next();
    if (req.method === 'DELETE' && SESSION_DELETE.test(req.path)) return next();
    for (const pattern of CHAT_ROUTES) {
      const match = pattern.exec(req.path);
      if (!match) continue;
      let id = match[1];
      try {
        id = decodeURIComponent(id);
      } catch {
        // Not a valid encoding: the route behind refuses it as well, and it names no chat here.
      }
      if (locked.has(id)) {
        res.status(409).json({ code: 'archived_chat_read_only', message: 'This chat belongs to a deleted space and is read-only.' });
        return undefined;
      }
    }
    return next();
  };

  const saveChats = async ({ spaceId, name, projectDirectory, source, allowUnsaved }) => {
    const deadline = now() + SAVE_TIMEOUT_MS;
    const earlier = entries.get(spaceId)?.chats ?? [];
    const tooLarge = [];
    let failed = 0;
    let listed;
    try {
      listed = await source.listChats();
    } catch (error) {
      logger.warn?.(`[spaces] the chats of space ${spaceId} could not be listed: ${error?.code ?? error?.message ?? error}`);
      listed = null;
    }
    const refuse = () => new SpaceError('chats_not_saved', `The chats of "${name}" could not be saved.`, { name, tooLarge, failed, listed: listed !== null });
    if (listed === null) {
      if (!allowUnsaved) throw refuse();
      return { saved: 0, tooLarge, failed, listed: false };
    }
    const wanted = listed.chats.filter((chat) => chatIdSchema.safeParse(chat.id).success);
    failed += listed.chats.length - wanted.length + Math.max(0, wanted.length - ARCHIVE_MAX_CHATS);
    if (!listed.complete) failed += 1;
    if (!allowUnsaved && failed > 0) throw refuse();
    const chosen = wanted.slice(0, ARCHIVE_MAX_CHATS);

    const incoming = path.join(root, `.incoming-${spaceId}`);
    fs.rmSync(incoming, { recursive: true, force: true });
    fs.mkdirSync(incoming, { recursive: true, mode: 0o700 });
    try {
      const taken = new Map();
      for (const chat of chosen) {
        if (now() > deadline) {
          failed += 1;
          continue;
        }
        try {
          const exported = await source.exportChat(chat.id);
          fs.writeFileSync(path.join(incoming, `${chat.id}.json`), JSON.stringify(exported), { mode: 0o600 });
          taken.set(chat.id, exported.info.parentID ?? null);
        } catch (error) {
          if (error?.code === 'chat_too_large') tooLarge.push(titleShown(chat.title) ?? chat.id);
          else failed += 1;
          logger.warn?.(`[spaces] chat ${chat.id} of space ${spaceId} was not taken out: ${error?.code ?? error?.message ?? error}`);
        }
      }
      if (!allowUnsaved && (tooLarge.length > 0 || failed > 0)) throw refuse();

      const order = [];
      const placed = new Set();
      const place = (id) => {
        if (placed.has(id)) return;
        placed.add(id);
        const parent = taken.get(id);
        if (parent && taken.has(parent)) place(parent);
        order.push(id);
      };
      for (const id of taken.keys()) place(id);

      const directory = directoryOf(spaceId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const archivedAt = now();
      const entry = { version: 1, spaceId, name, projectDirectory, archivedAt, chats: earlier };
      const withChats = (chats) => ({ ...entry, chats: Array.from(new Set([...earlier, ...chats])) });
      writeEntry(withChats(order));
      const added = [];
      const saved = [];
      const notImported = new Set();
      for (const id of order) {
        const parent = taken.get(id);
        if (parent && notImported.has(parent)) {
          notImported.add(id);
          failed += 1;
          continue;
        }
        try {
          const exported = JSON.parse(fs.readFileSync(path.join(incoming, `${id}.json`), 'utf8'));
          await hostOpenCode.importChat(archivedChatOf(exported, { directory, archivedAt, keepParent: Boolean(parent && taken.has(parent)) }));
          added.push(id);
          saved.push(id);
        } catch (error) {
          if (error?.status === 409 && earlier.includes(id)) {
            saved.push(id);
            continue;
          }
          notImported.add(id);
          failed += 1;
          logger.warn?.(`[spaces] chat ${id} of space ${spaceId} was not imported: ${error?.status ?? error?.code ?? error?.message ?? error}`);
          if (!allowUnsaved) break;
        }
      }
      if (!allowUnsaved && notImported.size > 0) {
        for (const id of added.reverse()) {
          await hostOpenCode.removeChat(id).catch((error) => {
            logger.warn?.(`[spaces] imported chat ${id} could not be taken back: ${error?.status ?? error?.code ?? error?.message ?? error}`);
          });
        }
        writeEntry(withChats([]));
        throw refuse();
      }
      writeEntry(withChats(saved));
      return { saved: saved.length, tooLarge, failed, listed: true };
    } finally {
      fs.rmSync(incoming, { recursive: true, force: true });
    }
  };

  return { guard, listArchives, isArchivedChat, saveChats, directoryOf };
}
