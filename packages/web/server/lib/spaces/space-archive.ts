
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';
import { requestedDirectories } from './dispatcher.js';

import { SpaceError } from './errors.js';
import { archivedChatOf, chatIdSchema } from './space-opencode.js';
import type { ExportedChat } from './space-opencode.js';
import type { Request, RequestHandler } from '../shared/http-contracts.js';
import { failureProperty } from './failure.js';
import { transferValue } from './code-transfer.js';

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

type ArchiveEntry = Omit<z.infer<typeof archiveEntrySchema>, 'name'> & { name: unknown };
export interface ListedArchiveChat {
  id: unknown;
  title: unknown;
}
export interface ArchiveChatSource {
  listChats: () => Promise<{ chats: ListedArchiveChat[]; complete: boolean }>;
  exportChat: (id: string) => Promise<ExportedChat>;
}
export interface SaveArchiveChats {
  spaceId: string;
  name: unknown;
  projectDirectory: string | null;
  source: ArchiveChatSource;
  allowUnsaved: boolean;
}
export interface SpaceArchiveOptions<Imported, Removed> {
  dataDir: string;
  hostOpenCode: {
    importChat: (chat: ReturnType<typeof archivedChatOf>) => Promise<Imported>;
    removeChat: (id: string) => Promise<Removed>;
  };
  logger?: Pick<Console, 'warn'>;
  now?: () => number;
}

const CHAT_ROUTES = [
  /^\/api\/session\/([^/]+)(\/.*)?$/i,
  /^\/api\/experimental\/session\/([^/]+)\/.+$/i,
  /^\/api\/openchamber\/sessions\/([^/]+)\/.+$/i,
  /^\/api\/message-queue\/sessions\/([^/]+)(\/.*)?$/i,
  /^\/api\/goals\/objective\/([^/]+)$/i,
  /^\/api\/permission-auto-accept\/sessions\/([^/]+)$/i,
];
const READ_METHODS = new Set<string | undefined>(['GET', 'HEAD', 'OPTIONS']);
const SESSION_DELETE = /^\/api\/session\/[^/]+$/i;
const SESSION_CREATE = /^\/api\/session\/?$/i;
const directorySchema = z.string().min(1);

const listedTitleSchema = z.string().trim().min(1);
const titleShown = <Title>(title: Title) => {
  const parsed = listedTitleSchema.safeParse(title);
  return parsed.success ? parsed.data.slice(0, TITLE_SHOWN_CHARACTERS) : null;
};

