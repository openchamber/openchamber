import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createBrowserPanelDriver, keyEventsFor } from './browser-panel-driver.mjs';

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

test('keyEventsFor maps shifted US digits and punctuation while retaining unmodified text', () => {
  for (const [base, shifted] of Object.entries({
    '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
    '`': '~', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
  })) {
    const [down, up] = keyEventsFor(`Shift+${base}`, 'linux');
    assert.equal(down.key, shifted);
    assert.equal(down.text, shifted);
    assert.equal(down.unmodifiedText, base);
    assert.equal(up.key, shifted);
  }
  const [letter] = keyEventsFor('Shift+a', 'linux');
  assert.equal(letter.unmodifiedText, 'a');
  const [chord] = keyEventsFor('Control+Shift+7', 'linux');
  assert.equal(chord.key, '&');
  assert.equal(chord.text, undefined);
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

test('keyboard input stops when the browser page loses focus', async () => {
  const commands = [];
  let focused = false;
  const debuggerSession = new EventEmitter();
  debuggerSession.isAttached = () => true;
  debuggerSession.sendCommand = async (method, params) => {
    commands.push({ method, params });
    if (method === 'Input.dispatchKeyEvent' && params.type === 'rawKeyDown') focused = false;
    return {};
  };
  const contents = { debugger: debuggerSession, isFocused: () => focused };
  const driver = createBrowserPanelDriver();

  await assert.rejects(driver.run(contents, 'insertText', { text: 'private' }), /lost keyboard focus/);
  await assert.rejects(driver.run(contents, 'press', { key: 'Enter' }), /lost keyboard focus/);
  assert.equal(commands.filter(({ method }) => method.startsWith('Input.')).length, 0);

  focused = true;
  await assert.rejects(driver.run(contents, 'insertText', { text: 'late', expiresAt: 0 }), /expired/);
  await assert.rejects(driver.run(contents, 'press', { key: 'Enter', expiresAt: 0 }), /expired/);
  assert.equal(commands.filter(({ method }) => method.startsWith('Input.')).length, 0);
  await driver.run(contents, 'press', { key: 'Tab' });
  const events = commands.filter(({ method }) => method === 'Input.dispatchKeyEvent');
  assert.deepEqual(events.map(({ params }) => params.type), ['rawKeyDown']);
});

test('a key press that outlives its deadline sends no key release', async (t) => {
  const commands = [];
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const debuggerSession = new EventEmitter();
  debuggerSession.isAttached = () => true;
  debuggerSession.sendCommand = async (method, params) => {
    commands.push({ method, params });
    // The key-down returns after the action expired; a later action has focused the page again.
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') now = 2_000;
    return {};
  };
  const contents = { debugger: debuggerSession, isFocused: () => true };
  const driver = createBrowserPanelDriver();

  await assert.rejects(driver.run(contents, 'press', { key: 'Enter', expiresAt: 1_500 }), /expired/);
  const events = commands.filter(({ method }) => method === 'Input.dispatchKeyEvent');
  assert.deepEqual(events.map(({ params }) => params.type), ['keyDown']);
});
