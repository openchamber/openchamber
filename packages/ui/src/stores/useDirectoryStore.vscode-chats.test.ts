import { expect, test } from 'bun:test';
import { directoryEnvironment } from './test-support/directoryEnvironment';

const home = '/home/user';
const chatsRoot = `${home}/.config/openchamber/chats`;
const environment = directoryEnvironment({ home, vscode: true });
let rootAvailable = false;
let allowMkdir = false;
const allocations: string[] = [];
environment.respond(async (url, init) => {
  if (url.pathname === '/api/fs/home') return rootAvailable
    ? Response.json({ home, chatsRoot })
    : Response.json({}, { status: 503 });
  if (url.pathname === '/api/fs/mkdir') {
    const { path } = JSON.parse(String(init?.body));
    allocations.push(path);
    return allowMkdir ? Response.json({ success: true }) : Response.json({ error: 'Read-only filesystem' }, { status: 403 });
  }
  if (url.pathname === '/api/location' || url.pathname === '/api/session') return Response.json({}, { status: 503 });
  throw new Error(`Unexpected request: ${url}`);
});

test('an empty VS Code window waits for the host root and never bootstraps the home', async () => {
  const { useDirectoryStore, ensureHomeDirectoryResolved } = await import('./useDirectoryStore');
  const { opencodeClient } = await import('@/lib/opencode/client');
  await ensureHomeDirectoryResolved();
  expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: '', isHomeReady: false });
  expect(opencodeClient.getDirectory()).toBeUndefined();
  rootAvailable = true;
  await ensureHomeDirectoryResolved();
  expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: '', isHomeReady: false });
  expect(opencodeClient.getDirectory()).toBeUndefined();
  expect(allocations).toEqual([chatsRoot]);
  allowMkdir = true;
  await ensureHomeDirectoryResolved();
  expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: chatsRoot, isHomeReady: true });
  expect(opencodeClient.getDirectory()).toBe(chatsRoot);
  expect(allocations).toEqual([chatsRoot, chatsRoot]);
  await environment.settle();
});
