import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installNativeElectron } from './test-support/native-electron.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'oc-selection-'));
const dataDirectory = process.env.OPENCHAMBER_DATA_DIR;
process.env.OPENCHAMBER_DATA_DIR = directory;
const { handlers, electron: { clipboard }, hooks } = installNativeElectron({ directory });
await import('../web/scripts/register-server-sources.mjs');
const cwd = process.cwd();
const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
Object.defineProperty(process, 'resourcesPath', { value: directory, configurable: true });
try {
  await import('./main.mjs');
} finally {
  process.chdir(cwd);
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath);
  else delete process.resourcesPath;
  hooks.deregister();
  delete globalThis.nativeElectronTestEdges;
  rmSync(directory, { recursive: true, force: true });
  if (dataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = dataDirectory;
}
const invokeHandler = handlers.get('openchamber:invoke');
const createInvoke = (selection, platform = 'linux') => async (_window, command, args) => {
  const originalPlatform = process.platform;
  clipboard.selection = selection;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await invokeHandler({ sender: { getURL: () => 'openchamber-ui://app/' } }, command, args);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    delete clipboard.selection;
  }
};

test('selection write acknowledges only after the native write completes', async () => {
  const pending = Promise.withResolvers();
  const writes = [];
  const invoke = createInvoke({ writeText: (text) => { writes.push(text); return pending.promise; } });
  let acknowledged = false;
  const response = invoke(null, 'desktop_clipboard_write_selection', { text: 'selected text' })
    .then((result) => { acknowledged = true; return result; });
  await new Promise(setImmediate);
  assert.deepEqual(writes, ['selected text']);
  assert.equal(acknowledged, false);
  pending.resolve();
  assert.equal(await response, true);
});

test('native write rejection rejects the command response', async () => {
  const pending = Promise.withResolvers();
  const failure = new Error('selection unavailable');
  const invoke = createInvoke({ writeText: () => pending.promise });
  const response = invoke(null, 'desktop_clipboard_write_selection', { text: 'selected text' });
  const rejected = assert.rejects(response, (error) => error === failure);
  pending.reject(failure);
  await rejected;
});

test('invalid text and unsupported platforms never write PRIMARY', async () => {
  const selection = { writeText: () => assert.fail('unexpected write') };
  assert.equal(await createInvoke(selection)(null, 'desktop_clipboard_write_selection', { text: 42 }), false);
  assert.equal(await createInvoke(selection, 'darwin')(null, 'desktop_clipboard_write_selection', { text: 'text' }), false);
  assert.equal(await createInvoke(selection, 'win32')(null, 'desktop_clipboard_write_selection', { text: 'text' }), false);
  assert.equal(await createInvoke(undefined)(null, 'desktop_clipboard_write_selection', { text: 'text' }), false);
});
