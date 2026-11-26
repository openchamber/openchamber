import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { createNotificationEmitterRuntime } from '../notifications/emitter-runtime.js';
import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';
import { createSettingsRuntime } from './settings-runtime.js';

const createRuntime = async ({
  mergePersistedSettings = (_current, changes) => changes,
  onManagedPluginSettingsChanged = undefined,
  onPermissionDefaultModeChanged = undefined,
  onLastDirectoryChanged = undefined,
  onMessageSearchEnabledChanged = undefined,
  chatRoots = undefined,
  fs = fsPromises,
  syncManagedRemoteTunnelConfigWithPresets = async () => {},
  settingsFilePath: sharedSettingsFilePath = undefined,
  refreshCanonicalPaths = undefined,
} = {}) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
  const settingsFilePath = sharedSettingsFilePath ?? path.join(tempRoot, 'settings.json');
  const runtime = createSettingsRuntime({
    fsPromises: fs,
    path,
    crypto,
    SETTINGS_FILE_PATH: settingsFilePath,
    sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
    sanitizeSettingsUpdate: (settings) => settings,
    mergePersistedSettings,
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
    formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelPresetTokens: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken: async () => {},
    chatRoots,
    refreshCanonicalPaths,
    onManagedPluginSettingsChanged,
    onPermissionDefaultModeChanged,
    onLastDirectoryChanged,
    onMessageSearchEnabledChanged,
  });

  return {
    runtime,
    settingsFilePath,
    tempRoot,
    cleanup: async () => {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    },
  };
};

