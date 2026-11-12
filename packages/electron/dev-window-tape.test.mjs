import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { attachDevWindowTape, DEV_WINDOW_TAPE_CSS } from './dev-window-tape.mjs';

const fakeWindow = () => {
  const webContents = new EventEmitter();
  webContents.inserted = [];
  webContents.insertCSS = async (css) => {
    webContents.inserted.push(css);
    return 'key';
  };
  return { webContents };
};

test('an unpackaged run tapes every page the window loads', () => {
  const browserWindow = fakeWindow();
  attachDevWindowTape({ isPackaged: false }, browserWindow);

  browserWindow.webContents.emit('dom-ready');
  browserWindow.webContents.emit('dom-ready');

  assert.deepEqual(browserWindow.webContents.inserted, [DEV_WINDOW_TAPE_CSS, DEV_WINDOW_TAPE_CSS]);
});

test('the installed app gets no tape', () => {
  const browserWindow = fakeWindow();
  attachDevWindowTape({ isPackaged: true }, browserWindow);

  browserWindow.webContents.emit('dom-ready');

  assert.deepEqual(browserWindow.webContents.inserted, []);
});

test('the tape lets clicks and window dragging through', () => {
  assert.match(DEV_WINDOW_TAPE_CSS, /pointer-events: none;/);
  assert.doesNotMatch(DEV_WINDOW_TAPE_CSS, /app-region/);
});
