import assert from 'node:assert/strict';
import test from 'node:test';

import { browserPanelKeyAction, browserPanelMouseAction, runBrowserPanelAction } from './browser-panel-navigation.mjs';

const key = (overrides) => ({
  type: 'keyDown', key: 'r', isAutoRepeat: false, shift: false, control: false, alt: false, meta: false, ...overrides,
});

test('Cmd+R reloads on macOS, Ctrl+R elsewhere', () => {
  assert.equal(browserPanelKeyAction(key({ meta: true }), 'darwin'), 'reload');
  assert.equal(browserPanelKeyAction(key({ control: true }), 'darwin'), null);
  assert.equal(browserPanelKeyAction(key({ control: true }), 'win32'), 'reload');
  assert.equal(browserPanelKeyAction(key({ control: true, key: 'R' }), 'linux'), 'reload');
  assert.equal(browserPanelKeyAction(key({ meta: true }), 'linux'), null);
});

test('Shift reloads past the cache', () => {
  assert.equal(browserPanelKeyAction(key({ meta: true, shift: true, key: 'R' }), 'darwin'), 'hard-reload');
});

test('a plain R, a held key, a key release and Alt combinations stay with the page', () => {
  assert.equal(browserPanelKeyAction(key({}), 'darwin'), null);
  assert.equal(browserPanelKeyAction(key({ meta: true, isAutoRepeat: true }), 'darwin'), null);
  assert.equal(browserPanelKeyAction(key({ meta: true, type: 'keyUp' }), 'darwin'), null);
  // The app's own shortcut for project actions.
  assert.equal(browserPanelKeyAction(key({ meta: true, alt: true }), 'darwin'), null);
});

test('only a mouse side button navigates', () => {
  assert.equal(browserPanelMouseAction({ type: 'mouseUp', button: 'back' }), 'back');
  assert.equal(browserPanelMouseAction({ type: 'mouseUp', button: 'forward' }), 'forward');
  assert.equal(browserPanelMouseAction({ type: 'mouseUp', button: 'left' }), null);
  assert.equal(browserPanelMouseAction({ type: 'mouseMove' }), null);
});

test('back and forward do nothing at the ends of the history', () => {
  const calls = [];
  const contents = {
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => true,
      goBack: () => calls.push('back'),
      goForward: () => calls.push('forward'),
    },
  };
  runBrowserPanelAction(contents, 'back');
  runBrowserPanelAction(contents, 'forward');
  assert.deepEqual(calls, ['forward']);
});
