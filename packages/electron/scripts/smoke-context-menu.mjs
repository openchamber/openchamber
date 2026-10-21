// Run with Electron on an isolated display/clipboard, not the user's desktop.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ClipboardItem } from 'electron';
import contextMenu from 'electron-context-menu';
import { createCopyLinkMenuHook } from '../context-menu-clipboard.mjs';
import { createContextMenuLabels } from '../menu-locales.mjs';

const profile = mkdtempSync(path.join(os.tmpdir(), 'openchamber-copy-link-'));
app.setPath('userData', profile);
const timeout = setTimeout(() => {
  console.error('Native context menu check timed out');
  app.exit(1);
}, 20_000);
app.on('window-all-closed', () => {});

const run = async () => {
  let exitCode = 0;
  try {
    await app.whenReady();
    const win = new BrowserWindow({ width: 800, height: 500, webPreferences: { sandbox: true } });
    const { labels, apply } = createContextMenuLabels();
    let nextMenu;
    let nextWrite;
    let writes = 0;
    const hook = createCopyLinkMenuHook({
      ClipboardItem,
      clipboard: {
        write: async (items) => {
          writes += 1;
          await clipboard.write(items);
          nextWrite.resolve();
        },
      },
      onError: () => nextWrite.reject(new Error('Copy link failed')),
    });
    const options = {
      window: win,
      labels,
      showInspectElement: true,
      showSaveImageAs: true,
      showCopyImage: true,
      showCopyLink: true,
      onShow() { nextMenu.resolve(this); },
    };
    let dispose = contextMenu(options);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <meta charset="utf-8">
      <p><a id="first" href="https://example.com/a%20b?q=one&amp;x=two#section">Read this</a></p>
      <p><a id="second" href="https://example.org/%E2%9C%93#two">Another link</a></p>
      <p id="plain">Plain text</p>
      <img id="image" width="32" height="32" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='red'/%3E%3C/svg%3E">
    `)}`);

    const openMenu = async (selector) => {
      nextMenu = Promise.withResolvers();
      const point = await win.webContents.executeJavaScript(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      win.focus();
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
      const menu = await nextMenu.promise;
      menu.closePopup(win);
      return menu;
    };
    const describe = (menu) => menu.items.map(({ id, label, type, enabled, visible }) => ({ id, label, type, enabled, visible }));

    const baseline = new Map();
    for (const selector of ['#first', '#plain', '#image']) {
      baseline.set(selector, describe(await openMenu(selector)));
    }
    dispose();
    dispose = contextMenu({ ...options, prepend: hook });
    for (const selector of baseline.keys()) {
      assert.deepEqual(describe(await openMenu(selector)), baseline.get(selector));
    }

    for (const [selector, locale, title, url] of [
      ['#first', 'en', 'Read this', 'https://example.com/a%20b?q=one&x=two#section'],
      ['#second', 'de', 'Another link', 'https://example.org/%E2%9C%93#two'],
    ]) {
      apply(locale);
      let nativeSelection;
      if (process.platform === 'linux') {
        // X11 can mirror ordinary clipboard writes to PRIMARY. Preserve the
        // runtime's own writeText semantics instead of restoring selection.
        await clipboard.selection.writeText('previous selection');
        await clipboard.writeText(url);
        nativeSelection = await clipboard.selection.readText();
      }
      await clipboard.writeText('previous clipboard');
      if (process.platform === 'linux') await clipboard.selection.writeText('previous selection');
      const menu = await openMenu(selector);
      assert.equal(menu.items.filter((item) => item.id === 'copyLink').length, 1);
      const item = menu.getMenuItemById('copyLink');
      assert.equal(item.label, labels.copyLink);
      nextWrite = Promise.withResolvers();
      item.click();
      await nextWrite.promise;
      assert.equal(await clipboard.readText(), url);
      if (process.platform === 'linux') {
        assert.equal(await clipboard.selection.readText(), nativeSelection);
      } else {
        const [entry] = await clipboard.read();
        assert.deepEqual(await entry.getType('electron application/bookmark'), { title, url });
      }
    }
    assert.equal(writes, 2);
    dispose();
    console.log(`PASS: real native menus, visibility/order, live locale, successive URL writes and clipboard formats on ${process.platform}, Electron ${process.versions.electron}`);
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    clearTimeout(timeout);
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    try {
      rmSync(profile, { recursive: true, force: true });
    } finally {
      app.exit(exitCode);
    }
  }
};

// Electron waits for the entry module to evaluate before emitting ready.
void run();
