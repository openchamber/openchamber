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
