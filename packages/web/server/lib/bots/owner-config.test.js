import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createOwnerBotConfig } from './owner-config.js';
import { createBotsConfig } from './config.js';
import { createScheduledTasksRuntime } from '../scheduled-tasks/runtime.js';
import { discoverLoops } from '../scheduled-tasks/loops.js';
import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';

const roots = [];
const runtimes = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});
const row = (id = 'bot-b') => ({ id, botId: 'b', botManaged: true, enabled: false, name: 'Bot',
  schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, execution: { prompt: 'Run', useDefaults: true } });
async function fixture() {
  const root = await fs.mkdtemp('/tmp/opencode/bots-owner-config-'); roots.push(root);
  const projectsDirPath = path.join(root, 'projects');
  const config = createOwnerBotConfig({ projectsDirPath });
  return { root, config, projectsDirPath };
}

it('keeps canonical stems, config compatibility, state and unknown fields in owner-local files', async () => {
  const f = await fixture();
  const id = createProjectIdFromPath(`/inaccessible/${'nested/'.repeat(80)}`);
  const config = createBotsConfig({ projectConfigRuntime: f.config });
  expect(await f.config.readBotsSection(id)).toBeUndefined();
  await config.update(id, { definitions: [{ id: 'b', name: 'Bot', mission: 'Fix' }] });
  await config.setApproval(id, '.agents/areas/a.md', 'a'.repeat(64));
  await f.config.upsertScheduledTask(id, { ...row(), future: { exact: ['retain'] }, state: { lastScheduledFor: 123, futureState: 'retain' } });
  await f.config.upsertScheduledTask(id, { ...row(), name: 'Changed' });
  const file = path.join(f.projectsDirPath, `${projectConfigFileStemOf(id)}.json`);
  expect(f.config.filePathFor(id)).toBe(file);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(persisted.scheduledTasks[0]).toMatchObject({ id: 'bot-b', future: { exact: ['retain'] }, state: { lastScheduledFor: 123, futureState: 'retain' } });
  expect((await config.read(id)).approvals).toEqual({ '.agents/areas/a.md': 'a'.repeat(64) });
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  const restarted = createOwnerBotConfig({ projectsDirPath: f.projectsDirPath });
  expect(await restarted.listScheduledTasks(id)).toEqual(await f.config.listScheduledTasks(id));
  expect(await fs.readdir(f.root)).toEqual(['projects']);
});

it('serializes occurrence claims across adapters and preserves storage on write failure', async () => {
  const f = await fixture();
  await f.config.upsertScheduledTask('p', row());
  const second = createOwnerBotConfig({ projectsDirPath: f.projectsDirPath });
  const claim = (runtime) => runtime.updateScheduledTaskStateIf('p', 'bot-b', (task) => task.state.lastScheduledFor !== 100, { lastScheduledFor: 100 });
  expect((await Promise.all([claim(f.config), claim(second)])).filter((result) => result.updated)).toHaveLength(1);
  const before = await fs.readFile(f.config.filePathFor('p'), 'utf8');
  const failing = createOwnerBotConfig({ projectsDirPath: f.projectsDirPath, fsImpl: { ...fs, rename: async () => { throw new Error('disk failed'); } } });
  await expect(failing.updateScheduledTaskState('p', 'bot-b', { lastStatus: 'sent' })).rejects.toThrow('disk failed');
  expect(await fs.readFile(f.config.filePathFor('p'), 'utf8')).toBe(before);
  expect((await fs.readdir(f.projectsDirPath)).filter((name) => name.includes('.tmp-'))).toEqual([]);
});

it('uses registered project metadata without remapping canonical storage IDs', async () => {
  const f = await fixture();
  const resolveProject = vi.fn(async (id) => id === 'registered' ? { id, path: '/inaccessible-checkout' } : null);
  const owner = createOwnerBotConfig({ projectsDirPath: f.projectsDirPath, resolveProject });
  await owner.upsertScheduledTask('registered', row());
  await expect(owner.readBotsSection('missing')).rejects.toThrow('Unknown owner Bots project');
  expect(resolveProject).toHaveBeenCalledWith('registered');
  expect(await fs.readdir(f.projectsDirPath)).toEqual(['registered.json']);
});

