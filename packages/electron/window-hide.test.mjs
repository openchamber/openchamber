import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { hideWindow } from './window-hide.mjs';

const createWindow = ({ fullScreen }) => {
  const window = new EventEmitter();
  window.calls = [];
  window.fullScreen = fullScreen;
  window.destroyed = false;
  window.isDestroyed = () => window.destroyed;
  window.isFullScreen = () => window.fullScreen;
  window.hide = () => window.calls.push('hide');
  window.setFullScreen = (value) => window.calls.push(`setFullScreen:${value}`);
  return window;
};

test('hides a window that is not in full screen right away', () => {
  const window = createWindow({ fullScreen: false });
  hideWindow(window, 'darwin');
  assert.deepEqual(window.calls, ['hide']);
});

test('on macOS a full-screen window leaves full screen before it hides', () => {
  const window = createWindow({ fullScreen: true });
  hideWindow(window, 'darwin');
  assert.deepEqual(window.calls, ['setFullScreen:false']);

  window.fullScreen = false;
  window.emit('leave-full-screen');
  assert.deepEqual(window.calls, ['setFullScreen:false', 'hide']);
});

test('a window destroyed while leaving full screen is not hidden', () => {
  const window = createWindow({ fullScreen: true });
  hideWindow(window, 'darwin');
  window.destroyed = true;
  window.emit('leave-full-screen');
  assert.deepEqual(window.calls, ['setFullScreen:false']);
});

test('on Windows and Linux a full-screen window hides in place', () => {
  for (const platform of ['win32', 'linux']) {
    const window = createWindow({ fullScreen: true });
    hideWindow(window, platform);
    assert.deepEqual(window.calls, ['hide']);
  }
});

test('ignores a missing or destroyed window', () => {
  hideWindow(null, 'darwin');
  const window = createWindow({ fullScreen: false });
  window.destroyed = true;
  hideWindow(window, 'darwin');
  assert.deepEqual(window.calls, []);
});
