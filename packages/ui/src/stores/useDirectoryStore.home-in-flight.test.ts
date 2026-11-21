import { describe, expect, test } from 'bun:test';
import { directoryEnvironment } from './test-support/directoryEnvironment';

const HOME = '/home/user';
const CHATS_ROOT = '/home/user/.config/openchamber/chats';
const environment = directoryEnvironment();
let homeReads = 0;
let answerPageLoadRead: () => void = () => undefined;
environment.respond(async (url) => {
  if (url.pathname !== '/api/fs/home') throw new Error(`Unexpected request: ${url}`);
  homeReads += 1;
  if (homeReads === 1) await new Promise<void>((resolve) => { answerPageLoadRead = resolve; });
  return Response.json({ home: HOME, chatsRoot: CHATS_ROOT });
});

describe('home directory read still in flight when the gate asks for it', () => {
  test('waits for the page-load read instead of starting a second one', async () => {
    const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH };
    const savedCwd = process.cwd;
    for (const key of Object.keys(savedEnv)) delete process.env[key];
    process.cwd = () => '';
    const { ensureHomeDirectoryResolved, useDirectoryStore } = await import('./useDirectoryStore').finally(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      process.cwd = savedCwd;
    });
    expect(useDirectoryStore.getState().isHomeReady).toBe(false);
    const ensured = ensureHomeDirectoryResolved();
    await environment.settle();
    answerPageLoadRead();
    await ensured;
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: HOME, currentDirectory: CHATS_ROOT, isHomeReady: true });
    expect((await import('@/lib/opencode/client')).opencodeClient.getDirectory()).toBe(CHATS_ROOT);
    expect(homeReads).toBe(2);
    await environment.settle();
  });
});