it('refuses malformed config, mixed ownership, duplicate IDs and migration blockers without replacing data', async () => {
  const f = await fixture();
  await fs.mkdir(f.projectsDirPath, { recursive: true });
  const ordinary = { id: 'normal', name: 'Keep', enabled: true };
  const file = f.config.filePathFor('p');
  await fs.writeFile(file, JSON.stringify({ version: 1, bots: {}, scheduledTasks: [ordinary, row()] }));
  expect((await f.config.listScheduledTasks('p')).map((task) => task.id)).toEqual(['bot-b']);
  await expect(f.config.upsertScheduledTask('p', row('normal'))).rejects.toThrow('another owner');
  await expect(f.config.deleteScheduledTask('p', 'normal')).rejects.toThrow('another owner');
  await f.config.updateScheduledTaskState('p', 'bot-b', { lastStatus: 'sent' });
  expect(JSON.parse(await fs.readFile(file, 'utf8')).scheduledTasks[0]).toEqual(ordinary);
  for (const text of ['{bad', JSON.stringify({ version: 1, bots: null }), JSON.stringify({ version: 1, scheduledTasks: [row(), row()] })]) {
    await fs.writeFile(file, text);
    await expect(f.config.readBotsSection('p')).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(text);
  }
  await fs.writeFile(`${file}.bots-migration-blocked`, 'blocked');
  await expect(f.config.readBotsSection('p')).rejects.toThrow('migration is blocked');
});

async function scheduler(mode) {
  const root = await fs.mkdtemp('/tmp/opencode/bots-owner-scheduler-'); roots.push(root);
  const loopDirectory = path.join(root, '.agents', 'loops');
  await fs.mkdir(loopDirectory, { recursive: true });
  await fs.writeFile(path.join(loopDirectory, 'project.md'), '---\nname: Project loop\nschedule: "0 9 * * *"\nmodel: controlled/model\n---\nRun project loop\n');
  const exists = vi.spyOn(fsSync, 'existsSync');
  const tasks = [row(), { ...row('normal'), botId: undefined, botManaged: undefined },
    { ...row('scan'), botId: undefined, botManaged: undefined, suggestedScan: true },
    { ...row('target'), botId: undefined, botManaged: undefined, targetSessionId: 'ses_a' }];
  const updateScheduledTaskStateIf = vi.fn(async (_project, id, predicate, patch) => {
    const task = tasks.find((task) => task.id === id);
    if (!predicate(task)) return { task, updated: false };
    task.state = { ...task.state, ...patch };
    return { task, updated: true };
  });
  const deps = { mode, listProjects: async () => [{ id: 'p', path: root }],
    projectConfigRuntime: { listScheduledTasks: async () => tasks,
      reconcileLoopTasks: vi.fn(async () => tasks), listScheduledWorktreeCleanups: vi.fn(async () => []),
      updateScheduledTaskStateIf,
      updateScheduledTaskState: vi.fn(async (_project, id, patch) => { const task = tasks.find((task) => task.id === id); task.state = { ...task.state, ...patch }; return { task }; }) },
    runBot: vi.fn(async () => ({ items: [], skipped: false })),
    runSuggestedScan: vi.fn(async () => ({ skipped: true })),
    waitForOpenCodeReady: vi.fn(async () => {}), logger: { info() {}, warn() {} },
  };
  const runtime = createScheduledTasksRuntime(deps); runtimes.push(runtime);
  return { deps, runtime, tasks, root, loopDirectory, exists };
}

