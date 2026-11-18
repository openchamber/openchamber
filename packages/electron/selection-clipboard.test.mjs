import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';

const handlers = new Map();
const clipboard = {};
const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  isDefaultProtocolClient: () => true,
  getAppPath: () => '',
  getPath: () => '/tmp/opencode/selection-clipboard-test',
  getVersion: () => '2.7.2',
  whenReady: () => new Promise(() => {}),
});
const electron = {
  app,
  BrowserWindow: Object.assign(class {}, { fromWebContents: () => null, getAllWindows: () => [] }),
  clipboard,
  ipcMain: Object.assign(new EventEmitter(), {
    handle: (channel, handler) => handlers.set(channel, handler),
  }),
  ClipboardItem: class {}, dialog: {}, globalShortcut: {}, Menu: {}, MessageChannelMain: class {},
  nativeTheme: {}, net: {}, Notification: class {}, powerMonitor: {}, powerSaveBlocker: {},
  protocol: {}, screen: {}, session: {}, shell: {}, webContents: {}, Tray: class {}, nativeImage: {},
};
const log = {
  initialize() {},
  transports: { file: { getFile: () => { throw new Error('no log file'); } }, console: {} },
  functions: {}, info() {}, warn() {}, debug() {}, error() {},
};
globalThis.selectionClipboardTestEdges = { electron, log };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron' || specifier === 'electron-log/main.js') {
      return { url: `selection-clipboard-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, { ...context, conditions: [...context.conditions, 'openchamber-source'] });
  },
  load(url, context, nextLoad) {
    if (url === 'selection-clipboard-test:electron') {
      return { format: 'module', shortCircuit: true, source: `
        const electron = globalThis.selectionClipboardTestEdges.electron;
        export default electron;
        ${Object.keys(electron).map((key) => `export const ${key} = electron.${key};`).join('\n')}
      ` };
    }
    if (url === 'selection-clipboard-test:electron-log/main.js') {
      return { format: 'module', shortCircuit: true,
        source: 'export default globalThis.selectionClipboardTestEdges.log;' };
    }
    return nextLoad(url, context);
  },
});
await import('../web/scripts/register-server-sources.mjs');
const cwd = process.cwd();
const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
Object.defineProperty(process, 'resourcesPath', { value: '/tmp/opencode', configurable: true });
try {
  await import('./main.mjs');
} finally {
  process.chdir(cwd);
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath);
  else delete process.resourcesPath;
  hooks.deregister();
  delete globalThis.selectionClipboardTestEdges;
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
  assert.equal(await createInvoke(undefined)(null, 'desktop_clipboard_write_selection', { text: 'text' }), false);
});
