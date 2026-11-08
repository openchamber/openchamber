import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, mkdir, writeFile, stat, readdir } from 'fs/promises';
import {
  computeNextRunAt,
  expandCommandGoalObjective,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
  createScheduledTasksRuntime as createRuntime,
} from './runtime.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createChatsScope } from './chats-scope.js';
import { loopFingerprint, parseLoopDefinition } from './loops.js';
import { createOpenCodeSessionMetadata, createSessionMetadataStore } from '../openchamber-sessions/session-metadata-store.js';
import { readProcessInstance } from './process-instance.js';

const createScheduledTasksRuntime = (deps) => {
  const cleanups = new Map();
  return createRuntime({
    readSessionMetadata: async () => ({}),
    readProcessInstance: async (pid) => pid === process.pid ? 'test-process-instance' : null,
    readWorktreeIdentity: async () => 'fixture-directory',
    ...deps,
    projectConfigRuntime: {
      listScheduledWorktreeCleanups: async () => [...cleanups.values()],
      saveScheduledWorktreeCleanup: async (projectID, value) => {
        const record = { ...value, projectID };
        cleanups.set(record.sessionID, record);
        return record;
      },
      finishScheduledWorktreeCleanup: async (_projectID, sessionID, remove) => {
        const record = cleanups.get(sessionID);
        if (!record) return;
        if (remove) { record.phase = 'removing'; await remove(record); }
        else if (record.phase === 'removing') return false;
        cleanups.delete(sessionID);
        return true;
      },
      ...deps.projectConfigRuntime,
    },
  });
};

describe('scheduled-tasks runtime helpers', () => {
  it.each([
    ['*/15 * * * *', 'UTC', '2026-09-18T08:07:00Z', '2026-09-18T08:15:00Z'],
    ['30 */5 * * * *', 'UTC', '2026-09-18T08:07:00Z', '2026-09-18T08:10:30Z'],
    ['0 9 * * MON-FRI', 'Europe/Kyiv', '2026-09-18T07:00:00Z', '2026-09-21T06:00:00Z'],
    ['0 9 * * *', 'Europe/Kyiv', '2026-03-28T08:00:00Z', '2026-03-29T06:00:00Z'],
    ['0 9 * * *', 'Europe/Kyiv', '2026-10-24T08:00:00Z', '2026-10-25T07:00:00Z'],
    ['0 0 L * *', 'UTC', '2026-02-01T00:00:00Z', '2026-02-28T00:00:00Z'],
  ])('computes cron %s in %s from %s', (cron, timezone, now, expected) => {
    expect(computeNextRunAt({
      enabled: true,
      schedule: { kind: 'cron', cron, timezone },
    }, Date.parse(now))).toBe(Date.parse(expected));
  });

  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
    expect(parseScheduledCommandPrompt(undefined)).toBeNull();
    expect(parseScheduledCommandPrompt('/ review')).toBeNull();
    expect(parseScheduledCommandPrompt('/\nreview')).toBeNull();
  });

  it.each([
    ['/review first line\n\n  indented text\nlast line', 'first line\n\n  indented text\nlast line'],
    ['/review \t\n  first line\n\n    indented text', '  first line\n\n    indented text'],
    ['/review\n\n  indented text', '\n  indented text'],
    ['/review\r\n  first line\r\n\r\n    indented text', '  first line\r\n\r\n    indented text'],
    ['/review first  second\tthird', 'first  second\tthird'],
    ['  /review \t first second \t\r\n', 'first second'],
    ['/review', ''],
    ['/review \t\r\n', ''],
  ])('preserves the argument body of %j after outer trimming', (prompt, argumentsText) => {
    expect(parseScheduledCommandPrompt(prompt)).toEqual({ command: 'review', arguments: argumentsText });
  });

  it('expands command arguments into the goal objective', () => {
    expect(expandCommandGoalObjective(
      'Run the issue pipeline for $ARGUMENTS. Verify $ARGUMENTS is represented by the PR.',
      'LIN-123 --draft',
    )).toBe('Run the issue pipeline for LIN-123 --draft. Verify LIN-123 --draft is represented by the PR.');
    expect(expandCommandGoalObjective(undefined, 'LIN-123')).toBeNull();
    expect(expandCommandGoalObjective('Move $1 to $2', '"src old" dist extra')).toBe('Move src old to dist extra');
    expect(expandCommandGoalObjective('Review the requested scope.', 'auth module'))
      .toBe('Review the requested scope.\n\nauth module');
  });
});

