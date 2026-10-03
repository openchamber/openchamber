// The chat archive with a stand-in space and a stand-in host OpenCode that records what it imported.
// What is under test is all-or-nothing, the order of the import, what a space may not claim, and
// that an archived chat cannot be run through any route that acts on a session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { ARCHIVE_MAX_CHATS, createSpaceArchive } from './space-archive.js';

const SPACE = 'a1b2c3d4e5f6';
const PARENT = 'ses_parent1';
const CHILD = 'ses_child1';
const OTHER = 'ses_other1';
const HOST_SESSION = 'ses_host1';
const quiet = { warn: () => {} };
const folders = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

const infoOf = (id, extra = {}) => ({
  id,
  projectID: 'p1',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: `chat ${id}`,
  ...extra,
});

/** A space that lists `chats` and exports each, and a host that imports them into a map. */
const archiveWith = ({ chats, failImportOf = null, dataDir = null, host = new Map(), now = () => 1234 } = {}) => {
  if (dataDir === null) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-archive-'));
    folders.push(dataDir);
  }
  const removed = [];
  const hostOpenCode = {
    importChat: async (chat) => {
      if (failImportOf === chat.info.id || host.has(chat.info.id)) throw Object.assign(new Error('conflict'), { status: 409 });
      if (chat.info.parentID && !host.has(chat.info.parentID)) throw Object.assign(new Error('parent missing'), { status: 404 });
      host.set(chat.info.id, chat);
    },
    removeChat: async (id) => { removed.push(id); host.delete(id); },
  };
  const archive = createSpaceArchive({ dataDir, hostOpenCode, logger: quiet, now });
  const source = {
    listChats: async () => ({ chats: (chats ?? []).map(({ info }) => ({ id: info.id, title: info.title })), complete: true }),
    exportChat: async (id) => {
      const chat = chats.find((entry) => entry.info.id === id);
      if (chat.fail) throw chat.fail;
      return { info: chat.info, messages: [{ id: `msg_${id}`, type: 'user', text: 'hi' }] };
    },
  };
  const save = (allowUnsaved = false) => archive.saveChats({ spaceId: SPACE, name: 'Fix login', projectDirectory: '/home/me/project', source, allowUnsaved });
  return { archive, host, removed, save, dataDir, source };
};

/** Runs the guard on one request and says whether it passed or what it answered. */
const through = (archive, method, requestPath) => {
  let answer = 'passed';
  const res = { status: (code) => ({ json: (body) => { answer = { code, body }; } }) };
  archive.guard({ method, path: requestPath }, res, () => {});
  return answer;
};

