import { describe, expect, test } from 'bun:test';
import { directoryEnvironment } from './test-support/directoryEnvironment';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const LOCAL_HOME = 'C:/Users/me';
const REMOTE_HOME = '/Users/me';
const REMOTE_CHATS = '/Users/me/.config/openchamber/chats';
const environment = directoryEnvironment({ home: LOCAL_HOME });
let homeLookups = 0;
let answerBootLookup: () => void = () => undefined;
const bootLookup = new Promise<void>((resolve) => { answerBootLookup = resolve; });
environment.respond(async (url) => {
  if (url.pathname !== '/api/fs/home') throw new Error(`Unexpected request: ${url}`);
  const local = url.hostname === 'local.test';
  homeLookups += 1;
  if (homeLookups === 1) await bootLookup;
  return Response.json(local
    ? { home: LOCAL_HOME, chatsRoot: `${LOCAL_HOME}/.config/openchamber/chats` }
    : { home: REMOTE_HOME, chatsRoot: REMOTE_CHATS });
});
switchRuntimeEndpoint({ apiBaseUrl: 'https://local.test', runtimeKey: 'local' });

describe('home lookup that answers after a runtime switch', () => {
  test('stores nothing from the host the window left', async () => {
    const { useDirectoryStore } = await import('./useDirectoryStore');
    await environment.settle();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://mac.test', runtimeKey: 'host:mac' });
    await environment.settle();
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: REMOTE_HOME, currentDirectory: REMOTE_CHATS, isHomeReady: true });
    answerBootLookup();
    await environment.settle();
    expect(useDirectoryStore.getState().homeDirectory).toBe(REMOTE_HOME);
    expect(environment.storage.getItem('homeDirectory')).toBe(REMOTE_HOME);
    expect(environment.settingsWrites.filter((write) => write.runtimeKey === 'mac.test' && write.changes.homeDirectory === LOCAL_HOME)).toEqual([]);
    useDirectoryStore.getState().setDirectory('~/notes');
    expect(useDirectoryStore.getState().currentDirectory).toBe(`${REMOTE_HOME}/notes`);
    await environment.settle();
  });
});
