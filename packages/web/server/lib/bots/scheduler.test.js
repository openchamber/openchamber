import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createScheduledTasksRuntime } from '../scheduled-tasks/runtime.js';
import { createScheduledTaskService } from '../scheduled-tasks/service.js';
import { botDefinitionSchema } from './config.js';
import { botTaskFor } from './events.js';
import { createBotScheduler } from './scheduler.js';

const botRow = (id = 'triage', schedule = { kind: 'manual' }) => botTaskFor(botDefinitionSchema.parse({
  id, name: `Bot ${id}`, mission: 'Investigate verified bugs.', schedule,
}));
const ordinaryTask = (id) => ({
  id, name: id, enabled: false, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
  execution: { prompt: 'Run the task.', useDefaults: true },
});

describe('bot managed scheduler', () => {
  let root;
  let projectConfigRuntime;
  let scheduledTasksRuntime;
  let scheduler;
  let service;
  let runBot;
  let runSuggestedScan;
  let requests;
  let failRename;
  let runtimeDeps;
  const runtimes = [];

  beforeEach(async () => {
    root = await fs.mkdtemp('/tmp/opencode/bot-scheduler-test-');
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('USERPROFILE', path.join(root, 'home'));
    failRename = false;
    projectConfigRuntime = createProjectConfigRuntime({
      fsPromises: { ...fs, rename: async (...args) => {
        if (failRename) throw new Error('disk write refused');
        return fs.rename(...args);
      } },
      path, projectsDirPath: path.join(root, 'projects'),
    });
    runBot = vi.fn(async () => ({ items: [], skipped: false }));
    runSuggestedScan = vi.fn(async () => ({ skipped: true }));
    requests = vi.fn(async () => { throw new Error('Unexpected OpenCode session request'); });
    vi.stubGlobal('fetch', requests);
    runtimeDeps = {
      projectConfigRuntime, listProjects: async () => [{ id: 'project', path: repo }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:9999', getOpenCodeAuthHeaders: () => ({}),
      runBot, runSuggestedScan, logger: { info() {}, warn() {} },
    };
    scheduledTasksRuntime = createScheduledTasksRuntime(runtimeDeps);
    runtimes.push(scheduledTasksRuntime);
    scheduler = createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime });
    service = createScheduledTaskService({
      projectConfigRuntime, scheduledTasksRuntime,
      readSettingsFromDiskMigrated: async () => ({ projects: await runtimeDeps.listProjects() }),
      sanitizeProjects: (projects) => projects,
    });
  });

  afterEach(async () => {
    runtimes.splice(0).forEach((runtime) => runtime.stop());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists botTaskFor fields and state through config sync/list/manual run without a session', async () => {
    const row = botRow();
    await scheduler.sync('project', [row]);
    await projectConfigRuntime.updateScheduledTaskState('project', row.id, { lastScheduledFor: 12345 });
    await scheduler.sync('project', [{ ...row, name: 'Renamed bot' }]);
    const listed = await service.list('project');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      botId: 'triage', botManaged: true, enabled: false, name: 'Renamed bot',
      execution: { notify: 'attention', useDefaults: true }, state: { lastScheduledFor: 12345 },
    });
    const persisted = JSON.parse(await fs.readFile(projectConfigRuntime.resolveProjectConfigPath('project'), 'utf8'));
    expect(persisted.scheduledTasks[0]).toMatchObject({ botId: 'triage', botManaged: true });
    const result = await service.run('project', row.id);
    expect(result).toMatchObject({ task: { botId: 'triage', enabled: false, state: { lastStatus: 'sent' } } });
    expect(result.sessionId).toBeUndefined();
    expect(runBot).toHaveBeenCalledWith('project', 'triage', expect.stringMatching(/^manual:/));
    expect(requests).not.toHaveBeenCalled();
    expect(scheduledTasksRuntime.getStatus().runningScheduledTasksCount).toBe(0);
  });

  it('refuses edit, pause, delete, loop-file mutations and owner injection through the ordinary service', async () => {
    const row = botRow();
    await scheduler.sync('project', [row]);
    for (const mutate of [
      () => service.upsert('project', { ...ordinaryTask(row.id), name: 'Hijacked' }),
      () => service.upsert('project', ordinaryTask(` ${row.id} `)),
      () => service.setEnabled('project', row.id, false),
      () => service.setEnabled('project', row.id, true),
      () => service.remove('project', row.id),
      () => service.setLoopEnabled('project', row.id, false),
      () => service.removeLoopFile('project', row.id),
      () => service.upsert('project', { ...ordinaryTask('injected'), botId: 'triage' }),
      () => service.upsert('project', { ...ordinaryTask('injected'), botManaged: true }),
    ]) await expect(mutate()).rejects.toMatchObject({ statusCode: 409 });
    expect(await projectConfigRuntime.listScheduledTasks('project')).toEqual([expect.objectContaining({ id: row.id, botId: row.botId, enabled: false })]);
  });

  it('removes stale bot owners and only the requested owner, preserving normal and suggested tasks', async () => {
    await service.upsert('project', ordinaryTask('normal'));
    await projectConfigRuntime.upsertScheduledTask('project', { ...ordinaryTask('scan'), suggestedScan: true });
    await scheduler.sync('project', [botRow('one'), botRow('two')]);
    await scheduler.sync('project', [botRow('two'), botRow('three')]);
    expect((await service.list('project')).map((task) => task.id).sort()).toEqual(['bot-three', 'bot-two', 'normal', 'scan']);
    await scheduler.remove('project', 'two');
    expect((await service.list('project')).map((task) => task.id).sort()).toEqual(['bot-three', 'normal', 'scan']);
    await scheduler.remove('project', 'missing');
    await scheduler.sync('project', []);
    expect((await service.list('project')).map((task) => task.id).sort()).toEqual(['normal', 'scan']);
    expect(await service.run('project', 'scan')).toMatchObject({ task: { suggestedScan: true, state: { lastStatus: 'skipped' } } });
    expect(runSuggestedScan).toHaveBeenCalledWith('project', 'manual');
    await expect(service.remove('project', 'scan')).rejects.toMatchObject({ statusCode: 409 });
    await service.remove('project', 'normal');
    expect((await service.list('project')).map((task) => task.id)).toEqual(['scan']);
    expect(requests).not.toHaveBeenCalled();
  });

  it('does not let same-name loops adopt bot rows', async () => {
    const row = botRow();
    await scheduler.sync('project', [row]);
    const tasks = await projectConfigRuntime.reconcileLoopTasks('project', [{
      scope: 'user', filePath: path.join(root, 'loop.md'),
      definition: { ...ordinaryTask('unused'), name: row.name },
    }]);
    expect(tasks.find((task) => task.id === row.id)).toMatchObject({ botId: row.botId, botManaged: true });
    expect(tasks.find((task) => task.id === row.id).loopFile).toBeUndefined();
    expect(tasks.some((task) => task.loopFile)).toBe(true);
  });

  it('rejects conflicting identities and malformed snapshots before removing existing owners', async () => {
    await scheduler.sync('project', [botRow('old')]);
    await service.upsert('project', ordinaryTask('bot-new'));
    await expect(scheduler.sync('project', [botRow('new')])).rejects.toThrow('another owner');
    await expect(scheduler.sync('project', null)).rejects.toThrow();
    await expect(scheduler.sync('project', [{ ...botRow('new'), id: 'wrong' }])).rejects.toThrow();
    expect((await service.list('project')).map((task) => task.id).sort()).toEqual(['bot-new', 'bot-old']);
  });

  it('preserves the old file after a failed write and safely retries the same config', async () => {
    await scheduler.sync('project', [botRow('old')]);
    const configPath = projectConfigRuntime.resolveProjectConfigPath('project');
    const before = await fs.readFile(configPath, 'utf8');
    failRename = true;
    await expect(scheduler.sync('project', [botRow('new')])).rejects.toThrow('disk write refused');
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    expect((await fs.readdir(path.dirname(configPath))).filter((file) => file.includes('.tmp-'))).toEqual([]);
    failRename = false;
    await scheduler.sync('project', [botRow('new')]);
    expect((await service.list('project')).map((task) => task.id)).toEqual(['bot-new']);
  });

  it.each(['missing', 'throws', 'invalid'])('records %s dispatch as failure without creating a fallback session', async (mode) => {
    if (mode === 'throws') runBot.mockRejectedValue(new Error('Source discovery failed'));
    if (mode === 'invalid') runBot.mockResolvedValue(undefined);
    if (mode === 'missing') {
      scheduledTasksRuntime = createScheduledTasksRuntime({ ...runtimeDeps, runBot: null });
      runtimes.push(scheduledTasksRuntime);
      scheduler = createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime });
    }
    await scheduler.sync('project', [botRow()]);
    const result = await scheduledTasksRuntime.runNow('project', 'bot-triage');
    expect(result).toMatchObject({ ok: false, status: 'error', task: { state: { lastStatus: 'error' } } });
    expect(requests).not.toHaveBeenCalled();
    expect(scheduledTasksRuntime.getStatus().runningScheduledTasksCount).toBe(0);
  });

  it('keeps concurrent manual bot dispatches within the project limit and releases slots on failure', async () => {
    let finish;
    runBot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    scheduledTasksRuntime = createScheduledTasksRuntime({ ...runtimeDeps, maxProjectConcurrency: 1 });
    runtimes.push(scheduledTasksRuntime);
    scheduler = createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime });
    await scheduler.sync('project', [botRow('one'), botRow('two')]);
    const first = scheduledTasksRuntime.runNow('project', 'bot-one');
    await vi.waitFor(() => expect(runBot).toHaveBeenCalledTimes(1));
    expect(await scheduledTasksRuntime.runNow('project', 'bot-two')).toMatchObject({ ok: false, queued: true });
    finish({ items: [], skipped: false });
    await first;
    expect(await scheduledTasksRuntime.runNow('project', 'bot-two')).toMatchObject({ ok: true });
    expect(runBot.mock.calls[0][2]).not.toBe(runBot.mock.calls[1][2]);
  });

  it('claims one scheduled occurrence across two instances and dispatches its stable slot key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-22T08:59:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const row = botRow('triage', { kind: 'daily', time: '09:00', timezone: 'UTC' });
    await scheduler.sync('project', [row]);
    const second = createScheduledTasksRuntime(runtimeDeps);
    runtimes.push(second);
    await scheduledTasksRuntime.start();
    await second.start();
    await vi.advanceTimersByTimeAsync(61_001);
    // Filesystem work uses real I/O even while the scheduler clock is fake.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [task] = await projectConfigRuntime.listScheduledTasks('project');
      if (task.state.lastStatus === 'success' && scheduledTasksRuntime.getStatus().runningScheduledTasksCount === 0 && second.getStatus().runningScheduledTasksCount === 0) break;
      await delay(10);
    }
    expect(runBot).toHaveBeenCalledTimes(1);
    const slot = Date.parse('2026-10-22T09:00:00Z');
    expect(runBot).toHaveBeenCalledWith('project', 'triage', `scheduled:project:bot-triage:${slot}`);
    const [task] = await projectConfigRuntime.listScheduledTasks('project');
    expect(task.state).toMatchObject({ lastScheduledFor: slot, lastStatus: 'sent' });
    expect(task.state.nextRunAt).toBe(Date.parse('2026-10-23T09:00:00Z'));
    expect(requests).not.toHaveBeenCalled();
  });
});