describe('saving the chats of a space', () => {
  it('imports parents before children at the archive\'s directory, stamped archived, and lists the archive', async () => {
    // The child is listed first, as a space may list them.
    const { archive, host, save, dataDir } = archiveWith({ chats: [{ info: infoOf(CHILD, { parentID: PARENT }) }, { info: infoOf(PARENT) }] });
    expect(await save()).toEqual({ saved: 2, tooLarge: [], failed: 0, listed: true });
    expect(Array.from(host.keys())).toEqual([PARENT, CHILD]);
    const directory = path.join(dataDir, 'spaces', 'archive', SPACE);
    expect(host.get(CHILD).info).toMatchObject({ parentID: PARENT, location: { directory }, time: { archived: 1234 } });
    expect(fs.statSync(directory).isDirectory()).toBe(true);
    expect(archive.listArchives()).toEqual([{ spaceId: SPACE, name: 'Fix login', projectDirectory: '/home/me/project', directory, archivedAt: 1234 }]);
  });

  it('refuses every tool of every agent in an archived chat, in OpenCode itself', async () => {
    const { host, save } = archiveWith({ chats: [{ info: infoOf(PARENT, { permissions: [{ action: '*', resource: '*', effect: 'allow' }] }) }] });
    await save();
    expect(host.get(PARENT).info.permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }]);
  });

  it('keeps the chats an earlier delete saved when the same space is saved again, and counts them as saved', async () => {
    const chats = [{ info: infoOf(PARENT) }, { info: infoOf(CHILD, { parentID: PARENT }) }];
    const first = archiveWith({ chats });
    await first.save();
    // The space was not removed; a second delete saves it again, with one chat more.
    const second = archiveWith({ chats: [...chats, { info: infoOf(OTHER) }], dataDir: first.dataDir, host: first.host });
    expect(await second.save()).toEqual({ saved: 3, tooLarge: [], failed: 0, listed: true });
    for (const id of [PARENT, CHILD, OTHER]) expect(second.archive.isArchivedChat(id)).toBe(true);

    // A third that fails takes back only what it added.
    const third = archiveWith({ chats: [...chats, { info: infoOf('ses_new1') }], dataDir: first.dataDir, host: first.host, failImportOf: 'ses_new1' });
    await expect(third.save()).rejects.toMatchObject({ code: 'chats_not_saved' });
    for (const id of [PARENT, CHILD, OTHER]) expect(third.archive.isArchivedChat(id)).toBe(true);
    expect(third.removed).toEqual([]);
  });

  it('stops taking chats out when the whole save runs out of time', async () => {
    let clock = 0;
    const { host, save } = archiveWith({ chats: [{ info: infoOf(PARENT) }, { info: infoOf(OTHER) }], now: () => { clock += 20 * 60_000; return clock; } });
    await expect(save()).rejects.toMatchObject({ code: 'chats_not_saved', details: { failed: 1 } });
    expect(host.size).toBe(0);
  });

  it('never hangs a chat under a session that is not in the same archive', async () => {
    const { host, save } = archiveWith({ chats: [{ info: infoOf(CHILD, { parentID: HOST_SESSION }) }] });
    await save();
    expect(host.get(CHILD).info).not.toHaveProperty('parentID');
  });

  it('saves nothing when one chat cannot be taken out, naming a chat too large by its title', async () => {
    const { archive, host, save, dataDir } = archiveWith({ chats: [
      { info: infoOf(PARENT) },
      { info: infoOf(OTHER, { title: 'Big one' }), fail: new SpaceError('chat_too_large', 'too large') },
    ] });
    await expect(save()).rejects.toMatchObject({ code: 'chats_not_saved', details: { name: 'Fix login', tooLarge: ['Big one'], failed: 0 } });
    expect(host.size).toBe(0);
    expect(archive.listArchives()).toEqual([]);
    expect(fs.readdirSync(path.join(dataDir, 'spaces', 'archive'))).toEqual([]);
  });

  it('with "delete anyway", saves what can be saved and reports the rest', async () => {
    const { host, save } = archiveWith({ chats: [
      { info: infoOf(PARENT) },
      { info: infoOf(OTHER), fail: new SpaceError('chat_export_failed', 'broken') },
    ] });
    expect(await save(true)).toEqual({ saved: 1, tooLarge: [], failed: 1, listed: true });
    expect(Array.from(host.keys())).toEqual([PARENT]);
  });

  it('takes back what it imported when a later import fails, so the space stays as it was', async () => {
    const { archive, host, removed, save } = archiveWith({ chats: [{ info: infoOf(PARENT) }, { info: infoOf(OTHER) }], failImportOf: OTHER });
    await expect(save()).rejects.toMatchObject({ code: 'chats_not_saved', details: { failed: 1 } });
    expect(removed).toEqual([PARENT]);
    expect(host.size).toBe(0);
    expect(archive.isArchivedChat(PARENT)).toBe(false);
  });

  it('counts a space that cannot list its chats, and chats past the cap, as not saved', async () => {
    const { archive, save, source } = archiveWith({ chats: [] });
    source.listChats = async () => { throw new SpaceError('space_not_running', 'stopped'); };
    await expect(save()).rejects.toMatchObject({ code: 'chats_not_saved', details: { listed: false } });
    expect(await save(true)).toEqual({ saved: 0, tooLarge: [], failed: 0, listed: false });
    expect(archive.listArchives()).toEqual([]);

    const many = Array.from({ length: ARCHIVE_MAX_CHATS + 1 }, (_, index) => ({ info: infoOf(`ses_n${index}`) }));
    await expect(archiveWith({ chats: many }).save()).rejects.toMatchObject({ code: 'chats_not_saved', details: { failed: 1 } });
  });
});

describe('an archived chat is read-only', () => {
  it('refuses every route that would run or change it, and lets it be read and deleted', async () => {
    const { archive, save } = archiveWith({ chats: [{ info: infoOf(PARENT) }] });
    await save();
    for (const [method, requestPath] of [
      ['POST', `/api/session/${PARENT}/prompt`],
      ['POST', `/api/session/${PARENT}/shell`],
      ['POST', `/api/session/${PARENT}/command`],
      ['POST', `/api/session/${PARENT}/fork`],
      ['PATCH', `/api/session/${PARENT}`],
      ['POST', `/api/experimental/session/${PARENT}/skill`],
      ['POST', `/api/openchamber/sessions/${PARENT}/send`],
      ['POST', `/api/openchamber/sessions/${PARENT}/fork`],
      ['POST', `/api/message-queue/sessions/${PARENT}/items`],
      ['PUT', `/api/goals/objective/${PARENT}`],
      ['PUT', `/api/permission-auto-accept/sessions/${PARENT}`],
      ['DELETE', `/api/session/${PARENT}/revert`],
    ]) {
      expect(through(archive, method, requestPath)).toEqual({ code: 409, body: expect.objectContaining({ code: 'archived_chat_read_only' }) });
    }
    expect(through(archive, 'POST', `/api/session/${PARENT.replace('_', '%5F')}/prompt`)).toMatchObject({ code: 409 });
    expect(through(archive, 'POST', `/api/session/${PARENT.replace('_', '%5f')}/shell`)).toMatchObject({ code: 409 });
    expect(through(archive, 'GET', `/api/session/${PARENT}/message`)).toBe('passed');
    expect(through(archive, 'DELETE', `/api/session/${PARENT}`)).toBe('passed');
    expect(through(archive, 'POST', `/api/session/${OTHER}/prompt`)).toBe('passed');
  });

  it('stays read-only after a restart, from the archive\'s file', async () => {
    const first = archiveWith({ chats: [{ info: infoOf(PARENT) }] });
    await first.save();
    const second = archiveWith({ chats: [], dataDir: first.dataDir });
    expect(second.archive.isArchivedChat(PARENT)).toBe(true);
    expect(through(second.archive, 'POST', `/api/session/${PARENT}/prompt`)).toMatchObject({ code: 409 });
    expect(second.archive.listArchives()).toHaveLength(1);
  });
});
