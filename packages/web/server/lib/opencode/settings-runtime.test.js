import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';
import { createSettingsRuntime } from './settings-runtime.js';

const createRuntime = async ({
  mergePersistedSettings = (_current, changes) => changes,
  onManagedPluginSettingsChanged = undefined,
  onPermissionDefaultModeChanged = undefined,
  onLastDirectoryChanged = undefined,
  chatRoots = undefined,
  fs = fsPromises,
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
    chatRoots,
    onManagedPluginSettingsChanged,
    onPermissionDefaultModeChanged,
    onLastDirectoryChanged,
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

  it('persists imported projects and their completion marker in the instance document', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime({
      mergePersistedSettings: (current, changes) => ({ ...current, ...changes }),
    });
    try {
      const directory = path.join(tempRoot, 'imported');
      await fsPromises.mkdir(directory);
      await runtime.persistSettings({ projects: [{ path: directory }], openCodeProjectImportCompleted: true });
      const saved = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(saved.openCodeProjectImportCompleted).toBe(true);
      expect(saved.projects.map((project) => project.path)).toEqual([directory]);
      await runtime.persistSettings({ lightThemeId: 'openchamber-light' });
      expect((await runtime.readSettingsFromDisk()).openCodeProjectImportCompleted).toBe(true);
    } finally {
      await cleanup();
    }
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

  it('round-trips shared sidebar preferences through preferences.json', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    const preferences = {
      sidebarProjectDisplayMode: 'single',
      sidebarViewMode: 'timeline',
      sidebarProjectSortOrder: 'date-added',
      sidebarShowChatsSection: false,
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
