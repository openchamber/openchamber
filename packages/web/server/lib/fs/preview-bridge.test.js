import { describe, expect, it } from 'vitest';

import { injectPreviewBridge } from './preview-bridge.js';

const BRIDGE_START = '<script data-openchamber-preview-bridge>';

const inject = (html) => injectPreviewBridge(Buffer.from(html, 'latin1')).toString('latin1');

describe('injectPreviewBridge', () => {
  it('puts the bridge first in the head', () => {
    const page = inject('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title></head></html>');
    expect(page.startsWith(`<!doctype html><html lang="en"><head>${BRIDGE_START}`)).toBe(true);
    expect(page).toContain('</script><meta charset="utf-8">');
  });

  it('never goes before the doctype, which would switch the page to quirks mode', () => {
    expect(inject('<!DOCTYPE html><p>hi</p>').startsWith(`<!DOCTYPE html>${BRIDGE_START}`)).toBe(true);
    expect(inject('<html><body>hi</body></html>').startsWith(`<html>${BRIDGE_START}`)).toBe(true);
    expect(inject('<p>fragment</p>').startsWith(BRIDGE_START)).toBe(true);
  });

  it('does not take a <header> for the head', () => {
    const page = inject('<body><header>top</header></body>');
    expect(page.startsWith(BRIDGE_START)).toBe(true);
  });

  it('keeps the page bytes in any ASCII-compatible encoding', () => {
    const cp1251 = Buffer.from([0x3c, 0x68, 0x65, 0x61, 0x64, 0x3e, 0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2]);
    const result = injectPreviewBridge(cp1251);
    expect(result.subarray(result.length - 6)).toEqual(cp1251.subarray(6));
    expect(result.subarray(0, 6)).toEqual(cp1251.subarray(0, 6));
  });

  it('keeps a UTF-8 byte order mark first and leaves UTF-16 pages alone', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>x</p>')]);
    expect(injectPreviewBridge(withBom).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const utf16 = Buffer.from([0xff, 0xfe, 0x3c, 0x00]);
    expect(injectPreviewBridge(utf16)).toBe(utf16);
  });
});

describe('storage in a page without an origin', () => {
  const run = (page) => {
    const script = /<script data-openchamber-preview-bridge>([\s\S]*?)<\/script>/.exec(inject('<p>x</p>'))[1];
    page.window.parent = page.window;
    new Function('window', 'document', script)(page.window, page.document);
    return page;
  };
  const denied = (target, name) => Object.defineProperty(target, name, {
    get() { throw new Error('SecurityError'); }, configurable: true,
  });

  it('works in memory where the browser denies it', () => {
    const { window, document } = run({
      window: denied(denied({}, 'localStorage'), 'sessionStorage'), document: denied({}, 'cookie'),
    });
    const storage = window.localStorage;
    expect(storage.getItem('theme')).toBeNull();
    storage.setItem('theme', 1);
    storage.size = 'big';
    expect([storage.theme, storage.getItem('size'), storage.length, storage.key(0)]).toEqual(['1', 'big', 2, 'theme']);
    expect(Object.keys(storage)).toEqual(['theme', 'size']);
    delete storage.size;
    expect('size' in storage).toBe(false);
    expect(window.sessionStorage.length).toBe(0);
    storage.clear();
    expect(storage.length).toBe(0);
    document.cookie = 'a=1';
    expect(document.cookie).toBe('');
  });

  it('leaves working storage alone', () => {
    const real = {};
    expect(run({ window: { localStorage: real, sessionStorage: real }, document: { cookie: 'a=1' } }).window.localStorage).toBe(real);
  });
});
