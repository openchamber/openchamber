import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachWindowVisibility, isNativeWindowVisible } from './window-visibility.mjs';

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
  attachWindowVisibility(window, (target, event, detail) => {
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