it('bots-only start, refresh and manual runs never discover loops, scan, reuse sessions or recover ordinary cleanups', async () => {
  const { deps, runtime, root, loopDirectory, exists } = await scheduler('bots-only');
  await runtime.start();
  expect((await runtime.syncProject('p')).map((task) => task.id)).toEqual(['bot-b']);
  for (const id of ['normal', 'scan', 'target']) expect(await runtime.runNow('p', id)).toEqual({ ok: false, skipped: true });
  expect(await runtime.runNow('p', 'bot-b')).toMatchObject({ ok: true });
  expect(deps.runBot).toHaveBeenCalledWith('p', 'b', expect.stringMatching(/^manual:/));
  expect(exists.mock.calls.some(([file]) => file === loopDirectory)).toBe(false);
  expect(deps.projectConfigRuntime.reconcileLoopTasks).not.toHaveBeenCalled();
  expect(deps.projectConfigRuntime.listScheduledWorktreeCleanups).not.toHaveBeenCalled();
  expect(deps.waitForOpenCodeReady).not.toHaveBeenCalled();
  expect(deps.runSuggestedScan).not.toHaveBeenCalled();
  expect(deps.projectConfigRuntime.updateScheduledTaskStateIf.mock.calls.every((call) => call[1] === 'bot-b')).toBe(true);
  // Real discovery is the positive control for both the fixture and observation.
  expect(discoverLoops(root)).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'project',
    definition: expect.objectContaining({ name: 'Project loop' }) })]));
  expect(exists.mock.calls.some(([file]) => file === loopDirectory)).toBe(true);
});

it('exclude-bots filters before refresh and manual state writes, including stale ownership changed on disk', async () => {
  const { deps, runtime, tasks } = await scheduler('exclude-bots');
  await runtime.start();
  expect((await runtime.syncProject('p')).map((task) => task.id)).toEqual(['normal', 'scan', 'target']);
  expect(await runtime.runNow('p', 'bot-b')).toEqual({ ok: false, skipped: true });
  const ordinary = tasks.find((task) => task.id === 'normal');
  // A refresh kept the old object; the authoritative write sees a newly bot-owned row.
  tasks[tasks.indexOf(ordinary)] = { ...ordinary, botId: 'b', botManaged: true };
  expect(await runtime.runNow('p', 'normal')).toEqual({ ok: false, skipped: true });
  expect(deps.runBot).not.toHaveBeenCalled();
  expect(deps.projectConfigRuntime.listScheduledWorktreeCleanups).toHaveBeenCalledOnce();
});

it('bots-only scheduled dispatch retains the claimed occurrence key and never claims excluded rows', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T08:59:30Z')); vi.spyOn(Math, 'random').mockReturnValue(0);
  const { deps, runtime, tasks } = await scheduler('bots-only');
  tasks.forEach((task) => { task.enabled = true; });
  await runtime.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deps.runBot).toHaveBeenCalledWith('p', 'b', `scheduled:p:bot-b:${Date.parse('2026-11-16T09:00:00Z')}`);
  expect(deps.projectConfigRuntime.updateScheduledTaskStateIf.mock.calls.every((call) => call[1] === 'bot-b')).toBe(true);
});

it('default single-account mode still discovers loops, recovers cleanup and dispatches both scans and Bots', async () => {
  const { deps, runtime, loopDirectory, exists } = await scheduler(undefined);
  await runtime.start();
  expect((await runtime.syncProject('p')).map((task) => task.id)).toEqual(['bot-b', 'normal', 'scan', 'target']);
  expect(await runtime.runNow('p', 'bot-b')).toMatchObject({ ok: true });
  expect(await runtime.runNow('p', 'scan')).toMatchObject({ ok: true, status: 'skipped' });
  expect(exists.mock.calls.some(([file]) => file === loopDirectory)).toBe(true);
  expect(deps.projectConfigRuntime.reconcileLoopTasks).toHaveBeenCalledWith('p', expect.arrayContaining([
    expect.objectContaining({ scope: 'project', definition: expect.objectContaining({ name: 'Project loop' }) }),
  ]));
  expect(deps.projectConfigRuntime.listScheduledWorktreeCleanups).toHaveBeenCalledOnce();
  expect(deps.runBot).toHaveBeenCalledOnce();
  expect(deps.runSuggestedScan).toHaveBeenCalledWith('p', 'manual');
});
