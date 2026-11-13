import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { hideWindow, isWindowHidePending, showWindow } from './window-hide.mjs';

const createWindow = ({ fullScreen }) => {
  const window = new EventEmitter();
  window.calls = [];
  window.fullScreen = fullScreen;
  window.destroyed = false;
  window.isDestroyed = () => window.destroyed;
  window.isFullScreen = () => window.fullScreen;
  window.hide = () => window.calls.push('hide');
  window.show = () => window.calls.push('show');
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

test('show during exit cancels hiding and restores full screen after exit', () => {
  const window = createWindow({ fullScreen: true });
  hideWindow(window, 'darwin');
  showWindow(window);
  assert.equal(isWindowHidePending(window), false);
  window.fullScreen = false;
  window.emit('leave-full-screen');
  assert.deepEqual(window.calls, ['setFullScreen:false', 'show', 'setFullScreen:true']);
  assert.equal(window.listenerCount('enter-full-screen'), 0);
  assert.equal(window.listenerCount('leave-full-screen'), 0);
});

test('Hide restores full screen on reopen but close does not', () => {
  for (const restoreFullScreen of [true, false]) {
    const window = createWindow({ fullScreen: true });
    hideWindow(window, 'darwin', { restoreFullScreen });
    window.fullScreen = false;
    window.emit('leave-full-screen');
    showWindow(window);
    assert.equal(window.calls.includes('setFullScreen:true'), restoreFullScreen);
    assert.equal(window.calls.filter((call) => call === 'hide').length, 1);
  }
});

test('repeated hide shares a transition and close discards restoration', () => {
  const window = createWindow({ fullScreen: true });
  hideWindow(window, 'darwin');
  hideWindow(window, 'darwin');
  hideWindow(window, 'darwin', { restoreFullScreen: false });
  hideWindow(window, 'darwin');
  assert.deepEqual(window.calls, ['setFullScreen:false']);
  assert.equal(window.listenerCount('leave-full-screen'), 1);
  window.fullScreen = false;
  window.emit('leave-full-screen');
  showWindow(window);
  assert.deepEqual(window.calls, ['setFullScreen:false', 'hide', 'show']);
});

test('close during entry retries exit when native entry completes', () => {
  const window = createWindow({ fullScreen: true });
  hideWindow(window, 'darwin', { restoreFullScreen: false });
  window.emit('enter-full-screen');
  assert.deepEqual(window.calls, ['setFullScreen:false', 'setFullScreen:false']);
  window.fullScreen = false;
  window.emit('leave-full-screen');
  showWindow(window);
  window.emit('enter-full-screen');
  window.emit('leave-full-screen');
  assert.deepEqual(window.calls, ['setFullScreen:false', 'setFullScreen:false', 'hide', 'show']);
});

test('entry completing after a normal-looking hide still exits before the final hide', () => {
  const window = createWindow({ fullScreen: false });
  hideWindow(window, 'darwin');
  window.fullScreen = true;
  window.emit('enter-full-screen');
  window.fullScreen = false;
  window.emit('leave-full-screen');
  showWindow(window);
  assert.ok(window.calls.includes('setFullScreen:true'));
});

test('show cancels a pending entry handler without affecting later full-screen entries', () => {
  const window = createWindow({ fullScreen: false });
  hideWindow(window, 'darwin');
  showWindow(window);
  window.emit('enter-full-screen');
  window.emit('leave-full-screen');
  assert.deepEqual(window.calls, ['hide', 'show']);
  assert.equal(window.listenerCount('closed'), 0);
});

test('destruction clears both native transition handlers', () => {
  const window = createWindow({ fullScreen: true });
  hideWindow(window, 'darwin');
  window.destroyed = true;
  window.emit('closed');
  window.emit('enter-full-screen');
  window.emit('leave-full-screen');
  assert.equal(window.listenerCount('enter-full-screen'), 0);
  assert.equal(window.listenerCount('leave-full-screen'), 0);
  assert.equal(isWindowHidePending(window), false);
  assert.deepEqual(window.calls, ['setFullScreen:false']);
});

test('show during entry restores full screen after the queued exit completes', () => {
  for (const restoreFullScreen of [true, false]) {
    const window = createWindow({ fullScreen: true });
    let entering = true;
    let queuedExit = false;
    window.setFullScreen = (value) => {
      window.calls.push(`setFullScreen:${value}`);
      if (entering && !value) queuedExit = true;
    };
    hideWindow(window, 'darwin', { restoreFullScreen });
    showWindow(window);
    entering = false;
    window.emit('enter-full-screen');
    assert.equal(queuedExit, true);
    assert.deepEqual(window.calls, ['setFullScreen:false', 'show']);
    window.fullScreen = false;
    window.emit('leave-full-screen');
    assert.deepEqual(window.calls, [
      'setFullScreen:false', 'show', ...(restoreFullScreen ? ['setFullScreen:true'] : []),
    ]);
    assert.equal(window.listenerCount('enter-full-screen'), 0);
    assert.equal(window.listenerCount('leave-full-screen'), 0);
    assert.equal(window.listenerCount('closed'), 0);
  }
});

test('a transition that never completes leaves a full-screen window visible', () => {
  const window = createWindow({ fullScreen: true });
  hideWindow(window, 'darwin');
  assert.deepEqual(window.calls, ['setFullScreen:false']);
});
