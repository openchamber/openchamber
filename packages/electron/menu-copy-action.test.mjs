import assert from 'node:assert/strict';
import test from 'node:test';
import { createCopyMenuAction } from './menu-copy-action.mjs';

/** A webContents fake; `host` stands for `getHostWebContents()`. */
const pageContents = ({ host = null } = {}) => {
  const calls = [];
  return {
    calls,
    copy: () => calls.push('copy'),
    getHostWebContents: () => host,
  };
};

test('copy reaches the focused DevTools renderer and skips the app copy action', () => {
  // An undocked DevTools window is its own webContents with a host; the
  // focused-window lookup used to miss it entirely, so Cmd+C copied from the
  // app document instead (#6012).
  const devtools = pageContents({ host: {} });
  const dispatches = [];
  const handleCopyAction = createCopyMenuAction({
    getFocusedWebContents: () => devtools,
    dispatchAppCopy: () => dispatches.push('copy'),
  });

  handleCopyAction();

  assert.deepEqual(devtools.calls, ['copy']);
  assert.deepEqual(dispatches, []);
});

test('copy from an app window page still runs the app copy action', () => {
  const page = pageContents();
  const dispatches = [];
  const handleCopyAction = createCopyMenuAction({
    getFocusedWebContents: () => page,
    dispatchAppCopy: () => dispatches.push('copy'),
  });

  handleCopyAction();

  assert.deepEqual(page.calls, ['copy']);
  assert.deepEqual(dispatches, ['copy']);
});

test('copy from a focused guest page copies the guest, not the app document', () => {
  // The built-in browser's guest page carries a host webContents too; its
  // selection is what Cmd+C should put on the clipboard.
  const guest = pageContents({ host: {} });
  const dispatches = [];
  const handleCopyAction = createCopyMenuAction({
    getFocusedWebContents: () => guest,
    dispatchAppCopy: () => dispatches.push('copy'),
  });

  handleCopyAction();

  assert.deepEqual(guest.calls, ['copy']);
  assert.deepEqual(dispatches, []);
});

test('nothing focused copies nothing and dispatches nothing', () => {
  const dispatches = [];
  const handleCopyMenuAction = createCopyMenuAction({
    getFocusedWebContents: () => null,
    dispatchAppCopy: () => dispatches.push('copy'),
  });

  handleCopyMenuAction();

  assert.deepEqual(dispatches, []);
});
