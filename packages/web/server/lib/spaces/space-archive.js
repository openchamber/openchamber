// The chat archive of a deleted space (DESIGN.md, decision 9 and journey step 7), built in 5e-2.
//
// Before a space goes, its chats are taken out and imported into the host's OpenCode at a
// directory of the archive's own, stamped archived, so they show on the Archive page and nowhere
// else. An imported chat is a live session of the host's OpenCode: anything sent to it would run
// on the host, measured. So the archive is read-only here, on the server, and not only on the
// screen: `guard` refuses every request that would run or change an archived chat, and lets it be
// read and deleted.
//
// The host keeps one small file per archive, `<data dir>/spaces/archive/<space id>.json`: the
// space's name, its project and the ids of its chats. The guard and the Archive page read those.
// Nothing here runs a container or a `docker` command, so the archive and its guard are there
// whether the feature's switch is on or off: an archived chat stays read-only either way.

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { SpaceError } from './errors.js';
import { archivedChatOf, chatIdSchema } from './space-opencode.js';

// The maintainer's call of 2026-09-30: at most this many chats of one space go to the archive.
export const ARCHIVE_MAX_CHATS = 1000;
// All the chats of one space are taken out within this, however slowly the space answers; the
// rest counts as not saved, so a space cannot hold its own delete.
const SAVE_TIMEOUT_MS = 30 * 60_000;
// A title from a space is shown as text; this much of it is enough to name the chat.
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

// A request that would run or change a chat, by the session id in its path. Reads pass, and so
// does `DELETE /api/session/<id>`, which is how the user deletes an archived chat.
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

const listedTitleSchema = z.string().trim().min(1);
/** A listed chat's title, from the space, cut to what names it; null when it has none. */
const titleShown = (title) => {
  const parsed = listedTitleSchema.safeParse(title);
  return parsed.success ? parsed.data.slice(0, TITLE_SHOWN_CHARACTERS) : null;
};

/**
 * `hostOpenCode.importChat(chat)` imports one chat into the host's OpenCode and
 * `hostOpenCode.removeChat(id)` deletes one again, for a save that is taken back.
 */
export function createSpaceArchive({ dataDir, hostOpenCode, logger = console, now = () => Date.now() }) {
  const root = path.join(dataDir, 'spaces', 'archive');
  const directoryOf = (spaceId) => path.join(root, spaceId);
  const entryFileOf = (spaceId) => path.join(root, `${spaceId}.json`);

  /** Every archive the data directory holds; a file that cannot be read is skipped and logged. */
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

  /** Keeps an archive's entry, or drops it when it holds no chat, and the guard follows at once. */
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

  /** The archives, for the Archive page: which directory holds which space's chats. */
  const listArchives = () => [...entries.values()].map((entry) => ({
    spaceId: entry.spaceId,
    name: entry.name,
    projectDirectory: entry.projectDirectory,
    directory: directoryOf(entry.spaceId),
    archivedAt: entry.archivedAt,
  }));

  const isArchivedChat = (id) => locked.has(id);

  /**
   * Express middleware, before every route that acts on a session: an archived chat is read-only.
   * The id is compared decoded, as the route behind it decodes it, so `ses%5F...` is the same chat.
   */
  const guard = (req, res, next) => {
    if (locked.size === 0 || READ_METHODS.has(req.method)) return next();
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

  /**
   * Takes the chats of a space out and imports them into the host's OpenCode, parents first.
   * `source.listChats()` answers `{ chats: [{ id, title }], complete }` and `source.exportChat(id)`
   * one chat as OpenCode exports it. Without `allowUnsaved` it is all or nothing: a chat that
   * cannot be taken out or imported leaves nothing new in the archive and fails with
   * `chats_not_saved`, whose details name the chats that were too large. With it, what can be
   * saved is saved and the rest is reported. Answers `{ saved, tooLarge, failed, listed }`.
   *
   * A space can be saved again, when a delete saved its chats and then could not remove it: the
   * chats saved before stay in the archive and stay read-only, and one the host already holds
   * there counts as saved.
   */
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
    // Known from the list alone: nothing is taken out for a save that cannot be whole.
    if (!allowUnsaved && failed > 0) throw refuse();
    const chosen = wanted.slice(0, ARCHIVE_MAX_CHATS);

    // Each chat is taken out and written to disk before any goes in, so a refusal leaves the
    // host's OpenCode untouched and memory holds one chat at a time.
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

      // Parents before children, as the import requires. A parent that is not in this archive
      // leaves the chat a root one.
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
      // Locked before the first one exists on the host, so no request slips in between.
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
          // Saved by an earlier delete of this space: the host holds it here already.
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
        // What this save added is taken back, children first, so the space and its chats stay as
        // they were; what an earlier save put there stays.
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
