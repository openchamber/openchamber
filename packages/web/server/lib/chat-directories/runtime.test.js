import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatDirectoryCleanupRuntime } from './runtime.js';

const temporaryRoots = [];
const runtimes = [];
const page = (data, next) => ({ data, cursor: next === undefined ? {} : { next } });
const session = (id, directory, fields = {}) => ({ id, location: { directory }, ...fields });
const created = (id, directory) => ({ type: 'session.created', properties: { info: { id, directory } } });
const forked = (sessionID, parentID) => ({ type: 'session.forked', properties: { sessionID, parentID } });
const moved = (id, directory) => ({ type: 'session.updated', properties: { info: { id, directory } } });
const deleted = (sessionID) => ({ type: 'session.deleted', properties: { sessionID } });
const quarantined = async (chats) => (await fs.readdir(chats)).filter((name) => name.startsWith('.reclaiming-'));
const exists = async (directory) => fs.lstat(directory).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const fixture = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-chat-cleanup-')));
  temporaryRoots.push(root);
  const chats = path.join(root, 'chats');
  const directory = path.join(chats, '2026-11-10', `session-${randomUUID()}`);
  const screenshot = path.join(directory, '.openchamber', 'screenshots', 'page.png');
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await fs.writeFile(screenshot, 'screenshot bytes');
  return { root, chats, directory, screenshot };
};

