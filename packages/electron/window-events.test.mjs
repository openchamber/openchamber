import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachWindowEvents, isNativeWindowVisible } from './window-events.mjs';

test('native visibility follows show, hide and minimize independently of focus', () => {
  const window = new EventEmitter();
  let visible = true;
  let minimized = false;
  let destroyed = false;
  Object.assign(window, {
    isVisible: () => visible,
    isMinimized: () => minimized,
    isDestroyed: () => destroyed,
  });
  const reported = [];
  attachWindowEvents(window, (target, event, detail) => {
    assert.equal(target, window);
    assert.equal(event, 'openchamber:window-visibility');
    reported.push(detail);
  });
  assert.equal(isNativeWindowVisible(window), true);
  window.emit('blur');
  assert.deepEqual(reported, []);
  minimized = true;
  window.emit('minimize');
  minimized = false;
  window.emit('restore');
  visible = false;
  window.emit('hide');
  visible = true;
  window.emit('show');
  assert.deepEqual(reported, [false, true, false, true]);
  destroyed = true;
  assert.equal(isNativeWindowVisible(window), false);
});

test('fullscreen transitions notify the renderer even without a resize event', () => {
  const window = new EventEmitter();
  const reported = [];
  attachWindowEvents(window, (target, event) => {
    assert.equal(target, window);
    reported.push(event);
  }, 'darwin');

  window.emit('enter-full-screen');
  window.emit('leave-full-screen');

  assert.deepEqual(reported, [
    'openchamber:window-resized',
    'openchamber:window-resized',
  ]);
});

test('macOS resizes still notify the renderer to refresh titlebar geometry', () => {
  const window = new EventEmitter();
  const reported = [];
  attachWindowEvents(window, (_target, event) => reported.push(event), 'darwin');

  window.emit('resize');

  assert.deepEqual(reported, ['openchamber:window-resized']);
});

test('fullscreen layout refreshes remain macOS-only', () => {
  const window = new EventEmitter();
  const reported = [];
  attachWindowEvents(window, (_target, event) => reported.push(event), 'win32');

  window.emit('resize');
  window.emit('enter-full-screen');
  window.emit('leave-full-screen');

  assert.deepEqual(reported, []);
});
