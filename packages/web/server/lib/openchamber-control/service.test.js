import { describe, expect, it, vi } from 'vitest';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createOpenChamberControlService } from './service.js';
import { OpenChamberControlError } from './error.js';

const createService = (overrides = {}) => {
  const client = {
    session: {
      list: vi.fn(async () => ({ data: [] })),
      active: vi.fn(async () => ({})),
      remove: vi.fn(async () => true),
    },
    message: {
      list: vi.fn(async () => ({ data: [] })),
    },
  };
  const sessionService = {
    create: vi.fn(async () => ({ sessionId: 'ses_1', directory: '/repo', promptDispatched: false })),
    resolveDirectory: vi.fn(async ({ projectId }) => {
      if (projectId === 'project-1') return '/repo';
      throw new OpenChamberControlError('Project not found', 404);
    }),
    send: vi.fn(),
    fork: vi.fn(),
  };
  const scheduledTaskService = {
    status: vi.fn(async () => ({ enabledScheduledTasksCount: 0 })),
    resolveProjectID: vi.fn(async () => 'project-1'),
    list: vi.fn(async () => []),
    upsert: vi.fn(),
    run: vi.fn(),
    remove: vi.fn(),
    setEnabled: vi.fn(),
  };
  const service = createOpenChamberControlService({
    readSettingsFromDiskMigrated: vi.fn(async () => ({
      projects: [{ id: 'project-1', path: '/repo', label: 'Repo' }],
      defaultModel: 'provider/model',
      favoriteModels: [],
      recentModels: [],
    })),
    sanitizeProjects: (projects) => projects,
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
    waitForOpenCodeReady: vi.fn(),
    createClient: vi.fn(() => client),
    sessionService,
    scheduledTaskService,
    ...overrides,
  });
  return { service, client, sessionService, scheduledTaskService };
};

