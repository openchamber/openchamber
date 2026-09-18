import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { createThemeCatalog, registerThemeCatalogRoutes } from './theme-catalog.js';
import { registerCommonRequestMiddleware } from './core-routes.js';
import express from 'express';
import request from 'supertest';
import { openThemeArchive } from './theme-archive.js';

function archive(files) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [filename, content] of Object.entries(files)) {
    const name = Buffer.from(filename);
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

const identity = { namespace: 'Author', name: 'fixture', version: '1.0.0' };
const manifest = { publisher: 'Author', name: 'fixture', version: '1.0.0', contributes: { themes: [
  { label: 'Readable Night', path: './themes/night.json', uiTheme: 'vs-dark' },
  { label: 'Broken sibling', path: '../../outside.json', uiTheme: 'vs' },
] } };
const packageFiles = {
  'extension/package.json': JSON.stringify(manifest),
  'extension/base.json': '{"colors":{"editor.background":"#111111","editor.foreground":"#eeeeee"},"tokenColors":[{"scope":"string","settings":{"foreground":"#aaaaaa"}}]}',
  'extension/themes/night.json': '{ // JSONC\n"include":"../base.json", "colors":{"editor.foreground":"#ffffff"},"tokenColors":"./tokens.json",}',
  'extension/themes/tokens.json': '[{"scope":"keyword","settings":{"foreground":"#aabbcc"}}]',
};

function transport(bytes, overrides = {}) {
  const responses = new Map([
    ['https://open-vsx.org/api/Author/fixture/1.0.0', JSON.stringify({ ...identity, files: { download: 'https://open-vsx.org/package.vsix', sha256: 'https://open-vsx.org/package.sha256' } })],
    ['https://open-vsx.org/package.vsix', bytes],
    ['https://open-vsx.org/package.sha256', createHash('sha256').update(bytes).digest('hex')],
    ...Object.entries(overrides),
  ]);
  return async (url) => {
    const body = responses.get(url.href);
    if (body === undefined) throw new Error(`Unexpected request ${url}`);
    return new Response(body);
  };
}

describe('Open VSX theme catalog', () => {
  test('catalog requests retain their bodies through the production middleware', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    const catalog = createThemeCatalog({ fetchImpl: transport(archive(packageFiles)) });
    registerThemeCatalogRoutes(app, {
      search: async (input) => { expect(input).toEqual({ query: 'nord' }); return []; },
      readPackage: catalog.readPackage,
    });
    await request(app).post('/api/config/themes/catalog/search').send({ query: 'nord' }).expect(200);
    const response = await request(app).post('/api/config/themes/catalog/package').send(identity).expect(200);
    expect(response.body.items[0].name).toBe('Readable Night');
  });
  test('resolves JSONC includes and external token files, preserving healthy siblings and manifest labels', async () => {
    const catalog = createThemeCatalog({ fetchImpl: transport(archive(packageFiles)) });
    const result = await catalog.readPackage(identity);
    expect(result[0].error).toBe(false);
    const source = JSON.parse(result[0].text);
    expect(source.name).toBe('Readable Night');
    expect(source.type).toBe('dark');
    expect(source.colors).toEqual({ 'editor.background': '#111111', 'editor.foreground': '#ffffff' });
    expect(source.tokenColors.map((rule) => rule.scope)).toEqual(['string', 'keyword']);
    expect(source.include).toBeUndefined();
    expect(result[1].error).toBe(true);
  });

  test('rejects checksum and package identity mismatches', async () => {
    const bytes = archive(packageFiles);
    await expect(createThemeCatalog({ fetchImpl: transport(bytes, { 'https://open-vsx.org/package.sha256': '0'.repeat(64) }) }).readPackage(identity)).rejects.toThrow('checksum');
    const wrong = archive({ ...packageFiles, 'extension/package.json': JSON.stringify({ ...manifest, publisher: 'Impostor' }) });
    await expect(createThemeCatalog({ fetchImpl: transport(wrong) }).readPackage(identity)).rejects.toThrow('identity');
  });

  test('limits decompression and rejects traversal and cyclic includes', async () => {
    expect(() => openThemeArchive(archive({ '../outside.json': '{}' }))).toThrow('Unsafe');
    const read = openThemeArchive(archive({ 'extension/huge.json': ' '.repeat(512 * 1024 + 1) }));
    await expect(read('extension/huge.json')).rejects.toThrow('large');
    const cyclic = archive({ ...packageFiles, 'extension/base.json': '{"include":"./themes/night.json"}' });
    expect((await createThemeCatalog({ fetchImpl: transport(cyclic) }).readPackage(identity))[0].error).toBe(true);
  });

  test('searches only the theme category and rejects redirects outside the catalog', async () => {
    const catalog = createThemeCatalog({ fetchImpl: async (url, options) => {
      expect(url.searchParams.get('category')).toBe('Themes');
      expect(url.searchParams.get('query')).toBe('Dune');
      expect(options.redirect).toBe('manual');
      return Response.json({ extensions: [{ ...identity, displayName: 'Dune', files: {} }] });
    } });
    expect((await catalog.search({ query: 'Dune' }))[0].label).toBe('Dune');
    let calls = 0;
    const hostile = createThemeCatalog({ fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); } });
    await expect(hostile.search({ query: 'Dune' })).rejects.toThrow('host');
    expect(calls).toBe(1);
    await expect(catalog.readPackage({ ...identity, name: '../secret' })).rejects.toThrow();
  });
});
