import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSettingsRuntime } from './settings-runtime.js';
import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';
import { createSettingsHelpers } from './settings-helpers.js';
import { createProjectRegistry } from '../agent-server/project-registry.js';
import { createSettingsMirror } from '../agent-server/settings-mirror.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const makeRuntime = async (overrides = {}) => {
  const root = await fs.mkdtemp('/tmp/opencode/front-door-settings-');
  roots.push(root);
  const settingsFile = path.join(root, 'settings.json');
  const touches = [];
  const realpathSync = (directory) => { touches.push(directory); throw new Error('project access'); };
  const normalization = createSettingsNormalizationRuntime({
    os: { homedir: () => '/front-door-home' }, path, processLike: process, realpathSync,
    readdirSync: realpathSync,
  });
  const helpers = createSettingsHelpers({
    ...normalization, normalizeTunnelProvider: (v) => v, normalizeTunnelMode: (v) => v,
    normalizeOptionalPath: (v) => v,
  });
  const guardedFs = { ...fs };
  for (const method of ['stat', 'realpath', 'access', 'readFile', 'readdir']) {
    guardedFs[method] = async (file, ...args) => {
      if (method === 'stat' || method === 'realpath' || method === 'access'
        || (file !== root && file !== settingsFile && file !== path.join(root, 'preferences.json'))) {
        touches.push(file);
        throw new Error('project access');
      }
      return fs[method](file, ...args);
    };
  }
  const runtime = createSettingsRuntime({
    fsPromises: guardedFs, path, crypto, SETTINGS_FILE_PATH: settingsFile,
    ...normalization, ...helpers, resolveDirectoryCandidate: (v) => v,
    syncManagedRemoteTunnelConfigWithPresets: async () => {}, upsertManagedRemoteTunnelToken: async () => {},
    frontDoor: true, beforeProjectsSave: async () => {}, ...overrides,
  });
  return { runtime, root, settingsFile, touches };
};

