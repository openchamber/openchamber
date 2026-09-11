import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';
import { createSettingsRuntime } from './settings-runtime.js';

const createRuntime = async ({
  mergePersistedSettings = (_current, changes) => changes,
  fsPromises: fs = fsPromises,
  getBroadcastGlobalUiEvent,
} = {}) => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
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
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
    getBroadcastGlobalUiEvent,
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

  it('round-trips shared sidebar preferences through preferences.json', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    const preferences = {
      sidebarProjectDisplayMode: 'single',
      sidebarSessionGroupingMode: 'flat',
      sidebarProjectSortOrder: 'date-added',
      sidebarShowRecentSection: false,
    };
    try {
      await runtime.persistSettings(preferences);

      await expect(runtime.readSettingsFromDisk()).resolves.toEqual(preferences);
      // Profile keys live in preferences.json; settings.json keeps a legacy copy for older builds.
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'))).toEqual(preferences);
      const stored = JSON.parse(await fsPromises.readFile(path.join(tempRoot, 'preferences.json'), 'utf8'));
      expect(Object.fromEntries(Object.entries(stored.fields).map(([key, entry]) => [key, entry.value]))).toEqual(preferences);
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

      await runtime.persistSettings({ fontSize: 130, desktopKeepAwakeEnabled: true });

      expect(await fsPromises.readFile(preferencesPath, 'utf8')).toBe('{ not json');
      const settings = await readJson(settingsFilePath);
      expect(settings.desktopKeepAwakeEnabled).toBe(true);
      // The refused profile write must not land in the legacy copy either.
      expect(settings).not.toHaveProperty('fontSize');
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

describe('settings runtime: persist broadcast and queue recovery', () => {
  it('emits exactly one payload-free UI event per successful persist', async () => {
    const events = [];
    const { runtime, cleanup } = await createRuntime({
      getBroadcastGlobalUiEvent: () => (payload) => events.push(payload),
    });
    try {
      await runtime.persistSettings({ themeId: 'dark' });
      expect(events).toEqual([{ type: 'openchamber:settings.updated' }]);

      await runtime.persistSettings({ themeId: 'light' });
      expect(events).toEqual([
        { type: 'openchamber:settings.updated' },
        { type: 'openchamber:settings.updated' },
      ]);
      for (const event of events) {
        expect(Object.keys(event)).toEqual(['type']);
        expect(event.properties).toBeUndefined();
      }
    } finally {
      await cleanup();
    }
  });

  it('emits no UI event when the settings write fails', async () => {
    const events = [];
    const failingFs = {
      ...fsPromises,
      rename: async () => {
        const error = new Error('disk failure');
        error.code = 'EIO';
        throw error;
      },
    };
    const { runtime, cleanup } = await createRuntime({
      fsPromises: failingFs,
      getBroadcastGlobalUiEvent: () => (payload) => events.push(payload),
    });
    try {
      await expect(runtime.persistSettings({ themeId: 'dark' })).rejects.toThrow('disk failure');
      expect(events).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('recovers the persist queue after a failed write without emitting for the failure', async () => {
    const events = [];
    let renameCalls = 0;
    const flakyFs = {
      ...fsPromises,
      rename: async (...args) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          const error = new Error('disk failure');
          error.code = 'EIO';
          throw error;
        }
        return fsPromises.rename(...args);
      },
    };
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({
      fsPromises: flakyFs,
      getBroadcastGlobalUiEvent: () => (payload) => events.push(payload),
    });
    try {
      // A valid preferences file keeps the first persist from seeding it: the
      // settings write itself is the first rename, and the one that fails.
      await fsPromises.writeFile(
        path.join(tempRoot, 'preferences.json'),
        JSON.stringify({ version: 1, fields: {} }),
        'utf8',
      );

      const failedPersist = runtime.persistSettings({ themeId: 'dark' });
      // Queue the next persist while the first is still failing: the queue must
      // recover and run it instead of replaying the earlier rejection.
      const recoveredPersist = runtime.persistSettings({ themeId: 'light' });

      await expect(failedPersist).rejects.toThrow('disk failure');
      await recoveredPersist;
      expect(events).toEqual([{ type: 'openchamber:settings.updated' }]);

      const persisted = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(persisted).toEqual({ themeId: 'light' });
    } finally {
      await cleanup();
    }
  });
});