describe('scheduled-tasks runtime syncProject wiring', () => {
  const createTempProject = async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-loop-'));
    const repoPath = path.join(tempRoot, 'repo');
    await mkdir(path.join(repoPath, '.agents', 'loops'), { recursive: true });
    return {
      tempRoot,
      repoPath,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  };

  const createProjectConfig = async (tempRoot) => createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: path.join(tempRoot, 'config'),
    createTaskID: () => 'task-fixed-id',
  });

  const createRuntimeDeps = (overrides = {}) => ({
    buildOpenCodeUrl: () => 'http://localhost',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    ...overrides,
  });

  it('reconciles discovered loops when the project path is known', async () => {
    const { tempRoot, repoPath, cleanup } = await createTempProject();
    try {
      await writeFile(path.join(repoPath, '.agents', 'loops', 'daily.md'), `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: repoPath }],
      });

      const loopFile = path.join(repoPath, '.agents', 'loops', 'daily.md');
      await runtime.syncProject('proj');

      // `enabled: true` came with the repository: listed, not scheduled.
      let tasks = await projectConfigRuntime.listScheduledTasks('proj');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('loop:project:daily');
      expect(tasks[0].loopFile).toBe(loopFile);
      expect(tasks[0].enabled).toBe(false);

      // Approved on this machine, this version runs.
      await projectConfigRuntime.setLoopApproval('proj', loopFile, loopFingerprint(parseLoopDefinition(loopFile)));
      await runtime.syncProject('proj');
      tasks = await projectConfigRuntime.listScheduledTasks('proj');
      expect(tasks[0].enabled).toBe(true);
      // syncTaskSchedule computed and persisted the next run for the enabled task.
      expect(tasks[0].state.nextRunAt).toBeGreaterThan(0);

      // A changed prompt is a new version and waits for a new approval.
      await writeFile(loopFile, `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run something else.
`, 'utf8');
      await runtime.syncProject('proj');
      tasks = await projectConfigRuntime.listScheduledTasks('proj');
      expect(tasks[0].enabled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('falls back to plain listing when the project path cannot be resolved', async () => {
    const { tempRoot, cleanup } = await createTempProject();
    try {
      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const reconcileSpy = vi.spyOn(projectConfigRuntime, 'reconcileLoopTasks');
      const listSpy = vi.spyOn(projectConfigRuntime, 'listScheduledTasks');

      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        // Project not registered -> ensureProjectPath cannot resolve a path.
        listProjects: async () => [],
      });

      await runtime.syncProject('proj');

      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(listSpy).toHaveBeenCalledWith('proj');
      expect(await projectConfigRuntime.listScheduledTasks('proj')).toEqual([]);
      reconcileSpy.mockRestore();
      listSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });
});

describe('scheduled-tasks runtime syncAllProjects', () => {
  it('keeps scheduling the other projects when one project cannot be synced', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-sync-all-'));
    try {
      const brokenPath = path.join(tempRoot, 'broken');
      const healthyPath = path.join(tempRoot, 'healthy');
      await mkdir(path.join(healthyPath, '.agents', 'loops'), { recursive: true });
      await mkdir(brokenPath, { recursive: true });
      await writeFile(path.join(healthyPath, '.agents', 'loops', 'daily.md'), `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

      const projectConfigRuntime = createProjectConfigRuntime({
        fsPromises: await import('fs/promises'),
        path,
        projectsDirPath: path.join(tempRoot, 'config'),
        createTaskID: () => 'task-fixed-id',
      });
      await mkdir(path.join(tempRoot, 'config'), { recursive: true });
      await writeFile(projectConfigRuntime.resolveProjectConfigPath('broken'), '{ not json', 'utf8');
      const healthyLoop = path.join(healthyPath, '.agents', 'loops', 'daily.md');
      await projectConfigRuntime.setLoopApproval('healthy', healthyLoop, loopFingerprint(parseLoopDefinition(healthyLoop)));

      const warnings = [];
      const runtime = createScheduledTasksRuntime({
        buildOpenCodeUrl: () => 'http://localhost',
        getOpenCodeAuthHeaders: () => ({}),
        waitForOpenCodeReady: async () => {},
        projectConfigRuntime,
        listProjects: async () => [
          { id: 'broken', path: brokenPath },
          { id: 'healthy', path: healthyPath },
        ],
        logger: { warn: (...args) => warnings.push(args) },
      });

      await expect(runtime.start()).resolves.toBeUndefined();

      expect(runtime.getStatus().enabledScheduledTasksCount).toBe(1);
      const healthyTasks = await projectConfigRuntime.listScheduledTasks('healthy');
      expect(healthyTasks.map((task) => task.id)).toEqual(['loop:project:daily']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toMatchObject({ projectID: 'broken' });
      runtime.stop();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('scheduled-tasks runtime prompt dispatch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the complete multiline command body to OpenCode', async () => {
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST') posts.push({ pathname, body: JSON.parse(init.body) });
      if (pathname === '/api/session/ses_run/command') return new Response(null, { status: 204 });
      const data = pathname === '/api/session' ? { id: 'ses_run' } : pathname === '/api/command' ? [{ name: 'review' }] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: '/review\r\nfirst  line\r\n\r\n  indented text', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async () => ({ task, updated: true }),
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      await runtime.start();
      const result = await runtime.runNow('proj', 'task-1');
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ ok: true });
      expect(posts.find((post) => post.pathname === '/api/session/ses_run/command')?.body).toEqual({
        name: 'review',
        text: 'first  line\r\n\r\n  indented text',
      });
      expect(posts.some((post) => post.pathname.endsWith('/prompt'))).toBe(false);
    } finally {
      runtime.stop();
    }
  });

  it('parks the briefing with resume: false so execution starts on the task prompt', async () => {
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST') posts.push({ pathname, body: JSON.parse(init.body) });
      const data = pathname === '/api/session' ? { id: 'ses_run' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5', goalEnabled: true, goalTokenBudget: 50_000 },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async () => ({ task, updated: true }),
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      persistSessionGoal: async () => undefined,
      sessionKnowledgeRuntime: {
        sync: async (sessionID, directory, responseStyleInstruction) => {
          posts.push({ pathname: `knowledge:${sessionID}`, body: { directory, responseStyleInstruction } });
          return true;
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    await runtime.runNow('proj', 'task-1');
    runtime.stop();

    // The run is marked, so it stays out of In work.
    expect(posts.find((post) => post.pathname === '/api/session')?.body.metadata).toEqual({ openchamber: { kind: 'scheduled' } });
    // The project knowledge is written into the session before anything is sent to it.
    const dispatch = posts.filter((post) => post.pathname.startsWith('/api/session/ses_run/') || post.pathname.startsWith('knowledge:'));
    expect(dispatch.map((post) => post.pathname.split('/').at(-1))).toEqual(['knowledge:ses_run', 'synthetic', 'prompt']);
    expect(dispatch[0].body).toEqual({ directory: '/repo', responseStyleInstruction: '' });
    expect(dispatch[1].body.resume).toBe(false);
    expect(dispatch[2].body).toMatchObject({ text: 'Review open issues' });
    expect(dispatch[2].body.resume).toBeUndefined();
  });

  it('points a run that fails after creating its session at that session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST' && pathname.endsWith('/prompt')) {
        return new Response(JSON.stringify({ error: 'provider down' }), { status: 500 });
      }
      const data = pathname === '/api/session' ? { id: 'ses_failed' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1, lastSessionId: 'ses_previous' },
    };
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(false);
    // The start clears the previous run's session, creation records this one,
    // and the failure keeps it.
    const startIndex = patches.findIndex((patch) => patch.lastStatus === 'running');
    expect(Object.hasOwn(patches[startIndex], 'lastSessionId')).toBe(true);
    expect(patches[startIndex].lastSessionId).toBeUndefined();
    expect(patches[startIndex + 1]).toEqual({ lastSessionId: 'ses_failed' });
    expect(patches.at(-1)).toMatchObject({ lastStatus: 'error', lastSessionId: 'ses_failed' });
  });

  it('records a dispatched prompt as sent instead of a completed success', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      const data = pathname === '/api/session' ? { id: 'ses_run' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(true);
    expect(patches.at(-1)).toMatchObject({ lastStatus: 'sent', lastSessionId: 'ses_run' });
    expect(patches.at(-1).lastError).toBeUndefined();
  });

  it.each([
    ['Review issues', 'settled'], ['/review issues', 'settled'],
    ['Review issues', 'wait failure'], ['Review issues', 'cleanup timeout'],
    ['Review issues', 'active subagent'], ['Review issues', 'activity failure'],
    ['Review issues', 'active goal'], ['Review issues', 'background shell'],
    ['Review issues', 'subsession shell'], ['Review issues', 'shell failure'],
    ['Review issues', 'goal failure'], ['Review issues', 'unrelated shell'], ['Review issues', 'old shell'],
    ['Review issues', 'journal failure'],
    ['Review issues', 'metadata timeout'], ['Review issues', 'metadata stop'],
  ])('cleans up after execution for %s with %s', async (prompt, outcome) => {
    const settled = Promise.withResolvers();
    const removed = Promise.withResolvers();
    const warned = Promise.withResolvers();
    const lineageRead = Promise.withResolvers();
    const paused = Promise.withResolvers();
    const resumeCheck = Promise.withResolvers();
    const continuation = Promise.withResolvers();
    const continuationWait = Promise.withResolvers();
    const metadataEntered = Promise.withResolvers();
    const metadataAborted = Promise.withResolvers();
    const metadataMode = ['metadata timeout', 'metadata stop'].includes(outcome);
    const metadataDir = metadataMode ? await mkdtemp(path.join(os.tmpdir(), 'oc-cleanup-metadata-')) : null;
    let blockMetadata = metadataMode;
    let goalActive = outcome === 'active goal';
    let backgroundLive = true;
    const watchdog = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(watchdog.signal);
    const removals = [];
    const waitRequests = [];
    const sentPrompts = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith('/wait')) {
        waitRequests.push(pathname);
        if (outcome === 'active goal' && waitRequests.length > 1) {
          continuationWait.resolve();
          return continuation.promise;
        }
        init.signal.addEventListener('abort', () => settled.reject(init.signal.reason), { once: true });
        return settled.promise;
      }
      if (pathname === '/api/session/active') {
        if (outcome === 'activity failure') return new Response(null, { status: 503 });
        return Response.json({ data: outcome === 'active subagent' ? { child: { type: 'running' } } : {} });
      }
      if (pathname === '/api/shell') {
        if (outcome === 'shell failure') return new Response(null, { status: 503 });
        const owners = { 'background shell': 'ses_settle', 'subsession shell': 'child', 'unrelated shell': 'other', 'old shell': 'ses_settle' };
        const owner = backgroundLive ? owners[outcome] : null;
        return Response.json({ data: owner ? [{
          status: 'running', command: 'bun test', metadata: { sessionID: owner },
          time: { started: outcome === 'old shell' ? 0 : Date.now() + 1 },
        }] : [] });
      }
      if (pathname === '/api/session/other') return Response.json({ data: { id: 'other', parentID: null } });
      if (pathname === '/api/session/ses_settle') {
        if (!blockMetadata) return Response.json({ data: { id: 'ses_settle', metadata: {} } });
        metadataEntered.resolve(init.signal);
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => {
          metadataAborted.resolve();
          reject(init.signal.reason);
        }, { once: true }));
      }
      if (pathname === '/api/session/child') {
        lineageRead.resolve();
        return Response.json({ data: { id: 'child', parentID: 'ses_settle' } });
      }
      if (pathname === '/api/command') return Response.json({ data: [{ name: 'review' }] });
      if (pathname.endsWith('/command')) return new Response(null, { status: 204 });
      if (pathname.endsWith('/prompt')) sentPrompts.push(pathname);
      return Response.json({ data: pathname === '/api/session' ? { id: 'ses_settle' } : { id: 'msg_accepted' } });
    }));
    const task = {
      id: 'task-1', name: 'Review', enabled: false, runInWorktree: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt, useDefaults: true }, state: { createdAt: 1, updatedAt: 1 },
    };
    const projectConfigRuntime = {
      listScheduledTasks: async () => [task], reconcileLoopTasks: async () => [task],
      updateScheduledTaskState: async () => ({ task, updated: true }),
    };
    if (outcome === 'journal failure') {
      projectConfigRuntime.saveScheduledWorktreeCleanup = async () => { throw new Error('Cleanup journal write failed'); };
    }
    let metadataReader = async () => {
      if (outcome === 'goal failure') throw new Error('Metadata unavailable');
      return { openchamber: { goal: { status: goalActive ? 'active' : 'complete' } } };
    };
    if (metadataMode) {
      const store = createSessionMetadataStore({
        dataDir: metadataDir,
        openCode: createOpenCodeSessionMetadata({
          buildOpenCodeUrl: (pathname) => `http://localhost:1${pathname}`,
          getOpenCodeAuthHeaders: () => ({}),
        }),
      });
      metadataReader = (sessionID, options) => store.get(sessionID, options);
    }
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime,
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: (pathname) => `http://localhost:1${pathname}`,
      getOpenCodeAuthHeaders: () => ({}), waitForOpenCodeReady: async () => {},
      isGitRepository: async () => true,
      readSessionMetadata: metadataReader,
      cleanupPause: async (signal) => {
        paused.resolve();
        if (['active goal', 'background shell', 'subsession shell'].includes(outcome)) await resumeCheck.promise;
        else {
          signal.throwIfAborted();
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
      },
      createTaskWorktree: async () => ({ directory: '/repo/run', branch: 'openchamber/run' }),
      removeTaskWorktree: async (input) => { removals.push(input); removed.resolve(); },
      logger: { info() {}, warn: (message, entry) => warned.resolve({ message, entry }), error() {} },
    });
    try {
      await runtime.start();
      const result = await runtime.runNow('proj', task.id);
      if (outcome === 'journal failure') {
        expect(result).toMatchObject({ ok: false, status: 'error', error: expect.stringContaining('Cleanup journal write failed') });
        expect(sentPrompts).toEqual([]);
        expect(waitRequests).toEqual([]);
        expect(removals).toHaveLength(1);
        return;
      }
      expect(result).toMatchObject({ ok: true, status: 'sent' });
      expect(removals).toEqual([]);
      expect(waitRequests).toEqual(['/api/experimental/session/ses_settle/wait']);
      if (outcome === 'cleanup timeout') {
        watchdog.abort(new DOMException('Cleanup timed out', 'TimeoutError'));
      } else {
        settled.resolve(new Response(null, { status: outcome === 'wait failure' ? 503 : 204 }));
      }
      if (metadataMode) {
        const requestSignal = await metadataEntered.promise;
        expect(requestSignal).toBeDefined();
        expect(removals).toEqual([]);
        if (outcome === 'metadata timeout') {
          watchdog.abort(new DOMException('Cleanup timed out', 'TimeoutError'));
          const warning = await warned.promise;
          expect(warning.message).toContain('failed to clean up the isolated worktree');
          expect(warning.entry).toMatchObject({ reason: 'cleanup-wait-budget-exceeded', error: 'Cleanup timed out' });
        }
        runtime.stop();
        await metadataAborted.promise;
        expect(requestSignal.aborted).toBe(true);
        expect(removals).toEqual([]);
        blockMetadata = false;
        timeoutSpy.mockRestore();
        await runtime.start();
        await removed.promise;
        expect(removals).toHaveLength(1);
        return;
      }
      if (outcome === 'active subagent') {
        await lineageRead.promise;
        watchdog.abort(new DOMException('Cleanup timed out', 'TimeoutError'));
      }
      if (['active goal', 'background shell', 'subsession shell'].includes(outcome)) {
        await paused.promise;
        expect(removals).toEqual([]);
        goalActive = false;
        backgroundLive = false;
        resumeCheck.resolve();
        if (outcome === 'active goal') {
          await continuationWait.promise;
          expect(removals).toEqual([]);
          continuation.resolve(new Response(null, { status: 204 }));
        }
      }
      if (['settled', 'active goal', 'background shell', 'subsession shell', 'unrelated shell', 'old shell'].includes(outcome)) {
        await removed.promise;
        expect(removals).toEqual([{
          projectDirectory: '/repo', worktreeDirectory: '/repo/run', branch: 'openchamber/run', deleteLocalBranch: true,
        }]);
      } else {
        expect((await warned.promise).message).toContain('failed to clean up the isolated worktree');
        expect(removals).toEqual([]);
      }
    } finally {
      timeoutSpy.mockRestore();
      runtime.stop();
      if (metadataDir) await rm(metadataDir, { recursive: true, force: true });
    }
  });

  it.each(['stop', 'timeout'])('keeps a claimed cleanup when %s fires during its final directory identity read', async (cause) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oc-cleanup-finalize-'));
    const directory = path.join(root, 'run');
    await mkdir(directory);
    const info = await stat(directory, { bigint: true });
    const identity = `${info.dev}:${info.ino}`;
    const config = createProjectConfigRuntime({ fsPromises: await import('fs/promises'), path, projectsDirPath: path.join(root, 'projects') });
    const record = {
      projectDirectory: root, worktreeDirectory: directory, directoryIdentity: identity,
      sessionID: 'ses_cancelled', branch: 'openchamber/run', startedAt: 1, ownerPID: 0, phase: 'waiting',
    };
    await config.saveScheduledWorktreeCleanup('project-test', record);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const finished = Promise.withResolvers();
    const removed = Promise.withResolvers();
    const budget = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(budget.signal);
    let hold = true;
    vi.stubGlobal('fetch', vi.fn(async (input) => new URL(String(input)).pathname.endsWith('/wait')
      ? new Response(null, { status: 204 }) : Response.json({ data: new URL(String(input)).pathname === '/api/shell' ? [] : {} })));
    const remove = vi.fn(async () => { await rm(directory, { recursive: true }); removed.resolve(); });
    const runtime = createRuntime({
      projectConfigRuntime: {
        ...config,
        finishScheduledWorktreeCleanup: (...args) => {
          const result = config.finishScheduledWorktreeCleanup(...args);
          result.then(finished.resolve, finished.resolve);
          return result;
        },
      },
      listProjects: async () => [], buildOpenCodeUrl: (pathname) => `http://localhost:1${pathname}`,
      getOpenCodeAuthHeaders: () => ({}), readSessionMetadata: async () => ({}),
      readWorktreeIdentity: async () => {
        if (hold && (await config.listScheduledWorktreeCleanups())[0]?.phase === 'removing') {
          entered.resolve();
          await release.promise;
        }
        return identity;
      },
      removeTaskWorktree: remove, logger: { info() {}, warn() {}, error() {} },
    });
    try {
      await runtime.start();
      await entered.promise;
      if (cause === 'stop') runtime.stop();
      else budget.abort(new DOMException('Cleanup timed out', 'TimeoutError'));
      hold = false;
      release.resolve();
      expect(await finished.promise).toBeInstanceOf(Error);
      expect(remove).not.toHaveBeenCalled();
      expect((await stat(directory)).isDirectory()).toBe(true);
      expect((await config.listScheduledWorktreeCleanups())[0]).toMatchObject({ phase: 'removing', ownerPID: 0 });
      runtime.stop();
      timeoutSpy.mockRestore();
      await runtime.start();
      await removed.promise;
      await vi.waitFor(async () => expect(await config.listScheduledWorktreeCleanups()).toEqual([]));
    } finally {
      hold = false;
      release.resolve();
      timeoutSpy.mockRestore();
      runtime.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['restart', 'same runtime restart', 'manual deletion', 'replaced directory', 'replacement during wait', 'interrupted removal', 'reused live PID', 'reused live PID during removal', 'live owner', 'unreadable owner', 'legacy owner record'])('recovers every run cleanup after %s without resending prompts', async (scenario) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oc-cleanup-recovery-'));
    const repository = path.join(root, 'repo');
    const projectsDirPath = path.join(root, 'projects');
    await mkdir(repository);
    const config = createProjectConfigRuntime({ fsPromises: await import('fs/promises'), path, projectsDirPath });
    const saved = await config.upsertScheduledTask('project-test', {
      name: 'Recurring review', enabled: false, runInWorktree: true,
      schedule: { kind: 'daily', time: '03:00', timezone: 'UTC' },
      execution: { prompt: 'Review', useDefaults: true },
    });
    const waiting = Promise.withResolvers();
    const removed = Promise.withResolvers();
    const removals = [];
    const logs = [];
    const restoredWaits = [];
    let sessionCount = 0;
    let worktreeCount = 0;
    let promptCount = 0;
    let waitCount = 0;
    let restoring = false;
    const replacement = ['replaced directory', 'replacement during wait'].includes(scenario);
    const expectedRemovals = scenario === 'manual deletion' || replacement ? 1 : 2;
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith('/wait')) {
        if (restoring) {
          restoredWaits.push(pathname);
          if (scenario === 'replacement during wait' && pathname.includes('/ses_recovery_1/')) {
            await (await import('fs/promises')).rename(path.join(root, 'run-1'), path.join(root, 'old-run-1'));
            await mkdir(path.join(root, 'run-1'));
            await writeFile(path.join(root, 'run-1', 'keep.txt'), 'New directory');
          }
          return new Response(null, { status: 204 });
        }
        waitCount += 1;
        if (waitCount === 2) waiting.resolve();
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      }
      if (pathname === '/api/session/active') return Response.json({ data: {} });
      if (pathname === '/api/shell') return Response.json({ data: [] });
      if (pathname.endsWith('/prompt')) {
        promptCount += 1;
        expect(await config.listScheduledWorktreeCleanups()).toHaveLength(promptCount);
      }
      return Response.json({ data: pathname === '/api/session' ? { id: `ses_recovery_${++sessionCount}` } : { id: 'msg_accepted' } });
    }));
    const dependencies = {
      projectConfigRuntime: config,
      listProjects: async () => [{ id: 'project-test', path: repository }],
      buildOpenCodeUrl: (pathname) => `http://localhost:1${pathname}`,
      getOpenCodeAuthHeaders: () => ({}), waitForOpenCodeReady: async () => {},
      readSessionMetadata: async () => ({}), isGitRepository: async () => true,
      createTaskWorktree: async () => {
        const directory = path.join(root, `run-${++worktreeCount}`);
        await mkdir(directory);
        return { directory, branch: `openchamber/run-${worktreeCount}` };
      },
      removeTaskWorktree: async (input) => {
        removals.push(input);
        if (input.removeDirectory !== false) await rm(input.worktreeDirectory, { recursive: true, force: true });
        if (removals.length === expectedRemovals) removed.resolve();
      },
      logger: { info: (message, entry) => logs.push({ message, entry }), warn: (message, entry) => logs.push({ message, entry }), error() {} },
    };
    const first = createRuntime(dependencies);
    let second;
    try {
      await first.start();
      expect((await first.runNow('project-test', saved.task.id)).ok).toBe(true);
      expect((await first.runNow('project-test', saved.task.id)).ok).toBe(true);
      await waiting.promise;
      first.stop();
      expect(await config.listScheduledWorktreeCleanups()).toHaveLength(2);
      expect(removals).toEqual([]);
      if (scenario === 'manual deletion') await rm(path.join(root, 'run-1'), { recursive: true });
      if (scenario === 'replaced directory') {
        await (await import('fs/promises')).rename(path.join(root, 'run-1'), path.join(root, 'old-run-1'));
        await mkdir(path.join(root, 'run-1'));
        await writeFile(path.join(root, 'run-1', 'keep.txt'), 'New directory');
      }
      if (scenario === 'interrupted removal' || scenario === 'reused live PID during removal') {
        await expect(config.finishScheduledWorktreeCleanup('project-test', 'ses_recovery_1', async (record) => {
          await rm(record.worktreeDirectory, { recursive: true });
          throw new Error('Interrupted before branch deletion');
        })).rejects.toThrow('Interrupted before branch deletion');
      }
      const ownerChecks = vi.fn(readProcessInstance);
      const parentOwner = ['reused live PID', 'reused live PID during removal', 'live owner', 'unreadable owner', 'legacy owner record'].includes(scenario);
      const parentInstance = parentOwner ? await readProcessInstance(process.ppid) : null;
      if (parentOwner) expect(parentInstance).toBeTypeOf('string');
      for (const record of await config.listScheduledWorktreeCleanups()) {
        const value = { ...record, ownerPID: parentOwner ? process.ppid : 2147483647 };
        if (scenario === 'live owner' || scenario === 'unreadable owner') value.ownerInstance = parentInstance;
        if (scenario === 'reused live PID' || scenario === 'reused live PID during removal') value.ownerInstance = 'previous-process-start-time';
        if (scenario === 'legacy owner record') delete value.ownerInstance;
        await config.saveScheduledWorktreeCleanup(record.projectID, value);
      }
      if (scenario === 'unreadable owner') ownerChecks.mockRejectedValue(new Error('Process info unavailable'));
      await config.deleteScheduledTask('project-test', saved.task.id);
      restoring = true;
      const reloaded = createProjectConfigRuntime({ fsPromises: await import('fs/promises'), path, projectsDirPath });
      second = scenario === 'same runtime restart' ? first
        : createRuntime({ ...dependencies, projectConfigRuntime: reloaded, listProjects: async () => [], readProcessInstance: ownerChecks });
      await second.start();
      if (scenario === 'live owner' || scenario === 'unreadable owner') {
        expect(await reloaded.listScheduledWorktreeCleanups()).toHaveLength(2);
        expect(removals).toEqual([]);
        expect(restoredWaits).toEqual([]);
        expect(logs.filter((entry) => entry.message.includes('skipping'))).toHaveLength(2);
        expect(ownerChecks).toHaveBeenCalledTimes(1);
        return;
      }
      await removed.promise;
      await vi.waitFor(async () => expect(await reloaded.listScheduledWorktreeCleanups()).toEqual([]));
      expect(promptCount).toBe(2);
      expect(removals.map((entry) => entry.branch).sort()).toEqual(scenario === 'manual deletion' || replacement
        ? ['openchamber/run-2'] : ['openchamber/run-1', 'openchamber/run-2']);
      if (replacement) {
        expect(await (await import('fs/promises')).readFile(path.join(root, 'run-1', 'keep.txt'), 'utf8')).toBe('New directory');
      }
    } finally {
      first.stop();
      second?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs an isolated task in a fresh worktree and tears it down with its branch (#1959)', async () => {
    const sessionDirectories = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith('/wait')) return new Response(null, { status: 204 });
      if (pathname === '/api/shell') return Response.json({ data: [] });
      if (init.method === 'POST' && pathname === '/api/session') {
        sessionDirectories.push(JSON.parse(init.body).location?.directory);
      }
      const data = pathname === '/api/session' ? { id: 'ses_iso' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo/.worktrees/scheduled-run-1' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly review',
      enabled: true,
      runInWorktree: true,
      baseBranch: 'release/2.5',
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const removals = [];
    const cleaned = Promise.withResolvers();
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createTaskWorktree: async ({ projectDirectory, baseBranch }) => {
        expect(projectDirectory).toBe('/repo');
        expect(baseBranch).toBe('release/2.5');
        return { directory: '/repo/.worktrees/scheduled-run-1', branch: 'release/2.5', name: 'scheduled-run-1' };
      },
      removeTaskWorktree: async ({ projectDirectory, worktreeDirectory, deleteLocalBranch, branch }) => {
        removals.push({ projectDirectory, worktreeDirectory, deleteLocalBranch, branch });
        cleaned.resolve();
      },
      isGitRepository: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    await cleaned.promise;
    runtime.stop();

    expect(result.ok).toBe(true);
    // The session lives in the worktree, not the checkout.
    expect(sessionDirectories[0]).toBe('/repo/.worktrees/scheduled-run-1');
    expect(result.directory).toBe('/repo/.worktrees/scheduled-run-1');
    expect(result.isolation).toEqual({ directory: '/repo/.worktrees/scheduled-run-1', branch: 'release/2.5' });
    // The run is done: worktree and the branch made for it go away.
    expect(removals).toEqual([{
      projectDirectory: '/repo',
      worktreeDirectory: '/repo/.worktrees/scheduled-run-1',
      deleteLocalBranch: true,
      branch: 'release/2.5',
    }]);
    // The record remembers that the run isolated, but not the branch: the
    // cleanup removed it, and the card shows the branch only when it stayed.
    expect(patches.at(-1)).toMatchObject({
      lastStatus: 'sent',
      lastRunIsolated: true,
      lastRunBranch: undefined,
    });
    // The checkout was never used as the run directory.
    expect(result.directory).not.toBe('/repo');
  });

  it('keeps the worktree and branch when the task asks not to clean up (#1959)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      const data = pathname === '/api/session' ? { id: 'ses_keep' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo/.worktrees/scheduled-run-1' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly review',
      enabled: true,
      runInWorktree: true,
      baseBranch: 'release/2.5',
      cleanupWorktree: false,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const removals = [];
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createTaskWorktree: async () => ({ directory: '/repo/.worktrees/scheduled-run-1', branch: 'openchamber/keep-me' }),
      removeTaskWorktree: async (input) => { removals.push(input); },
      isGitRepository: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(true);
    // Nothing removed: the result stays openable, so the branch is recorded and
    // the card can name it.
    expect(removals).toEqual([]);
    expect(patches.at(-1)).toMatchObject({
      lastStatus: 'sent',
      lastRunIsolated: true,
      lastRunBranch: 'openchamber/keep-me',
    });
  });

  it('fails an isolated run whose worktree cannot be created instead of dirtying the checkout (#1959)', async () => {
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST') posts.push({ pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly review',
      enabled: true,
      runInWorktree: true,
      baseBranch: 'gone-branch',
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createTaskWorktree: async () => {
        throw new Error("Start ref not found: gone-branch");
      },
      removeTaskWorktree: async () => {},
      isGitRepository: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    // A failed isolation is a failed run, not a silent downgrade.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed to create isolated worktree: Start ref not found/);
    // No session was created anywhere, least of all the checkout.
    expect(posts.filter((post) => post.pathname === '/api/session')).toHaveLength(0);
    expect(patches.at(-1)).toMatchObject({ lastStatus: 'error', lastRunIsolated: undefined });
  });

  it('fails an isolated run when the repository probe itself fails (#1959)', async () => {
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      if (init.method === 'POST') posts.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly review',
      enabled: true,
      runInWorktree: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const createTaskWorktree = vi.fn(async () => ({ directory: '/repo/.worktrees/should-not-exist' }));
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createTaskWorktree,
      removeTaskWorktree: async () => {},
      isGitRepository: async () => {
        throw new Error('git is unavailable');
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    // An unknown answer is not a "not a git repository" answer: the run fails
    // rather than quietly using the checkout.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed to check whether the project is a git repository: git is unavailable/);
    expect(createTaskWorktree).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    expect(patches.at(-1)).toMatchObject({ lastStatus: 'error' });
  });

  it('fails an isolated run when no worktree creation is wired (#1959)', async () => {
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      if (init.method === 'POST') posts.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly review',
      enabled: true,
      runInWorktree: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      removeTaskWorktree: async () => {},
      isGitRepository: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/worktree creation is unavailable/);
    expect(posts).toHaveLength(0);
    expect(patches.at(-1)).toMatchObject({ lastStatus: 'error' });
  });

  it('removes a just-created worktree when the run session cannot start (#1959)', async () => {
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST') posts.push({ pathname });
      if (init.method === 'POST' && pathname === '/api/session') {
        return new Response(JSON.stringify({ data: { message: 'nope' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      const data = pathname === '/api/session' ? { id: 'unused' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly review',
      enabled: true,
      runInWorktree: true,
      baseBranch: 'release/2.5',
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const removals = [];
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createTaskWorktree: async () => ({ directory: '/repo/.worktrees/scheduled-run-1', branch: 'release/2.5' }),
      removeTaskWorktree: async ({ projectDirectory, worktreeDirectory, deleteLocalBranch, branch }) => {
        removals.push({ projectDirectory, worktreeDirectory, deleteLocalBranch, branch });
      },
      isGitRepository: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    // The run fails, but nothing is left behind: the worktree made for the run
    // is removed before the error is surfaced.
    expect(result.ok).toBe(false);
    expect(removals).toEqual([{
      projectDirectory: '/repo',
      worktreeDirectory: '/repo/.worktrees/scheduled-run-1',
      deleteLocalBranch: true,
      branch: 'release/2.5',
    }]);
    expect(patches.at(-1)).toMatchObject({ lastStatus: 'error' });
  });

  it("logs instead of swallowing a rollback removal failure on a failed session start (#1959)", async () => {
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST' && pathname === '/api/session') {
        return new Response(JSON.stringify({ data: { message: 'nope' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      const data = pathname === '/api/session' ? { id: 'unused' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly review',
      enabled: true,
      runInWorktree: true,
      baseBranch: 'release/2.5',
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const warnEntries = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async () => ({ task, updated: true }),
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createTaskWorktree: async () => ({ directory: '/repo/.worktrees/scheduled-run-1', branch: 'release/2.5' }),
      removeTaskWorktree: async () => {
        throw new Error('git worktree remove failed: directory is not empty');
      },
      isGitRepository: async () => true,
      logger: { info: () => {}, warn: (message, entry) => warnEntries.push({ message, entry }), error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(false);
    // The rollback failure is named, not swallowed: a stranded worktree nobody
    // owns is what cleanup exists to avoid, so it is worth a log line.
    const rollbackWarning = warnEntries.find((entry) => entry.message.includes("failed to clean up the failed run's worktree"));
    expect(rollbackWarning).toBeTruthy();
    expect(rollbackWarning.entry).toMatchObject({ worktree: '/repo/.worktrees/scheduled-run-1', error: expect.stringContaining('git worktree remove failed') });
  });

  it('a run that times out still records that it ran isolated (#1959)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST' && pathname.endsWith('/prompt') && !pathname.includes('synthetic')) {
        return new Promise(() => {});
      }
      const data = pathname === '/api/session' ? { id: 'ses_to' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo/.worktrees/scheduled-run-1' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly review',
      enabled: true,
      runInWorktree: true,
      baseBranch: 'release/2.5',
      cleanupWorktree: false,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const removals = [];
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      maxRunDurationMs: 40,
      createTaskWorktree: async () => ({ directory: '/repo/.worktrees/scheduled-run-1', branch: 'openchamber/time-lane' }),
      removeTaskWorktree: async (input) => { removals.push(input); },
      isGitRepository: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    // Creation already knew the run happens in a worktree it got for itself,
    // and with cleanup off the branch is still there to name. Nothing was
    // removed, because the task asked to keep both.
    expect(removals).toEqual([]);
    expect(patches.at(-1)).toMatchObject({
      lastStatus: 'error',
      lastSessionId: 'ses_to',
      lastRunIsolated: true,
      lastRunBranch: 'openchamber/time-lane',
    });
  });

  it('keeps the run result when the teardown of the worktree fails (#1959)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith('/wait')) return new Response(null, { status: 204 });
      if (pathname === '/api/shell') return Response.json({ data: [] });
      const data = pathname === '/api/session' ? { id: 'ses_iso' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo/.worktrees/scheduled-run-1' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly review',
      enabled: true,
      runInWorktree: true,
      baseBranch: 'release/2.5',
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const warnEntries = [];
    const warned = Promise.withResolvers();
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createTaskWorktree: async () => ({ directory: '/repo/.worktrees/scheduled-run-1', branch: 'release/2.5' }),
      removeTaskWorktree: async () => {
        throw new Error('worktree remove failed');
      },
      isGitRepository: async () => true,
      logger: { info: () => {}, warn: (message) => { warnEntries.push(message); warned.resolve(); }, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    await warned.promise;
    runtime.stop();

    // A failed teardown is logged, never overriding the run's own result.
    expect(result.ok).toBe(true);
    expect(result.isolation).toEqual({ directory: '/repo/.worktrees/scheduled-run-1', branch: 'release/2.5' });
    expect(warnEntries.some((message) => message.includes('failed to clean up the isolated worktree'))).toBe(true);
    expect(patches.at(-1)).toMatchObject({ lastStatus: 'sent', lastRunIsolated: true, lastRunBranch: undefined });
  });

  it('falls back to the in-directory run for a non-git project and keeps the pick when isolation is off (#1959)', async () => {
    const isoTasks = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST' && pathname === '/api/session') {
        isoTasks.push(JSON.parse(init.body).location?.directory);
      }
      const data = pathname === '/api/session' ? { id: 'ses_plain' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/plain-folder' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly digest',
      enabled: true,
      runInWorktree: true,
      baseBranch: 'main',
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Summarize', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const patches = [];
    const worktreeCreate = vi.fn(async () => ({ directory: '/plain-folder/.worktrees/x', branch: 'auto' }));
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/plain-folder' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      createTaskWorktree: worktreeCreate,
      removeTaskWorktree: async () => {},
      isGitRepository: async () => false,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    // Not a git repository: the run happens in the directory, with no error.
    expect(result.ok).toBe(true);
    expect(result.directory).toBe('/plain-folder');
    expect(worktreeCreate).not.toHaveBeenCalled();
    expect(isoTasks[0]).toBe('/plain-folder');
    expect(patches.at(-1)).toMatchObject({ lastStatus: 'sent', lastRunIsolated: undefined, lastRunBranch: undefined });
  });
});

describe('scheduled-tasks runtime chats scope', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const task = {
    id: 'task-1',
    name: 'Morning digest',
    enabled: true,
    schedule: { kind: 'daily', times: ['08:00'], timezone: 'UTC' },
    execution: { prompt: 'Summarize the news', providerID: 'openai', modelID: 'gpt-5' },
    state: { createdAt: 1, updatedAt: 1 },
  };

  const createChatsRuntime = async ({ sessionStatus = 200 } = {}) => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-chats-'));
    const chatsScope = createChatsScope(path.join(tempRoot, 'chats'));
    const sessionBodies = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST' && pathname === '/api/session') {
        sessionBodies.push(JSON.parse(init.body));
        if (sessionStatus !== 200) return new Response(JSON.stringify({ error: 'boom' }), { status: sessionStatus });
      }
      const data = pathname === '/api/session' ? { id: 'ses_chat' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const projectConfigRuntime = {
      listScheduledTasks: vi.fn(async () => [task]),
      reconcileLoopTasks: vi.fn(async () => [task]),
      updateScheduledTaskState: async () => ({ task, updated: true }),
      updateScheduledTaskStateIf: async () => ({ task, updated: true }),
    };
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime,
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      chatsScope,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    return {
      runtime,
      chatsScope,
      projectConfigRuntime,
      sessionBodies,
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  };

  it('schedules chats without discovering loop files', async () => {
    const { runtime, chatsScope, projectConfigRuntime, cleanup } = await createChatsRuntime();
    try {
      await runtime.start();
      runtime.stop();
      expect(projectConfigRuntime.reconcileLoopTasks).toHaveBeenCalledWith('proj', expect.anything());
      expect(projectConfigRuntime.reconcileLoopTasks).not.toHaveBeenCalledWith(chatsScope.id, expect.anything());
      expect(projectConfigRuntime.listScheduledTasks).toHaveBeenCalledWith(chatsScope.id);
    } finally {
      await cleanup();
    }
  });

  it('starts every run in a new chat directory under the chats root', async () => {
    const { runtime, chatsScope, sessionBodies, cleanup } = await createChatsRuntime();
    try {
      await runtime.start();
      const first = await runtime.runNow(chatsScope.id, 'task-1');
      const second = await runtime.runNow(chatsScope.id, 'task-1');
      runtime.stop();

      expect(first.ok).toBe(true);
      expect(first.directory).not.toBe(second.directory);
      for (const result of [first, second]) {
        expect(path.relative(chatsScope.root, result.directory)).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]session-/);
        await expect(stat(result.directory)).resolves.toBeTruthy();
      }
      expect(sessionBodies.map((body) => body.location.directory)).toEqual([first.directory, second.directory]);
    } finally {
      await cleanup();
    }
  });

  it('removes the new chat directory when the session cannot be created', async () => {
    const { runtime, chatsScope, cleanup } = await createChatsRuntime({ sessionStatus: 500 });
    try {
      await runtime.start();
      const result = await runtime.runNow(chatsScope.id, 'task-1');
      runtime.stop();

      expect(result.ok).toBe(false);
      const dayDirectories = await readdir(chatsScope.root);
      expect(dayDirectories).toHaveLength(1);
      expect(await readdir(path.join(chatsScope.root, dayDirectories[0]))).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
