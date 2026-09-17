import { describe, expect, test } from 'bun:test';
import { crc32 } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { extractZipBuffer, unwrapGuestRoot } from './extract-zip.js';

const u16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};

const u32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};

/** Store-only zip. Used by install tests too. */
export const buildStoreZip = (files) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, central, eocd]);
};

describe('extractZipBuffer', () => {
  test('extracts files and rejects traversal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-zip-'));
    const ok = await extractZipBuffer(buildStoreZip([
      { name: 'package.json', data: '{"ok":true}' },
      { name: 'panel/index.html', data: '<html></html>' },
    ]), dir);
    expect(ok).toEqual({ ok: true });
    expect(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).toBe('{"ok":true}');
    expect(await fs.readFile(path.join(dir, 'panel', 'index.html'), 'utf8')).toBe('<html></html>');

    const escapeDir = path.join(dir, 'escape');
    const escaped = await extractZipBuffer(buildStoreZip([
      { name: '../secret', data: 'nope' },
    ]), escapeDir);
    expect(escaped).toEqual({ ok: false, code: 'extract-failed' });

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('unwraps a single root folder', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-zip-'));
    await fs.mkdir(path.join(dir, 'panel-root', 'panel'), { recursive: true });
    await fs.writeFile(path.join(dir, 'panel-root', 'package.json'), '{}');
    expect(await unwrapGuestRoot(dir)).toBe(path.join(dir, 'panel-root'));
    await fs.rm(dir, { recursive: true, force: true });
  });
});
