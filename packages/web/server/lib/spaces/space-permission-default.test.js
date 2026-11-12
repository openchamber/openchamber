// The default permission mode as the server inside a space reads it: from the file the host
// writes, which the agent can also write, through the permission runtime of the server inside.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPermissionAutoAcceptRuntime } from '../permission-auto-accept/runtime.js';
import { permissionDefaultOf, readSpacePermissionDefault } from './space-permission-default.js';

const folders = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

const settingFile = () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-default-mode-'));
  folders.push(folder);
  return path.join(folder, 'permission-default.json');
};

/** The permission runtime of a server inside a space: its own settings hold no default, the file does. */
const runtimeInside = (filePath) => {
  let settings = { permissionAutoAccept: { sessions: {} } };
  let eventHandler;
  // Each read of the file, so a test waits for the runtime to have read it rather than for a guessed time.
  const reads = [];
  const runtime = createPermissionAutoAcceptRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus() { return () => {}; },
    },
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: async () => settings,
    persistSettings: async (changes) => { settings = { ...settings, ...changes }; },
    fetchImpl: vi.fn(async () => new Response('[]')),
    retryDelaysMs: [0],
    readDefaultMode: async () => {
      const mode = await readSpacePermissionDefault(filePath);
      reads.push(mode);
      return mode;
    },
  });
  runtime.start();
  /** Announces a new chat; for one that reads the file, `reads`, resolves once the runtime has read it. */
  const created = async (id, { parentID, reads: readsFile = !parentID } = {}) => {
    const before = reads.length;
    const payload = { type: 'session.created', properties: { info: { id, parentID } } };
    eventHandler({ payload, directory: '/spaces/0123456789ab/project', translated: () => [payload] });
    if (readsFile) await vi.waitFor(() => expect(reads.length).toBe(before + 1));
  };
  // A mode the runtime read is written after the read, so a test that expects a write waits for it.
  const modesBecome = (expected) => vi.waitFor(async () => expect((await runtime.load()).modes).toEqual(expected));
  return { runtime, created, modesBecome };
};

describe('the default permission mode inside a space', () => {
  it('starts every new top-level chat in the mode the host wrote, however the chat was made', async () => {
    const filePath = settingFile();
    fs.writeFileSync(filePath, JSON.stringify({ mode: 'auto' }));
    const { runtime, created, modesBecome } = runtimeInside(filePath);
    await created('from-the-draft');
    await created('from-a-review');
    await created('a-subagent', { parentID: 'from-a-review' });
    await modesBecome({ 'from-the-draft': 'auto', 'from-a-review': 'auto' });
    await expect(runtime.resolveSessionMode('a-subagent', '/spaces/0123456789ab/project')).resolves.toBe('auto');
  });

  it('takes a changed mode for the next chat and leaves older chats as they are', async () => {
    const filePath = settingFile();
    fs.writeFileSync(filePath, JSON.stringify({ mode: 'auto' }));
    const { created, modesBecome } = runtimeInside(filePath);
    await created('older');
    fs.writeFileSync(filePath, JSON.stringify({ mode: 'safety' }));
    await created('newer');
    fs.writeFileSync(filePath, JSON.stringify({ mode: 'ask' }));
    await created('newest');
    await modesBecome({ older: 'auto', newer: 'safety' });
  });

  it('keeps a mode the creating flow already set over the file', async () => {
    const filePath = settingFile();
    fs.writeFileSync(filePath, JSON.stringify({ mode: 'auto' }));
    const { runtime, created, modesBecome } = runtimeInside(filePath);
    await runtime.setSessionPolicy('picked', 'ask');
    await created('fresh');
    await created('picked', { reads: false });
    await modesBecome({ picked: 'ask', fresh: 'auto' });
  });

  it.each([
    ['missing', null],
    ['not JSON', '{'],
    ['no mode', JSON.stringify({ mode: 'always' })],
    ['with an unknown field', JSON.stringify({ mode: 'auto', also: 'safety' })],
    ['far too large', `${JSON.stringify({ mode: 'auto' })}${' '.repeat(2048)}`],
  ])('writes no mode when the file is %s, so the chat asks', async (_what, raw) => {
    const filePath = settingFile();
    if (raw !== null) fs.writeFileSync(filePath, raw);
    expect(await readSpacePermissionDefault(filePath)).toBeNull();
    const { runtime, created } = runtimeInside(filePath);
    await created('root');
    expect((await runtime.load()).modes).toEqual({});
  });

  it('does not wait on a file the agent made a FIFO, a folder or a link', async () => {
    const fifo = settingFile();
    execFileSync('mkfifo', [fifo]);
    expect(await readSpacePermissionDefault(fifo)).toBeNull();

    const folder = settingFile();
    fs.mkdirSync(folder);
    expect(await readSpacePermissionDefault(folder)).toBeNull();

    const target = settingFile();
    fs.writeFileSync(target, JSON.stringify({ mode: 'auto' }));
    const link = settingFile();
    fs.symlinkSync(target, link);
    expect(await readSpacePermissionDefault(link)).toBeNull();
  }, 2000);
});

describe('the default permission mode on the host', () => {
  it('writes the mode from Settings, and ask for anything that is no mode', () => {
    for (const mode of ['ask', 'safety', 'auto']) expect(permissionDefaultOf(mode)).toEqual({ mode });
    for (const value of [undefined, null, '', 'always', true, { mode: 'auto' }]) expect(permissionDefaultOf(value)).toEqual({ mode: 'ask' });
  });
});
