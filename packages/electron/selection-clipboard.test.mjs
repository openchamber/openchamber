import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { z } from 'zod';

// Evaluate the real dispatcher without booting Electron or the embedded server.
const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const start = main.indexOf('const handleInvoke = async ');
assert.notEqual(start, -1);
const end = main.indexOf('\n};', start);
assert.notEqual(end, -1);
const dispatcher = new vm.Script(`${main.slice(start, end + 3)}\nhandleInvoke;`);
const createInvoke = (selection, platform = 'linux') => dispatcher.runInNewContext({
  clipboard: { selection }, process: { platform }, z,
});

test('selection write acknowledges only after the native write completes', async () => {
  const pending = Promise.withResolvers();
  const writes = [];
  const invoke = createInvoke({ writeText: (text) => { writes.push(text); return pending.promise; } });
  let acknowledged = false;
  const response = invoke(null, 'desktop_clipboard_write_selection', { text: 'selected text' })
    .then((result) => { acknowledged = true; return result; });
  await Promise.resolve();
  await Promise.resolve();
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