const makeRuntime = ({ roots, sessions = [] }) => {
  const state = { sessions, owner: Symbol('managed OpenCode') };
  const list = vi.fn(async (input) => {
    // Match the SDK filters so accidentally excluding archives or subagents
    // loses a real reference in the filesystem assertions below.
    const records = state.sessions.filter((record) => (
      (input.archived === undefined || Boolean(record.time?.archived) === input.archived)
      && (input.parentID === undefined || (record.parentID ?? null) === input.parentID)
    ));
    const start = input.cursor ? Number(input.cursor) : 0;
    const end = start + input.limit;
    const data = records.slice(start, end);
    return page(data, data.length ? String(end) : undefined);
  });
  const logger = { warn: vi.fn() };
  const get = vi.fn(async ({ sessionID }) => {
    const record = state.sessions.find((session) => session.id === sessionID);
    if (!record) throw Object.assign(new Error('Session not found'), { _tag: 'SessionNotFoundError' });
    return record;
  });
  const runtime = createChatDirectoryCleanupRuntime({
    roots,
    createClient: () => ({ session: { list, get } }),
    getOwner: () => state.owner,
    logger,
  });
  runtimes.push(runtime);
  return { runtime, state, list, get, logger };
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('managed chat directory cleanup', () => {
  it('keeps archived forks and nested subagent references, then removes the folder with its last session', async () => {
    const { root, chats, directory, screenshot } = await fixture();
    const childDirectory = path.join(directory, '..generated-project');
    const project = path.join(root, 'project');
    await fs.mkdir(childDirectory);
    await fs.mkdir(project);
    const fork = session('fork', directory, { time: { archived: 1 } });
    const parent = session('project-parent', project);
    const child = session('subagent', childDirectory, { parentID: parent.id });
    const { runtime, state } = makeRuntime({
      roots: [chats], sessions: [session('root', directory), fork, parent],
    });
    await runtime.onConnected();

    state.sessions = [fork, parent];
    await runtime.processPayload(deleted('root'));
    expect(await exists(screenshot)).toBe(true);
    state.sessions = [parent, child];
    await runtime.processPayload(deleted('fork'));
    expect(await exists(screenshot)).toBe(true);
    state.sessions = [parent];
    await runtime.processPayload(deleted('subagent'));
    expect(await exists(directory)).toBe(false);
    expect(await exists(project)).toBe(true);
    expect(await exists(chats)).toBe(true);
  });

  it('learns new chats from events and shares one inventory for a deletion burst', async () => {
    const { chats, directory } = await fixture();
    const { runtime, list } = makeRuntime({ roots: [chats] });
    await runtime.onConnected();
    list.mockClear();
    runtime.processPayload(created('root', directory));
    runtime.processPayload(created('child', directory));
    const rootDeletion = runtime.processPayload(deleted('root'));
    const childDeletion = runtime.processPayload(deleted('child'));
    await Promise.all([rootDeletion, childDeletion]);
    expect(await exists(directory)).toBe(false);
    // One inventory before claiming the folder, one fresh read before destroying it.
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('learns a new fork before its source moves away and reclaims the last fork folder', async () => {
    const { root, chats, directory } = await fixture();
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const source = session('source', directory);
    const fork = session('fork', directory);
    const { runtime, state } = makeRuntime({ roots: [chats], sessions: [source] });
    await runtime.onConnected();
    state.sessions = [source, fork];
    await runtime.processPayload(forked('fork', 'source'));
    state.sessions = [session('source', project), fork];
    runtime.processPayload(moved('source', project));
    state.sessions = [session('source', project)];
    await runtime.processPayload(deleted('fork'));
    expect(await exists(directory)).toBe(false);
    expect(await exists(project)).toBe(true);
  });

  it('waits for fork directory evidence when deletion arrives during its record read', async () => {
    const { root, chats, directory } = await fixture();
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const source = session('source', project);
    const fork = session('fork', directory);
    const { runtime, state, get } = makeRuntime({ roots: [chats], sessions: [source] });
    await runtime.onConnected();
    state.sessions = [source, fork];
    const read = Promise.withResolvers();
    const started = Promise.withResolvers();
    get.mockImplementationOnce(async () => { started.resolve(); return read.promise; });
    const learning = runtime.processPayload(forked('fork', 'source'));
    await started.promise;
    state.sessions = [source];
    const cleanup = runtime.processPayload(deleted('fork'));
    read.resolve(fork);
    await Promise.all([learning, cleanup]);
    expect(await exists(directory)).toBe(false);
    expect(await exists(project)).toBe(true);
  });

  it('uses a newer move when an older fork directory lookup completes', async () => {
    const first = await fixture();
    const second = await fixture();
    const source = session('source', first.directory);
    const fork = session('fork', first.directory);
    const { runtime, state, get } = makeRuntime({ roots: [first.chats, second.chats], sessions: [source] });
    await runtime.onConnected();
    state.sessions = [source, fork];
    const read = Promise.withResolvers();
    const started = Promise.withResolvers();
    get.mockImplementationOnce(async () => { started.resolve(); return read.promise; });
    const learning = runtime.processPayload(forked('fork', 'source'));
    await started.promise;
    state.sessions = [source, session('fork', second.directory)];
    runtime.processPayload(moved('fork', second.directory));
    read.resolve(fork);
    await learning;
    state.sessions = [source];
    await runtime.processPayload(deleted('fork'));
    expect(await exists(second.directory)).toBe(false);
    expect(await exists(first.screenshot)).toBe(true);
  });

  it('follows a short page cursor before deciding that a folder is unused', async () => {
    const { root, chats, directory, screenshot } = await fixture();
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const { runtime, state, list } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
    await runtime.onConnected();
    state.sessions = [session('archived-fork', directory, { time: { archived: 1 } })];
    list.mockImplementation(async ({ cursor }) => {
      if (cursor === undefined) return page([session('other', project)], 'next-page');
      if (cursor === 'next-page') return page(state.sessions, state.sessions.length ? 'terminal-page' : undefined);
      if (cursor === 'terminal-page') return page([]);
      throw new Error('Unexpected session cursor');
    });
    await runtime.processPayload(deleted('root'));
    expect(await exists(screenshot)).toBe(true);
    state.sessions = [];
    await runtime.processPayload(deleted('archived-fork'));
    expect(await exists(directory)).toBe(false);
  });

  for (const [name, answer] of [
    ['failed page', () => { throw new Error('OpenCode unavailable'); }],
    ['malformed record', () => page([{ id: 'unresolved-session' }])],
    ['missing cursor', () => ({ data: [] })],
    ['empty continuation page', () => page([], 'another-page')],
    ['repeated cursor', (call) => page([session(`session-${call}`, '/missing/project')], 'same-cursor')],
  ]) {
    it(`keeps files after a ${name} and retries on reconnect`, async () => {
      const { chats, directory, screenshot } = await fixture();
      const { runtime, state, list, logger } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
      await runtime.onConnected();
      state.sessions = [];
      let calls = 0;
      list.mockImplementation(async () => answer(calls++));
      await runtime.processPayload(deleted('root'));
      expect(await exists(screenshot)).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
      list.mockImplementation(async () => page([]));
      await runtime.onConnected();
      expect(await exists(directory)).toBe(false);
    });
  }

  it('rejects a failed later page without using the earlier page as a complete inventory', async () => {
    const { chats, directory, screenshot } = await fixture();
    const { runtime, state, list } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
    await runtime.onConnected();
    state.sessions = [];
    list.mockImplementationOnce(async () => page([session('other', '/missing/project')], 'unavailable-page'));
    list.mockImplementationOnce(async () => { throw new Error('Later page failed'); });
    await runtime.processPayload(deleted('root'));
    expect(await exists(screenshot)).toBe(true);
    await runtime.onConnected();
    expect(await exists(directory)).toBe(false);
  });

  it('preserves drafts and historical orphans on first load and ignores unknown deletion events', async () => {
    const { chats, directory, screenshot } = await fixture();
    const draft = path.join(chats, '2026-11-10', `session-${randomUUID()}`);
    await fs.mkdir(draft);
    const { runtime, list } = makeRuntime({ roots: [chats] });
    await runtime.onConnected();
    await runtime.processPayload(deleted('unknown-session'));
    expect(await exists(draft)).toBe(true);
    expect(await exists(screenshot)).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('recognizes configured and reference aliases without deleting a referenced folder', async () => {
    const { root, chats, directory, screenshot } = await fixture();
    const configured = path.join(root, 'configured-chats');
    const referenceAlias = path.join(root, 'another-alias');
    await fs.symlink(chats, configured, 'junction');
    await fs.symlink(chats, referenceAlias, 'junction');
    const aliasedDirectory = path.join(referenceAlias, path.relative(chats, directory));
    const { runtime, state } = makeRuntime({ roots: [configured], sessions: [session('root', directory)] });
    await runtime.onConnected();
    state.sessions = [session('fork', aliasedDirectory)];
    await runtime.processPayload(deleted('root'));
    expect(await exists(screenshot)).toBe(true);
    state.sessions = [];
    await runtime.processPayload(deleted('fork'));
    expect(await exists(directory)).toBe(false);
    expect(await exists(configured)).toBe(true);
  });

  it('preserves a missing aliased descendant that an archived session still references', async () => {
    const { root, chats, directory, screenshot } = await fixture();
    const alias = path.join(root, 'chat-alias');
    await fs.symlink(directory, alias, 'junction');
    const missingChild = path.join(alias, 'removed-project');
    const archived = session('archived', missingChild, { time: { archived: 1 } });
    const { runtime, state } = makeRuntime({ roots: [chats], sessions: [session('root', directory), archived] });
    await runtime.onConnected();
    state.sessions = [archived];
    await runtime.processPayload(deleted('root'));
    expect(await exists(screenshot)).toBe(true);
    state.sessions = [];
    await runtime.processPayload(deleted('archived'));
    expect(await exists(directory)).toBe(false);
  });

  it('retains cleanup when a reference cannot be resolved and retries after it becomes readable', async () => {
    const { root, chats, directory, screenshot } = await fixture();
    const first = path.join(root, 'loop-a');
    const second = path.join(root, 'loop-b');
    await fs.symlink(second, first, 'junction');
    await fs.symlink(first, second, 'junction');
    const { runtime, state } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
    await runtime.onConnected();
    state.sessions = [session('unreadable-reference', first)];
    await runtime.processPayload(deleted('root'));
    expect(await exists(screenshot)).toBe(true);
    await fs.unlink(second);
    await fs.mkdir(second);
    await runtime.onConnected();
    expect(await exists(directory)).toBe(false);
  });

  for (const link of ['date', 'session']) {
    it(`keeps files behind a symlinked ${link} directory`, async () => {
      const { root, chats, directory, screenshot } = await fixture();
      const outside = path.join(root, 'outside');
      if (link === 'date') {
        await fs.rename(path.dirname(directory), outside);
        await fs.symlink(outside, path.dirname(directory), 'junction');
      } else {
        await fs.rename(directory, outside);
        await fs.symlink(outside, directory, 'junction');
      }
      const { runtime, state } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
      await runtime.onConnected();
      state.sessions = [];
      await runtime.processPayload(deleted('root'));
      expect(await exists(screenshot)).toBe(true);
      expect(await exists(outside)).toBe(true);
    });
  }

  it('discards a stale empty inventory when a new session starts using the folder', async () => {
    const { chats, directory, screenshot } = await fixture();
    const { runtime, state, list } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
    await runtime.onConnected();
    state.sessions = [];
    const read = Promise.withResolvers();
    const started = Promise.withResolvers();
    list.mockImplementationOnce(async () => { started.resolve(); return read.promise; });
    const cleanup = runtime.processPayload(deleted('root'));
    await started.promise;
    state.sessions = [session('new-session', directory)];
    runtime.processPayload(created('new-session', directory));
    read.resolve(page([]));
    await cleanup;
    expect(await exists(screenshot)).toBe(true);
    state.sessions = [];
    await runtime.processPayload(deleted('new-session'));
    expect(await exists(directory)).toBe(false);
  });

  it('preserves a replacement folder when failed cleanup is retried', async () => {
    const { chats, directory, screenshot } = await fixture();
    const { runtime, state, list } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
    await runtime.onConnected();
    state.sessions = [];
    list.mockImplementationOnce(async () => { throw new Error('OpenCode unavailable'); });
    await runtime.processPayload(deleted('root'));
    const previous = `${directory}-preserved`;
    await fs.rename(directory, previous);
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await fs.writeFile(screenshot, 'replacement files');
    await runtime.onConnected();
    expect(await fs.readFile(screenshot, 'utf8')).toBe('replacement files');
    expect(await exists(previous)).toBe(true);
  });

  it('does not adopt a replacement after a failed first inspection', async () => {
    const { root, chats, directory, screenshot } = await fixture();
    const { runtime, state } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
    await runtime.onConnected();
    const preservedChats = path.join(root, 'preserved-chats');
    const loop = path.join(root, 'loop');
    await fs.rename(chats, preservedChats);
    await fs.symlink(loop, chats, 'junction');
    await fs.symlink(chats, loop, 'junction');
    state.sessions = [];
    await runtime.processPayload(deleted('root'));
    await fs.unlink(chats);
    await fs.unlink(loop);
    await fs.rename(preservedChats, chats);
    const previous = `${directory}-preserved`;
    await fs.rename(directory, previous);
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await fs.writeFile(screenshot, 'replacement after failed inspection');
    await runtime.onConnected();
    expect(await fs.readFile(screenshot, 'utf8')).toBe('replacement after failed inspection');
    expect(await exists(previous)).toBe(true);
  });

  it('retains the original folder identity when a session event overtakes inspection', async () => {
    const { root, chats, directory, screenshot } = await fixture();
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const source = session('other-source', project);
    const fork = session('other-fork', project);
    const { runtime, state } = makeRuntime({ roots: [chats], sessions: [session('root', directory), source] });
    await runtime.onConnected();
    state.sessions = [source];
    const originalLstat = fs.lstat.bind(fs);
    const inspected = Promise.withResolvers();
    const release = Promise.withResolvers();
    let delayed = false;
    const stat = vi.spyOn(fs, 'lstat').mockImplementation(async (target, options) => {
      const identity = await originalLstat(target, options);
      if (target === directory && !delayed) {
        delayed = true;
        inspected.resolve();
        await release.promise;
      }
      return identity;
    });
    try {
      const cleanup = runtime.processPayload(deleted('root'));
      await inspected.promise;
      const previous = `${directory}-preserved`;
      await fs.rename(directory, previous);
      await fs.mkdir(path.dirname(screenshot), { recursive: true });
      await fs.writeFile(screenshot, 'replacement during inspection');
      state.sessions = [source, fork];
      const learning = runtime.processPayload(forked(fork.id, source.id));
      release.resolve();
      await Promise.all([cleanup, learning]);
      expect(await fs.readFile(screenshot, 'utf8')).toBe('replacement during inspection');
      expect(await exists(previous)).toBe(true);
    } finally {
      release.resolve();
      stat.mockRestore();
    }
  });

  for (const [phase, method, failAt, code] of [
    ['initial inspection', 'realpath', 1, 'EIO'],
    ['identity check', 'lstat', 2, 'ENOENT'],
    ['claim', 'rename', 1, null],
  ]) {
    it(`keeps the new owner's cleanup after a stale ${phase} completion`, async () => {
      const { chats, directory, screenshot } = await fixture();
      const { runtime, state } = makeRuntime({ roots: [chats], sessions: [session('old', directory)] });
      await runtime.onConnected();
      state.sessions = [];
      const original = fs[method].bind(fs);
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      let reads = 0;
      const inspection = vi.spyOn(fs, method).mockImplementation(async (target, options) => {
        if (target === directory && ++reads === failAt) {
          if (method === 'rename') await original(target, options);
          started.resolve();
          await release.promise;
          if (code) throw Object.assign(new Error('Stale filesystem read'), { code });
          return;
        }
        return original(target, options);
      });
      try {
        const oldDeletion = runtime.processPayload(deleted('old'));
        await started.promise;
        state.owner = Symbol('new managed process');
        if (phase === 'identity check') {
          await fs.rename(directory, `${directory}-preserved`);
        }
        if (phase !== 'initial inspection') {
          await fs.mkdir(path.dirname(screenshot), { recursive: true });
          await fs.writeFile(screenshot, 'new owner files');
        }
        runtime.processPayload(created('new', directory));
        const newDeletion = runtime.processPayload(deleted('new'));
        release.resolve();
        await Promise.all([oldDeletion, newDeletion]);
        await runtime.onConnected();
        expect(await exists(directory)).toBe(false);
        if (phase === 'identity check') expect(await exists(`${directory}-preserved`)).toBe(true);
        if (phase === 'claim') {
          // The old owner lost its authority while holding the folder, and the
          // new owner's files took the name, so the original stays aside.
          const [kept] = await quarantined(chats);
          expect(await fs.readFile(path.join(chats, kept, path.basename(directory), '.openchamber', 'screenshots', 'page.png'), 'utf8'))
            .toBe('screenshot bytes');
        }
      } finally {
        release.resolve();
        inspection.mockRestore();
      }
    });
  }

  for (const change of ['shutdown', 'external OpenCode', 'another managed process']) {
    it(`preserves files when ${change} overtakes an inventory read`, async () => {
      const { chats, directory, screenshot } = await fixture();
      const { runtime, state, list } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
      await runtime.onConnected();
      state.sessions = [];
      const read = Promise.withResolvers();
      const started = Promise.withResolvers();
      list.mockImplementationOnce(async () => { started.resolve(); return read.promise; });
      const cleanup = runtime.processPayload(deleted('root'));
      await started.promise;
      const stopping = change === 'shutdown' ? runtime.stop() : null;
      if (change !== 'shutdown') state.owner = change === 'external OpenCode' ? null : Symbol('new process');
      read.resolve(page([]));
      await Promise.all([cleanup, stopping]);
      expect(await exists(screenshot)).toBe(true);
    });
  }
  // OpenCode pages sessions by (time.updated, id) with an anchor cursor; a
  // write moves the session to the newest end between two pages.
  const orderedList = (state, afterFirstPage) => {
    let pages = 0;
    return async ({ cursor, order, limit }) => {
      const anchor = cursor ? JSON.parse(cursor) : { order: order ?? 'desc' };
      const sign = anchor.order === 'asc' ? 1 : -1;
      const compare = (left, right) => sign * (left.time.updated - right.time.updated
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const sorted = [...state.sessions].sort(compare);
      const after = cursor ? sorted.filter((record) => compare(record, { id: anchor.id, time: { updated: anchor.time } }) > 0) : sorted;
      const data = after.slice(0, limit);
      if (++pages === 1) afterFirstPage?.();
      const last = data.at(-1);
      return page(data, last ? JSON.stringify({ order: anchor.order, time: last.time.updated, id: last.id }) : undefined);
    };
  };

  for (const change of ['archived', 'renamed']) {
    it(`keeps a folder whose ${change} reference crosses the page cursor`, async () => {
      const { root, chats, directory, screenshot } = await fixture();
      const project = path.join(root, 'project');
      await fs.mkdir(project);
      const others = Array.from({ length: 250 }, (_, index) => (
        session(`other-${String(index).padStart(3, '0')}`, project, { time: { updated: 1_000 + index } })
      ));
      // Older than the 200 newest sessions: the second page when read newest first.
      const fork = session('fork', directory, { time: { updated: 1_020 } });
      const { runtime, state, list } = makeRuntime({ roots: [chats], sessions: [session('root', directory), fork, ...others] });
      await runtime.onConnected();
      state.sessions = [fork, ...others];
      list.mockImplementation(orderedList(state, () => {
        fork.time = change === 'archived' ? { updated: 2_000, archived: 2_000 } : { updated: 2_000 };
        if (change === 'renamed') fork.title = 'Renamed';
      }));
      await runtime.processPayload(deleted('root'));
      expect(await fs.readFile(screenshot, 'utf8')).toBe('screenshot bytes');

      state.sessions = others;
      list.mockImplementation(orderedList(state));
      await runtime.processPayload(deleted('fork'));
      expect(await exists(directory)).toBe(false);
      expect(await quarantined(chats)).toEqual([]);
    });
  }

  it('reads a session the stream wrote to during the inventory when the list missed it', async () => {
    const { chats, directory, screenshot } = await fixture();
    const fork = session('fork', directory, { time: { archived: 1 } });
    const { runtime, state, list, get } = makeRuntime({ roots: [chats], sessions: [session('root', directory), fork] });
    await runtime.onConnected();
    state.sessions = [fork];
    // The archive moved the fork across the cursor; only the raw event names it.
    list.mockImplementationOnce(async () => {
      runtime.observeWirePayload({ type: 'session.archived', data: { sessionID: 'fork' } });
      return page([]);
    });
    await runtime.processPayload(deleted('root'));
    expect(get).toHaveBeenCalledWith({ sessionID: 'fork' }, expect.anything());
    expect(await fs.readFile(screenshot, 'utf8')).toBe('screenshot bytes');
  });

  it('removes nothing while the event stream is down and rereads after reconnecting', async () => {
    const { chats, directory, screenshot } = await fixture();
    const { runtime, state, list } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
    await runtime.onConnected();
    state.sessions = [];
    list.mockImplementationOnce(async () => {
      runtime.onDisconnected();
      return page([]);
    });
    await runtime.processPayload(deleted('root'));
    // Created while no events arrive.
    state.sessions = [session('created-in-gap', directory)];
    expect(await fs.readFile(screenshot, 'utf8')).toBe('screenshot bytes');
    expect(await quarantined(chats)).toEqual([]);

    await runtime.onConnected();
    expect(await fs.readFile(screenshot, 'utf8')).toBe('screenshot bytes');
    state.sessions = [];
    await runtime.processPayload(deleted('created-in-gap'));
    expect(await exists(directory)).toBe(false);
  });

  for (const change of ['reference', 'replacement', 'reference and replacement']) {
    it(`protects files when a ${change} appears while the folder is claimed`, async () => {
      const { chats, directory, screenshot } = await fixture();
      const { runtime, state, list } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
      await runtime.onConnected();
      state.sessions = [];
      const paused = Promise.withResolvers();
      const resume = Promise.withResolvers();
      list.mockImplementationOnce(async () => page([]));
      list.mockImplementationOnce(async () => {
        paused.resolve();
        await resume.promise;
        return page(state.sessions);
      });
      const cleanup = runtime.processPayload(deleted('root'));
      await paused.promise;
      expect(await exists(directory)).toBe(false);
      if (change.includes('replacement')) {
        await fs.mkdir(path.dirname(screenshot), { recursive: true });
        await fs.writeFile(screenshot, 'replacement bytes');
      }
      if (change.includes('reference')) state.sessions = [session('new-session', directory)];
      resume.resolve();
      await cleanup;

      const kept = await quarantined(chats);
      if (change === 'reference') {
        expect(await fs.readFile(screenshot, 'utf8')).toBe('screenshot bytes');
        expect(kept).toEqual([]);
      } else if (change === 'replacement') {
        expect(await fs.readFile(screenshot, 'utf8')).toBe('replacement bytes');
        expect(kept).toEqual([]);
      } else {
        expect(await fs.readFile(screenshot, 'utf8')).toBe('replacement bytes');
        expect(await fs.readFile(path.join(chats, kept[0], path.basename(directory), '.openchamber', 'screenshots', 'page.png'), 'utf8'))
          .toBe('screenshot bytes');
      }
    });
  }

  it('retries a failed removal by its quarantine path after reconnecting', async () => {
    const { chats, directory, screenshot } = await fixture();
    const { runtime, state } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
    await runtime.onConnected();
    state.sessions = [];
    const remove = vi.spyOn(fs, 'rm').mockImplementationOnce(async () => {
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    });
    try {
      await runtime.processPayload(deleted('root'));
    } finally {
      remove.mockRestore();
    }
    expect(await quarantined(chats)).toHaveLength(1);
    await fs.mkdir(path.dirname(screenshot), { recursive: true });
    await fs.writeFile(screenshot, 'replacement bytes');

    runtime.onDisconnected();
    await runtime.onConnected();
    expect(await quarantined(chats)).toEqual([]);
    expect(await fs.readFile(screenshot, 'utf8')).toBe('replacement bytes');
  });

  it('puts a claimed folder back when the stream drops before destruction', async () => {
    const { chats, directory, screenshot } = await fixture();
    const { runtime, state, list } = makeRuntime({ roots: [chats], sessions: [session('root', directory)] });
    await runtime.onConnected();
    state.sessions = [];
    list.mockImplementationOnce(async () => page([]));
    list.mockImplementationOnce(async () => {
      runtime.onDisconnected();
      return page([]);
    });
    await runtime.processPayload(deleted('root'));
    expect(await fs.readFile(screenshot, 'utf8')).toBe('screenshot bytes');
    expect(await quarantined(chats)).toEqual([]);
    await runtime.onConnected();
    expect(await exists(directory)).toBe(false);
  });
});
