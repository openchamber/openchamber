import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsFileState } from './settings-file-state.js';
import { folderWatchHarness } from '../fs/folder-watch-test-helpers.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixture = async ({ onChange, readFile = fs.readFile } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-settings-watch-'));
  const settingsFilePath = path.join(root, 'settings.json');
  const preferencesFilePath = path.join(root, 'preferences.json');
  await fs.writeFile(settingsFilePath, JSON.stringify({ lightThemeId: 'first' }));
  await fs.writeFile(preferencesFilePath, JSON.stringify({ version: 1, fields: {
    darkThemeId: { value: 'first', updatedAt: 1 },
  } }));
  let reads = 0;
  const state = createSettingsFileState({
    fsPromises: { ...fs, readFile: (...args) => { reads++; return readFile(...args); } },
    path, settingsFilePath, preferencesFilePath,
    sanitizeSettingsUpdate: (document) => Object.fromEntries(Object.entries(document).filter(([, value]) => typeof value === 'string')),
    logger: { warn: () => {} },
  });
  const clock = folderWatchHarness();
  const changes = [];
  const watch = state.watch({ onChange: async (change) => { await onChange?.(change); changes.push(change); }, fsWatch: clock.fsWatch, timers: clock.timers });
  await watch.ready;
  cleanups.push(async () => {
    watch.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const settle = async () => { await watch.check(); await watch.check(); };
  return { root, settingsFilePath, preferencesFilePath, state, watch, clock, changes, reads: () => reads, settle };
};

describe('settings file state', () => {
  it('does not let a late publication acknowledgment replace a newer externally read snapshot', async () => {
    const { state, settingsFilePath, settle, changes } = await fixture();
    const revision = state.getRevision('settings');
    await fs.writeFile(settingsFilePath, '{"lightThemeId":"newer"}');
    await state.read('settings');
    state.acknowledge(settingsFilePath, '{"lightThemeId":"first"}', { expectedRevision: revision });
    await fs.writeFile(settingsFilePath, '{');
    expect((await state.read('settings')).document.lightThemeId).toBe('newer');
    await fs.writeFile(settingsFilePath, '{"lightThemeId":"newer"}');
    await settle();
    expect(changes).toEqual([{ source: 'settings', changedKeys: ['lightThemeId'] }]);
  });
  it('retains native-shell fields without applying the UI settings-write validator to them', async () => {
    const { settingsFilePath, state, changes, settle } = await fixture();
    await fs.writeFile(settingsFilePath, '{"lightThemeId":"first","desktopLocalPort":1234,"desktopDefaultHostId":"local"}');
    await settle();
    expect((await state.read('settings')).status).toBe('ok');
    expect((await state.read('settings')).document.desktopLocalPort).toBe(1234);
    expect(changes).toEqual([]);
  });
  it('ignores key order and formatting changes within preference fields', async () => {
    const { preferencesFilePath, changes, settle } = await fixture();
    await fs.writeFile(preferencesFilePath, '{ "fields": { "darkThemeId": { "updatedAt": 1, "value": "first" } }, "version": 1 }');
    await settle();
    expect(changes).toEqual([]);
  });

  it('retries a failed publication rather than accepting it as delivered', async () => {
    let attempts = 0;
    const { settingsFilePath, watch, changes } = await fixture({ onChange: () => {
      if (++attempts === 1) throw new Error('Publication failed');
    } });
    await fs.writeFile(settingsFilePath, '{"lightThemeId":"second"}');
    await watch.check();
    await watch.check();
    expect(changes).toEqual([]);
    await watch.check();
    expect(attempts).toBe(2);
    expect(changes).toEqual([{ source: 'settings', changedKeys: ['lightThemeId'] }]);
  });

  it('stops before notifying another source while a callback is in flight', async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let attempts = 0;
    const { settingsFilePath, preferencesFilePath, watch, clock } = await fixture({ onChange: async () => {
      attempts++;
      entered.resolve();
      await release.promise;
    } });
    await fs.writeFile(settingsFilePath, '{"lightThemeId":"second"}');
    await fs.writeFile(preferencesFilePath, '{"version":1,"fields":{"darkThemeId":{"value":"second","updatedAt":2}}}');
    await watch.check();
    const check = watch.check();
    await entered.promise;
    watch.stop();
    release.resolve();
    await check;
    expect(attempts).toBe(1);
    expect(clock.jobs.size).toBe(0);
  });

  it('does not replace an acknowledged publication with an older read completion', async () => {
    let blocked = false;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const { state, settingsFilePath } = await fixture({ readFile: async (...args) => {
      const text = await fs.readFile(...args);
      if (blocked) { entered.resolve(); await release.promise; }
      return text;
    } });
    blocked = true;
    const pending = state.read('settings');
    await entered.promise;
    const text = '{"lightThemeId":"published"}';
    await fs.writeFile(settingsFilePath, text);
    state.acknowledge(settingsFilePath, text);
    release.resolve();
    expect((await pending).document).toEqual({ lightThemeId: 'published' });
  });

  it('announces settled external changes from both files without values or unknown keys', async () => {
    const { settingsFilePath, preferencesFilePath, changes, settle } = await fixture();
    await fs.writeFile(settingsFilePath, JSON.stringify({ lightThemeId: 'second', privateUnknownField: 'not sent', constructor: 'not sent' }));
    await fs.writeFile(preferencesFilePath, JSON.stringify({ version: 1, fields: {
      darkThemeId: { surfaces: { desktop: { value: 'second', updatedAt: 2 } } },
    } }));
    await settle();
    expect(changes).toEqual([
      { source: 'settings', changedKeys: ['lightThemeId'] },
      { source: 'preferences', changedKeys: ['darkThemeId'] },
    ]);
    await settle();
    expect(changes).toHaveLength(2);
  });

  it('keeps each last valid document during partial, invalid and missing-after-valid saves', async () => {
    const { settingsFilePath, preferencesFilePath, state, changes, settle } = await fixture();
    for (const text of ['{', 'null', '[]', '{"lightThemeId":false}']) {
      await fs.writeFile(settingsFilePath, text);
      await settle();
      expect((await state.read('settings')).document).toEqual({ lightThemeId: 'first' });
    }
    await fs.writeFile(preferencesFilePath, '{"version":2,"fields":{}}');
    await settle();
    expect((await state.read('preferences')).document.darkThemeId.value).toBe('first');
    await fs.rm(settingsFilePath);
    await settle();
    expect((await state.read('settings')).status).toBe('failed');
    expect(changes).toEqual([]);
    await fs.writeFile(settingsFilePath, '{"lightThemeId":"recovered"}');
    await settle();
    expect(changes).toEqual([{ source: 'settings', changedKeys: ['lightThemeId'] }]);
  });

  it('suppresses the exact app publication without hiding a change to the other file', async () => {
    const { settingsFilePath, preferencesFilePath, state, changes, settle } = await fixture();
    const own = '{"lightThemeId":"own"}';
    await fs.writeFile(settingsFilePath, own);
    state.acknowledge(settingsFilePath, own);
    await fs.writeFile(preferencesFilePath, JSON.stringify({ version: 1, fields: {
      darkThemeId: { value: 'external', updatedAt: 2 },
    } }));
    await settle();
    expect(changes).toEqual([{ source: 'preferences', changedKeys: ['darkThemeId'] }]);
    await fs.writeFile(settingsFilePath, '{"lightThemeId":"external"}');
    await settle();
    expect(changes[1]).toEqual({ source: 'settings', changedKeys: ['lightThemeId'] });
  });

  it('does no idle disk work until the safety check and stops all scheduled work', async () => {
    const { state, clock, changes, reads, settingsFilePath, watch } = await fixture();
    const baseline = reads();
    await clock.advance(29_000);
    expect(reads()).toBe(baseline);
    await clock.advance(1000);
    expect(reads()).toBe(baseline + 2);
    const document = (await state.read('settings')).document;
    document.lightThemeId = 'caller mutation';
    expect((await state.read('settings')).document.lightThemeId).toBe('first');
    watch.stop();
    await fs.writeFile(settingsFilePath, '{"lightThemeId":"late"}');
    await clock.advance(60_000);
    expect(changes).toEqual([]);
    expect(clock.jobs.size).toBe(0);
  });

  it('does not settle a valid intermediate save after the file becomes invalid', async () => {
    const { settingsFilePath, changes, watch } = await fixture();
    await fs.writeFile(settingsFilePath, '{"lightThemeId":"intermediate"}');
    await watch.check();
    await fs.writeFile(settingsFilePath, '{');
    await watch.check();
    await watch.check();
    expect(changes).toEqual([]);
  });
});