describe('settings runtime', () => {
  it('restores default-enabled search when a save or external edit removes its opt-out', async () => {
    const changed = vi.fn();
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
      onMessageSearchEnabledChanged: changed,
    });
    try {
      await runtime.persistSettings({ messageSearchEnabled: false });
      await runtime.persistSettings({ messageSearchEnabled: undefined });
      expect(changed.mock.calls.map(([enabled]) => enabled)).toEqual([false, true]);
      await runtime.persistSettings({ messageSearchEnabled: false });
      changed.mockClear();
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      delete settings.messageSearchEnabled;
      await fsPromises.writeFile(settingsFilePath, JSON.stringify(settings));
      await runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['messageSearchEnabled'] });
      expect(changed).toHaveBeenCalledExactlyOnceWith(true);
    } finally { await cleanup(); }
  });
  it('delivers reconciled filesystem changes over the authenticated control stream', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    });
    const clients = new Set();
    const auth = createUiAuth({
      requireClientAuth: true,
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'fixture-client' ? { ok: true, clientId: 'fixture' } : null,
      },
    });
    const emitter = createNotificationEmitterRuntime({
      process,
      getDesktopNotifyEnabled: () => false,
      desktopNotifyPrefix: '',
      getUiNotificationClients: () => new Set(),
      getOpenChamberEventClients: () => clients,
    });
    const app = express();
    app.use('/api', auth.requireAuth);
    registerScheduledTaskRoutes(app, {
      getOpenChamberEventClients: () => clients,
      writeSseEvent: emitter.writeSseEvent,
    });
    const server = createServer(app);
    const abort = new AbortController();
    const announced = [];
    let watch;
    try {
      await runtime.persistSettings({ lightThemeId: 'initial', themeId: 'selected' });
      watch = runtime.watchSettingsFiles({ pollMs: 20, onChange: async (properties) => {
        const changes = await runtime.reconcileExternalSettings(properties);
        announced.push(...changes);
        for (const change of changes) {
          for (const client of clients) emitter.writeSseEvent(client, { type: 'openchamber:settings-changed', properties: change });
        }
      } });
      await watch.ready;
      await new Promise((resolve) => server.listen(0, 'localhost', resolve));
      const base = `http://localhost:${server.address().port}`;
      expect((await fetch(`${base}/api/openchamber/events`)).status).toBe(401);
      const response = await fetch(`${base}/api/openchamber/events`, {
        headers: { Authorization: 'Bearer fixture-client' }, signal: abort.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('openchamber:event-stream-ready');
      const events = [];
      const collect = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          events.push(new TextDecoder().decode(value));
        }
      })();
      await runtime.persistSettings({ lastDirectory: '/own' });
      await watch.check();
      await watch.check();
      expect(announced).toEqual([]);
      expect(events).toEqual([]);
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      await fsPromises.writeFile(settingsFilePath, '{');
      await watch.check();
      await watch.check();
      expect(announced).toEqual([]);
      expect(events).toEqual([]);
      expect((await runtime.readSettingsFromDisk()).themeId).toBe('selected');
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...settings, lightThemeId: 'external' }));
      await vi.waitFor(() => expect(events.join('')).toContain('"source":"settings"'));
      expect(events.join('')).toContain('"changedKeys":["lightThemeId"]');
      expect(events.join('')).not.toContain('"external"');
      expect((await runtime.readSettingsFromDisk()).lightThemeId).toBe('external');
      expect((await runtime.readSettingsFromDisk()).themeId).toBeUndefined();
      events.length = 0;
      const preferencesFilePath = path.join(tempRoot, 'preferences.json');
      const preferences = JSON.parse(await fsPromises.readFile(preferencesFilePath, 'utf8'));
      preferences.fields.lightThemeId.value = 'preference-edit';
      await fsPromises.writeFile(preferencesFilePath, JSON.stringify(preferences));
      await vi.waitFor(() => expect(events.join('')).toContain('"source":"preferences"'));
      expect((await runtime.readSettingsFromDisk()).lightThemeId).toBe('preference-edit');
      await reader.cancel();
      await collect;
    } finally {
      watch?.stop();
      abort.abort();
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      auth.dispose();
      await cleanup();
    }
  });
  it('retains an explicit selection when a legacy palette key is omitted', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    const events = [];
    let watch;
    const retained = {
      themeId: 'openchamber-dark', useSystemTheme: false, themeVariant: 'light',
      lightThemeId: 'openchamber-light', darkThemeId: 'openchamber-dark',
    };
    try {
      await runtime.persistSettings(retained);
      const preferencesBefore = JSON.parse(await fsPromises.readFile(path.join(tempRoot, 'preferences.json'), 'utf8'));
      watch = runtime.watchSettingsFiles({ onChange: async (change) => { await runtime.reconcileExternalSettings(change); events.push(change); } });
      await watch.ready;
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      delete settings.lightThemeId;
      await fsPromises.writeFile(settingsFilePath, JSON.stringify(settings));
      await watch.check();
      await watch.check();
      expect(events).toEqual([{ source: 'settings', changedKeys: ['lightThemeId'] }]);
      expect(await runtime.readSettingsFromDisk()).toMatchObject(retained);
      const preferencesAfter = JSON.parse(await fsPromises.readFile(path.join(tempRoot, 'preferences.json'), 'utf8'));
      expect(preferencesAfter.fields.themeId).toEqual(preferencesBefore.fields.themeId);
    } finally { watch?.stop(); await cleanup(); }
  });

  describe('a save through the app while the files change outside', () => {
    const merging = (options = {}) => createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }), ...options });
    const read = async (file) => JSON.parse(await fsPromises.readFile(file, 'utf8'));
    const write = (file, document) => fsPromises.writeFile(file, JSON.stringify(document));
    const editPreference = async (file, key, value) => {
      const document = await read(file);
      document.fields[key] = { value, updatedAt: 2 };
      await write(file, document);
    };

    it('takes in edits of both files, applies the user change on top and announces the edits', async () => {
      const changed = vi.fn();
      const announced = [];
      const { runtime, settingsFilePath, tempRoot, cleanup } = await merging({ onMessageSearchEnabledChanged: changed });
      const preferencesFile = path.join(tempRoot, 'preferences.json');
      try {
        await runtime.persistSettings({ messageSearchEnabled: false, lightThemeId: 'old', darkThemeId: 'old', fontSize: 100 });
        changed.mockClear();
        runtime.subscribeTakenInSettings((changes) => announced.push(...changes));
        await editPreference(preferencesFile, 'lightThemeId', 'outside-light');
        await write(settingsFilePath, { ...await read(settingsFilePath), darkThemeId: 'outside-dark', desktopLocalPort: 4321 });
        await runtime.persistSettings({ messageSearchEnabled: true, fontSize: 120 });
        const expected = { messageSearchEnabled: true, fontSize: 120, lightThemeId: 'outside-light', darkThemeId: 'outside-dark', desktopLocalPort: 4321 };
        expect(await runtime.readSettingsFromDisk()).toMatchObject(expected);
        expect(await read(settingsFilePath)).toMatchObject(expected);
        expect(changed).toHaveBeenCalledExactlyOnceWith(true);
        expect(announced).toEqual(expect.arrayContaining([
          expect.objectContaining({ source: 'settings', changedKeys: ['darkThemeId'] }),
          expect.objectContaining({ source: 'preferences', changedKeys: ['lightThemeId'] }),
        ]));
      } finally { await cleanup(); }
    });

    it('keeps a project added outside while folders are checked at startup', async () => {
      let settingsFile;
      const created = await createRuntime({
        refreshCanonicalPaths: async () => {
          if (!settingsFile) return;
          const file = settingsFile;
          settingsFile = undefined;
          await write(file, { ...await read(file), projects: [{ id: 'outside', path: os.tmpdir() }] });
        },
      });
      try {
        await write(created.settingsFilePath, { approvedDirectories: ['/tmp'], projects: [] });
        settingsFile = created.settingsFilePath;
        await created.runtime.readSettingsFromDiskMigrated();
        const saved = await read(created.settingsFilePath);
        expect(saved.projects).toHaveLength(1);
        expect(saved.approvedDirectories).toBeUndefined();
      } finally {
        await created.cleanup();
      }
    });

    it('keeps the user key when the legacy copy is edited outside before the profile is published', async () => {
      let intercept = false;
      const created = await merging({ fs: { ...fsPromises, writeFile: async (file, text, options) => {
        await fsPromises.writeFile(file, text, options);
        if (intercept && path.basename(file).startsWith('preferences.json.tmp-')) {
          intercept = false;
          await write(created.settingsFilePath, { ...await read(created.settingsFilePath), lightThemeId: 'outside' });
        }
      } } });
      try {
        await created.runtime.persistSettings({ lightThemeId: 'old' });
        intercept = true;
        await created.runtime.persistSettings({ lightThemeId: 'mine' });
        await created.runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['lightThemeId'] });
        expect((await created.runtime.readSettingsFromDisk()).lightThemeId).toBe('mine');
      } finally { await created.cleanup(); }
    });

    it('keeps a surface override when another server changes the base and this one saves something else', async () => {
      const first = await merging();
      const second = await merging({ settingsFilePath: first.settingsFilePath });
      try {
        await first.runtime.persistSettings({ lightThemeId: 'base', lastDirectory: '/one' });
        await first.runtime.persistSettings({ lightThemeId: 'desktop' }, { surface: 'desktop' });
        await second.runtime.persistSettings({ lastDirectory: '/two' });
        await second.runtime.persistSettings({ messageSearchEnabled: false });
        await first.runtime.persistSettings({ lightThemeId: 'new-base' });
        await second.runtime.persistSettings({ lastDirectory: '/three' });
        expect((await second.runtime.readSettingsFromDisk({ surface: 'desktop' })).lightThemeId).toBe('desktop');
        expect((await second.runtime.readSettingsFromDisk()).lightThemeId).toBe('new-base');
      } finally { await first.cleanup(); await second.cleanup(); }
    });

    it.each(['preferences.json', 'settings.json'])('names the refused keys and applies the instance change when the profile breaks while %s is written', async (written) => {
      const changed = vi.fn();
      let intercept = false;
      const created = await merging({ onPermissionDefaultModeChanged: changed, fs: { ...fsPromises, writeFile: async (file, text, options) => {
        await fsPromises.writeFile(file, text, options);
        if (intercept && path.basename(file).startsWith(`${written}.tmp-`)) {
          intercept = false;
          await fsPromises.writeFile(path.join(created.tempRoot, 'preferences.json'), '{broken');
        }
      } } });
      try {
        await created.runtime.persistSettings({ lightThemeId: 'old', permissionDefaultMode: 'ask' });
        changed.mockClear();
        intercept = true;
        await expect(created.runtime.persistSettings({ lightThemeId: 'mine', permissionDefaultMode: 'auto', lastDirectory: '/mine' })).rejects.toThrow('not saved: lightThemeId');
        expect(changed).toHaveBeenCalledExactlyOnceWith('auto');
        expect(await read(created.settingsFilePath)).toMatchObject({ lightThemeId: 'old', permissionDefaultMode: 'auto', lastDirectory: '/mine' });
        expect(await fsPromises.readFile(path.join(created.tempRoot, 'preferences.json'), 'utf8')).toBe('{broken');
      } finally { await created.cleanup(); }
    });

    it.each(['missing', 'broken'])('does not report a save as done when settings.json is %s by the time the profile is published', async (state) => {
      let intercept = false;
      const created = await merging({ fs: { ...fsPromises, writeFile: async (file, text, options) => {
        await fsPromises.writeFile(file, text, options);
        if (intercept && path.basename(file).startsWith('preferences.json.tmp-')) {
          intercept = false;
          if (state === 'missing') await fsPromises.rm(created.settingsFilePath);
          else await fsPromises.writeFile(created.settingsFilePath, '{broken');
        }
      } } });
      try {
        await created.runtime.persistSettings({ lightThemeId: 'old', lastDirectory: '/old' });
        intercept = true;
        const save = created.runtime.persistSettings({ lightThemeId: 'mine', lastDirectory: '/mine' });
        if (state === 'missing') {
          await save;
          expect(await read(created.settingsFilePath)).toMatchObject({ lightThemeId: 'mine', lastDirectory: '/mine' });
        } else {
          await expect(save).rejects.toThrow('unreadable settings.json');
          expect(await fsPromises.readFile(created.settingsFilePath, 'utf8')).toBe('{broken');
        }
      } finally { await created.cleanup(); }
    });

    it('does not drop a profile change when another read finds the profile broken during the save', async () => {
      const created = await merging({ syncManagedRemoteTunnelConfigWithPresets: async () => {
        await fsPromises.writeFile(path.join(created.tempRoot, 'preferences.json'), '{broken');
        await created.runtime.readSettingsFromDisk();
      } });
      try {
        await created.runtime.persistSettings({ lightThemeId: 'old' });
        await expect(created.runtime.persistSettings({ lightThemeId: 'mine', managedRemoteTunnelPresets: [] })).rejects.toThrow('not saved: lightThemeId');
      } finally { await created.cleanup(); }
    });

    it('does not remove the temporary file of a save another server is making', async () => {
      const { runtime, tempRoot, cleanup } = await merging();
      try {
        const active = path.join(tempRoot, `settings.json.tmp-1-${Date.now()}-active`);
        const abandoned = path.join(tempRoot, `settings.json.tmp-1-${Date.now() - 120_000}-old`);
        await Promise.all([active, abandoned].map((file) => fsPromises.writeFile(file, '{}')));
        await runtime.readSettingsFromDiskMigrated();
        expect((await fsPromises.readdir(tempRoot)).filter((name) => name.includes('.tmp-'))).toEqual([path.basename(active)]);
      } finally { await cleanup(); }
    });

    it('lets the user key win over an outside edit of the same key', async () => {
      const { runtime, tempRoot, cleanup } = await merging();
      try {
        await runtime.persistSettings({ lightThemeId: 'old' });
        await editPreference(path.join(tempRoot, 'preferences.json'), 'lightThemeId', 'outside');
        await runtime.persistSettings({ lightThemeId: 'mine' });
        expect((await runtime.readSettingsFromDisk()).lightThemeId).toBe('mine');
      } finally { await cleanup(); }
    });

    it.each(['settings.json', 'preferences.json'])('starts over when the profile is edited outside while %s is being written', async (written) => {
      let intercept = false;
      const created = await merging({ fs: { ...fsPromises, writeFile: async (file, text, options) => {
        await fsPromises.writeFile(file, text, options);
        if (intercept && path.basename(file).startsWith(`${written}.tmp-`)) {
          intercept = false;
          await editPreference(path.join(created.tempRoot, 'preferences.json'), 'darkThemeId', 'outside-dark');
        }
      } } });
      try {
        await created.runtime.persistSettings({ lightThemeId: 'old', darkThemeId: 'old' });
        intercept = true;
        await created.runtime.persistSettings({ lightThemeId: 'mine' });
        const expected = { lightThemeId: 'mine', darkThemeId: 'outside-dark' };
        expect(intercept).toBe(false);
        expect(await created.runtime.readSettingsFromDisk()).toMatchObject(expected);
        expect(await read(created.settingsFilePath)).toMatchObject(expected);
      } finally { await created.cleanup(); }
    });

    it.each(['preferences.json', 'settings.json'])('restores a missing %s from its last valid content with the user change', async (missing) => {
      const { runtime, settingsFilePath, tempRoot, cleanup } = await merging();
      const preferencesFile = path.join(tempRoot, 'preferences.json');
      try {
        await runtime.persistSettings({ lightThemeId: 'kept', lastDirectory: '/kept' });
        await runtime.persistSettings({ themeId: 'desktop-kept' }, { surface: 'desktop' });
        await fsPromises.rm(path.join(tempRoot, missing));
        await runtime.persistSettings({ darkThemeId: 'mine', desktopKeepAwakeEnabled: true });
        expect((await read(preferencesFile)).fields).toMatchObject({ lightThemeId: { value: 'kept' }, darkThemeId: { value: 'mine' }, themeId: { surfaces: { desktop: { value: 'desktop-kept' } } } });
        expect(await read(settingsFilePath)).toMatchObject({ lastDirectory: '/kept', desktopKeepAwakeEnabled: true, darkThemeId: 'mine' });
      } finally { await cleanup(); }
    });

    it('registers a project without losing settings while settings.json is missing or just edited', async () => {
      const { runtime, settingsFilePath, cleanup } = await merging();
      try {
        await runtime.persistSettings({ lastDirectory: '/kept' });
        await fsPromises.rm(settingsFilePath);
        await runtime.registerSessionProject(async () => ({ id: 'one', path: '/one' }));
        await write(settingsFilePath, { ...await read(settingsFilePath), messageSearchEnabled: false });
        await runtime.registerSessionProject(async () => ({ id: 'two', path: '/two' }));
        await runtime.updateSettingsFromDisk((current) => ({ ...current, lastDirectory: '/new' }));
        expect(await read(settingsFilePath)).toMatchObject({ lastDirectory: '/new', messageSearchEnabled: false, projects: [{ path: '/one' }, { path: '/two' }] });
      } finally { await cleanup(); }
    });

    it('reports a save it cannot write and leaves a broken file as it is', async () => {
      const { runtime, settingsFilePath, tempRoot, cleanup } = await merging();
      const preferencesFile = path.join(tempRoot, 'preferences.json');
      try {
        await runtime.persistSettings({ lightThemeId: 'kept', lastDirectory: '/kept' });
        const valid = await fsPromises.readFile(preferencesFile, 'utf8');
        await fsPromises.writeFile(preferencesFile, '{broken');
        await expect(runtime.persistSettings({ lightThemeId: 'lost' })).rejects.toThrow('unreadable preferences.json');
        expect(await fsPromises.readFile(preferencesFile, 'utf8')).toBe('{broken');
        expect(await runtime.readSettingsFromDisk()).toMatchObject({ lightThemeId: 'kept' });
        await fsPromises.writeFile(preferencesFile, valid);
        await fsPromises.writeFile(settingsFilePath, '{broken');
        await expect(runtime.persistSettings({ lastDirectory: '/lost' })).rejects.toThrow('unreadable settings.json');
        expect(await fsPromises.readFile(settingsFilePath, 'utf8')).toBe('{broken');
      } finally { await cleanup(); }
    });

    it('keeps every key when two processes save to one directory at once', async () => {
      const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-processes-'));
      const run = (name) => promisify(execFile)('bun', [fileURLToPath(new URL('./settings-process.fixture.js', import.meta.url)), tempRoot, name]);
      try {
        await Promise.all(['one', 'two'].map(run));
        const settings = await read(path.join(tempRoot, 'settings.json'));
        const { fields } = await read(path.join(tempRoot, 'preferences.json'));
        const keys = ['one', 'two'].flatMap((name) => Array.from({ length: 20 }, (_, index) => `${name}-${index}`));
        expect(fields.lightThemeId.value).toBe('one-19');
        expect(fields.darkThemeId.value).toBe('two-19');
        for (const key of keys) expect(settings).toHaveProperty([key], true);
      } finally { await fsPromises.rm(tempRoot, { recursive: true, force: true }); }
    });
  });

  it('retries from a new snapshot when a preference is edited while a reconciliation temporary file is being written', async () => {
    let intercept = false;
    let preferencesFile;
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
      fs: { ...fsPromises, writeFile: async (file, text, options) => {
        await fsPromises.writeFile(file, text, options);
        if (intercept && file.startsWith(`${preferencesFile}.tmp-`)) {
          intercept = false;
          const preferences = JSON.parse(await fsPromises.readFile(preferencesFile, 'utf8'));
          preferences.fields.darkThemeId.value = 'late-dark';
          await fsPromises.writeFile(preferencesFile, JSON.stringify(preferences));
        }
      } },
    });
    preferencesFile = path.join(tempRoot, 'preferences.json');
    try {
      await runtime.persistSettings({ lightThemeId: 'old-light', darkThemeId: 'old-dark' });
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...settings, lightThemeId: 'outside-light' }));
      intercept = true;
      expect(await runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['lightThemeId'] })).toEqual([
        { source: 'settings', changedKeys: ['lightThemeId'] },
        { source: 'preferences', changedKeys: ['darkThemeId'] },
      ]);
      expect(await runtime.readSettingsFromDisk()).toMatchObject({ lightThemeId: 'outside-light', darkThemeId: 'late-dark' });
    } finally { await cleanup(); }
  });

  it('reconciles a second legacy save made while the first waits in the settings queue', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    const events = [];
    let watch;
    let releaseQueue;
    let markDetected;
    const detected = new Promise((resolve) => { markDetected = resolve; });
    try {
      await runtime.persistSettings({ lightThemeId: 'old-light', darkThemeId: 'old-dark' });
      watch = runtime.watchSettingsFiles({ onChange: async (change) => {
        markDetected();
        events.push(...await runtime.reconcileExternalSettings(change));
      } });
      await watch.ready;
      let markHeld;
      const queueHeld = new Promise((resolve) => { markHeld = resolve; });
      const held = runtime.updateSettingsFromDisk(async (current) => {
        await new Promise((resolve) => { releaseQueue = resolve; markHeld(); });
        return current;
      });
      await queueHeld;
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...settings, lightThemeId: 'outside-light' }));
      await watch.check();
      const reconciling = watch.check();
      await detected;
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...settings, lightThemeId: 'outside-light', darkThemeId: 'outside-dark' }));
      releaseQueue();
      await held;
      await reconciling;
      expect(events).toEqual([{ source: 'settings', changedKeys: ['lightThemeId', 'darkThemeId'] }]);
      expect(await runtime.readSettingsFromDisk()).toMatchObject({ lightThemeId: 'outside-light', darkThemeId: 'outside-dark' });
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'))).toMatchObject({ lightThemeId: 'outside-light', darkThemeId: 'outside-dark' });
      await watch.check();
      await watch.check();
      expect(events).toHaveLength(1);
    } finally { watch?.stop(); await cleanup(); }
  });

  it('keeps a legacy save made after a preference edit woke the reconciler', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ lightThemeId: 'old-light', darkThemeId: 'old-dark' });
      const file = path.join(tempRoot, 'preferences.json');
      const preferences = JSON.parse(await fsPromises.readFile(file, 'utf8'));
      preferences.fields.darkThemeId.value = 'outside-dark';
      await fsPromises.writeFile(file, JSON.stringify(preferences));
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...settings, lightThemeId: 'outside-light' }));
      expect(await runtime.reconcileExternalSettings({ source: 'preferences', changedKeys: ['darkThemeId'] })).toEqual([
        { source: 'preferences', changedKeys: ['darkThemeId'] },
        { source: 'settings', changedKeys: ['lightThemeId'] },
      ]);
      expect(await runtime.readSettingsFromDisk()).toMatchObject({ lightThemeId: 'outside-light', darkThemeId: 'outside-dark' });
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'))).toMatchObject({ lightThemeId: 'outside-light', darkThemeId: 'outside-dark' });
    } finally { await cleanup(); }
  });

  it('keeps a surface theme when an external edit to the base theme was reverted before reconciliation', async () => {
    const { runtime, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ themeId: 'base' });
      await runtime.persistSettings({ themeId: 'desktop' }, { surface: 'desktop' });
      expect(await runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['themeId'] })).toEqual([]);
      expect((await runtime.readSettingsFromDisk({ surface: 'desktop' })).themeId).toBe('desktop');
    } finally { await cleanup(); }
  });

  it('leaves the selected theme alone when a surface edits the palette of the inactive variant', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ themeId: 'base-light', lightThemeId: 'base-light', darkThemeId: 'base-dark', useSystemTheme: false, themeVariant: 'light' });
      await runtime.persistSettings({ themeId: 'desktop-light', darkThemeId: 'desktop-dark' }, { surface: 'desktop' });
      const file = path.join(tempRoot, 'preferences.json');
      const preferences = JSON.parse(await fsPromises.readFile(file, 'utf8'));
      preferences.fields.darkThemeId.surfaces.desktop.value = 'outside-dark';
      await fsPromises.writeFile(file, JSON.stringify(preferences));
      await runtime.reconcileExternalSettings({ source: 'preferences', changedKeys: ['darkThemeId'] });
      expect(await runtime.readSettingsFromDisk({ surface: 'desktop' })).toMatchObject({ themeId: 'desktop-light', darkThemeId: 'outside-dark' });
    } finally { await cleanup(); }
  });

  it('runs the live callback for an instance save while preferences.json is edited during publication', async () => {
    const changed = vi.fn();
    let intercept = false;
    let settingsFile;
    let preferencesFile;
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }), onMessageSearchEnabledChanged: changed,
      fs: { ...fsPromises, writeFile: async (file, text, options) => {
        await fsPromises.writeFile(file, text, options);
        if (intercept && file.startsWith(`${settingsFile}.tmp-`)) {
          intercept = false;
          const preferences = JSON.parse(await fsPromises.readFile(preferencesFile, 'utf8'));
          preferences.fields.lightThemeId.value = 'outside';
          await fsPromises.writeFile(preferencesFile, JSON.stringify(preferences));
        }
      } },
    });
    settingsFile = settingsFilePath;
    preferencesFile = path.join(tempRoot, 'preferences.json');
    try {
      await runtime.persistSettings({ messageSearchEnabled: false, lightThemeId: 'old' });
      changed.mockClear();
      intercept = true;
      await runtime.persistSettings({ messageSearchEnabled: true });
      expect(changed).toHaveBeenCalledWith(true);
      expect(JSON.parse(await fsPromises.readFile(preferencesFile, 'utf8')).fields.lightThemeId.value).toBe('outside');
    } finally { await cleanup(); }
  });

  it('serves a migration in memory while an external edit waits for reconciliation', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ lastDirectory: '/kept' });
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      const external = JSON.stringify({ ...settings, agentControlToolEnabled: false });
      await fsPromises.writeFile(settingsFilePath, external);
      await expect(runtime.readSettingsFromDiskMigrated()).resolves.toMatchObject({ agentControlToolEnabled: false, agentScheduleToolEnabled: false });
      expect(await fsPromises.readFile(settingsFilePath, 'utf8')).toBe(external);
    } finally { await cleanup(); }
  });

  it('serves the last valid settings and defers their migration while settings.json is unreadable', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ lastDirectory: '/kept' }));
      await runtime.readSettingsFromDisk();
      await fsPromises.writeFile(settingsFilePath, '{"lastDirectory":');
      await expect(runtime.readSettingsFromDiskMigrated()).resolves.toMatchObject({ lastDirectory: '/kept', notifyOnCompletion: true });
      expect(await fsPromises.readFile(settingsFilePath, 'utf8')).toBe('{"lastDirectory":');
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ lastDirectory: '/replaced' }));
      await expect(runtime.readSettingsFromDiskMigrated()).resolves.toMatchObject({ lastDirectory: '/replaced', notifyOnCompletion: true });
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'))).toMatchObject({ lastDirectory: '/replaced', notifyOnCompletion: true });
    } finally { await cleanup(); }
  });

  it('does not regenerate legacy profile data from unreadable startup preferences', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    let watch;
    try {
      await fsPromises.writeFile(settingsFilePath, '{"themeId":"kept","messageSearchEnabled":true}');
      await fsPromises.writeFile(path.join(tempRoot, 'preferences.json'), '{');
      watch = runtime.watchSettingsFiles({ onChange: () => {} });
      await watch.ready;
      await fsPromises.writeFile(settingsFilePath, '{"themeId":"kept","messageSearchEnabled":false}');
      await runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['messageSearchEnabled'] });
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).themeId).toBe('kept');
    } finally { watch?.stop(); await cleanup(); }
  });

  it('gives an edited surface its new selection without removing the inherited selection of another surface', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ themeId: 'base-selected', lightThemeId: 'base-light', useSystemTheme: false, themeVariant: 'light' });
      const file = path.join(tempRoot, 'preferences.json');
      const preferences = JSON.parse(await fsPromises.readFile(file, 'utf8'));
      preferences.fields.lightThemeId.surfaces = { desktop: { value: 'new-desktop-light', updatedAt: 2 } };
      await fsPromises.writeFile(file, JSON.stringify(preferences));
      await runtime.reconcileExternalSettings({ source: 'preferences', changedKeys: ['lightThemeId'] });
      expect((await runtime.readSettingsFromDisk({ surface: 'desktop' })).themeId).toBe('new-desktop-light');
      expect((await runtime.readSettingsFromDisk({ surface: 'web' })).themeId).toBe('base-selected');
    } finally { await cleanup(); }
  });

  it('reconciles a simultaneous preference delta before acknowledging a legacy file edit', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ useSystemTheme: true, lightThemeId: 'old-light', themeVariant: 'light' });
      await runtime.persistSettings({ themeId: 'old-desktop', lightThemeId: 'old-light' }, { surface: 'desktop' });
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      const file = path.join(tempRoot, 'preferences.json');
      const preferences = JSON.parse(await fsPromises.readFile(file, 'utf8'));
      preferences.fields.lightThemeId.surfaces.desktop.value = 'outside-desktop';
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...settings, useSystemTheme: false }));
      await fsPromises.writeFile(file, JSON.stringify(preferences));
      expect(await runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['useSystemTheme'] })).toEqual([
        { source: 'settings', changedKeys: ['useSystemTheme'] },
        { source: 'preferences', changedKeys: ['lightThemeId'] },
      ]);
      expect(await runtime.readSettingsFromDisk({ surface: 'desktop' })).toMatchObject({ themeId: 'outside-desktop', useSystemTheme: false });
    } finally { await cleanup(); }
  });
  it('honors a global explicit selection with system following off despite an existing surface override', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ themeId: 'old', useSystemTheme: false });
      await runtime.persistSettings({ useSystemTheme: true }, { surface: 'desktop' });
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...settings, themeId: 'outside' }));
      await runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['themeId'] });
      expect(await runtime.readSettingsFromDisk({ surface: 'desktop' })).toMatchObject({ themeId: 'outside', useSystemTheme: false });
    } finally { await cleanup(); }
  });
  it.each(['settings', 'preferences'])('announces an external %s edit once when an unrelated save takes it in', async (source) => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    const events = [];
    let watch;
    try {
      await runtime.persistSettings({ themeId: 'old', lightThemeId: 'old' });
      watch = runtime.watchSettingsFiles({ onChange: async (change) => { await runtime.reconcileExternalSettings(change); events.push(change); } });
      await watch.ready;
      if (source === 'settings') {
        const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
        await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...settings, lightThemeId: 'outside' }));
      } else {
        const file = path.join(tempRoot, 'preferences.json');
        const preferences = JSON.parse(await fsPromises.readFile(file, 'utf8'));
        preferences.fields.lightThemeId.value = 'outside';
        await fsPromises.writeFile(file, JSON.stringify(preferences));
      }
      runtime.subscribeTakenInSettings((changes) => events.push(...changes));
      await runtime.persistSettings({ lastDirectory: '/unrelated' });
      await watch.check();
      await watch.check();
      expect(events).toEqual([{ source, changedKeys: ['lightThemeId'] }]);
      expect((await runtime.readSettingsFromDisk()).lightThemeId).toBe('outside');
      await runtime.persistSettings({ lastDirectory: '/after-reconciliation' });
      expect((await runtime.readSettingsFromDisk()).lightThemeId).toBe('outside');
    } finally { watch?.stop(); await cleanup(); }
  });

  it.each(['settings.json', 'preferences.json'])('retries external selection without resurrecting a stale hint after a failed %s publication', async (target) => {
    let fail = false;
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
      fs: { ...fsPromises, rename: async (from, to) => {
        if (fail && path.basename(to) === target) { fail = false; throw new Error('Publication failed'); }
        await fsPromises.rename(from, to);
      } },
    });
    let watch;
    try {
      await runtime.persistSettings({ themeId: 'stale-hint', lightThemeId: 'old-light' });
      watch = runtime.watchSettingsFiles({ onChange: runtime.reconcileExternalSettings });
      await watch.ready;
      const settings = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...settings, lightThemeId: 'outside-light' }));
      fail = true;
      await expect(runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['lightThemeId'] })).rejects.toThrow('Publication failed');
      await watch.check();
      await watch.check();
      expect((await runtime.readSettingsFromDisk()).lightThemeId).toBe('outside-light');
      expect((await runtime.readSettingsFromDisk()).themeId).toBeUndefined();
    } finally { watch?.stop(); await cleanup(); }
  });

  it('applies the server search transition after an external instance edit', async () => {
    const changed = vi.fn();
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ onMessageSearchEnabledChanged: changed });
    try {
      await runtime.persistSettings({ messageSearchEnabled: false });
      changed.mockClear();
      await fsPromises.writeFile(settingsFilePath, '{"messageSearchEnabled":true}');
      await runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['messageSearchEnabled'] });
      expect(changed).toHaveBeenCalledWith(true);
    } finally { await cleanup(); }
  });
  it('adopts changed legacy profile keys without stale surface overrides and preserves unrelated preferences', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ themeId: 'old', lightThemeId: 'old-light', darkThemeId: 'old-dark', useSystemTheme: false }, { surface: 'desktop' });
      await runtime.persistSettings({ darkThemeId: 'web-dark' }, { surface: 'web' });
      const instance = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...instance, lightThemeId: 'outside-light' }));
      await runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['lightThemeId'] });
      expect(await runtime.readSettingsFromDisk({ surface: 'desktop' })).toMatchObject({ lightThemeId: 'outside-light', darkThemeId: 'old-dark', useSystemTheme: false });
      expect(await runtime.readSettingsFromDisk({ surface: 'web' })).toMatchObject({ lightThemeId: 'outside-light', darkThemeId: 'web-dark' });
      expect((await runtime.readSettingsFromDisk({ surface: 'desktop' })).themeId).toBeUndefined();
    } finally { await cleanup(); }
  });

  it('retains valid profile and instance state while either settings file is malformed', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ themeId: 'kept', lastDirectory: '/kept' }, { surface: 'desktop' });
      await runtime.readSettingsFromDisk({ surface: 'desktop' });
      await fsPromises.writeFile(path.join(tempRoot, 'preferences.json'), '{broken');
      expect(await runtime.readSettingsFromDisk({ surface: 'desktop' })).toMatchObject({ themeId: 'kept', lastDirectory: '/kept' });
      const legacy = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ ...legacy, themeId: 'outside' }));
      await expect(runtime.reconcileExternalSettings({ source: 'settings', changedKeys: ['themeId'] })).rejects.toThrow('unreadable');
      expect(await fsPromises.readFile(path.join(tempRoot, 'preferences.json'), 'utf8')).toBe('{broken');
      await fsPromises.writeFile(settingsFilePath, JSON.stringify(legacy));
      await runtime.readSettingsFromDisk({ surface: 'desktop' });
      await fsPromises.writeFile(settingsFilePath, '{broken');
      expect(await runtime.readSettingsFromDisk({ surface: 'desktop' })).toMatchObject({ themeId: 'kept', lastDirectory: '/kept' });
      await expect(runtime.writeSettingsToDisk({ lastDirectory: '/not-written' })).rejects.toThrow('unreadable');
      expect(await fsPromises.readFile(settingsFilePath, 'utf8')).toBe('{broken');
    } finally { await cleanup(); }
  });

  it('keeps direct per-surface preference edits scoped and clears only the redundant selected-theme hint', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await runtime.persistSettings({ themeId: 'old', lightThemeId: 'desktop-light' }, { surface: 'desktop' });
      await runtime.persistSettings({ lightThemeId: 'web-light', themeId: 'web-selected' }, { surface: 'web' });
      const file = path.join(tempRoot, 'preferences.json');
      const preferences = JSON.parse(await fsPromises.readFile(file, 'utf8'));
      preferences.fields.lightThemeId.surfaces.desktop.value = 'outside-desktop';
      await fsPromises.writeFile(file, JSON.stringify(preferences));
      await runtime.reconcileExternalSettings({ source: 'preferences', changedKeys: ['lightThemeId'] });
      expect((await runtime.readSettingsFromDisk({ surface: 'desktop' })).lightThemeId).toBe('outside-desktop');
      expect((await runtime.readSettingsFromDisk({ surface: 'web' })).lightThemeId).toBe('web-light');
      expect((await runtime.readSettingsFromDisk({ surface: 'web' })).themeId).toBe('web-selected');
    } finally { await cleanup(); }
  });

  it('serializes a feature update with a user save through one write lock', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    });
    try {
      // A relay demand flip or a first push subscribe has to add one field
      // without dropping what the user saved at the same moment.
      const update = runtime.updateSettingsFromDisk((settings) => ({
        ...settings,
        privateRelay: { enabled: true, relayUrl: 'wss://relay.example/ws' },
      }));
      const save = runtime.persistSettings({ projects: [] });
      await Promise.all([update, save]);

      const onDisk = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(onDisk.privateRelay).toEqual({ enabled: true, relayUrl: 'wss://relay.example/ws' });
      expect(onDisk.projects).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('refuses a feature update without a mutation', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await expect(runtime.updateSettingsFromDisk()).rejects.toThrow(TypeError);
    } finally {
      await cleanup();
    }
  });

  it('serializes session project registration with settings writes without changing navigation', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      const kept = createProjectIdFromPath('/kept');
      const added = createProjectIdFromPath('/new');
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ projects: [{ id: kept, path: '/kept', label: 'Kept' }], activeProjectId: kept, lastDirectory: '/kept', future: 42 }));
      const append = () => runtime.registerSessionProject((projects) => projects.find(p => p.id === added) ?? { id: added, path: '/new' });
      await Promise.all([append(), runtime.persistSettings({ lightThemeId: 'test' }), append()]);
      const stored = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(stored.projects).toEqual([{ id: kept, path: '/kept', label: 'Kept' }, { id: added, path: '/new' }]);
      expect(stored).toMatchObject({ activeProjectId: kept, lastDirectory: '/kept', future: 42, lightThemeId: 'test' });
    } finally { await cleanup(); }
  });

  it('keeps a save made while a read is writing a migration', async () => {
    let hold = false;
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let reached;
    const held = new Promise((resolve) => { reached = resolve; });
    const fs = { ...fsPromises, rename: async (from, to) => {
      if (hold && path.basename(to) === 'settings.json') {
        hold = false;
        reached();
        await released;
      }
      return fsPromises.rename(from, to);
    } };
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }), fs,
    });
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ approvedDirectories: ['/old'] }));
      hold = true;
      const read = runtime.readSettingsFromDiskMigrated();
      await held;
      const save = runtime.persistSettings({ lightThemeId: 'saved' });
      for (let turn = 0; turn < 30; turn += 1) await runtime.readSettingsFromDisk();
      release();
      await read;
      await expect(save).resolves.toMatchObject({ lightThemeId: 'saved' });
      const after = await runtime.readSettingsFromDisk();
      expect(after.lightThemeId).toBe('saved');
      expect(after).not.toHaveProperty('approvedDirectories');
    } finally { release(); await cleanup(); }
  });
  it('does not wait on itself when a save reads settings that need a migration', async () => {
    let runtime;
    let reads = 0;
    const created = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
      onManagedPluginSettingsChanged: async () => {
        expect(await runtime.readSettingsFromDiskMigrated({ surface: 'web' })).toMatchObject({ agentScheduleToolEnabled: false });
        reads += 1;
      },
    });
    runtime = created.runtime;
    try {
      await expect(runtime.persistSettings({ agentControlToolEnabled: false })).resolves.toMatchObject({ agentControlToolEnabled: false });
      expect(reads).toBe(1);
      expect(await runtime.readSettingsFromDiskMigrated()).toMatchObject({ agentScheduleToolEnabled: false });
    } finally { await created.cleanup(); }
  });
  it('resolves changes against the settings left by the save queued before them', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ lightThemeId: 'old' }));
      await Promise.all([
        runtime.persistSettings({ lightThemeId: 'queued-first' }),
        runtime.persistResolvedSettings((current) => ({ darkThemeId: `after-${current.lightThemeId}` })),
      ]);
      const stored = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(stored).toMatchObject({ lightThemeId: 'queued-first', darkThemeId: 'after-queued-first' });
    } finally { await cleanup(); }
  });

  it('does not overwrite a malformed registry and allows registration after repair', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, '{broken');
      const append = () => runtime.registerSessionProject(() => ({ id: 'new', path: '/new' }));
      await expect(append()).rejects.toThrow();
      expect(await fsPromises.readFile(settingsFilePath, 'utf8')).toBe('{broken');
      await fsPromises.writeFile(settingsFilePath, '{"projects":[]}');
      await expect(append()).resolves.toEqual({ id: 'new', path: '/new' });
    } finally { await cleanup(); }
  });

  it('preserves the registry after a failed session append and allows retry', async () => {
    let fail = true;
    const { runtime, settingsFilePath, cleanup } = await createRuntime({ fs: {
      ...fsPromises,
      rename: async (...args) => {
        if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return fsPromises.rename(...args);
      },
    } });
    try {
      const original = '{"projects":[],"lastDirectory":"/kept"}';
      await fsPromises.writeFile(settingsFilePath, original);
      const append = () => runtime.registerSessionProject(() => ({ id: 'new', path: '/new' }));
      await expect(append()).rejects.toThrow();
      expect(await fsPromises.readFile(settingsFilePath, 'utf8')).toBe(original);
      fail = false;
      await expect(append()).resolves.toEqual({ id: 'new', path: '/new' });
    } finally { await cleanup(); }
  });

  it('reports the directory the UI moved to, once per change', async () => {
    const onLastDirectoryChanged = vi.fn();
    const { runtime, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
      onLastDirectoryChanged,
    });
    try {
      await runtime.persistSettings({ lastDirectory: '/work/a' });
      await runtime.persistSettings({ lastDirectory: '/work/a' });
      await runtime.persistSettings({ lightThemeId: 'flexoki-light' });
      await runtime.persistSettings({ lastDirectory: '/work/b' });
      expect(onLastDirectoryChanged.mock.calls).toEqual([['/work/a'], ['/work/b']]);
    } finally {
      await cleanup();
    }
  });

  it('refreshes the managed OpenCode config only when a managed plugin setting changed', async () => {
    const onManagedPluginSettingsChanged = vi.fn(async () => {});
    const { runtime, cleanup } = await createRuntime({ onManagedPluginSettingsChanged });
    try {
      await runtime.persistSettings({ lightThemeId: 'flexoki-light' });
      expect(onManagedPluginSettingsChanged).not.toHaveBeenCalled();

      await runtime.persistSettings({ agentWebToolEnabled: false });
      expect(onManagedPluginSettingsChanged).toHaveBeenCalledTimes(1);

      // The limit failover plugin loads only while one of its options is set.
      await runtime.persistSettings({ fallbackModel: 'openai/gpt-5.6' });
      await runtime.persistSettings({ accountSwitchProviders: ['anthropic'] });
      expect(onManagedPluginSettingsChanged).toHaveBeenCalledTimes(3);
    } finally {
      await cleanup();
    }
  });

  it('tells the running spaces the default permission mode only when it changed, once it is written', async () => {
    const seen = [];
    let settingsFilePath = '';
    const { runtime, cleanup, settingsFilePath: filePath } = await createRuntime({
      onPermissionDefaultModeChanged: async (mode) => {
        seen.push([mode, JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).permissionDefaultMode]);
      },
    });
    settingsFilePath = filePath;
    try {
      await runtime.persistSettings({ lightThemeId: 'flexoki-light' });
      await runtime.persistSettings({ permissionDefaultMode: 'auto' });
      await runtime.persistSettings({ permissionDefaultMode: 'auto' });
      await vi.waitFor(() => expect(seen).toEqual([['auto', 'auto']]));
      await runtime.persistSettings({ permissionDefaultMode: 'ask' });
      await vi.waitFor(() => expect(seen).toEqual([['auto', 'auto'], ['ask', 'ask']]));
    } finally {
      await cleanup();
    }
  });

  it('still answers the settings write when the managed config refresh fails', async () => {
    const onManagedPluginSettingsChanged = vi.fn(async () => { throw new Error('disk full'); });
    const { runtime, cleanup } = await createRuntime({ onManagedPluginSettingsChanged });
    try {
      await expect(runtime.persistSettings({ agentMemoryToolEnabled: true }))
        .resolves.toMatchObject({ agentMemoryToolEnabled: true });
    } finally {
      await cleanup();
    }
  });

  it('round-trips both archived-only retention states through instance settings', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      for (const sessionRetentionOnlyArchived of [true, false]) {
        const settings = { sessionRetentionOnlyArchived, sessionRetentionAction: 'delete', autoDeleteAfterDays: 30 };
        await runtime.persistSettings(settings);
        expect(await runtime.readSettingsFromDisk()).toEqual(settings);
        expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'))).toEqual(settings);
      }
    } finally {
      await cleanup();
    }
  });

  it('keeps scheduling off for someone who had switched the control tool off', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await runtime.persistSettings({ agentControlToolEnabled: false });
      expect(await runtime.readSettingsFromDiskMigrated()).toMatchObject({ agentControlToolEnabled: false, agentScheduleToolEnabled: false });

      // A choice made after the split stays.
      await runtime.persistSettings({ agentControlToolEnabled: false, agentScheduleToolEnabled: true });
      expect((await runtime.readSettingsFromDiskMigrated()).agentScheduleToolEnabled).toBe(true);

      await runtime.persistSettings({ agentControlToolEnabled: true });
      expect(await runtime.readSettingsFromDiskMigrated()).not.toHaveProperty('agentScheduleToolEnabled');
    } finally {
      await cleanup();
    }
  });

  it('turns a stored last directory into a project only while one is stored', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const directory = path.join(tempRoot, 'removed-project');
      await fsPromises.mkdir(directory);
      // The legacy migration: no projects, a last directory on disk.
      await runtime.writeSettingsToDisk({ projects: [], lastDirectory: directory });
      expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([
        expect.objectContaining({ path: directory }),
      ]);
      // Removing the last project forgets the last directory with ''.
      await runtime.writeSettingsToDisk({ projects: [], lastDirectory: '' });
      expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('never turns a chat folder stored as the last directory into a project', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-chats-'));
    const chatsRoot = path.join(tempRoot, 'chats');
    const { runtime, cleanup } = await createRuntime({ chatRoots: [chatsRoot] });
    try {
      const chat = path.join(chatsRoot, '2026-10-12', 'session-a');
      await fsPromises.mkdir(chat, { recursive: true });
      await runtime.writeSettingsToDisk({ projects: [], lastDirectory: chat });
      expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([]);

      // The same folder reached through a link to the chats root.
      const alias = path.join(tempRoot, 'chats-alias');
      await fsPromises.symlink(chatsRoot, alias, 'junction');
      await runtime.writeSettingsToDisk({ projects: [], lastDirectory: path.join(alias, '2026-10-12', 'session-a') });
      expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([]);
    } finally {
      await cleanup();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses OpenChamber themes when a new install has no theme preferences', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await expect(runtime.readSettingsFromDiskMigrated()).resolves.toMatchObject({
        lightThemeId: 'openchamber-light',
        darkThemeId: 'openchamber-dark',
      });
    } finally {
      await cleanup();
    }
  });

  it('preserves existing theme preferences during theme migration', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({
        lightThemeId: 'flexoki-light',
        darkThemeId: 'flexoki-dark',
      }), 'utf8');

      await expect(runtime.readSettingsFromDiskMigrated()).resolves.toMatchObject({
        lightThemeId: 'flexoki-light',
        darkThemeId: 'flexoki-dark',
      });
    } finally {
      await cleanup();
    }
  });

  it('round-trips shared profile preferences through preferences.json', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    const preferences = {
      sidebarProjectDisplayMode: 'single',
      sidebarViewMode: 'timeline',
      sidebarProjectSortOrder: 'date-added',
      sidebarShowChatsSection: false,
      selectionApprovalText: '认可此方案 👍',
    };
    try {
      await runtime.persistSettings(preferences);

      await expect(runtime.readSettingsFromDisk()).resolves.toEqual(preferences);
      // Profile keys live in preferences.json; settings.json keeps a legacy copy for older builds.
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'))).toEqual(preferences);
      const stored = JSON.parse(await fsPromises.readFile(path.join(tempRoot, 'preferences.json'), 'utf8'));
      expect(Object.fromEntries(Object.entries(stored.fields).map(([key, entry]) => [key, entry.value]))).toEqual(preferences);
      await runtime.persistSettings({ ...preferences, selectionApprovalText: '' });
      await expect(runtime.readSettingsFromDisk()).resolves.toEqual({ ...preferences, selectionApprovalText: '' });
    } finally {
      await cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('writes settings with restrictive directory and file permissions', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      await runtime.writeSettingsToDisk({ desktopUiPassword: 'secret' });

      expect((await fsPromises.stat(tempRoot)).mode & 0o777).toBe(0o700);
      expect((await fsPromises.stat(settingsFilePath)).mode & 0o777).toBe(0o600);
    } finally {
      await cleanup();
    }
  });

  it('only remaps project plan paths within the migrated storage directory', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const projectPath = path.join(tempRoot, 'project');
      const oldProjectId = 'legacy-project-id';
      const newProjectId = createProjectIdFromPath(projectPath);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const oldStorageDir = path.join(projectsRoot, oldProjectId);
      const newStorageDir = path.join(projectsRoot, newProjectId);
      const siblingStorageDir = `${oldStorageDir}-sibling`;

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(projectsRoot, { recursive: true });
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          projects: [{ id: oldProjectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
          activeProjectId: oldProjectId,
        }, null, 2),
        'utf8',
      );
      await fsPromises.writeFile(
        path.join(projectsRoot, `${oldProjectId}.json`),
        JSON.stringify({
          projectPlanFiles: [
            { id: 'inside', path: path.join(oldStorageDir, 'plans', 'inside.md') },
            { id: 'sibling', path: path.join(siblingStorageDir, 'plans', 'outside.md') },
          ],
        }, null, 2),
        'utf8',
      );

      await runtime.readSettingsFromDiskMigrated();

      const migratedConfig = JSON.parse(await fsPromises.readFile(path.join(projectsRoot, `${newProjectId}.json`), 'utf8'));
      expect(migratedConfig.projectPlanFiles).toEqual([
        { id: 'inside', path: path.join(newStorageDir, 'plans', 'inside.md') },
        { id: 'sibling', path: path.join(siblingStorageDir, 'plans', 'outside.md') },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('migrates a legacy id into the bounded file of a project whose path is too long for a file name', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const projectPath = path.join(tempRoot, 'a'.repeat(160));
      const oldProjectId = 'legacy-project-id';
      const newProjectId = createProjectIdFromPath(projectPath);
      expect(newProjectId.length).toBeGreaterThan(200);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const boundedPath = path.join(projectsRoot, `${projectConfigFileStemOf(newProjectId)}.json`);
      expect(path.basename(boundedPath).startsWith('path_sha256_')).toBe(true);

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(projectsRoot, { recursive: true });
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          projects: [{ id: oldProjectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
          activeProjectId: oldProjectId,
        }, null, 2),
        'utf8',
      );
      await fsPromises.writeFile(
        path.join(projectsRoot, `${oldProjectId}.json`),
        JSON.stringify({ 'setup-worktree': ['bun install'] }, null, 2),
        'utf8',
      );

      const settings = await runtime.readSettingsFromDiskMigrated();

      expect(settings.projects[0].id).toBe(newProjectId);
      const migratedConfig = JSON.parse(await fsPromises.readFile(boundedPath, 'utf8'));
      expect(migratedConfig['setup-worktree']).toEqual(['bun install']);
      await expect(fsPromises.readFile(path.join(projectsRoot, `${oldProjectId}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      // A second pass sees the bounded file beside the settings; it is the
      // project's own file, not a stray from the random-id era.
      await runtime.readSettingsFromDiskMigrated();
      expect(JSON.parse(await fsPromises.readFile(boundedPath, 'utf8'))['setup-worktree']).toEqual(['bun install']);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('orphan'))).toBe(false);
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  it.skipIf(process.platform !== 'win32')('falls back when Windows blocks atomic settings replacement', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
    const settingsFilePath = path.join(tempRoot, 'settings.json');
    const wrappedFs = {
      ...fsPromises,
      rename: async () => {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      },
    };
    const runtime = createSettingsRuntime({
      fsPromises: wrappedFs,
      path,
      crypto,
      SETTINGS_FILE_PATH: settingsFilePath,
      sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
      sanitizeSettingsUpdate: (settings) => settings,
      mergePersistedSettings: (_current, changes) => changes,
      normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
      normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
      formatSettingsResponse: (settings) => settings,
      resolveDirectoryCandidate: (value) => value,
      normalizeManagedRemoteTunnelHostname: (value) => value,
      normalizeManagedRemoteTunnelPresets: (value) => value,
      normalizeManagedRemoteTunnelPresetTokens: (value) => value,
      syncManagedRemoteTunnelConfigWithPresets: async () => {},
      upsertManagedRemoteTunnelToken: async () => {},
    });

    try {
      await runtime.writeSettingsToDisk({ theme: 'dark' });

      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(JSON.stringify({ theme: 'dark' }, null, 2));
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('moves project storage into the bounded folder when the canonical id is too long for a folder name', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const projectPath = path.join(tempRoot, `${'segment-'.repeat(18)}`, 'demo-repo');
      const oldProjectId = 'legacy-project-id';
      const newProjectId = createProjectIdFromPath(projectPath);
      const stem = projectConfigFileStemOf(newProjectId);
      expect(newProjectId.length).toBeGreaterThan(240);
      expect(stem).not.toBe(newProjectId);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const oldStorageDir = path.join(projectsRoot, oldProjectId);
      const newStorageDir = path.join(projectsRoot, stem);

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(path.join(oldStorageDir, 'plans'), { recursive: true });
      await fsPromises.writeFile(path.join(oldStorageDir, 'context.json'), JSON.stringify({ version: 2, notes: [], todos: [{ id: 't1', text: 'keep', completed: false, createdAt: 1 }], plans: [] }), 'utf8');
      await fsPromises.writeFile(path.join(oldStorageDir, 'plans', 'inside.md'), '# Inside\n', 'utf8');
      await fsPromises.writeFile(path.join(oldStorageDir, 'memory.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8');
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          projects: [{ id: oldProjectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
          activeProjectId: oldProjectId,
        }, null, 2),
        'utf8',
      );
      await fsPromises.writeFile(
        path.join(projectsRoot, `${oldProjectId}.json`),
        JSON.stringify({ projectPlanFiles: [{ id: 'inside', path: path.join(oldStorageDir, 'plans', 'inside.md') }] }, null, 2),
        'utf8',
      );

      const settings = await runtime.readSettingsFromDiskMigrated();

      expect(settings.projects.map((project) => project.id)).toEqual([newProjectId]);
      const migratedConfig = JSON.parse(await fsPromises.readFile(path.join(projectsRoot, `${stem}.json`), 'utf8'));
      expect(migratedConfig.projectPlanFiles).toEqual([{ id: 'inside', path: path.join(newStorageDir, 'plans', 'inside.md') }]);
      expect(JSON.parse(await fsPromises.readFile(path.join(newStorageDir, 'context.json'), 'utf8')).todos).toHaveLength(1);
      await fsPromises.access(path.join(newStorageDir, 'plans', 'inside.md'));
      await fsPromises.access(path.join(newStorageDir, 'memory.json'));
      expect((await fsPromises.readdir(projectsRoot)).sort()).toEqual([stem, `${stem}.json`]);
    } finally {
      await cleanup();
    }
  });

  it('moves a folder an older build created under a raw id that still fit a folder name into the bounded folder', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      // Long enough for the bounded name, short enough that an older build
      // could still have created `<id>/` on this filesystem. The temp root
      // differs per OS (a few characters on Linux runners, dozens on macOS),
      // so pad to a fixed path length instead of a fixed segment.
      const projectPathLength = 170;
      const segment = 'x'.repeat(Math.max(1, projectPathLength - path.join(tempRoot, 'demo-repo').length - 1));
      const projectPath = path.join(tempRoot, segment, 'demo-repo');
      const projectId = createProjectIdFromPath(projectPath);
      const stem = projectConfigFileStemOf(projectId);
      expect(projectId.length).toBeGreaterThan(200);
      expect(projectId.length).toBeLessThanOrEqual(255);
      expect(stem).not.toBe(projectId);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const rawStorageDir = path.join(projectsRoot, projectId);
      const boundedStorageDir = path.join(projectsRoot, stem);

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(path.join(rawStorageDir, 'plans'), { recursive: true });
      await fsPromises.writeFile(path.join(rawStorageDir, 'context.json'), JSON.stringify({ version: 2, notes: [{ id: 'n1', body: 'old note', createdAt: 1, updatedAt: 1 }], todos: [], plans: [] }), 'utf8');
      await fsPromises.writeFile(path.join(rawStorageDir, 'plans', 'old.md'), '# Old\n', 'utf8');
      await fsPromises.writeFile(path.join(rawStorageDir, 'memory.json'), JSON.stringify({ version: 1, entries: [{ id: 'm1', title: 'Old memory', body: 'x', type: 'fact', createdAt: 1, updatedAt: 1 }] }), 'utf8');
      // The bounded folder already holds newer context: both sides survive.
      await fsPromises.mkdir(boundedStorageDir, { recursive: true });
      await fsPromises.writeFile(path.join(boundedStorageDir, 'context.json'), JSON.stringify({ version: 2, notes: [{ id: 'n2', body: 'new note', createdAt: 2, updatedAt: 2 }], todos: [], plans: [] }), 'utf8');
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({ projects: [{ id: projectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }], activeProjectId: projectId }, null, 2),
        'utf8',
      );

      const settings = await runtime.readSettingsFromDiskMigrated();

      expect(settings.projects.map((project) => project.id)).toEqual([projectId]);
      const context = JSON.parse(await fsPromises.readFile(path.join(boundedStorageDir, 'context.json'), 'utf8'));
      expect(context.notes.map((note) => note.id).sort()).toEqual(['n1', 'n2']);
      await fsPromises.access(path.join(boundedStorageDir, 'plans', 'old.md'));
      expect(JSON.parse(await fsPromises.readFile(path.join(boundedStorageDir, 'memory.json'), 'utf8')).entries).toHaveLength(1);
      await expect(fsPromises.access(rawStorageDir)).rejects.toMatchObject({ code: 'ENOENT' });

      // A second startup finds nothing left to move.
      await runtime.readSettingsFromDiskMigrated();
      expect(JSON.parse(await fsPromises.readFile(path.join(boundedStorageDir, 'context.json'), 'utf8')).notes).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it('cleans up orphaned settings.json.tmp files during startup migration', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const settingsDir = path.dirname(settingsFilePath);
      const orphan1 = path.join(settingsDir, 'settings.json.tmp-1234-11111-abc');
      const orphan2 = path.join(settingsDir, 'settings.json.tmp-5678-22222-def');
      const unrelated = path.join(settingsDir, 'other-file.json');

      await fsPromises.writeFile(orphan1, '{"broken": true}', 'utf8');
      await fsPromises.writeFile(orphan2, '{"broken": true}', 'utf8');
      await fsPromises.writeFile(unrelated, '{"keep": true}', 'utf8');
      await fsPromises.writeFile(settingsFilePath, '{"theme": "light"}', 'utf8');

      await runtime.readSettingsFromDiskMigrated();

      const files = await fsPromises.readdir(settingsDir);
      expect(files).toContain('settings.json');
      expect(files).toContain('other-file.json');
      expect(files).not.toContain('settings.json.tmp-1234-11111-abc');
      expect(files).not.toContain('settings.json.tmp-5678-22222-def');
    } finally {
      await cleanup();
    }
  });

  it('writes the next save after one failed with a full disk', async () => {
    let failNextSettingsWrite = true;
    const fs = {
      ...fsPromises,
      writeFile: async (file, ...rest) => {
        if (failNextSettingsWrite && path.basename(String(file)).startsWith('settings.json.tmp-')) {
          failNextSettingsWrite = false;
          const error = new Error('ENOSPC: no space left on device, write');
          error.code = 'ENOSPC';
          throw error;
        }
        return fsPromises.writeFile(file, ...rest);
      },
    };
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      fs,
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(runtime.persistSettings({ lightThemeId: 'flexoki-light' })).rejects.toThrow('ENOSPC');
      await expect(runtime.persistSettings({ lastDirectory: '/work/a' })).resolves.toMatchObject({ lastDirectory: '/work/a' });
      const onDisk = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(onDisk.lastDirectory).toBe('/work/a');
      expect((await runtime.readSettingsFromDisk()).lightThemeId).toBeUndefined();
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  it('writes a save already queued behind one that fails with a full disk', async () => {
    let failNextSettingsWrite = true;
    const fs = {
      ...fsPromises,
      writeFile: async (file, ...rest) => {
        if (failNextSettingsWrite && path.basename(String(file)).startsWith('settings.json.tmp-')) {
          failNextSettingsWrite = false;
          const error = new Error('ENOSPC: no space left on device, write');
          error.code = 'ENOSPC';
          throw error;
        }
        return fsPromises.writeFile(file, ...rest);
      },
    };
    const { runtime, settingsFilePath, cleanup } = await createRuntime({
      fs,
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = runtime.persistSettings({ lightThemeId: 'flexoki-light' });
      const second = runtime.persistSettings({ lastDirectory: '/work/b' });
      await expect(first).rejects.toThrow('ENOSPC');
      await expect(second).resolves.toMatchObject({ lastDirectory: '/work/b' });
      const onDisk = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(onDisk.lastDirectory).toBe('/work/b');
      expect((await runtime.readSettingsFromDisk()).lightThemeId).toBeUndefined();
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  it('removes temp file when writeSettingsToDisk encounters a write error', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
    const settingsFilePath = path.join(tempRoot, 'settings.json');
    let capturedTmp = null;
    const wrappedFs = {
      ...fsPromises,
      rename: async (src, dst) => {
        capturedTmp = src;
        const error = new Error('unexpected disk failure');
        error.code = 'EIO';
        throw error;
      },
    };
    const runtime = createSettingsRuntime({
      fsPromises: wrappedFs,
      path,
      crypto,
      SETTINGS_FILE_PATH: settingsFilePath,
      sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
      sanitizeSettingsUpdate: (settings) => settings,
      mergePersistedSettings: (_current, changes) => changes,
      normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
      normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
      formatSettingsResponse: (settings) => settings,
      resolveDirectoryCandidate: (value) => value,
      normalizeManagedRemoteTunnelHostname: (value) => value,
      normalizeManagedRemoteTunnelPresets: (value) => value,
      normalizeManagedRemoteTunnelPresetTokens: (value) => value,
      syncManagedRemoteTunnelConfigWithPresets: async () => {},
      upsertManagedRemoteTunnelToken: async () => {},
    });

    try {
      await expect(runtime.writeSettingsToDisk({ theme: 'dark' })).rejects.toThrow('unexpected disk failure');
      expect(capturedTmp).toBeTruthy();
      const files = await fsPromises.readdir(tempRoot);
      expect(files.some((f) => f.startsWith('settings.json.tmp-'))).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('settings runtime: preferences.json split', () => {
  const readJson = async (filePath) => JSON.parse(await fsPromises.readFile(filePath, 'utf8'));

  it('seeds preferences.json from the profile keys of an existing settings.json and leaves that file intact', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const legacy = { projects: [], fontSize: 110, themeId: 'openchamber-dark', desktopLanAccessEnabled: true };
      await fsPromises.writeFile(settingsFilePath, JSON.stringify(legacy));

      const merged = await runtime.readSettingsFromDisk();
      expect(merged).toMatchObject(legacy);

      const preferences = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(preferences.version).toBe(1);
      expect(Object.keys(preferences.fields).sort()).toEqual(['fontSize', 'themeId']);
      expect(preferences.fields.fontSize.value).toBe(110);
      expect(typeof preferences.fields.fontSize.updatedAt).toBe('number');
      expect(await readJson(settingsFilePath)).toEqual(legacy);
    } finally {
      await cleanup();
    }
  });

  it('routes profile keys to preferences.json, keeps a legacy copy of them in settings.json, and drops device keys', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      await runtime.persistSettings({ fontSize: 120, desktopLanAccessEnabled: true, mobileKeyboardMode: 'native' });

      const settings = await readJson(settingsFilePath);
      expect(settings.desktopLanAccessEnabled).toBe(true);
      // Older builds read only settings.json: the profile's base values stay there as a copy.
      expect(settings.fontSize).toBe(120);
      expect(settings).not.toHaveProperty('mobileKeyboardMode');

      const preferences = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(preferences.fields.fontSize.value).toBe(120);
      expect(preferences.fields).not.toHaveProperty('mobileKeyboardMode');
      expect(preferences.fields).not.toHaveProperty('desktopLanAccessEnabled');

      expect(await runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 120, desktopLanAccessEnabled: true });
    } finally {
      await cleanup();
    }
  });

  it('keeps the timestamp of an unchanged profile key and restamps a changed one', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const preferencesPath = path.join(tempRoot, 'preferences.json');
      await runtime.persistSettings({ fontSize: 100, padding: 100 });
      const first = await readJson(preferencesPath);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.persistSettings({ fontSize: 100, padding: 120 });
      const second = await readJson(preferencesPath);

      expect(second.fields.fontSize.updatedAt).toBe(first.fields.fontSize.updatedAt);
      expect(second.fields.padding.updatedAt).toBeGreaterThan(first.fields.padding.updatedAt);
      expect(second.fields.padding.value).toBe(120);
    } finally {
      await cleanup();
    }
  });

  it('treats an unreadable preferences.json as failure: no seed, no overwrite, profile writes refused, instance still served', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const preferencesPath = path.join(tempRoot, 'preferences.json');
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ desktopLanAccessEnabled: true }));
      await fsPromises.writeFile(preferencesPath, '{ not json');

      expect(await runtime.readSettingsFromDisk()).toEqual({ desktopLanAccessEnabled: true });

      await expect(runtime.persistSettings({ fontSize: 130, desktopKeepAwakeEnabled: true })).rejects.toThrow('not saved: fontSize');

      expect(await fsPromises.readFile(preferencesPath, 'utf8')).toBe('{ not json');
      const settings = await readJson(settingsFilePath);
      expect(settings.desktopKeepAwakeEnabled).toBe(true);
      // The refused profile write must not land in the legacy copy either.
      expect(settings).not.toHaveProperty('fontSize');
    } finally {
      await cleanup();
    }
  });

  it('keeps a copy of legacy profile values that an already seeded empty preferences.json hides', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const projectPath = path.join(tempRoot, 'project');
      await fsPromises.mkdir(projectPath);
      const legacy = { queueModeEnabled: false, fontSize: 120, approvedDirectories: ['/tmp'], projects: [{ id: 'legacy', path: projectPath }], activeProjectId: 'legacy' };
      await fsPromises.writeFile(settingsFilePath, JSON.stringify(legacy));
      await fsPromises.writeFile(path.join(tempRoot, 'preferences.json'), JSON.stringify({ version: 1, fields: {} }));

      const first = await runtime.readSettingsFromDiskMigrated();
      expect(first.projects).toEqual([expect.objectContaining({ path: projectPath })]);
      expect(first.fontSize).toBeUndefined();
      await runtime.persistSettings({ lastDirectory: projectPath });

      expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([expect.objectContaining({ path: projectPath })]);
      expect(await readJson(settingsFilePath)).not.toHaveProperty('fontSize');
      const backup = await readJson(path.join(tempRoot, 'settings.legacy-profile.json'));
      expect(backup).toMatchObject({ fontSize: 120, queueModeEnabled: false });
      expect(backup).not.toHaveProperty('projects');
    } finally {
      await cleanup();
    }
  });

  it('keeps a legacy global value that preferences.json holds only as a surface override', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ fontSize: 120, approvedDirectories: ['/tmp'] }));
      await fsPromises.writeFile(path.join(tempRoot, 'preferences.json'), JSON.stringify({
        version: 1,
        fields: { fontSize: { updatedAt: 1, surfaces: { desktop: { value: 105, updatedAt: 1 } } } },
      }));

      await runtime.readSettingsFromDiskMigrated();
      await runtime.persistSettings({ lastDirectory: '/tmp' });

      expect(await readJson(path.join(tempRoot, 'settings.legacy-profile.json'))).toEqual({ fontSize: 120 });
    } finally {
      await cleanup();
    }
  });

  it('keeps the legacy profile copy when its first write fails partway', async () => {
    let failBackup = true;
    const fs = {
      ...fsPromises,
      writeFile: async (target, data, options) => {
        if (failBackup && String(target).includes('settings.legacy-profile.json')) {
          failBackup = false;
          await fsPromises.writeFile(target, String(data).slice(0, 5), options);
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        return fsPromises.writeFile(target, data, options);
      },
    };
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({ fs });
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ fontSize: 120, approvedDirectories: ['/tmp'] }));
      await fsPromises.writeFile(path.join(tempRoot, 'preferences.json'), JSON.stringify({ version: 1, fields: {} }));

      await expect(runtime.persistSettings({ lastDirectory: '/tmp' })).rejects.toThrow('no space left');
      expect(await readJson(settingsFilePath)).toHaveProperty('fontSize', 120);

      await runtime.persistSettings({ lastDirectory: '/tmp' });
      expect(await readJson(settingsFilePath)).not.toHaveProperty('fontSize');
      expect(await readJson(path.join(tempRoot, 'settings.legacy-profile.json'))).toEqual({ fontSize: 120 });
    } finally {
      await cleanup();
    }
  });

  it('writes no legacy profile copy when settings.json seeds preferences.json', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ fontSize: 120, approvedDirectories: ['/tmp'] }));
      await runtime.readSettingsFromDiskMigrated();
      await runtime.persistSettings({ fontSize: 110 });
      expect(await runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 110 });
      await expect(fsPromises.access(path.join(tempRoot, 'settings.legacy-profile.json'))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it('does not seed preferences.json while settings.json is unreadable, so its profile survives the repair', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const preferencesPath = path.join(tempRoot, 'preferences.json');
      await fsPromises.writeFile(settingsFilePath, '{ not json');

      await runtime.readSettingsFromDisk();
      await expect(fsPromises.access(preferencesPath)).rejects.toThrow();

      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ fontSize: 110 }));
      expect(await runtime.readSettingsFromDisk()).toMatchObject({ fontSize: 110 });
      expect((await readJson(preferencesPath)).fields.fontSize.value).toBe(110);
    } finally {
      await cleanup();
    }
  });
});

describe('settings runtime: per-surface profile keys', () => {
  const readJson = async (filePath) => JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
  // These sequences persist several times; the default stub replaces the
  // document with the changes, the real merge keeps the current document.
  const createMergingRuntime = () => createRuntime({ mergePersistedSettings: (current, changes) => ({ ...current, ...changes }) });

  it('stores a per-surface key under the writing surface and leaves the base alone', async () => {
    const { runtime, tempRoot, cleanup } = await createMergingRuntime();
    try {
      await runtime.persistSettings({ fontSize: 100 }); // base (no surface): migrations and legacy callers
      await runtime.persistSettings({ fontSize: 130, showReasoningTraces: false }, { surface: 'mobile' });

      const stored = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(stored.fields.fontSize.value).toBe(100);
      expect(stored.fields.fontSize.surfaces.mobile.value).toBe(130);
      // Not per-surface: written to the base regardless of the surface.
      expect(stored.fields.showReasoningTraces.value).toBe(false);
      expect(stored.fields.showReasoningTraces.surfaces).toBeUndefined();

      expect((await runtime.readSettingsFromDisk({ surface: 'mobile' })).fontSize).toBe(130);
      expect((await runtime.readSettingsFromDisk({ surface: 'desktop' })).fontSize).toBe(100);
      expect((await runtime.readSettingsFromDisk()).fontSize).toBe(100);
      expect((await runtime.readSettingsFromDiskMigrated({ surface: 'mobile' })).fontSize).toBe(130);
    } finally {
      await cleanup();
    }
  });

  it('a per-surface key set only from one surface has no base and stays absent elsewhere', async () => {
    const { runtime, tempRoot, cleanup } = await createMergingRuntime();
    try {
      await runtime.persistSettings({ stickyUserHeader: false }, { surface: 'mobile' });
      const stored = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(stored.fields.stickyUserHeader).not.toHaveProperty('value');
      expect(stored.fields.stickyUserHeader.surfaces.mobile.value).toBe(false);
      expect((await runtime.readSettingsFromDisk({ surface: 'desktop' })).stickyUserHeader).toBeUndefined();
      expect((await runtime.readSettingsFromDisk({ surface: 'mobile' })).stickyUserHeader).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('a per-surface key set only from one surface survives writes from other surfaces and the base', async () => {
    const { runtime, tempRoot, cleanup } = await createMergingRuntime();
    try {
      await runtime.persistSettings({ chatWidth: 'wider' }, { surface: 'desktop' });
      await runtime.persistSettings({ showReasoningTraces: true }, { surface: 'web' });
      await runtime.persistSettings({ showReasoningTraces: false });
      const stored = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(stored.fields.chatWidth.surfaces.desktop.value).toBe('wider');
      expect((await runtime.readSettingsFromDisk({ surface: 'desktop' })).chatWidth).toBe('wider');
    } finally {
      await cleanup();
    }
  });

  it('a surface write of an unrelated key does not copy the resolved per-surface view into the file', async () => {
    const { runtime, tempRoot, cleanup } = await createMergingRuntime();
    try {
      await runtime.persistSettings({ fontSize: 100 });
      await runtime.persistSettings({ fontSize: 130 }, { surface: 'mobile' });
      await runtime.persistSettings({ showReasoningTraces: true }, { surface: 'mobile' });
      const stored = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(stored.fields.fontSize.value).toBe(100);
      expect(stored.fields.fontSize.surfaces.mobile.value).toBe(130);
      expect(stored.fields.fontSize.surfaces.desktop).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('ignores an unknown surface header value and writes the base', async () => {
    const { runtime, tempRoot, cleanup } = await createMergingRuntime();
    try {
      await runtime.persistSettings({ fontSize: 90 }, { surface: 'toaster' });
      const stored = await readJson(path.join(tempRoot, 'preferences.json'));
      expect(stored.fields.fontSize.value).toBe(90);
      expect(stored.fields.fontSize.surfaces).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('settings runtime: notification templates', () => {
  const emptyTemplates = {
    completion: { title: '', message: '' },
    error: { title: '', message: '' },
    question: { title: '', message: '' },
    subtask: { title: '', message: '' },
  };
  const legacySeed = {
    completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
    error: { title: 'Tool error', message: '{last_message}' },
    question: { title: 'Input needed', message: '{last_message}' },
    subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  };

  it('clears the English seed older builds wrote, so the defaults follow the interface language', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ locale: 'zh-CN', notificationTemplates: legacySeed }));
      const settings = await runtime.readSettingsFromDiskMigrated();
      expect(settings.notificationTemplates).toEqual(emptyTemplates);
    } finally {
      await cleanup();
    }
  });

  it('keeps templates the user wrote', async () => {
    const custom = {
      completion: { title: 'Fertig', message: '{last_message}' },
      error: { title: 'Fehler', message: '{last_message}' },
      question: { title: 'Eingabe', message: '{last_message}' },
      subtask: { title: 'Unteraufgabe fertig', message: '' },
    };
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({ notificationTemplates: custom }));
      const settings = await runtime.readSettingsFromDiskMigrated();
      expect(settings.notificationTemplates).toEqual(custom);
    } finally {
      await cleanup();
    }
  });

  it('fills a missing event with empty fields and leaves the others alone', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({
        notificationTemplates: { completion: { title: 'Fertig', message: '' } },
      }));
      const settings = await runtime.readSettingsFromDiskMigrated();
      expect(settings.notificationTemplates).toEqual({
        ...emptyTemplates,
        completion: { title: 'Fertig', message: '' },
      });
    } finally {
      await cleanup();
    }
  });
});
