import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { createThemeRuntime } from './theme-runtime.js';
import { registerSettingsUtilityRoutes, registerCommonRequestMiddleware } from './core-routes.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const definition = {
  metadata: { id: '../../escape', name: 'Imported fixture', variant: 'dark' },
  colors: {
    primary: { base: '#ffcc66' },
    surface: { background: '#111111', foreground: '#eeeeee', muted: '#181818', mutedForeground: '#999999', elevated: '#222222' },
    interactive: { border: '#333333' },
    status: { error: '#ff6666', warning: '#ffcc66', success: '#66cc66', info: '#66aaff' },
    syntax: { base: { comment: '#888888', keyword: '#aa88ff', string: '#88cc66', number: '#ffcc66', function: '#66aaff', variable: '#eeeeee', type: '#66dddd', operator: '#ff6677' } },
  },
};

async function setup(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-theme-import-'));
  directories.push(root);
  const themesDir = path.join(root, 'themes');
  const runtime = createThemeRuntime({ fsPromises: { ...fs, ...overrides }, path, themesDir, maxThemeJsonBytes: 512 * 1024, logger: console });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerSettingsUtilityRoutes(app, runtime);
  return { root, themesDir, runtime, app };
}

describe('theme import persistence', () => {
  it('deletes only imported files, leaves siblings intact and allows an identical reimport', async () => {
    const { app, runtime, themesDir } = await setup();
    const theme = await runtime.saveImportedTheme(definition);
    await fs.writeFile(path.join(themesDir, 'custom.json'), JSON.stringify(definition));
    await request(app).delete('/api/config/themes/openchamber-dark').expect(200);
    await request(app).delete(`/api/config/themes/${theme.metadata.id}`).expect(200);
    expect(await fs.readdir(themesDir)).toEqual(['custom.json']);
    await request(app).delete(`/api/config/themes/${theme.metadata.id}`).expect(200);
    expect(await runtime.saveImportedTheme(definition)).toEqual(theme);
  });

  it('does not follow a symlink during deletion or report deletion failure as success', async () => {
    const { app, root, themesDir } = await setup();
    await fs.mkdir(themesDir);
    const outside = path.join(root, 'outside.json');
    await fs.writeFile(outside, 'keep');
    const id = `imported-vscode-${'a'.repeat(24)}`;
    await fs.symlink(outside, path.join(themesDir, `${id}.json`));
    await request(app).delete(`/api/config/themes/${id}`).expect(200);
    expect(await fs.readFile(outside, 'utf8')).toBe('keep');
    const denied = await setup({ unlink: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
    await fs.mkdir(denied.themesDir);
    await fs.writeFile(path.join(denied.themesDir, `${id}.json`), JSON.stringify({ ...definition, metadata: { ...definition.metadata, id } }));
    await request(denied.app).delete(`/api/config/themes/${id}`).expect(500);
    expect(await fs.readdir(denied.themesDir)).toEqual([`${id}.json`]);
  });
  it('deletes a hand-added theme by its metadata ID, not by an assumed filename', async () => {
    const { app, themesDir } = await setup();
    await fs.mkdir(themesDir);
    const custom = { ...definition, metadata: { ...definition.metadata, id: 't3-code-dark', name: 'T3 Code' } };
    await fs.writeFile(path.join(themesDir, 'my-custom-palette.json'), JSON.stringify(custom));
    const loaded = await request(app).get('/api/config/themes').expect(200);
    expect(loaded.body.themes[0].metadata.id).toBe('t3-code-dark');
    await request(app).delete('/api/config/themes/t3-code-dark').expect(200);
    expect(await fs.readdir(themesDir)).toEqual([]);
  });

  it('refuses ambiguous duplicate IDs and does not turn an ID into a filesystem path', async () => {
    const { app, themesDir, root } = await setup();
    await fs.mkdir(themesDir);
    const custom = { ...definition, metadata: { ...definition.metadata, id: 'duplicate' } };
    for (const name of ['one.json', 'two.json']) await fs.writeFile(path.join(themesDir, name), JSON.stringify(custom));
    await request(app).delete('/api/config/themes/duplicate').expect(409);
    expect((await fs.readdir(themesDir)).sort()).toEqual(['one.json', 'two.json']);
    await fs.writeFile(path.join(root, 'outside.json'), JSON.stringify(custom));
    await request(app).delete('/api/config/themes/..%2Foutside').expect(200);
    expect(await fs.readFile(path.join(root, 'outside.json'), 'utf8')).toBe(JSON.stringify(custom));
  });

  it('allows deleting a readable theme beside an unreadable sibling, but does not treat failed reads as absence', async () => {
    const { runtime, themesDir } = await setup({ readFile: async (file, ...args) => {
      if (path.basename(file) === 'unreadable.json') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.readFile(file, ...args);
    } });
    const theme = await runtime.saveImportedTheme(definition);
    await fs.writeFile(path.join(themesDir, 'unreadable.json'), JSON.stringify(definition));
    await runtime.deleteImportedTheme(theme.metadata.id);
    expect(await fs.readdir(themesDir)).toEqual(['unreadable.json']);
    await expect(runtime.deleteImportedTheme('possibly-unreadable')).rejects.toMatchObject({ code: 'EACCES' });
  });
  it('saves through the API under a server-owned ID and returns it through reload', async () => {
    const { app, themesDir, root } = await setup();
    const response = await request(app).post('/api/config/themes').send({ theme: definition }).expect(201);
    expect(response.body.theme.metadata.id).toMatch(/^imported-vscode-[a-f0-9]{24}$/);
    expect(await fs.readdir(root)).toEqual(['themes']);
    expect(await fs.readdir(themesDir)).toEqual([`${response.body.theme.metadata.id}.json`]);
    const loaded = await request(app).get('/api/config/themes').expect(200);
    expect(loaded.body.themes).toEqual([response.body.theme]);
  });

  it('deduplicates simultaneous imports and never overwrites a subsequently edited theme', async () => {
    const { runtime, themesDir } = await setup();
    const [first, second] = await Promise.all([runtime.saveImportedTheme(definition), runtime.saveImportedTheme(definition)]);
    expect(first).toEqual(second);
    expect((await fs.readdir(themesDir)).length).toBe(1);
    const filename = path.join(themesDir, `${first.metadata.id}.json`);
    await fs.writeFile(filename, 'manually edited');
    await expect(runtime.saveImportedTheme(definition)).rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect(await fs.readFile(filename, 'utf8')).toBe('manually edited');
    expect(await fs.readdir(themesDir)).toEqual([`${first.metadata.id}.json`]);
  });

  it('rejects malformed definitions and unsafe token names without creating files', async () => {
    const { app, root } = await setup();
    await request(app).post('/api/config/themes').send({ theme: { ...definition, colors: {} } }).expect(400);
    await request(app).post('/api/config/themes').send({ theme: { ...definition, colors: { ...definition.colors, syntax: { ...definition.colors.syntax, tokens: { 'x;body': '#000000' } } } } }).expect(400);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('cleans temporary files after a publication failure', async () => {
    const { runtime, themesDir } = await setup({ link: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
    await expect(runtime.saveImportedTheme(definition)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await fs.readdir(themesDir)).toEqual([]);
  });

  it('does not report a directory read failure as an empty theme library', async () => {
    const { runtime } = await setup({ readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
    await expect(runtime.readCustomThemesFromDisk()).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('rejects oversized imports without touching the themes directory', async () => {
    const { runtime, root } = await setup();
    const tokens = Object.fromEntries(Array.from({ length: 30000 }, (_, index) => [`token${index}`, '#123456']));
    await expect(runtime.saveImportedTheme({ ...definition, colors: { ...definition.colors, syntax: { ...definition.colors.syntax, tokens } } })).rejects.toMatchObject({ code: 'size', status: 413 });
    expect(await fs.readdir(root)).toEqual([]);
  });
});