describe('OpenChamber control service', () => {
  it('creates a target task with inherited selection and accepts retargeting on update', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.upsert.mockImplementation(async (_project, task) => ({ task }));
    const created = await service.execute('schedule.create', { name: 'Reuse', prompt: 'Continue', daily: '09:00', targetSessionId: 'ses_target' }, '/repo');
    expect(created.task).toMatchObject({ targetSessionId: 'ses_target', execution: { useDefaults: true } });
    scheduledTaskService.list.mockResolvedValue([{ ...created.task, id: 'task-1' }]);
    await service.execute('schedule.update', { taskId: 'task-1', targetSessionId: 'ses_second', agent: 'plan' }, '/repo');
    expect(scheduledTaskService.upsert.mock.calls[1][1]).toMatchObject({ targetSessionId: 'ses_second', execution: { agent: 'plan' } });
    expect(scheduledTaskService.upsert.mock.calls[1][1].execution.useDefaults).toBeUndefined();
  });
  it('serves project and model projections without an HTTP or CLI round trip', async () => {
    const { service } = createService();
    await expect(service.execute('projects.list')).resolves.toEqual({
      projects: [{ id: 'project-1', path: '/repo', label: 'Repo', settings: { label: 'Repo' } }],
    });
    await expect(service.execute('models.list')).resolves.toEqual(expect.objectContaining({
      defaultModel: 'provider/model',
      favoriteModels: [],
    }));
  });

  it('dispatches module actions with a session-scoped directory resolver', async () => {
    const execute = vi.fn(async (_action, input, ctx) => ({ directory: await ctx.resolveSessionDirectory(input) }));
    const { service } = createService({ actionModules: [{ actions: ['session.rename'], execute }] });
    await expect(service.execute('session.rename', { directory: '/explicit', title: 't' }, '/ctx')).resolves.toEqual({ directory: '/explicit' });
    await expect(service.execute('session.rename', { projectId: 'project-1', title: 't' }, '/ctx')).resolves.toEqual({ directory: '/repo' });
    await expect(service.execute('session.rename', { title: 't' }, '/ctx')).resolves.toEqual({ directory: '/ctx' });
    await expect(service.execute('session.rename', { directory: '/a', projectId: 'project-1' }, '/ctx')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('schedule.get returns one task by id and 404s an unknown one', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.list.mockResolvedValue([{ id: 'task-1', name: 'Daily' }]);
    await expect(service.execute('schedule.get', { taskId: 'task-1' }, '/repo')).resolves.toEqual({ task: { id: 'task-1', name: 'Daily' } });
    await expect(service.execute('schedule.get', { taskId: 'nope' }, '/repo')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.execute('schedule.get', {}, '/repo')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('session.create makes a worktree named from the prompt by the session model by default', async () => {
    const generateWorktreeName = vi.fn(async () => 'add-csv-export');
    const { service, sessionService } = createService({
      isGitRepository: vi.fn(async () => true),
      generateWorktreeName,
      randomWorktreeName: vi.fn(async () => 'random-name'),
    });
    const result = await service.execute('session.create', { prompt: 'Add CSV export', model: 'anthropic/claude' }, '/repo');
    expect(generateWorktreeName).toHaveBeenCalledWith({ prompt: 'Add CSV export', model: 'anthropic/claude', directory: '/repo' });
    expect(sessionService.create).toHaveBeenCalledWith(expect.objectContaining({ worktree: { name: 'add-csv-export' } }));
    expect(result.autoWorktree).toEqual({ mode: 'auto', name: 'add-csv-export', naming: 'generated', model: 'anthropic/claude' });
  });

  it('session.create names with worktreeNameModel, then the default model, and falls back to a random name', async () => {
    const generateWorktreeName = vi.fn(async () => '');
    const { service, sessionService } = createService({
      isGitRepository: vi.fn(async () => true),
      generateWorktreeName,
      randomWorktreeName: vi.fn(async () => 'cosmic-dolphin'),
    });
    await service.execute('session.create', { prompt: 'x', worktreeNameModel: 'openai/mini' }, '/repo');
    expect(generateWorktreeName.mock.calls[0][0].model).toBe('openai/mini');
    await service.execute('session.create', { prompt: 'x' }, '/repo');
    expect(generateWorktreeName.mock.calls[1][0].model).toBe('provider/model');
    expect(sessionService.create.mock.calls[1][0].worktree).toEqual({ name: 'cosmic-dolphin' });
  });

  it('session.create stays in the directory when newWorktree is false, a name is given, or it is not a git repo', async () => {
    const isGitRepository = vi.fn(async (dir) => dir === '/repo');
    const generateWorktreeName = vi.fn(async () => 'n');
    const { service, sessionService } = createService({ isGitRepository, generateWorktreeName, randomWorktreeName: vi.fn() });
    await service.execute('session.create', { prompt: 'x', newWorktree: false }, '/repo');
    expect(sessionService.create.mock.calls[0][0]).not.toHaveProperty('worktree');
    await service.execute('session.create', { prompt: 'x', worktree: 'mine' }, '/repo');
    expect(sessionService.create.mock.calls[1][0].worktree).toEqual({ name: 'mine' });
    const skipped = await service.execute('session.create', { prompt: 'x' }, '/plain');
    expect(sessionService.create.mock.calls[2][0]).not.toHaveProperty('worktree');
    expect(skipped.autoWorktree).toEqual({ mode: 'skipped', reason: 'not a git repository' });
    expect(generateWorktreeName).not.toHaveBeenCalled();
  });

  it('session.create names a new branch from a pull request from the prompt, and leaves a checkout to its branch', async () => {
    const generateWorktreeName = vi.fn(async () => 'csv-export');
    const { service, sessionService } = createService({ generateWorktreeName });
    const result = await service.execute('session.create', { prompt: 'Add CSV export', model: 'anthropic/claude', pullRequest: 42, branchOff: true }, '/repo');
    expect(sessionService.create).toHaveBeenCalledWith(expect.objectContaining({
      pullRequest: 42, branchOff: true, worktree: { name: 'csv-export' },
    }));
    expect(result.autoWorktree).toMatchObject({ mode: 'auto', name: 'csv-export', naming: 'generated' });

    await service.execute('session.create', { prompt: 'Review it', pullRequest: 43 }, '/repo');
    expect(sessionService.create.mock.calls[1][0].worktree).toEqual({});
    expect(generateWorktreeName).toHaveBeenCalledTimes(1);
  });

  it('session.create leaves a malformed branchOff to the session service, unnamed, even when Settings branch off', async () => {
    const generateWorktreeName = vi.fn(async () => 'csv-export');
    const { service, sessionService } = createService({
      generateWorktreeName,
      readSettingsFromDiskMigrated: vi.fn(async () => ({ projects: [{ id: 'project-1', path: '/repo' }], pullRequestWorktree: 'branch-off' })),
    });
    await service.execute('session.create', { prompt: 'x', pullRequest: 42, branchOff: 'false' }, '/repo');
    expect(sessionService.create.mock.calls[0][0]).toMatchObject({ pullRequest: 42, branchOff: 'false', worktree: {} });

    await service.execute('session.create', { prompt: 'x', pullRequest: 42 }, '/repo');
    expect(sessionService.create.mock.calls[1][0]).toMatchObject({ branchOff: true, worktree: { name: 'csv-export' } });
    expect(generateWorktreeName).toHaveBeenCalledTimes(1);
  });

  it('session.create passes branchOff with a pull request to the session service', async () => {
    const { service, sessionService } = createService({ isGitRepository: vi.fn(async () => true) });
    await service.execute('session.create', { prompt: 'Follow up', pullRequest: 42, branchOff: true, worktree: 'follow-up' }, '/repo');
    expect(sessionService.create).toHaveBeenCalledWith(expect.objectContaining({
      pullRequest: 42, branchOff: true, worktree: { name: 'follow-up' },
    }));
  });

  it('rejects projects.add and projects.remove when the server has not wired the dependencies they need', async () => {
    const { service } = createService();
    await expect(service.execute('projects.add', { directory: '/repo2' })).rejects.toMatchObject({
      statusCode: 503,
      message: 'Adding projects is not available on this server',
    });
    await expect(service.execute('projects.remove', { projectId: 'project-1' })).rejects.toMatchObject({
      statusCode: 503,
      message: 'Removing projects is not available on this server',
    });
  });

  it('adds a project the same way the directory route does: validated, deduplicated by path, made active', async () => {
    let storedProjects = [{ id: 'project-1', path: '/repo', label: 'Repo' }];
    const persistSettings = vi.fn(async (changes) => {
      if (changes.projects) storedProjects = changes.projects;
      return { projects: storedProjects, activeProjectId: changes.activeProjectId };
    });
    const { service } = createService({
      readSettingsFromDiskMigrated: vi.fn(async () => ({ projects: storedProjects })),
      fsPromises: { mkdir: vi.fn(async () => {}) },
      validateDirectoryPath: vi.fn(async (candidate) => ({ ok: true, directory: candidate })),
      persistSettings,
      createProjectIdFromPath: (p) => `project-id-of-${p}`,
    });

    const added = await service.execute('projects.add', { directory: '/repo2', projectLabel: 'Repo Two' });
    expect(added).toEqual({
      project: { id: 'project-id-of-/repo2', path: '/repo2', label: 'Repo Two' },
      alreadyConfigured: false,
    });
    expect(persistSettings).toHaveBeenCalledWith(expect.objectContaining({
      activeProjectId: 'project-id-of-/repo2',
      lastDirectory: '/repo2',
    }));

    // Adding the same directory again is a no-op that reports the existing entry.
    const addedAgain = await service.execute('projects.add', { directory: '/repo2' });
    expect(addedAgain).toEqual({
      project: { id: 'project-id-of-/repo2', path: '/repo2', label: 'Repo Two' },
      alreadyConfigured: true,
    });
    expect(storedProjects).toHaveLength(2);
  });

  it('rejects projects.add when the directory fails validation, and requires directory at all', async () => {
    const { service } = createService({
      fsPromises: { mkdir: vi.fn() },
      validateDirectoryPath: vi.fn(async () => ({ ok: false, error: 'Directory not found' })),
      persistSettings: vi.fn(),
      createProjectIdFromPath: (p) => p,
    });
    await expect(service.execute('projects.add', { directory: '/missing' })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Directory not found',
    });
    await expect(service.execute('projects.add', {})).rejects.toMatchObject({
      statusCode: 400,
      message: 'directory is required',
    });
  });

  it('changes per-project settings through the settings writer and refuses what the sanitizer would drop', async () => {
    let storedProjects = [{ id: 'project-1', path: '/repo', label: 'Repo', color: 'blue' }];
    const persistSettings = vi.fn(async (changes) => {
      storedProjects = changes.projects;
      return { projects: storedProjects };
    });
    // Stands in for the server sanitizer's rule that a model is provider/model.
    const sanitizeProjects = (entries) => entries.map((entry) => {
      const { defaultModel, ...rest } = entry;
      return defaultModel?.includes('/') ? { ...rest, defaultModel } : rest;
    });
    const { service } = createService({
      readSettingsFromDiskMigrated: vi.fn(async () => ({ projects: storedProjects })),
      sanitizeProjects,
      fsPromises: {},
      validateDirectoryPath: vi.fn(),
      persistSettings,
      createProjectIdFromPath: (p) => p,
    });

    await expect(service.execute('projects.update', { projectId: 'project-1', projectSettings: { defaultModel: 'openai/gpt', color: null } }))
      .resolves.toMatchObject({ project: { id: 'project-1', settings: { label: 'Repo', defaultModel: 'openai/gpt' } } });
    expect(storedProjects[0]).not.toHaveProperty('color');
    expect(storedProjects[0].defaultModel).toBe('openai/gpt');

    persistSettings.mockClear();
    await expect(service.execute('projects.update', { projectId: 'project-1', projectSettings: { defaultModel: 'no-provider' } }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/^Nothing was saved.*defaultModel/) });
    await expect(service.execute('projects.update', { projectId: 'project-1', projectSettings: { path: '/elsewhere' } }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Not a project setting: path/) });
    await expect(service.execute('projects.update', { projectId: 'nope', projectSettings: { label: 'x' } }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('keeps a hex colour the sanitizer lowercases, and says when clearing a model clears its variant', async () => {
    let storedProjects = [{ id: 'project-1', path: '/repo', defaultModel: 'openai/gpt', defaultVariant: 'high' }];
    const persistSettings = vi.fn(async (changes) => {
      storedProjects = changes.projects;
      return { projects: storedProjects };
    });
    // Stands in for the server sanitizer: lowercases a hex colour, and keeps a
    // variant only with a model (settings-normalization-runtime.js).
    const sanitizeProjects = (entries) => entries.map((entry) => {
      const next = { ...entry };
      if (next.iconBackground) next.iconBackground = next.iconBackground.toLowerCase();
      if (!next.defaultModel) delete next.defaultVariant;
      return next;
    });
    const { service } = createService({
      readSettingsFromDiskMigrated: vi.fn(async () => ({ projects: storedProjects })),
      sanitizeProjects,
      fsPromises: {},
      validateDirectoryPath: vi.fn(),
      persistSettings,
      createProjectIdFromPath: (p) => p,
    });

    await expect(service.execute('projects.update', { projectId: 'project-1', projectSettings: { iconBackground: '#AABBCC' } }))
      .resolves.toMatchObject({ project: { settings: { iconBackground: '#aabbcc' } } });

    const cleared = await service.execute('projects.update', { projectId: 'project-1', projectSettings: { defaultModel: null } });
    expect(cleared.alsoCleared).toEqual(['defaultVariant']);
    expect(cleared.note).toMatch(/defaultVariant was cleared too/);
  });

  it('runs concurrent project changes through updateSettings so none writes over another', async () => {
    // A store whose reads and writes yield, so two read-then-write sequences
    // interleave unless something serializes them. updateSettings serializes
    // the way the settings runtime does: one read-compute-write at a time.
    let stored = { projects: [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }, { id: 'c', path: '/c' }] };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    const persistSettings = vi.fn(async (changes) => { await tick(); stored = { ...stored, ...changes }; return stored; });
    let lock = Promise.resolve();
    const updateSettings = vi.fn((compute) => {
      const run = lock.then(async () => {
        await tick();
        const changes = await compute(structuredClone(stored));
        if (changes) await persistSettings(changes);
      });
      lock = run.catch(() => {});
      return run;
    });
    const { service } = createService({
      readSettingsFromDiskMigrated: vi.fn(async () => { await tick(); return structuredClone(stored); }),
      sanitizeProjects: (entries) => entries,
      fsPromises: {},
      validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
      persistSettings,
      createProjectIdFromPath: (p) => `id${p}`,
      updateSettings,
    });

    await Promise.all([
      service.execute('projects.update', { projectId: 'a', projectSettings: { label: 'A' } }),
      service.execute('projects.update', { projectId: 'b', projectSettings: { label: 'B' } }),
      service.execute('projects.remove', { projectId: 'c' }),
      service.execute('projects.add', { directory: '/d' }),
    ]);

    expect(stored.projects).toEqual([
      { id: 'a', path: '/a', label: 'A' },
      { id: 'b', path: '/b', label: 'B' },
      expect.objectContaining({ id: 'id/d', path: '/d' }),
    ]);
    expect(updateSettings).toHaveBeenCalledTimes(4);
  });

  it('a refused project change inside updateSettings writes nothing and does not block the next one', async () => {
    let stored = { projects: [{ id: 'a', path: '/a' }] };
    const persistSettings = vi.fn(async (changes) => { stored = { ...stored, ...changes }; return stored; });
    let lock = Promise.resolve();
    const updateSettings = (compute) => {
      const run = lock.then(async () => {
        const changes = await compute(structuredClone(stored));
        if (changes) await persistSettings(changes);
      });
      lock = run.catch(() => {});
      return run;
    };
    const { service } = createService({
      readSettingsFromDiskMigrated: vi.fn(async () => structuredClone(stored)),
      sanitizeProjects: (entries) => entries,
      fsPromises: {},
      validateDirectoryPath: vi.fn(),
      persistSettings,
      createProjectIdFromPath: (p) => p,
      updateSettings,
    });

    await expect(service.execute('projects.update', { projectId: 'nope', projectSettings: { label: 'x' } }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(persistSettings).not.toHaveBeenCalled();
    await expect(service.execute('projects.update', { projectId: 'a', projectSettings: { label: 'A' } }))
      .resolves.toMatchObject({ project: { id: 'a', settings: { label: 'A' } } });
  });

  it('removes a configured project by id, leaving its checkout untouched, and rejects an unknown id', async () => {
    const persistSettings = vi.fn(async () => ({}));
    const { service } = createService({
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        projects: [{ id: 'project-1', path: '/repo', label: 'Repo' }, { id: 'project-2', path: '/repo2', label: 'Repo Two' }],
      })),
      fsPromises: {},
      validateDirectoryPath: vi.fn(),
      persistSettings,
      createProjectIdFromPath: (p) => p,
    });

    await expect(service.execute('projects.remove', { projectId: 'project-2' })).resolves.toEqual({
      removed: { id: 'project-2', path: '/repo2', label: 'Repo Two' },
    });
    expect(persistSettings).toHaveBeenCalledWith({ projects: [{ id: 'project-1', path: '/repo', label: 'Repo' }] });
    expect(persistSettings.mock.calls[0][0]).not.toHaveProperty('activeProjectId');

    await expect(service.execute('projects.remove', { projectId: 'does-not-exist' })).rejects.toMatchObject({
      statusCode: 404,
      message: 'Unknown project: does-not-exist',
    });
    await expect(service.execute('projects.remove', {})).rejects.toMatchObject({
      statusCode: 400,
      message: 'projectId is required',
    });
  });

  it('searches the model catalog the way the picker shows it', async () => {
    const model = (providerID, id, released, family) => ({
      providerID, id, name: id, family, time: { released }, variants: [{ id: 'high' }], cost: [], status: 'active',
    });
    const { service, client } = createService({
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        favoriteModels: [{ providerID: 'b', modelID: 'old' }],
        recentModels: [],
        hiddenModels: [{ providerID: 'a', modelID: 'secret' }],
      })),
    });
    client.model = { list: vi.fn(async () => ({ data: [
      model('a', 'new', 3, 'fam'), model('a', 'older', 2, 'fam'), model('a', 'secret', 4),
      model('b', 'old', 1, 'bfam'), model('b', 'newer', 5, 'bfam'),
    ] })) };
    client.provider = { list: vi.fn(async () => ({ data: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] })) };

    const first = await service.execute('models.search', {}, '/repo');
    // The favorite leads, a hidden model never shows, older versions fold into their family.
    expect(first.models.map(({ id }) => id)).toEqual(['b/old', 'a/new', 'b/newer']);
    expect(first.models[0]).toMatchObject({ preference: 'favorite', provider: 'Beta', variants: ['high'] });
    expect(first.models[1].preference).toBeUndefined();
    expect(first.total).toBe(3);

    const all = await service.execute('models.search', { all: true, provider: 'alpha' }, '/repo');
    expect(all.models.map(({ id }) => id)).toEqual(['a/new', 'a/older']);

    const paged = await service.execute('models.search', { query: 'NEW', limit: 1 }, '/repo');
    expect(paged).toMatchObject({ models: [{ id: 'a/new' }], total: 2, next: 1 });
  });

  it('maps schedule creation into the shared scheduled-task service', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.upsert.mockResolvedValue({ task: { id: 'task-1' }, created: true });
    await expect(service.execute('schedule.create', {
      directory: '/repo',
      name: 'Daily',
      prompt: 'Run checks',
      model: 'provider/model',
      daily: ' 09:00 ',
      goal: true,
      goalTokenBudget: 5000,
    })).resolves.toEqual({ task: { id: 'task-1' }, created: true });
    expect(scheduledTaskService.resolveProjectID).toHaveBeenCalledWith({ projectId: undefined, directory: '/repo' });
    expect(scheduledTaskService.upsert).toHaveBeenCalledWith('project-1', expect.objectContaining({
      name: 'Daily',
      schedule: { kind: 'daily', times: ['09:00'] },
      execution: expect.objectContaining({ providerID: 'provider', modelID: 'model', goalEnabled: true, goalTokenBudget: 5000 }),
    }));
  });

  it('rejects malformed weekly weekdays instead of coercing them', async () => {
    for (const weekly of ['1.9', '0x1', '1abc,2', '+3', '3e0', '7', '-1', '1,,2']) {
      const { service, scheduledTaskService } = createService();
      await expect(service.execute('schedule.create', {
        directory: '/repo',
        name: 'Weekly',
        prompt: 'Run checks',
        model: 'provider/model',
        weekly,
        time: '09:00',
      }, '/repo')).rejects.toMatchObject({ statusCode: 400 });
      expect(scheduledTaskService.upsert).not.toHaveBeenCalled();
    }
  });

  it('accepts well-formed weekly weekdays, deduped and sorted', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.upsert.mockImplementation(async (_project, task) => ({ task, created: true }));
    await service.execute('schedule.create', {
      directory: '/repo',
      name: 'Weekly',
      prompt: 'Run checks',
      model: 'provider/model',
      weekly: '6, 0,6',
      time: '09:00',
    }, '/repo');
    expect(scheduledTaskService.upsert.mock.calls[0][1].schedule).toEqual({ kind: 'weekly', weekdays: [0, 6], times: ['09:00'] });
  });

  it('updates a scheduled task in place, changing only the named fields', async () => {
    const { service, scheduledTaskService } = createService();
    const existing = {
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
      execution: { prompt: 'Old', providerID: 'a', modelID: 'm', variant: 'high', agent: 'build' },
      state: { lastRunAt: 5, lastStatus: 'success' },
    };
    scheduledTaskService.list.mockResolvedValue([existing]);
    scheduledTaskService.upsert.mockImplementation(async (_project, task) => ({ task, created: false }));

    await service.execute('schedule.update', { taskId: 'task-1', prompt: 'New', model: 'b/n', cron: '0 * * * *' }, '/repo');
    const saved = scheduledTaskService.upsert.mock.calls[0][1];
    expect(saved).toEqual({
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule: { kind: 'cron', cron: '0 * * * *' },
      execution: { prompt: 'New', providerID: 'b', modelID: 'n', agent: 'build' },
    });
    // No state in the patch: the stored run history is kept.
    expect(saved.state).toBeUndefined();

    await service.execute('schedule.update', { taskId: 'task-1', timezone: 'Europe/Kyiv', disabled: true }, '/repo');
    expect(scheduledTaskService.upsert.mock.calls[1][1]).toMatchObject({
      enabled: false,
      schedule: { kind: 'daily', times: ['09:00'], timezone: 'Europe/Kyiv' },
      execution: existing.execution,
    });
  });

  it('refuses to update a missing task or one driven by a loop file', async () => {
    const { service, scheduledTaskService } = createService();
    await expect(service.execute('schedule.update', { taskId: 'nope', prompt: 'x' }, '/repo')).rejects.toThrow('Scheduled task not found');
    scheduledTaskService.list.mockResolvedValue([{ id: 'loop:project:x', loopFile: '/repo/.agents/loops/x.md', name: 'x', execution: {}, schedule: {} }]);
    await expect(service.execute('schedule.update', { taskId: 'loop:project:x', prompt: 'x' }, '/repo')).rejects.toThrow('change that file instead');
  });

  it('does not combine an explicit schedule project with the tool context directory', async () => {
    const { service, scheduledTaskService } = createService();
    await service.execute('schedule.list', { projectId: ' project-1 ' }, '/current-session');
    expect(scheduledTaskService.resolveProjectID).toHaveBeenCalledWith({ projectId: 'project-1', directory: undefined });
  });

  it('includes scheduler status alongside listed tasks', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.list.mockResolvedValue([{ id: 'task-1' }]);
    await expect(service.execute('schedule.list', {}, '/repo')).resolves.toEqual({
      scheduler: { enabledScheduledTasksCount: 0 },
      tasks: [{ id: 'task-1' }],
    });
  });

  it('toggles a scheduled task through the required disabled boolean', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.setEnabled.mockResolvedValue({ id: 'task-1', enabled: false });
    await expect(service.execute('schedule.toggle', { taskId: 'task-1' }, '/repo')).rejects.toThrow('disabled is required for schedule.toggle');
    await expect(service.execute('schedule.toggle', { taskId: 'task-1', disabled: true }, '/repo')).resolves.toEqual({
      task: { id: 'task-1', enabled: false },
      enabled: false,
    });
    expect(scheduledTaskService.setEnabled).toHaveBeenCalledWith('project-1', 'task-1', false);
  });

  it('reports the enabled state that was saved, not the one requested', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.setEnabled.mockResolvedValue({ id: 'task-1', enabled: false });
    await expect(service.execute('schedule.toggle', { taskId: 'task-1', disabled: false }, '/repo')).resolves.toEqual({
      task: { id: 'task-1', enabled: false },
      enabled: false,
    });
  });

  it('returns an actionable taskId error before resolving schedule scope', async () => {
    const { service, scheduledTaskService } = createService();
    await expect(service.execute('schedule.run', {}, '/repo')).rejects.toThrow('taskId is required');
    expect(scheduledTaskService.resolveProjectID).not.toHaveBeenCalled();
    expect(scheduledTaskService.run).not.toHaveBeenCalled();
  });

  it('validates wait modifiers before creating a session', async () => {
    const { service, sessionService } = createService();
    await expect(service.execute('session.create', { directory: '/repo', timeout: 30 })).rejects.toThrow('timeout requires wait');
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('uses the tool context directory for session actions', async () => {
    const { service, sessionService } = createService();
    await service.execute('session.create', { title: 'From tool' }, '/repo');
    expect(sessionService.create).toHaveBeenCalledWith({ directory: '/repo', title: 'From tool' });
  });

  it('forwards subagentPolicy unchanged on session.create and leaves it off send and fork', async () => {
    const { service, sessionService } = createService();
    const subagentPolicy = {
      models: ['anthropic/claude-haiku-5-5', 'opencode-go/*'],
      excludedModels: ['openai/gpt-5'],
      agentOverrides: { build: { models: ['anthropic/claude-haiku-5-5'] } },
    };
    await service.execute('session.create', { title: 'Governed', subagentPolicy, newWorktree: false }, '/repo');
    expect(sessionService.create).toHaveBeenCalledWith({ directory: '/repo', title: 'Governed', subagentPolicy });
    sessionService.send.mockResolvedValue({ sessionId: 'ses_1', directory: '/repo' });
    await service.execute('session.send', { sessionId: 'ses_1', prompt: 'Go', subagentPolicy }, '/repo');
    expect(sessionService.send).toHaveBeenCalledWith('ses_1', { directory: '/repo', prompt: 'Go' });
  });

  it('refuses a subagentPolicy that is not an object on session.create', async () => {
    const { service, sessionService } = createService();
    for (const subagentPolicy of ['anthropic/claude', ['anthropic/claude'], 42]) {
      await expect(service.execute('session.create', { title: 'Governed', subagentPolicy, newWorktree: false }, '/repo'))
        .rejects.toThrow('subagentPolicy must be an object');
    }
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('hands a pull request number to session creation with the folder and branch names it may carry', async () => {
    const { service, sessionService } = createService();
    await service.execute('session.create', { pullRequest: 42 }, '/repo');
    await service.execute('session.create', { pullRequest: 42, worktree: ' review ', branch: 'review-42' }, '/repo');
    expect(sessionService.create.mock.calls).toEqual([
      [{ directory: '/repo', worktree: {}, pullRequest: 42 }],
      [{ directory: '/repo', worktree: { name: 'review', branchName: 'review-42' }, pullRequest: 42 }],
    ]);
  });

  it('refuses a pull request number on a send or fork, which would ignore it', async () => {
    const { service, sessionService } = createService();
    await expect(service.execute('session.send', { sessionId: 'ses_1', prompt: 'Go', pullRequest: 42 }, '/repo'))
      .rejects.toThrow('pullRequest applies only to session.create');
    expect(sessionService.send).not.toHaveBeenCalled();
  });

  it.each([
    ['session.send', 'send'],
    ['session.fork', 'fork'],
  ])('delegates %s directly to the session service', async (action, method) => {
    const { service, sessionService } = createService();
    sessionService[method].mockResolvedValue({ sessionId: 'ses_1', directory: '/repo' });

    await service.execute(action, { sessionId: 'ses_1', directory: '/repo', prompt: 'Continue' });

    expect(sessionService[method]).toHaveBeenCalledWith('ses_1', { directory: '/repo', prompt: 'Continue' });
  });

  it('resolves the target session directory from the global session list when send omits it', async () => {
    const { service, sessionService, client } = createService();
    client.session.list.mockResolvedValue({
      data: [
        { id: 'ses_other', location: { directory: '/repo/worktrees/other' } },
        { id: 'ses_target', location: { directory: '/repo/worktrees/target' } },
      ],
    });
    sessionService.send.mockResolvedValue({ sessionId: 'ses_target', directory: '/repo/worktrees/target', promptDispatched: true });

    await service.execute('session.send', { sessionId: 'ses_target', prompt: 'Continue' }, '/repo');

    expect(sessionService.send).toHaveBeenCalledWith('ses_target', { directory: '/repo/worktrees/target', prompt: 'Continue' });
  });

  it('moves the calling session into a worktree from the directory the call came from', async () => {
    const moveToWorktree = vi.fn(async () => ({ sessionId: 'ses_me', directory: '/repo/worktrees/fix' }));
    const { service } = createService({ sessionService: { moveToWorktree } });

    const result = await service.execute('session.moveToWorktree', { worktree: ' fix ', branch: 'iuliia/fix' }, '/repo', { contextSessionId: 'ses_me' });

    expect(result).toEqual({ sessionId: 'ses_me', directory: '/repo/worktrees/fix' });
    expect(moveToWorktree).toHaveBeenCalledWith('ses_me', {
      directory: '/repo',
      worktree: { name: 'fix', branchName: 'iuliia/fix' },
    });
  });

  it('passes a branch that already exists through to the move', async () => {
    const moveToWorktree = vi.fn(async () => ({}));
    const { service } = createService({ sessionService: { moveToWorktree } });

    await service.execute('session.moveToWorktree', { worktree: 'review', existingBranch: ' origin/review ' }, '/repo', { contextSessionId: 'ses_me' });

    expect(moveToWorktree).toHaveBeenCalledWith('ses_me', {
      directory: '/repo',
      worktree: { name: 'review', existingBranch: 'origin/review' },
    });
  });

  it('passes the files to carry through to the move', async () => {
    const moveToWorktree = vi.fn(async () => ({}));
    const { service } = createService({ sessionService: { moveToWorktree } });

    await service.execute('session.moveToWorktree', { worktree: 'fix', carry: ['src/a.ts'] }, '/repo', { contextSessionId: 'ses_me' });

    expect(moveToWorktree).toHaveBeenCalledWith('ses_me', {
      directory: '/repo',
      worktree: { name: 'fix' },
      carry: ['src/a.ts'],
    });
  });

  it('moves a named session from where that session lives', async () => {
    const moveToWorktree = vi.fn(async () => ({}));
    const { service, client } = createService({ sessionService: { moveToWorktree } });
    client.session.list.mockResolvedValue({ data: [{ id: 'ses_other', location: { directory: '/repo/worktrees/other' } }] });

    // A directory of the caller's choosing is ignored: the changes come from where the session lives.
    await service.execute('session.moveToWorktree', { sessionId: 'ses_other', worktree: 'fix', startRef: 'develop', directory: '/elsewhere' }, '/repo', { contextSessionId: 'ses_me' });
    await expect(service.execute('session.moveToWorktree', { worktree: 'fix' }, '/repo')).rejects.toThrow('sessionId is required');

    expect(moveToWorktree).toHaveBeenCalledWith('ses_other', {
      directory: '/repo/worktrees/other',
      worktree: { name: 'fix', startRef: 'develop' },
    });
    expect(moveToWorktree).toHaveBeenCalledTimes(1);
  });

  it('finds the target session directory on a later session.list page', async () => {
    const { service, client } = createService();
    client.session.list
      .mockResolvedValueOnce({ data: [{ id: 'ses_early', location: { directory: '/repo' } }], cursor: { next: 'page-2' } })
      .mockResolvedValueOnce({ data: [{ id: 'ses_target', location: { directory: '/repo/worktrees/target' } }], cursor: { next: null } });

    await expect(service.resolveSessionDirectory('ses_target')).resolves.toBe('/repo/worktrees/target');
    expect(client.session.list).toHaveBeenNthCalledWith(2, { cursor: 'page-2' });
    expect(client.session.list).toHaveBeenCalledTimes(2);
  });

  it('keeps paging session.list until the requested limit is satisfied', async () => {
    const { service, client } = createService();
    client.session.list
      .mockResolvedValueOnce({ data: [{ id: 'ses_1', location: { directory: '/repo' }, time: {} }], cursor: { next: 'page-2' } })
      .mockResolvedValueOnce({ data: [{ id: 'ses_2', location: { directory: '/other' }, time: {} }], cursor: { next: null } });

    await expect(service.execute('session.list', { limit: 2 })).resolves.toEqual({
      sessions: [
        { id: 'ses_1', location: { directory: '/repo' }, time: {} },
        { id: 'ses_2', location: { directory: '/other' }, time: {} },
      ],
      limit: 2,
      directory: null,
      archived: 'excluded',
    });
    expect(client.session.list).toHaveBeenNthCalledWith(2, { cursor: 'page-2' });
  });

  it('stops paging the session list when a cursor repeats', async () => {
    const { service, client } = createService();
    client.session.list.mockResolvedValue({
      data: [{ id: 'ses_1', location: { directory: '/repo' }, time: {} }],
      cursor: { next: 'loop' },
    });

    const { sessions } = await service.execute('session.list', { limit: 10 });

    expect(sessions).toEqual([{ id: 'ses_1', location: { directory: '/repo' }, time: {} }]);
    expect(client.session.list).toHaveBeenCalledTimes(2);
  });

  it('falls back to the context directory when the session is not in the global list', async () => {
    const { service, sessionService } = createService();
    sessionService.send.mockResolvedValue({ sessionId: 'ses_unknown', directory: '/repo', promptDispatched: true });

    await service.execute('session.send', { sessionId: 'ses_unknown', prompt: 'Continue' }, '/repo');

    expect(sessionService.send).toHaveBeenCalledWith('ses_unknown', { directory: '/repo', prompt: 'Continue' });
  });

  it('waits past initial idle until a completed assistant result appears', async () => {
    let timestamp = 1000;
    const { service, client, sessionService } = createService({
      now: () => timestamp,
      sleep: async (duration) => { timestamp += duration; },
    });
    sessionService.create.mockResolvedValue({
      sessionId: 'ses_1',
      directory: '/repo',
      promptDispatched: true,
      baselineAssistantMessageId: 'msg_old',
    });
    client.session.active.mockResolvedValue({});
    client.message.list
      .mockResolvedValueOnce({ data: [{ id: 'msg_old', type: 'assistant', time: { completed: 900 }, content: [{ type: 'text', text: 'old' }] }] })
      .mockResolvedValueOnce({ data: [{ id: 'msg_new', type: 'assistant', time: { completed: 1500 }, content: [{ type: 'text', text: 'done' }] }] })
      .mockResolvedValueOnce({ data: [{ id: 'msg_new', type: 'assistant', time: { completed: 1500 }, content: [{ type: 'text', text: 'done' }] }] });

    await expect(service.execute('session.create', {
      directory: '/repo',
      prompt: 'work',
      wait: true,
      lastAssistant: true,
      timeout: 2,
    })).resolves.toEqual(expect.objectContaining({
      sessionStatus: { type: 'idle' },
      lastAssistantMessage: expect.objectContaining({ id: 'msg_new', text: 'done' }),
    }));
    expect(client.session.active).toHaveBeenCalledTimes(2);
  });

  it('filters sessions archived in OpenChamber state and adds global statuses', async () => {
    const { service, client } = createService({
      // Async like the real store (`openchamber-sessions/archive-store.js`).
      archiveStore: { archivedAt: async (id) => (id === 'ses_archived' ? 100 : null) },
    });
    client.session.list.mockResolvedValue({ data: [
      { id: 'ses_active', location: { directory: '/repo' }, time: {} },
      { id: 'ses_archived', location: { directory: '/repo' }, time: {} },
      { id: 'ses_other', location: { directory: '/other' }, time: {} },
    ] });
    client.session.active.mockResolvedValue({ ses_active: { type: 'running' } });

    await expect(service.execute('session.list', { limit: 10, withStatus: true })).resolves.toEqual({
      sessions: [
        { id: 'ses_active', location: { directory: '/repo' }, time: {}, status: { type: 'busy' } },
        { id: 'ses_other', location: { directory: '/other' }, time: {}, status: { type: 'idle' } },
      ],
      limit: 10,
      directory: null,
      archived: 'excluded',
    });
  });

  it('reports unknown status when the active-session read fails', async () => {
    const { service, client } = createService();
    client.session.list.mockResolvedValue({ data: [{ id: 'ses_active', location: { directory: '/repo' }, time: {} }] });
    client.session.active.mockRejectedValue(new Error('unavailable'));

    await expect(service.execute('session.list', { limit: 10, withStatus: true })).resolves.toEqual({
      sessions: [{ id: 'ses_active', location: { directory: '/repo' }, time: {}, status: { type: 'unknown' } }],
      limit: 10,
      directory: null,
      archived: 'excluded',
    });
  });

  it('scopes session reads to an explicit project instead of the tool context directory', async () => {
    const { service, client, sessionService } = createService();
    client.session.list.mockResolvedValue({ data: [{ id: 'ses_repo', location: { directory: '/repo' }, time: {} }] });

    await expect(service.execute('session.list', { projectId: ' project-1 ' }, '/current-session')).resolves.toEqual(
      expect.objectContaining({ directory: '/repo', sessions: [{ id: 'ses_repo', location: { directory: '/repo' }, time: {} }] }),
    );
    expect(sessionService.resolveDirectory).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(client.session.list).toHaveBeenCalledWith({ directory: '/repo' });

    await expect(service.execute('session.status', { projectId: 'project-1', sessionId: 'ses_repo' }, '/current-session'))
      .resolves.toEqual({ sessionId: 'ses_repo', directory: '/repo', sessionStatus: { type: 'idle' } });
  });

  it('reports the target session directory for status and messages when no scope is given', async () => {
    const { service, client } = createService();
    client.session.list.mockResolvedValue({
      data: [{ id: 'ses_target', location: { directory: '/repo/worktrees/target' } }],
    });
    client.message.list.mockResolvedValue({
      data: [{ id: 'msg_user', type: 'user', time: { created: 10 }, text: 'Question' }],
    });

    await expect(service.execute('session.status', { sessionId: 'ses_target' }, '/current-session'))
      .resolves.toEqual({ sessionId: 'ses_target', directory: '/repo/worktrees/target', sessionStatus: { type: 'idle' } });
    await expect(service.execute('session.messages', { sessionId: 'ses_target' }, '/current-session'))
      .resolves.toEqual(expect.objectContaining({
        sessionId: 'ses_target',
        directory: '/repo/worktrees/target',
        messages: [expect.objectContaining({ id: 'msg_user', text: 'Question' })],
      }));
  });

  it('keeps an explicit directory for status instead of the session directory', async () => {
    const { service, client } = createService();
    client.session.list.mockResolvedValue({
      data: [{ id: 'ses_target', location: { directory: '/repo/worktrees/target' } }],
    });

    await expect(service.execute('session.status', { sessionId: 'ses_target', directory: '/explicit' }, '/current-session'))
      .resolves.toEqual({ sessionId: 'ses_target', directory: '/explicit', sessionStatus: { type: 'idle' } });
  });

  it('falls back to the context directory when the session is not in the global list', async () => {
    const { service, client } = createService();
    client.session.list.mockResolvedValue({ data: [] });

    await expect(service.execute('session.status', { sessionId: 'ses_unknown' }, '/current-session'))
      .resolves.toEqual({ sessionId: 'ses_unknown', directory: '/current-session', sessionStatus: { type: 'idle' } });
  });

  it('does not report a prototype-named session as busy (#2311)', async () => {
    const { service, client } = createService();
    client.session.list.mockResolvedValue({ data: [{ id: 'constructor', location: { directory: '/repo' }, time: {} }] });
    client.session.active.mockResolvedValue({ ses_active: { type: 'running' } });

    await expect(service.execute('session.status', { sessionId: 'constructor' }, '/current-session'))
      .resolves.toEqual({ sessionId: 'constructor', directory: '/repo', sessionStatus: { type: 'idle' } });
    await expect(service.execute('session.status', { sessionId: 'ses_active' }, '/current-session'))
      .resolves.toEqual({ sessionId: 'ses_active', directory: '/current-session', sessionStatus: { type: 'busy' } });
    await expect(service.execute('session.list', { limit: 10, withStatus: true }))
      .resolves.toEqual(expect.objectContaining({
        sessions: [expect.objectContaining({ id: 'constructor', status: { type: 'idle' } })],
      }));
  });

  it('rejects an unknown project instead of reading another directory', async () => {
    const { service, client } = createService();
    await expect(service.execute('session.list', { projectId: 'missing' }, '/current-session'))
      .rejects.toMatchObject({ statusCode: 404, message: 'Project not found' });
    await expect(service.execute('session.list', { projectId: 'missing' }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(service.execute('session.messages', { projectId: 'missing', sessionId: 'ses_1' }, '/current-session'))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.message.list).not.toHaveBeenCalled();
  });

  it('asks for sessionId before looking up the project', async () => {
    const { service, sessionService } = createService();
    await expect(service.execute('session.status', { projectId: 'missing' }, '/current-session'))
      .rejects.toMatchObject({ statusCode: 400, message: 'sessionId is required' });
    expect(sessionService.resolveDirectory).not.toHaveBeenCalled();
  });

  it('rejects any session action scoped by both projectId and directory', async () => {
    const { service, client, sessionService } = createService();
    for (const action of ['session.list', 'session.status', 'session.create', 'session.send', 'session.fork']) {
      await expect(service.execute(action, { projectId: 'project-1', directory: '/other', sessionId: 'ses_1', prompt: 'hi' }))
        .rejects.toMatchObject({ statusCode: 400, message: 'Provide only one of projectId or directory' });
    }
    expect(client.session.list).not.toHaveBeenCalled();
    expect(sessionService.create).not.toHaveBeenCalled();
    expect(sessionService.send).not.toHaveBeenCalled();
    expect(sessionService.fork).not.toHaveBeenCalled();
  });

  it('names limit in positive-integer validation errors', async () => {
    const { service, client } = createService();
    await expect(service.execute('session.list', { limit: 0 })).rejects.toThrow('limit must be a positive integer');
    expect(client.session.list).not.toHaveBeenCalled();
  });

  it('projects only ordered text content from session messages', async () => {
    const { service, client } = createService();
    client.message.list.mockResolvedValue({ data: [
      {
        id: 'msg_assistant', type: 'assistant', model: { providerID: 'openai', id: 'gpt-5.4-mini' }, time: { created: 20, completed: 30 },
        content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'First ' }, { type: 'tool' }, { type: 'text', text: 'answer' }],
      },
      { id: 'msg_user', type: 'user', time: { created: 10 }, text: 'Question' },
      { id: 'msg_tool', type: 'assistant', time: { created: 15 }, content: [{ type: 'tool' }] },
    ] });

    await expect(service.execute('session.messages', {
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      all: true,
    })).resolves.toEqual({
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      sessionStatus: { type: 'idle' },
      messages: [
        { id: 'msg_user', role: 'user', createdAt: 10, completedAt: null, model: null, text: 'Question' },
        { id: 'msg_assistant', role: 'assistant', createdAt: 20, completedAt: 30, model: 'openai/gpt-5.4-mini', text: 'First answer' },
      ],
    });
  });

  it('follows the message cursor so all: true returns the whole history', async () => {
    const { service, client } = createService();
    const page = (data, next) => ({ data, cursor: { next } });
    // Newest page first (the API pages with order: 'desc'), then older pages
    // reachable only through cursor.next.
    client.message.list.mockImplementation(async (input) => {
      if (!input.cursor) {
        return page([
          { id: 'msg_new_user', type: 'user', time: { created: 40 }, text: 'Recent question' },
          { id: 'msg_new_assistant', type: 'assistant', time: { created: 50, completed: 55 }, content: [{ type: 'text', text: 'Recent answer' }] },
        ], 'cursor-page-2');
      }
      if (input.cursor === 'cursor-page-2') {
        return page([
          { id: 'msg_old_user', type: 'user', time: { created: 10 }, text: 'Older requirement' },
        ], undefined);
      }
      throw new Error(`unexpected cursor ${input.cursor}`);
    });

    const result = await service.execute('session.messages', {
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      all: true,
    });

    expect(client.message.list).toHaveBeenCalledTimes(2);
    expect(client.message.list.mock.calls[1][0]).toMatchObject({ sessionID: 'ses_1', cursor: 'cursor-page-2' });
    expect(result.messages.map((message) => message.id)).toEqual([
      'msg_old_user', 'msg_new_user', 'msg_new_assistant',
    ]);
  });

  it('pages a bounded read with the cursor alone until it has enough text messages', async () => {
    const { service, client } = createService();
    const page = (data, next) => ({ data, cursor: { next } });
    client.message.list.mockImplementation(async (input) => {
      if (!input.cursor) {
        return page([
          { id: 'msg_new_assistant', type: 'assistant', time: { created: 50, completed: 55 }, content: [{ type: 'text', text: 'Recent answer' }] },
          { id: 'msg_new_user', type: 'user', time: { created: 40 }, text: 'Recent question' },
        ], 'cursor-page-2');
      }
      if (input.cursor === 'cursor-page-2') {
        return page([
          { id: 'msg_mid_user', type: 'user', time: { created: 20 }, text: 'Earlier question' },
          { id: 'msg_old_user', type: 'user', time: { created: 10 }, text: 'First question' },
        ], 'cursor-page-3');
      }
      throw new Error(`unexpected cursor ${input.cursor}`);
    });

    const result = await service.execute('session.messages', {
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'user',
      limit: 2,
    });

    expect(client.message.list).toHaveBeenCalledTimes(2);
    expect(client.message.list.mock.calls[0][0]).toMatchObject({ sessionID: 'ses_1', order: 'desc' });
    expect(client.message.list.mock.calls[1][0]).toMatchObject({ sessionID: 'ses_1', cursor: 'cursor-page-2' });
    expect(client.message.list.mock.calls[1][0]).not.toHaveProperty('order');
    expect(result.messages.map((message) => message.id)).toEqual(['msg_mid_user', 'msg_new_user']);
  });

  // OpenCode refuses a page over 200 ("Expected a value less than or equal to
  // 200"), which surfaced as an error about the caller's own limit of 100.
  it('keeps each page within what OpenCode accepts, for any requested limit', async () => {
    const { service, client } = createService();
    client.message.list.mockImplementation(async () => ({ data: [], cursor: {} }));
    await service.execute('session.messages', { sessionId: 'ses_1', directory: '/repo', limit: 100 });
    expect(client.message.list.mock.calls[0][0].limit).toBe(200);
  });

  it('stops paging when the message cursor repeats or a page comes back empty', async () => {
    const { service, client } = createService();
    client.message.list.mockImplementation(async (input) => {
      if (!input.cursor) {
        return { data: [{ id: 'msg_new_user', type: 'user', time: { created: 20 }, text: 'Question' }], cursor: { next: 'cursor-loop' } };
      }
      return { data: [{ id: 'msg_old_user', type: 'user', time: { created: 10 }, text: 'Older question' }], cursor: { next: 'cursor-loop' } };
    });

    const looped = await service.execute('session.messages', { sessionId: 'ses_1', directory: '/repo', all: true });
    expect(client.message.list).toHaveBeenCalledTimes(2);
    expect(looped.messages.map((message) => message.id)).toEqual(['msg_old_user', 'msg_new_user']);

    client.message.list.mockReset();
    client.message.list.mockImplementation(async (input) => (input.cursor
      ? { data: [], cursor: { next: `${input.cursor}-next` } }
      : { data: [{ id: 'msg_user', type: 'user', time: { created: 10 }, text: 'Question' }], cursor: { next: 'cursor-empty' } }));

    const drained = await service.execute('session.messages', { sessionId: 'ses_1', directory: '/repo', all: true });
    expect(client.message.list).toHaveBeenCalledTimes(2);
    expect(drained.messages.map((message) => message.id)).toEqual(['msg_user']);
  });

  it('caps the message walk when the cursor is always new', async () => {
    const { service, client } = createService();
    let page = 0;
    client.message.list.mockImplementation(async () => {
      page += 1;
      return {
        data: [{ id: `msg_${page}`, type: 'user', time: { created: page }, text: `Question ${page}` }],
        cursor: { next: `cursor-${page}` },
      };
    });

    const result = await service.execute('session.messages', { sessionId: 'ses_1', directory: '/repo', all: true });
    // MAX_PAGES_PER_WALK in service.js: the walk stops at the cap and
    // returns the partial history instead of looping on fresh cursors,
    // flagged truncated so the partial history is not read as complete.
    expect(client.message.list).toHaveBeenCalledTimes(20);
    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(20);
    expect(result.messages[0].id).toBe('msg_1');
    expect(result.messages[19].id).toBe('msg_20');
  });

  it('caps session directory resolution when the cursor is always new, and stops on an empty page', async () => {
    const { service, client } = createService();
    let page = 0;
    client.session.list.mockImplementation(async () => {
      page += 1;
      return {
        data: [{ id: 'ses_other', location: { directory: '/repo' } }],
        cursor: { next: `cursor-${page}` },
      };
    });

    await expect(service.resolveSessionDirectory('ses_target')).resolves.toBeNull();
    expect(client.session.list).toHaveBeenCalledTimes(20);

    client.session.list.mockReset();
    client.session.list.mockImplementation(async () => ({ data: [], cursor: { next: 'cursor-empty' } }));
    await expect(service.resolveSessionDirectory('ses_target')).resolves.toBeNull();
    expect(client.session.list).toHaveBeenCalledTimes(1);
  });

  it('rejects actions outside the fixed contract', async () => {
    const { service } = createService();
    await expect(service.execute('session.explode')).rejects.toThrow('Unsupported OpenChamber action');
  });

  it('archives and restores a session through the archive store', async () => {
    const archiveStore = {
      archivedAt: vi.fn(async () => null),
      archive: vi.fn(async (ids) => ({ archived: ids.map((id) => ({ id, archivedAt: 123 })), failedIds: [] })),
      unarchive: vi.fn(async (ids) => ({ restored: ids.map((id) => ({ id, archivedAt: null })), failedIds: [] })),
    };
    const { service } = createService({ archiveStore });
    await expect(service.execute('session.archive', { sessionId: 'ses_1', directory: '/repo' }))
      .resolves.toEqual({ sessionId: 'ses_1', directory: '/repo', archived: true, archivedAt: 123 });
    expect(archiveStore.archive).toHaveBeenCalledWith(['ses_1']);
    await expect(service.execute('session.unarchive', { sessionId: 'ses_1', directory: '/repo' }))
      .resolves.toEqual({ sessionId: 'ses_1', directory: '/repo', archived: false });
    expect(archiveStore.unarchive).toHaveBeenCalledWith(['ses_1']);
  });

  it('prefers the session service archive, which broadcasts to open windows', async () => {
    const { service, sessionService } = createService();
    sessionService.archive = vi.fn(async ({ ids }) => ({ archived: ids.map((id) => ({ id, archivedAt: 7 })), failedIds: [] }));
    await expect(service.execute('session.archive', { sessionId: 'ses_1', directory: '/repo' }))
      .resolves.toEqual({ sessionId: 'ses_1', directory: '/repo', archived: true, archivedAt: 7 });
    expect(sessionService.archive).toHaveBeenCalledWith({ ids: ['ses_1'] });
  });

  it('reports an archive the store refused, and 503s when no archive is wired', async () => {
    const failing = createService({
      archiveStore: {
        archivedAt: vi.fn(async () => null),
        archive: vi.fn(async () => ({ archived: [], failedIds: ['ses_1'] })),
        unarchive: vi.fn(async () => ({ restored: [], failedIds: ['ses_1'] })),
      },
    });
    await expect(failing.service.execute('session.archive', { sessionId: 'ses_1', directory: '/repo' }))
      .rejects.toMatchObject({ statusCode: 500 });
    const bare = createService();
    await expect(bare.service.execute('session.archive', { sessionId: 'ses_1', directory: '/repo' }))
      .rejects.toMatchObject({ statusCode: 503 });
  });

  it('deletes a session through the directory-scoped client', async () => {
    const { service, client } = createService();
    await expect(service.execute('session.delete', { sessionId: 'ses_1', directory: '/repo' }))
      .resolves.toEqual({ sessionId: 'ses_1', directory: '/repo', deleted: true });
    expect(client.session.remove).toHaveBeenCalledWith({ sessionID: 'ses_1' });
  });

  it('refuses to delete the session the call is running in', async () => {
    const { service, client } = createService();
    await expect(service.execute('session.delete', { sessionId: 'ses_1', directory: '/repo' }, '/repo', { contextSessionId: 'ses_1' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(client.session.remove).not.toHaveBeenCalled();
  });
});

describe('file.open', () => {
  it('hands the path, the session directory and the session to the file viewer', async () => {
    const request = vi.fn(async () => ({ path: '/repo/out.csv', size: 3, opened: true }));
    const { service } = createService({ fileOpen: { request } });

    const result = await service.execute('file.open', { path: 'out.csv' }, '/repo', { contextSessionId: 'ses_1' });

    expect(request).toHaveBeenCalledWith({ path: 'out.csv', directory: '/repo', sessionId: 'ses_1' });
    expect(result).toEqual({ path: '/repo/out.csv', size: 3, opened: true });
  });

  it('lets an explicit directory win over the session directory', async () => {
    const request = vi.fn(async () => ({ path: '/other/out.csv', size: 3, opened: true }));
    const { service } = createService({ fileOpen: { request } });

    await service.execute('file.open', { path: 'out.csv', directory: '/other' }, '/repo');

    expect(request).toHaveBeenCalledWith({ path: 'out.csv', directory: '/other', sessionId: null });
  });

  it('answers 503 when this server has no file viewer wired', async () => {
    const { service } = createService({});
    await expect(service.execute('file.open', { path: 'out.csv' }, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('notify.send', () => {
  it('sends the notice for the calling session and returns what was delivered', async () => {
    const notifyUser = vi.fn(async () => ({ status: 200, body: { delivered: true } }));
    const { service } = createService({ notifyUser });

    const result = await service.execute('notify.send', { title: 'Done', body: 'All green', showWhenFocused: true }, '/repo', { contextSessionId: 'ses_1' });

    expect(notifyUser).toHaveBeenCalledWith({ title: 'Done', body: 'All green', showWhenFocused: true, sessionId: 'ses_1', directory: '/repo' });
    expect(result).toEqual({ delivered: true });
  });

  it('turns a refused notice into an error the agent can read', async () => {
    const notifyUser = vi.fn(async () => ({ status: 429, retryAfter: 4, body: { error: 'too many notifications' } }));
    const { service } = createService({ notifyUser });

    await expect(service.execute('notify.send', { title: 'Done' }, '/repo'))
      .rejects.toMatchObject({ statusCode: 429, message: 'too many notifications' });
  });

  it('answers 503 when this server has no notifier wired', async () => {
    const { service } = createService({});
    await expect(service.execute('notify.send', { title: 'Done' }, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('render.page', () => {
  const page = '<!doctype html><p>Hi</p>';

  it('accepts a page with a title and tells the agent not to restate it', async () => {
    const { service } = createService();

    const result = await service.execute('render.page', { html: page, title: '  Coverage  ' }, '/repo');

    expect(result).toMatchObject({ shown: true, title: 'Coverage' });
    expect(result.note).toContain("Don't announce");
  });

  it('names a page sent without a title after its own title or first heading', async () => {
    const { service } = createService();
    const named = (html) => service.execute('render.page', { html }, '/repo').then((result) => result.title);

    expect(await named('<html><head><title> Q3 &amp; Q4 </title></head><h1>Other</h1></html>')).toBe('Q3 & Q4');
    expect(await named('<title></title><div><h2>Release <b>2.4</b></h2></div>')).toBe('Release 2.4');
    expect(await named(`<h1>${'x'.repeat(200)}</h1>`)).toBe('x'.repeat(120));
    expect(await named(page)).toBe('Page');
  });

  it('never splits a surrogate pair at the title cap (oracle: astral char straddling offset 120)', async () => {
    const { service } = createService();
    const named = (html) => service.execute('render.page', { html }, '/repo').then((result) => result.title);

    const title = await named(`<title>${'a'.repeat(119)}😀tail</title>`);
    expect(title).toBe('a'.repeat(119));
    expect(title.length).toBe(119);
    // A lone surrogate would encode as U+FFFD and not round-trip.
    expect(new TextDecoder().decode(new TextEncoder().encode(title))).toBe(title);
    // An over-cap ASCII title still cuts at exactly 120 code units.
    expect(await named(`<h1>${'a'.repeat(200)}</h1>`)).toBe('a'.repeat(120));
  });

  it('asks for html and title in one call when html is missing', async () => {
    const { service } = createService();
    await expect(service.execute('render.page', { title: 'Coverage' }, '/repo'))
      .rejects.toMatchObject({ message: expect.stringContaining('Send html and title together in one call') });
  });

  it.each([
    [{ title: 'Coverage' }, 'html is required'],
    [{ html: '   ', title: 'Coverage' }, 'html is required'],
    [{ html: 'x'.repeat(200_001), title: 'Coverage' }, 'the limit is 200000'],
    [{ html: page, title: 't'.repeat(121) }, 'the limit is 120'],
  ])('refuses %o with a reason the agent can act on', async (input, reason) => {
    const { service } = createService();
    await expect(service.execute('render.page', input, '/repo'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(reason) });
  });

  it('refuses while the tool is switched off, so a stale plugin cannot keep drawing', async () => {
    const { service } = createService({ isRenderToolEnabled: async () => false });
    await expect(service.execute('render.page', { html: page, title: 'Coverage' }, '/repo'))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  describe('with awaitAnswer', () => {
    const ask = { html: page, title: 'Pick a layout', awaitAnswer: true };
    const call = { contextSessionId: 'ses_1', contextCallId: 'call_1' };
    // The call starts waiting once its checks have run.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('waits until the user answers and returns the answer', async () => {
      const { service } = createService();
      const pending = service.execute('render.page', ask, '/repo', call);
      await settle();

      expect(service.answerPage({ sessionId: 'ses_1', callId: 'call_1', summary: ' Layout B ', data: { layout: 'b' } })).toEqual({ answered: true });
      const result = await pending;

      expect(result).toMatchObject({ title: 'Pick a layout', answer: { answered: true, summary: 'Layout B', data: { layout: 'b' } } });
      expect(result.note).toContain('answered on the page');
    });

    it('announces when the page starts and stops waiting', async () => {
      const onPageWaitChange = vi.fn();
      const { service } = createService({ onPageWaitChange });
      const pending = service.execute('render.page', ask, '/repo', call);
      await settle();

      expect(onPageWaitChange).toHaveBeenCalledWith({ type: 'waiting', sessionId: 'ses_1', callId: 'call_1', title: 'Pick a layout', directory: '/repo' });
      service.answerPage({ sessionId: 'ses_1', callId: 'call_1', summary: 'B' });
      await pending;
      expect(onPageWaitChange).toHaveBeenLastCalledWith({ type: 'settled', sessionId: 'ses_1', callId: 'call_1' });

      const controller = new AbortController();
      const aborted = service.execute('render.page', ask, '/repo', { ...call, signal: controller.signal });
      await settle();
      controller.abort();
      await expect(aborted).rejects.toBeTruthy();
      expect(onPageWaitChange).toHaveBeenLastCalledWith({ type: 'settled', sessionId: 'ses_1', callId: 'call_1' });
    });

    it('answers once: a second answer, or one for another call, finds nothing waiting', async () => {
      const { service } = createService();
      const pending = service.execute('render.page', ask, '/repo', call);
      await settle();

      expect(() => service.answerPage({ sessionId: 'ses_1', callId: 'call_2', summary: 'B' })).toThrow(expect.objectContaining({ statusCode: 404 }));
      service.answerPage({ sessionId: 'ses_1', callId: 'call_1', summary: 'B' });
      await expect(pending).resolves.toMatchObject({ answer: { data: null } });
      expect(() => service.answerPage({ sessionId: 'ses_1', callId: 'call_1', summary: 'B' })).toThrow(expect.objectContaining({ statusCode: 404 }));
    });

    it('stops waiting when the call is aborted, and the page no longer takes an answer', async () => {
      const { service } = createService();
      const controller = new AbortController();
      const pending = service.execute('render.page', ask, '/repo', { ...call, signal: controller.signal });
      await settle();

      controller.abort();

      await expect(pending).rejects.toMatchObject({ message: expect.stringContaining('stopped waiting') });
      expect(() => service.answerPage({ sessionId: 'ses_1', callId: 'call_1', summary: 'B' })).toThrow(expect.objectContaining({ statusCode: 404 }));
    });

    it.each([
      [{ summary: '' }, 400],
      [{ summary: 's'.repeat(501) }, 400],
      [{ summary: 'B', data: 'x'.repeat(16_001) }, 413],
      [{ sessionId: '', summary: 'B' }, 400],
    ])('refuses the answer %o and keeps waiting', async (answer, statusCode) => {
      const { service } = createService();
      const pending = service.execute('render.page', ask, '/repo', call);
      await settle();

      expect(() => service.answerPage({ sessionId: 'ses_1', callId: 'call_1', ...answer })).toThrow(expect.objectContaining({ statusCode }));
      service.answerPage({ sessionId: 'ses_1', callId: 'call_1', summary: 'B' });
      await expect(pending).resolves.toMatchObject({ answer: { summary: 'B' } });
    });

    it('refuses to wait without a call id, so an older plugin falls back to asking in text', async () => {
      const { service } = createService();
      await expect(service.execute('render.page', ask, '/repo', { contextSessionId: 'ses_1' }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('without awaitAnswer') });
    });
  });
});

describe('browser capture', () => {
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const createBrowserService = async (capture) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-capture-'));
    const request = vi.fn(async () => capture);
    const { service } = createService({ browserControl: { request } });
    return { service, directory, request };
  };

  it('saves the image beside the code and hands back a path the answer can use', async () => {
    const { service, directory } = await createBrowserService({
      base64: pixel,
      mime: 'image/png',
      url: 'http://localhost:3000/',
      title: 'App',
      viewport: { mode: 'mobile', width: 390, height: 844 },
      width: 390,
      height: 844,
    });

    const result = await service.execute('browser.capture', { label: 'After fix' }, directory);

    expect(result.path.startsWith('.openchamber/screenshots/after-fix-')).toBe(true);
    expect(result.path.endsWith('.png')).toBe(true);
    expect(result.url).toBe('http://localhost:3000/');
    expect(result.viewport).toEqual({ mode: 'mobile', width: 390, height: 844 });
    // The bytes stay on disk; a tool result is not a place to carry an image.
    expect('base64' in result).toBe(false);
    const written = await fs.readFile(path.join(directory, result.path));
    expect(written.length > 0).toBe(true);
  });

  it('tells the agent how to actually show the image', async () => {
    const { service, directory } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    const result = await service.execute('browser.capture', {}, directory);
    expect(result.hint).toContain(`![](${result.path})`);
  });

  it('refuses to capture with no project to save into', async () => {
    const { service } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await expect(service.execute('browser.capture', {})).rejects.toThrow(/directory is required/);
  });

  it('passes the tab the agent named to the browser', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', { tabId: ' tab-2 ' }, directory);
    expect(request).toHaveBeenCalledWith('browser.capture', { tabId: 'tab-2' }, expect.anything());
  });

  it('passes a label through to the browser and leaves other actions untouched', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', { label: 'before' }, directory);
    expect(request).toHaveBeenCalledWith('browser.capture', { label: 'before' }, expect.anything());
  });

  it('tells the browser which project and chat the action came from', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', {}, directory, { contextSessionId: 'ses_1' });
    expect(request).toHaveBeenCalledWith('browser.capture', {}, expect.objectContaining({
      context: { directory, sessionId: 'ses_1' },
    }));
    await service.execute('browser.capture', {}, directory);
    expect(request).toHaveBeenLastCalledWith('browser.capture', {}, expect.objectContaining({
      context: { directory, sessionId: null },
    }));
  });
});

describe('browser close', () => {
  const createCloseService = () => {
    const request = vi.fn(async () => ({ closed: true, tabId: 'tab-1' }));
    const { service } = createService({ browserControl: { request } });
    return { service, request };
  };

  it('forwards the tab the agent named, trimmed', async () => {
    const { service, request } = createCloseService();
    const result = await service.execute('browser.close', { tabId: ' tab-1 ' }, '/repo');
    expect(request).toHaveBeenCalledWith('browser.close', { tabId: 'tab-1' }, expect.anything());
    expect(result).toEqual({ closed: true, tabId: 'tab-1' });
  });

  it('forwards a close with no tab, so the browser closes the session\'s own', async () => {
    const { service, request } = createCloseService();
    await service.execute('browser.close', {}, '/repo');
    expect(request).toHaveBeenCalledWith('browser.close', {}, expect.anything());
  });
});

describe('returning a dispatched session result', () => {
  const createReturningService = (overrides = {}) => {
    const dispatchResults = { register: vi.fn(async () => ({ id: 'dispatch-1' })) };
    const created = createService({ dispatchResults, now: () => 1_000, ...overrides });
    created.sessionService.create.mockResolvedValue({ sessionId: 'ses_child', directory: '/repo', promptDispatched: true });
    created.sessionService.send.mockResolvedValue({ sessionId: 'ses_child', directory: '/repo', promptDispatched: true, baselineAssistantMessageId: 'msg_old' });
    return { ...created, dispatchResults };
  };

  it('returns at once and registers the delivery to the calling session', async () => {
    const { service, dispatchResults, client } = createReturningService();
    const result = await service.execute('session.create', { prompt: 'Check the build', returnResult: true }, '/repo', { contextSessionId: 'ses_parent' });

    expect(dispatchResults.register).toHaveBeenCalledWith({ parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 1_000 });
    expect(result.resultDelivery).toEqual({ status: 'pending', note: expect.stringContaining('delivered to you automatically') });
    expect(result.resultDelivery.note).toContain('Do not poll');
    // Nothing waits: no status or message reads happen for the dispatch.
    expect(client.session.active).not.toHaveBeenCalled();
  });

  it('hands the end-of-run baseline to the delivery and keeps it from the agent', async () => {
    const { service, dispatchResults, sessionService } = createReturningService();
    sessionService.send.mockResolvedValue({ sessionId: 'ses_child', directory: '/repo', promptDispatched: true, baselineIdleRecordId: 'msg_idle_old' });
    const result = await service.execute('session.send', { sessionId: 'ses_child', prompt: 'Again', returnResult: true }, '/repo', { contextSessionId: 'ses_parent' });

    expect(dispatchResults.register).toHaveBeenCalledWith({
      parentSessionId: 'ses_parent', sessionId: 'ses_child', dispatchedAt: 1_000, afterIdleId: 'msg_idle_old',
    });
    expect(result).not.toHaveProperty('baselineIdleRecordId');
  });

  it('does not schedule a delivery for a prompt that never landed', async () => {
    const { service, dispatchResults, sessionService } = createReturningService();
    sessionService.create.mockResolvedValue({ sessionId: 'ses_child', directory: '/repo', promptDispatched: false, promptError: 'no queued message' });
    const result = await service.execute('session.create', { prompt: 'Check', returnResult: true }, '/repo', { contextSessionId: 'ses_parent' });

    expect(dispatchResults.register).not.toHaveBeenCalled();
    expect(result.resultDelivery.status).toBe('not-scheduled');
  });

  it('reports a failed registration instead of claiming the result is coming', async () => {
    const { service, dispatchResults } = createReturningService();
    dispatchResults.register.mockRejectedValue(new Error('disk full'));
    const result = await service.execute('session.send', { sessionId: 'ses_child', prompt: 'Again', returnResult: true }, '/repo', { contextSessionId: 'ses_parent' });

    expect(result.resultDelivery).toEqual({ status: 'not-scheduled', reason: expect.stringContaining('disk full') });
    expect(result).not.toHaveProperty('baselineAssistantMessageId');
  });

  it.each([
    ['without a calling session', { prompt: 'x', returnResult: true }, {}, 'needs a calling session'],
    ['without a prompt', { returnResult: true }, { contextSessionId: 'ses_parent' }, 'returnResult requires prompt'],
    ['combined with wait', { prompt: 'x', returnResult: true, wait: true }, { contextSessionId: 'ses_parent' }, 'cannot be combined with wait'],
  ])('refuses returnResult %s before creating anything', async (_label, input, options, message) => {
    const { service, sessionService } = createReturningService();
    await expect(service.execute('session.create', input, '/repo', options)).rejects.toThrow(message);
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('refuses to deliver a session\'s result to itself', async () => {
    const { service, sessionService } = createReturningService();
    await expect(service.execute('session.send', { sessionId: 'ses_parent', prompt: 'x', returnResult: true }, '/repo', { contextSessionId: 'ses_parent' }))
      .rejects.toThrow('to itself');
    expect(sessionService.send).not.toHaveBeenCalled();
  });

  it('answers 503 on a server that cannot deliver results', async () => {
    const { service, sessionService } = createService();
    await expect(service.execute('session.create', { prompt: 'x', returnResult: true }, '/repo', { contextSessionId: 'ses_parent' }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('refuses a returnResult that is not a boolean instead of silently skipping delivery', async () => {
    const { service, sessionService, dispatchResults } = createReturningService();
    await expect(service.execute('session.create', { prompt: 'x', returnResult: 'true' }, '/repo', { contextSessionId: 'ses_parent' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('returnResult must be a boolean') });
    expect(sessionService.create).not.toHaveBeenCalled();
    expect(dispatchResults.register).not.toHaveBeenCalled();
  });

  it('accepts an explicit false returnResult as the plain dispatch path', async () => {
    const { service, sessionService, dispatchResults } = createReturningService();
    const result = await service.execute('session.create', { prompt: 'x', returnResult: false }, '/repo', { contextSessionId: 'ses_parent' });
    expect(sessionService.create).toHaveBeenCalled();
    expect(result).not.toHaveProperty('resultDelivery');
    expect(dispatchResults.register).not.toHaveBeenCalled();
  });

  it('refuses a wait that is not a boolean', async () => {
    const { service, sessionService } = createService();
    await expect(service.execute('session.send', { sessionId: 'ses_1', prompt: 'x', wait: 'true' }, '/repo'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('wait must be a boolean') });
    expect(sessionService.send).not.toHaveBeenCalled();
  });
});