describe('front-door settings runtime', () => {
  it('reads and saves without project probes, migration, orphan recovery, or home expansion', async () => {
    const onManagedPluginSettingsChanged = vi.fn();
    const onMessageSearchEnabledChanged = vi.fn();
    const onLastDirectoryChanged = vi.fn();
    const { runtime, settingsFile, touches } = await makeRuntime({
      onManagedPluginSettingsChanged, onMessageSearchEnabledChanged, onLastDirectoryChanged,
    });
    const project = { id: 'legacy-id', path: '/human/project', label: 'Project' };
    await fs.writeFile(settingsFile, JSON.stringify({ projects: [project], lastDirectory: '/human/project' }));
    expect(runtime.formatSettingsResponse(await runtime.readSettingsFromDiskMigrated()).projects).toEqual([project]);
    expect(runtime.sanitizeProjects([project])).toEqual([project]);
    const result = await runtime.persistSettings({
      projects: [project], lastDirectory: '/human/project', homeDirectory: '/home/human', pinnedDirectories: ['/human/project'],
      agentWebToolEnabled: true, messageSearchEnabled: true, opencodeBinary: '~/bin/opencode',
    });
    expect(result.projects).toEqual([project]);
    expect(result.opencodeBinary).toBe('~/bin/opencode');
    expect(touches).toEqual([]);
    expect(onManagedPluginSettingsChanged).not.toHaveBeenCalled();
    expect(onMessageSearchEnabledChanged).not.toHaveBeenCalled();
    expect(onLastDirectoryChanged).not.toHaveBeenCalled();
    await runtime.writeSettingsToDisk({ projects: [], lastDirectory: '/human/old' });
    expect((await runtime.readSettingsFromDiskMigrated()).projects).toEqual([]);
    expect(touches).toEqual([]);
    await expect(runtime.persistSettings({ projects: [{ id: 'bad', path: '~/repo' }] }))
      .rejects.toMatchObject({ code: 'project_path_invalid' });
    expect(touches).toEqual([]);
  });

  it('gates every project writer before any settings or preference write and propagates refusal', async () => {
    const seen = [];
    let settingsFile;
    const beforeProjectsSave = vi.fn(async (projects, current) => {
      seen.push([projects, current]);
      await expect(fs.readFile(settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(path.dirname(settingsFile), 'preferences.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      throw Object.assign(new Error('refused'), { code: 'share_project_unavailable' });
    });
    const fixture = await makeRuntime({ beforeProjectsSave });
    settingsFile = fixture.settingsFile;
    const projects = [{ id: 'new', path: '/human/new' }];
    await expect(fixture.runtime.persistSettings({ projects })).rejects.toMatchObject({ code: 'share_project_unavailable' });
    await expect(fixture.runtime.writeSettingsToDisk({ projects })).rejects.toMatchObject({ code: 'share_project_unavailable' });
    await expect(fixture.runtime.registerSessionProject(() => projects[0])).rejects.toMatchObject({ code: 'share_project_unavailable' });
    expect(seen).toEqual([[projects, []], [projects, []], [projects, []]]);
  });

  it('holds the save lock through sharing and uses the latest projects for the next writer', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const sharing = vi.fn(async () => { entered(); await gate; });
    const registry = createProjectRegistry({ shareProject: sharing });
    const beforeProjectsSave = vi.fn(registry.beforeProjectsSave);
    const { runtime, settingsFile } = await makeRuntime({ beforeProjectsSave });
    const project = { id: 'new', path: '/human/new' };
    const first = runtime.persistSettings({ projects: [project] });
    await started;
    const second = runtime.writeSettingsToDisk({ projects: [project], locale: 'uk' });
    await expect(fs.readFile(settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(beforeProjectsSave).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(sharing).toHaveBeenCalledTimes(1);
    expect(beforeProjectsSave).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(settingsFile, 'utf8'))).toMatchObject({ projects: [project], locale: 'uk' });
  });

  it('notifies after raw, migrated, persisted and registration writes and ignores callback failures', async () => {
    const snapshots = [];
    const diskSnapshots = [];
    let settingsFile;
    const onSettingsWritten = vi.fn(async (settings) => {
      snapshots.push(settings);
      diskSnapshots.push(JSON.parse(await fs.readFile(settingsFile, 'utf8')));
      throw new Error('sensitive upstream failure');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = await makeRuntime({ onSettingsWritten });
    settingsFile = fixture.settingsFile;
    await fixture.runtime.writeSettingsToDisk({ projects: [] });
    await fixture.runtime.readSettingsFromDiskMigrated();
    await fixture.runtime.persistSettings({ locale: 'uk' });
    await fixture.runtime.registerSessionProject(() => ({ id: 'new', path: '/human/new' }));
    expect(onSettingsWritten).toHaveBeenCalledTimes(4);
    expect(diskSnapshots.map((settings) => settings.projects)).toEqual(snapshots.map((settings) => settings.projects));
    expect(snapshots.at(-1)).toMatchObject({ locale: 'uk', projects: [{ id: 'new', path: '/human/new' }] });
    expect(warning.mock.calls).toEqual(Array.from({ length: 4 }, () => ['settings_written_hook_failed']));
  });

  it('does not notify after a failed disk write and permits retry', async () => {
    const onSettingsWritten = vi.fn();
    const fixture = await makeRuntime({ onSettingsWritten });
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    // The injected fs captures the original methods; create another runtime with the failing rename.
    const runtime = createSettingsRuntime({
      fsPromises: { ...fs, rename }, path, crypto, SETTINGS_FILE_PATH: fixture.settingsFile, onSettingsWritten,
    });
    await expect(runtime.writeSettingsToDisk({ locale: 'uk' })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(onSettingsWritten).not.toHaveBeenCalled();
    await runtime.writeSettingsToDisk({ locale: 'en' });
    expect(onSettingsWritten).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a project authorization hook and preserves unreadable authority', async () => {
    const { runtime, settingsFile } = await makeRuntime({ beforeProjectsSave: undefined });
    await expect(runtime.persistSettings({ projects: [{ id: 'a', path: '/human/new' }] }))
      .rejects.toMatchObject({ code: 'share_project_unavailable' });
    await expect(runtime.writeSettingsToDisk({ projects: null }))
      .rejects.toMatchObject({ code: 'project_registry_invalid' });
    await fs.writeFile(settingsFile, '{broken');
    await expect(runtime.persistSettings({ locale: 'uk' })).rejects.toThrow();
    await expect(runtime.readSettingsFromDiskMigrated()).rejects.toThrow();
    expect(await fs.readFile(settingsFile, 'utf8')).toBe('{broken');
  });

  it('mirrors non-HTTP writes while owner settings survive hostile replies and mirror failure', async () => {
    const upstream = { json: vi.fn().mockResolvedValueOnce({ locale: 'hostile', desktopUiPassword: 'hostile' })
      .mockRejectedValueOnce(new Error('private upstream response')) };
    const logger = { warn: vi.fn() };
    const mirror = createSettingsMirror({ upstream, logger });
    const { runtime, settingsFile } = await makeRuntime({ onSettingsWritten: mirror.onSettingsWritten });
    await runtime.writeSettingsToDisk({ locale: 'uk', desktopUiPassword: 'owner-secret' });
    await expect(runtime.writeSettingsToDisk({ locale: 'fr', desktopUiPassword: 'owner-secret' })).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(settingsFile, 'utf8'))).toMatchObject({ locale: 'fr', desktopUiPassword: 'owner-secret' });
    const sent = upstream.json.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(sent.map((settings) => settings.locale)).toEqual(['uk', 'fr']);
    for (const settings of sent) {
      expect(settings).not.toHaveProperty('desktopUiPassword');
      expect(settings).not.toHaveProperty('permissionAutoAccept');
      expect(settings).toMatchObject({ projects: [], fallbackModel: '', permissionDefaultMode: 'ask' });
    }
    expect(logger.warn.mock.calls).toEqual([['agent_settings_mirror_failed']]);
  });
});
