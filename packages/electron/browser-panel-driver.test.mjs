import assert from 'node:assert/strict';
import test from 'node:test';

import { keyEventsFor } from './browser-panel-driver.mjs';

test('keyEventsFor types the text of a named key that has one', () => {
  const [down, up] = keyEventsFor('Enter', 'linux');
  assert.equal(down.type, 'keyDown');
  assert.equal(down.text, '\r');
  assert.equal(down.windowsVirtualKeyCode, 13);
  assert.equal(up.type, 'keyUp');
});

test('keyEventsFor sends a raw key down for keys that type nothing', () => {
  const [down] = keyEventsFor('Shift+Tab', 'linux');
  assert.equal(down.type, 'rawKeyDown');
  assert.equal(down.modifiers, 8);
  assert.equal(down.text, undefined);
});

test('keyEventsFor maps a letter to its code and types it, upper case with Shift', () => {
  const [down] = keyEventsFor('Shift+a', 'linux');
  assert.equal(down.key, 'A');
  assert.equal(down.code, 'KeyA');
  assert.equal(down.text, 'A');
});

test('keyEventsFor turns the platform shortcut into an editing command and types nothing', () => {
  const [mac] = keyEventsFor('Meta+a', 'darwin');
  assert.deepEqual(mac.commands, ['selectAll']);
  assert.equal(mac.text, undefined);
  const [other] = keyEventsFor('Control+a', 'linux');
  assert.deepEqual(other.commands, ['selectAll']);
  const [redo] = keyEventsFor('Meta+Shift+z', 'darwin');
  assert.deepEqual(redo.commands, ['redo']);
  const [plain] = keyEventsFor('Control+a', 'darwin');
  assert.equal(plain.commands, undefined);
});

test('keyEventsFor names what it accepts when the key or modifier is unknown', () => {
  assert.throws(() => keyEventsFor('Hyper+a'), /Unknown modifier Hyper/);
  assert.throws(() => keyEventsFor('F13'), /Unknown key F13/);
  assert.throws(() => keyEventsFor(''), /Unknown key/);
});