export function createSpaceArchive<Imported, Removed>({ dataDir, hostOpenCode, logger = console, now = () => Date.now() }: SpaceArchiveOptions<Imported, Removed>) {
  const root = path.join(dataDir, 'spaces', 'archive');
  const directoryOf = (spaceId: string) => path.join(root, spaceId);
  const entryFileOf = (spaceId: string) => path.join(root, `${spaceId}.json`);

  const readEntries = () => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch (error) {
      if (failureProperty(error, 'code') !== 'ENOENT') logger.warn?.(`[spaces] the chat archive could not be read: ${failureProperty(error, 'code') ?? failureProperty(error, 'message') ?? error}`);
      return new Map<string, ArchiveEntry>();
    }
    const entries = new Map<string, ArchiveEntry>();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = archiveEntrySchema.parse(JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
        entries.set(entry.spaceId, entry);
      } catch (error) {
        logger.warn?.(`[spaces] an archive entry could not be read: ${name}: ${failureProperty(error, 'code') ?? 'malformed'}`);
      }
    }
    return entries;
  };

  const entries = readEntries();
  let locked = new Set<string>();
  const relock = () => { locked = new Set([...entries.values()].flatMap((entry) => entry.chats)); };
  relock();

  const writeEntry = (entry: ArchiveEntry) => {
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

  const isArchivedChat = (id: string) => locked.has(id);

  const namedDirectories = (req: Request) => requestedDirectories(req, new URL(req.originalUrl ?? req.url ?? req.path ?? '/', 'http://archive'));

  const isUnderRoot = <Directory>(directory: Directory) => {
    const named = directorySchema.safeParse(directory);
    if (!named.success) return false;
    const resolved = path.resolve(named.data);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  };

  const guard: RequestHandler = (req, res, next) => {
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
      const matchedId = transferValue(match[1]);
      let id = matchedId;
      try {
        id = decodeURIComponent(id);
      } catch {
        id = matchedId;
      }
      if (locked.has(id)) {
        res.status(409).json({ code: 'archived_chat_read_only', message: 'This chat belongs to a deleted space and is read-only.' });
        return undefined;
      }
    }
    return next();
  };

  const saveChats = async ({ spaceId, name, projectDirectory, source, allowUnsaved }: SaveArchiveChats) => {
    const deadline = now() + SAVE_TIMEOUT_MS;
    const earlier = entries.get(spaceId)?.chats ?? [];
    const tooLarge: string[] = [];
    let failed = 0;
    let listed: Awaited<ReturnType<ArchiveChatSource['listChats']>> | null;
    try {
      listed = await source.listChats();
    } catch (error) {
      logger.warn?.(`[spaces] the chats of space ${spaceId} could not be listed: ${failureProperty(error, 'code') ?? failureProperty(error, 'message') ?? error}`);
      listed = null;
    }
    const refuse = () => new SpaceError('chats_not_saved', `The chats of "${name}" could not be saved.`, { name, tooLarge, failed, listed: listed !== null });
    if (listed === null) {
      if (!allowUnsaved) throw refuse();
      return { saved: 0, tooLarge, failed, listed: false };
    }
    const wanted = listed.chats.filter((chat): chat is ListedArchiveChat & { id: string } => chatIdSchema.safeParse(chat.id).success);
    failed += listed.chats.length - wanted.length + Math.max(0, wanted.length - ARCHIVE_MAX_CHATS);
    if (!listed.complete) failed += 1;
    if (!allowUnsaved && failed > 0) throw refuse();
    const chosen = wanted.slice(0, ARCHIVE_MAX_CHATS);

    const incoming = path.join(root, `.incoming-${spaceId}`);
    fs.rmSync(incoming, { recursive: true, force: true });
    fs.mkdirSync(incoming, { recursive: true, mode: 0o700 });
    try {
      const taken = new Map<string, string | null>();
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
          if (failureProperty(error, 'code') === 'chat_too_large') tooLarge.push(titleShown(chat.title) ?? chat.id);
          else failed += 1;
          logger.warn?.(`[spaces] chat ${chat.id} of space ${spaceId} was not taken out: ${failureProperty(error, 'code') ?? failureProperty(error, 'message') ?? error}`);
        }
      }
      if (!allowUnsaved && (tooLarge.length > 0 || failed > 0)) throw refuse();

      const order: string[] = [];
      const placed = new Set<string>();
      const place = (id: string) => {
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
      const entry: ArchiveEntry = { version: 1, spaceId, name, projectDirectory, archivedAt, chats: earlier };
      const withChats = (chats: string[]) => ({ ...entry, chats: Array.from(new Set([...earlier, ...chats])) });
      writeEntry(withChats(order));
      const added: string[] = [];
      const saved: string[] = [];
      const notImported = new Set<string>();
      for (const id of order) {
        const parent = taken.get(id);
        if (parent && notImported.has(parent)) {
          notImported.add(id);
          failed += 1;
          continue;
        }
        try {
          const exported: unknown = JSON.parse(fs.readFileSync(path.join(incoming, `${id}.json`), 'utf8'));
          await hostOpenCode.importChat(archivedChatOf(exported, { directory, archivedAt, keepParent: Boolean(parent && taken.has(parent)) }));
          added.push(id);
          saved.push(id);
        } catch (error) {
          if (failureProperty(error, 'status') === 409 && earlier.includes(id)) {
            saved.push(id);
            continue;
          }
          notImported.add(id);
          failed += 1;
          logger.warn?.(`[spaces] chat ${id} of space ${spaceId} was not imported: ${failureProperty(error, 'status') ?? failureProperty(error, 'code') ?? failureProperty(error, 'message') ?? error}`);
          if (!allowUnsaved) break;
        }
      }
      if (!allowUnsaved && notImported.size > 0) {
        for (const id of added.reverse()) {
          await hostOpenCode.removeChat(id).catch((error) => {
            logger.warn?.(`[spaces] imported chat ${id} could not be taken back: ${failureProperty(error, 'status') ?? failureProperty(error, 'code') ?? failureProperty(error, 'message') ?? error}`);
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
