import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCAN_TASK_ID, createSuggestedTasksRuntime, isInQuietHours, scanPermissions, scanTaskFor } from './runtime.js';
import { createSuggestionStore } from './store.js';
import { DEFAULT_CONFIG } from './config.js';

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const waitFor = async (check, timeoutMs = 3_000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const answer = (suggestions) => `Done.\n\`\`\`json\n${JSON.stringify({ suggestions })}\n\`\`\``;

const lens = (id, overrides = {}) => ({ id, name: id, enabled: true, prompt: `Look for ${id}.`, model: { useDefaults: true }, web: false, action: 'suggest', ...overrides });

const setup = async ({ config = {}, git: gitOverrides = {}, beforePrompt = async () => {}, sweepIntervalMs, dependencyOverrides = {} } = {}) => {
  const projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-suggested-'));
  temporaryDirectories.push(projectsDir);
  const projectPath = path.join(projectsDir, 'repo');
  await fs.mkdir(projectPath);

  let section = { ...DEFAULT_CONFIG, enabled: true, lensApprovals: {}, ...config };
  let tasks = [];
  const projectConfigRuntime = {
    readSuggestedTasksSection: async () => section,
    updateSuggestedTasksSection: async (_id, change) => {
      section = await change(section);
      return section;
    },
    listScheduledTasks: async () => tasks,
    upsertScheduledTask: async (_id, task) => {
      tasks = [...tasks.filter((entry) => entry.id !== task.id), task];
      return { task };
    },
    deleteScheduledTask: async (_id, taskId) => {
      tasks = tasks.filter((entry) => entry.id !== taskId);
      return { deleted: true };
    },
  };

  const sessions = new Map();
  let sessionCounter = 0;
  const createdSessions = [];
  const interrupted = [];
  const createClient = () => ({
    session: {
      get: async ({ sessionID }) => ({ tokens: sessions.get(sessionID)?.tokens ?? { input: 0, output: 0, reasoning: 0 } }),
      create: async (input) => {
        sessionCounter += 1;
        const id = `ses_lens${sessionCounter}`;
        createdSessions.push({ id, ...input });
        sessions.set(id, { running: false, records: [], queued: [] });
        return { id };
      },
      prompt: async ({ sessionID, text }) => {
        sessions.get(sessionID).running = true;
        await beforePrompt(sessionID);
        sessions.get(sessionID).prompt = text;
      },
      interrupt: async ({ sessionID }) => {
        interrupted.push(sessionID);
        sessions.get(sessionID).running = false;
        return { interrupted: true };
      },
      inbox: {
        list: async ({ sessionID }) => sessions.get(sessionID)?.queued ?? [],
        cancel: async ({ sessionID, inboxID }) => { sessions.get(sessionID).queued = sessions.get(sessionID).queued.filter((entry) => entry.id !== inboxID); },
      },
    },
  });

  const fetchImpl = vi.fn(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/session/active') {
      const data = Object.fromEntries([...sessions].filter(([, entry]) => entry.running).map(([id]) => [id, { type: 'busy' }]));
      return json({ data });
    }
    const match = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (match) {
      const entry = sessions.get(match[1]);
      return entry ? json({ data: entry.records, cursor: {} }) : json({ error: 'gone' }, 404);
    }
    return json({ error: 'unexpected' }, 500);
  });

  let eventHandler = () => {};
  const globalEventHub = {
    subscribeEvent: (handler) => {
      eventHandler = handler;
      return () => {};
    },
    subscribeStatus: () => () => {},
  };
  const emit = (payload) => eventHandler({ translated: () => [payload] });

  /** Ends a lens session's turn with `text`, the way OpenCode records it. */
  const finish = (sessionId, text, outcome = 'succeeded') => {
    const entry = sessions.get(sessionId);
    entry.running = false;
    entry.records = [
      { id: `idle_${sessionId}`, type: 'idle', outcome, time: { created: Date.now() } },
      { id: `msg_${sessionId}`, type: 'assistant', content: [{ type: 'text', text }], time: { created: Date.now() } },
    ];
    emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
  };

  const todos = [{ id: 'todo1', text: 'Rotate the signing keys', completed: false }];
  const projectContextRuntime = {
    readContext: async () => ({ todos }),
    createTodo: vi.fn(async (_id, { text }) => ({ todo: { id: 'todo_new', text } })),
  };
  const sessionService = {
    create: vi.fn(async (payload, options) => {
      const created = { sessionId: 'ses_work', directory: payload.worktree ? `${projectPath}-wt` : projectPath };
      await options?.onSessionCreated?.(created);
      return created;
    }),
    archive: vi.fn(async () => ({ archived: [] })),
  };
  const notify = vi.fn();
  const broadcast = vi.fn();
  const readProjectOpenIssues = vi.fn(async () => ({ titles: [], warnings: [] }));
  const git = {
    readScanCheckout: vi.fn(async () => ({ branch: 'main', commit: 'c2' })),
    listChangedPathsSince: vi.fn(async () => ['src/a.ts']),
    addDetachedWorktree: vi.fn(async () => undefined),
    removeDetachedWorktree: vi.fn(async () => undefined),
    getRepositoryRemoteUrls: vi.fn(async () => [{ name: 'origin', fetchUrl: 'git@github.com:acme/demo.git', pushUrl: '' }]),
    ...gitOverrides,
  };

  let runtime;
  const scheduledTasksRuntime = {
    syncProject: vi.fn(async () => tasks),
    runNow: vi.fn(async (projectId) => {
      const result = await runtime.runScan(projectId, 'manual');
      return { ok: true, status: result.skipped ? 'skipped' : 'success' };
    }),
  };

  const store = createSuggestionStore({ projectsDirPath: projectsDir });
  const dependencies = {
    projectConfigRuntime,
    scheduledTasksRuntime,
    store,
    listProjects: async () => [{ id: 'p1', path: projectPath, label: 'Demo' }],
    projectContextRuntime,
    sessionService,
    sessionKnowledgeRuntime: { sync: vi.fn(async () => true) },
    permissionAutoAcceptRuntime: { setSessionPolicy: vi.fn(async () => {}) },
    readSessionDefaults: async () => ({ providerID: 'acme', modelID: 'fast', variant: null, agent: 'plan' }),
    globalEventHub,
    git,
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    notify,
    broadcast,
    readProjectOpenIssues,
    scanCheckoutsDir: path.join(projectsDir, 'checkouts'),
    createClient,
    fetchImpl,
    quietMs: 0,
    settleRecheckMs: 5,
    sweepIntervalMs,
    logger: { warn: () => {}, info: () => {} },
    ...dependencyOverrides,
  };
  runtime = createSuggestedTasksRuntime(dependencies);
  runtimes.push(runtime);
  runtime.start();

  const restart = async () => {
    await runtime.stop();
    runtime = createSuggestedTasksRuntime(dependencies);
    runtimes.push(runtime);
    runtime.start();
  };
  return { get runtime() { return runtime; }, restart, store, createdSessions, sessions, finish, emit, interrupted, projectContextRuntime, sessionService, notify, git, projectPath, readProjectOpenIssues, dependencies, getSection: () => section, getTasks: () => tasks };
};

describe('lens context and permission contracts', () => {
  const mcp = [{ server: 'issue.server', tools: { 'find/ticket': 'allow', 'write.ticket': 'ask', delete: 'deny' } }];

  it('appends exact sanitized rules while denying unlisted tools, shell, edits and memory', () => {
    const rules = scanPermissions(false, [...mcp, { server: 'openchamber', tools: { memory: 'allow' } }, { server: 'apply', tools: { patch: 'allow' } }]);
    expect(rules.slice(0, scanPermissions(false).length)).toEqual(scanPermissions(false));
    expect(rules.slice(-6)).toEqual([
      { action: 'issue_server_find_ticket', resource: '*', effect: 'allow' },
      { action: 'openchamber_mcp_issue_server_find_ticket', resource: '*', effect: 'allow' },
      { action: 'issue_server_write_ticket', resource: '*', effect: 'ask' },
      { action: 'openchamber_mcp_issue_server_write_ticket', resource: '*', effect: 'ask' },
      { action: 'issue_server_delete', resource: '*', effect: 'deny' },
      { action: 'openchamber_mcp_issue_server_delete', resource: '*', effect: 'deny' },
    ]);
    const effect = (action) => rules.filter((rule) => rule.action === '*' || rule.action === action).at(-1).effect;
    for (const action of ['issue_server_new', 'openchamber_mcp_issue_server_new', 'execute', 'webfetch', 'shell', 'edit', 'write', 'apply_patch', 'external_directory', 'openchamber_memory', 'subagent']) expect(effect(action)).toBe('deny');
  });

  it('sets ask and syncs knowledge without memory save guidance before the lens prompt', async () => {
    const calls = [];
    const env = await setup({
      config: { lenses: [lens('a', { mcp })] },
      beforePrompt: async () => { calls.push('prompt'); },
      dependencyOverrides: {
        readMcpServers: vi.fn(async () => [{ name: 'issue.server', status: { status: 'connected' } }]),
        permissionAutoAcceptRuntime: { setSessionPolicy: vi.fn(async (...args) => { calls.push(['policy', ...args]); }) },
        sessionKnowledgeRuntime: { sync: vi.fn(async (...args) => { calls.push(['knowledge', ...args]); return true; }) },
      },
    });
    await env.runtime.runScan('p1', 'manual');
    expect(calls).toEqual([
      ['policy', 'ses_lens1', 'ask', env.projectPath],
      ['knowledge', 'ses_lens1', env.projectPath, { includeMemorySaveRule: false }],
      'prompt',
    ]);
    expect(env.dependencies.readMcpServers).toHaveBeenCalledExactlyOnceWith(env.projectPath);
    expect(env.createdSessions[0].permissions).toEqual(scanPermissions(false, mcp));
    expect(env.createdSessions[0].metadata.openchamber).toMatchObject({ kind: 'scheduled', automation: { source: 'suggested-tasks', lensId: 'a', notify: 'attention', runId: expect.any(String) } });
    expect(env.sessions.get('ses_lens1').prompt).toContain('MCP issue.server: write.ticket (ask)');
  });

  it.each(['disconnected', 'no reader', 'read failure', 'malformed'])('warns and omits unavailable MCP rules for %s', async (availability) => {
    const overrides = {};
    if (availability === 'disconnected') overrides.readMcpServers = async () => [{ name: 'issue.server', status: { status: 'disabled' } }];
    if (availability === 'read failure') overrides.readMcpServers = async () => { throw new Error('offline'); };
    if (availability === 'malformed') overrides.readMcpServers = async () => null;
    const env = await setup({ config: { lenses: [lens('a', { mcp })] }, dependencyOverrides: overrides });
    await env.runtime.runScan('p1', 'manual');
    expect(env.createdSessions[0].permissions).toEqual(scanPermissions(false));
    expect((await env.store.read('p1')).runs[0].warnings.join('\n')).toContain('issue.server');
    expect(env.sessions.get('ses_lens1').prompt).not.toContain('MCP issue.server:');
  });

  it('continues after failed knowledge sync but never prompts after a policy failure', async () => {
    const env = await setup({ config: { lenses: [lens('a')] }, dependencyOverrides: { sessionKnowledgeRuntime: { sync: async () => { throw new Error('knowledge unavailable'); } } } });
    await env.runtime.runScan('p1', 'manual');
    expect(env.sessions.get('ses_lens1').prompt).toBeTruthy();
    const failed = await setup({ config: { lenses: [lens('a')] }, dependencyOverrides: { permissionAutoAcceptRuntime: { setSessionPolicy: async () => { throw new Error('policy unavailable'); } } } });
    await failed.runtime.runScan('p1', 'manual');
    expect(failed.sessions.get('ses_lens1').prompt).toBeUndefined();
    expect((await failed.store.read('p1')).runs[0].lenses[0]).toMatchObject({ status: 'failed', sessionId: 'ses_lens1' });
  });

  it.each(['default', 'ask', 'safety', 'auto'])('persists evidence and installs automatic %s policy before dispatch', async (permissionMode) => {
    const evidence = [{ source: 'Jira', summary: 'The ticket reproduces this defect.', url: 'https://example.com/BUG-1' }];
    const env = await setup({ config: { lenses: [lens('a', { action: 'worktree', permissionMode })] } });
    const order = [];
    env.dependencies.permissionAutoAcceptRuntime.setSessionPolicy.mockImplementation(async (...args) => { order.push(['policy', ...args]); });
    // Minimal session-service driver exercises the internal pre-prompt contract.
    env.sessionService.create.mockImplementation(async (payload, options) => {
      order.push(['create', options.metadata]);
      await options.onSessionCreated({ sessionId: 'ses_work', directory: `${env.projectPath}-wt` });
      const stored = (await env.store.read('p1')).suggestions[0];
      expect(stored.conversion.sessionId).toBe('ses_work');
      order.push(['dispatch', payload.prompt]);
      return { sessionId: 'ses_work', directory: `${env.projectPath}-wt` };
    });
    await env.runtime.runScan('p1', 'manual');
    order.length = 0;
    env.finish('ses_lens1', answer([{ title: 'Fix the stale response', explanation: 'A response replaces newer data.', evidence }]));
    await waitFor(async () => (await env.store.read('p1')).suggestions[0]?.status === 'approved');
    const suggestion = (await env.store.read('p1')).suggestions[0];
    expect(suggestion.evidence).toEqual(evidence);
    expect(order[0]).toEqual(['create', { openchamber: { kind: 'scheduled', automation: { source: 'suggested-tasks', projectId: 'p1', suggestionId: suggestion.id, lensId: 'a', notify: 'attention' } } }]);
    if (permissionMode !== 'default') expect(order[1]).toEqual(['policy', 'ses_work', permissionMode, `${env.projectPath}-wt`]);
    else expect(order).toHaveLength(2);
    expect(order.at(-1)[0]).toBe('dispatch');
    expect(order.at(-1)[1]).toContain('Jira: The ticket reproduces this defect. (https://example.com/BUG-1)');
    expect((await env.runtime.getInbox('p1')).suggestions[0].evidence).toEqual(evidence);
  });

  it('leaves manual approval metadata and permission mode unchanged', async () => {
    const env = await setup({ config: { lenses: [lens('a', { permissionMode: 'auto' })] } });
    await env.runtime.runScan('p1', 'manual');
    env.finish('ses_lens1', answer([{ title: 'Fix stale response' }]));
    await waitFor(async () => (await env.store.read('p1')).suggestions.length === 1);
    env.dependencies.permissionAutoAcceptRuntime.setSessionPolicy.mockClear();
    await env.runtime.approve('p1', (await env.store.read('p1')).suggestions[0].id, { action: 'session' });
    expect(env.sessionService.create.mock.calls[0][1].metadata).toBeUndefined();
    expect(env.dependencies.permissionAutoAcceptRuntime.setSessionPolicy).not.toHaveBeenCalled();
  });
});

describe('scan lifecycle', () => {
  it('reconciles an owner that dies after startup inspection, then stops recovery reads while idle', async () => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      if (!owner.pid) throw new Error('Owner process did not start');
      const env = await setup({ config: { lenses: [lens('a')] }, sweepIntervalMs: 15 });
      await env.runtime.stop();
      await env.store.update('p1', (inbox) => ({ inbox: { ...inbox, runs: [{ id: 'owner-run', reason: 'manual', status: 'running', startedAt: Date.now(), maxSuggestions: 5, ownerHost: os.hostname(), ownerPid: owner.pid, lenses: [{ lensId: 'a', lensName: 'a', action: 'suggest', status: 'pending', dispatch: 'created', startedAt: Date.now() }] }] } }));
      const reads = vi.spyOn(env.store, 'read');
      await env.restart();
      await waitFor(() => reads.mock.calls.length > 0);
      expect((await env.store.read('p1')).runs[0].lenses[0].status).toBe('pending');
      const exited = new Promise((resolve) => owner.once('exit', resolve));
      owner.kill();
      await exited;
      await waitFor(async () => (await env.store.read('p1')).runs[0].finalized);
      expect((await env.store.read('p1')).runs[0].status).toBe('failed');
      const idleReads = reads.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(reads.mock.calls.length).toBe(idleReads);
      await expect(env.runtime.runNow('p1')).resolves.toBeTruthy();
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const exited = new Promise((resolve) => owner.once('exit', resolve));
        owner.kill();
        await exited;
      }
    }
  });

  it('can stop a settled request after its delivery-state write fails once', async () => {
    const env = await setup({ config: { lenses: [lens('a')] }, beforePrompt: async (sessionId) => {
      env.sessions.get(sessionId).running = false;
      throw new Error('delivery response lost');
    } });
    const update = env.store.update;
    let failed = false;
    vi.spyOn(env.store, 'update').mockImplementation((projectId, change) => update(projectId, async (inbox) => {
      const outcome = await change(inbox);
      if (!failed && outcome.inbox?.runs.some((run) => run.lenses.some((entry) => entry.dispatch === 'uncertain'))) {
        failed = true;
        throw new Error('one dispatch-state write failed');
      }
      return outcome;
    }));
    await env.runtime.runNow('p1');
    expect(failed).toBe(true);
    const run = (await env.store.read('p1')).runs[0];
    expect(run.lenses[0].dispatch).toBe('sending');
    await env.runtime.stopRun('p1', run.id);
    await waitFor(async () => (await env.store.read('p1')).runs[0].finalized);
    expect((await env.store.read('p1')).runs[0].lenses[0]).toMatchObject({ status: 'stopped', stopReason: 'user' });
  });

  it('keeps an accepted prompt watched after its response is lost and retains the checkout until completion', async () => {
    const env = await setup({ config: { lenses: [lens('a')], scope: { ...DEFAULT_CONFIG.scope, baseBranch: 'release' } }, beforePrompt: async () => { throw new Error('connection reset after acceptance'); } });
    await env.runtime.runNow('p1');
    const running = (await env.store.read('p1')).runs[0];
    expect(running.lenses[0]).toMatchObject({ status: 'running', dispatch: 'uncertain' });
    expect(env.git.removeDetachedWorktree).not.toHaveBeenCalled();
    env.emit({ type: 'session.updated', properties: { sessionID: 'ses_lens1', info: { tokens: { input: 1234, output: 0, reasoning: 0 } } } });
    await waitFor(async () => (await env.store.read('p1')).runs[0].lenses[0].tokens === 1234);
    env.finish('ses_lens1', answer([{ title: 'Keep the accepted result', files: [{ path: 'src/a.ts' }] }]));
    const inbox = await waitFor(async () => {
      const current = await env.store.read('p1');
      return current.runs[0].finalized ? current : null;
    });
    expect(inbox.runs[0].status).toBe('done');
    expect(inbox.runs[0].lenses[0].error).toBeUndefined();
    expect(inbox.suggestions.map((entry) => entry.title)).toEqual(['Keep the accepted result']);
    expect(env.git.removeDetachedWorktree).toHaveBeenCalledOnce();
  });

  it('recovers a crash after session persistence but before dispatch and allows a fresh scan', async () => {
    const env = await setup({ config: { lenses: [lens('a')] } });
    await env.runtime.stop();
    env.sessions.set('ses_unused', { running: false, records: [], queued: [] });
    await env.store.update('p1', (inbox) => ({ inbox: { ...inbox, runs: [{ id: 'crashed', reason: 'manual', status: 'running', startedAt: Date.now(), maxSuggestions: 5, ownerHost: os.hostname(), ownerPid: 2147483647, lenses: [{ lensId: 'a', lensName: 'a', action: 'suggest', status: 'running', startedAt: Date.now(), sessionId: 'ses_unused', dispatch: 'created' }] }] } }));
    await env.restart();
    await waitFor(async () => (await env.store.read('p1')).runs[0].finalized);
    expect((await env.store.read('p1')).runs[0].status).toBe('failed');
    await expect(env.runtime.runNow('p1')).resolves.toMatchObject({ runs: [expect.objectContaining({ status: 'running' }), expect.objectContaining({ status: 'failed' })] });
    expect(env.createdSessions).toHaveLength(1);
  });

  it('can stop an ambiguous dispatch with no execution records after restart and cancels queued work', async () => {
    const env = await setup({ config: { lenses: [lens('a')] }, beforePrompt: async (sessionId) => {
      env.sessions.get(sessionId).running = false;
      throw new Error('request delivery unknown');
    } });
    await env.runtime.runNow('p1');
    const runId = (await env.store.read('p1')).runs[0].id;
    await env.store.update('p1', (inbox) => ({ inbox: { ...inbox, runs: inbox.runs.map((run) => ({ ...run, ownerPid: 2147483647, lenses: run.lenses.map((entry) => ({ ...entry, dispatch: 'sending' })) })) } }));
    env.sessions.get('ses_lens1').queued = [{ id: 'queued_prompt' }];
    await env.restart();
    await env.runtime.stopRun('p1', runId);
    const run = await waitFor(async () => {
      const entry = (await env.store.read('p1')).runs[0];
      return entry.finalized ? entry : null;
    });
    expect(run.lenses[0]).toMatchObject({ status: 'stopped', stopReason: 'user' });
    expect(env.sessions.get('ses_lens1').queued).toEqual([]);
    expect(env.interrupted).toContain('ses_lens1');
  });

  it('deduplicates against the run issue snapshot after restart and preserves incomplete-read warnings', async () => {
    const env = await setup({ config: { lenses: [lens('a')] } });
    env.readProjectOpenIssues.mockResolvedValueOnce({ titles: ['Reject negative invoice quantities'], warnings: [{ message: 'GitLab issues could not be read.' }] });
    await env.runtime.runNow('p1');
    expect(env.sessions.get('ses_lens1').prompt).toContain('[open issue] Reject negative invoice quantities');
    await env.restart();
    env.finish('ses_lens1', answer([{ title: 'Reject negative invoice quantities', files: [{ path: 'src/invoices.js', startLine: 1 }] }]));
    const inbox = await waitFor(async () => {
      const current = await env.store.read('p1');
      return current.runs[0].finalized ? current : null;
    });
    expect(inbox.suggestions).toEqual([]);
    expect(inbox.runs[0].warnings).toEqual(['GitLab issues could not be read.']);
    expect(inbox.runs[0].lenses[0].dropped.duplicate).toBe(1);
    expect(env.readProjectOpenIssues).toHaveBeenCalledTimes(1);
  });

  it('keeps the run active when a fast first lens finishes before the second prompt dispatch', async () => {
    const env = await setup({ config: { lenses: [lens('a'), lens('b')] }, beforePrompt: async (sessionId) => {
      if (sessionId === 'ses_lens1') env.finish(sessionId, answer([{ title: 'Preserve this early finding', files: [{ path: 'src/a.ts' }] }]));
      else {
        const run = await waitFor(async () => {
          const current = (await env.store.read('p1')).runs[0];
          return current.lenses[0].status === 'done' ? current : null;
        });
        expect(run.status).toBe('running');
        expect(env.sessionService.archive).not.toHaveBeenCalled();
        throw new Error('second prompt failed');
      }
    } });
    await env.runtime.runNow('p1');
    // Rejection alone does not prove whether the second prompt was accepted.
    // Its authoritative failed outcome lets the watcher finish it safely.
    env.finish('ses_lens2', '', 'failed');
    const inbox = await waitFor(async () => {
      const current = await env.store.read('p1');
      return current.runs[0].finalized ? current : null;
    });
    expect(inbox.runs[0]).toMatchObject({ status: 'partial', finalized: true });
    expect(inbox.suggestions.map((entry) => entry.title)).toEqual(['Preserve this early finding']);
    expect(inbox.runs[0].lenses.map((entry) => entry.status)).toEqual(['done', 'failed']);
  });

  it('fails abandoned pending lenses on restart while keeping completed results', async () => {
    const env = await setup({ config: { lenses: [lens('a')] } });
    await env.runtime.runNow('p1');
    await env.store.update('p1', (inbox) => ({ inbox: { ...inbox, runs: inbox.runs.map((run) => ({ ...run, ownerPid: 2147483647, lenses: [...run.lenses, { lensId: 'pending', lensName: 'pending', action: 'suggest', status: 'pending', startedAt: Date.now() }] })) } }));
    await env.restart();
    await waitFor(async () => (await env.store.read('p1')).runs[0].lenses[1].status === 'failed');
    env.finish('ses_lens1', answer([{ title: 'Keep this valid finding', files: [{ path: 'src/a.ts' }] }]));
    const inbox = await waitFor(async () => {
      const current = await env.store.read('p1');
      return current.runs[0].finalized ? current : null;
    });
    expect(inbox.runs[0].status).toBe('partial');
    expect(inbox.suggestions.map((entry) => entry.title)).toEqual(['Keep this valid finding']);
  });

  it('claims a run atomically before preparing its checkout', async () => {
    const env = await setup({ config: { lenses: [lens('a')] } });
    const outcomes = await Promise.allSettled([env.runtime.runScan('p1', 'manual'), env.runtime.runScan('p1', 'manual')]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(env.createdSessions).toHaveLength(1);
    expect((await env.store.read('p1')).runs).toHaveLength(1);
  });

  it('restores persisted usage and stops an over-budget scan after restart without another usage event', async () => {
    const env = await setup({ config: { lenses: [lens('a'), lens('b')], limits: { ...DEFAULT_CONFIG.limits, tokenBudget: 10_000 } } });
    await env.runtime.runNow('p1');
    env.emit({ type: 'session.updated', properties: { sessionID: 'ses_lens1', info: { tokens: { input: 6_000, output: 0, reasoning: 0 } } } });
    await waitFor(async () => (await env.store.read('p1')).runs[0].lenses[0].tokens === 6_000);
    env.sessions.get('ses_lens2').tokens = { input: 4_000, output: 0, reasoning: 0 };
    await env.restart();
    await waitFor(() => env.interrupted.length === 2);
    const restored = (await env.store.read('p1')).runs[0];
    expect(restored.lenses.map((entry) => entry.tokens)).toEqual([6_000, 4_000]);
    expect(restored.lenses.map((entry) => entry.stopReason)).toEqual(['budget', 'budget']);
    env.finish('ses_lens1', 'interrupted', 'interrupted');
    env.finish('ses_lens2', 'interrupted', 'interrupted');
    await waitFor(async () => (await env.store.read('p1')).runs[0].status !== 'running');
  });

  it('uses the latest locked inbox to deduplicate concurrently completed lenses', async () => {
    const env = await setup({ config: { lenses: [lens('a'), lens('b')] } });
    await env.runtime.runNow('p1');
    env.finish('ses_lens1', answer([{ title: 'Fix command injection in /ping handler by validating the host parameter', files: [{ path: 'src/server.js', startLine: 5, endLine: 13 }] }]));
    env.finish('ses_lens2', answer([{ title: 'Stop passing the /ping host parameter to a shell', files: [{ path: 'src/server.js', startLine: 7, endLine: 12 }] }]));
    const run = await waitFor(async () => {
      const inbox = await env.store.read('p1');
      return inbox.runs[0].status === 'done' ? inbox : null;
    });
    expect(run.suggestions).toHaveLength(1);
    expect(run.runs[0].lenses.reduce((sum, entry) => sum + entry.dropped.duplicate, 0)).toBe(1);
  });
  it('runs each lens read-only and turns their answers into suggestions; one failed lens leaves the rest', async () => {
    const env = await setup({ config: { lenses: [lens('security', { web: true }), lens('docs')] } });
    await env.runtime.runNow('p1');

    expect(env.createdSessions).toHaveLength(2);
    expect(env.createdSessions[0].permissions).toEqual(scanPermissions(true));
    expect(env.createdSessions[1].permissions).toEqual(scanPermissions(false));
    expect(env.createdSessions[0].model).toEqual({ providerID: 'acme', id: 'fast' });
    expect(env.createdSessions[0].agent).toBe('plan');
    expect(env.sessions.get('ses_lens1').prompt).toContain('[todo] Rotate the signing keys');

    env.finish('ses_lens1', answer([{ title: 'Escape shell arguments', explanation: 'Injection.', files: [{ path: 'src/run.ts', startLine: 3 }], confidence: 'high', severity: 'critical' }]));
    env.finish('ses_lens2', 'I could not finish.');

    const inbox = await waitFor(async () => {
      const current = await env.store.read('p1');
      return current.runs[0]?.status === 'partial' && current.runs[0].finalized ? current : null;
    });
    expect(inbox.suggestions.map((entry) => entry.title)).toEqual(['Escape shell arguments']);
    expect(inbox.suggestions[0]).toMatchObject({ lensId: 'security', status: 'open', severity: 'critical' });
    const [security, docs] = inbox.runs[0].lenses;
    expect(security).toMatchObject({ status: 'done', added: 1, reported: 1 });
    expect(docs).toMatchObject({ status: 'failed' });
    expect(docs.error).toMatch(/readable list/);
    // A partial run keeps the incremental baseline where it was.
    expect(inbox.lastScanned).toEqual({});
    expect(env.sessionService.archive).toHaveBeenCalledWith({ ids: ['ses_lens1', 'ses_lens2'] });
    expect(env.notify).toHaveBeenCalledWith(expect.objectContaining({ body: '1 new suggestion for Demo' }));
  });

  it('reports a lens that answered with an empty list as done with nothing added, and moves the baseline', async () => {
    const env = await setup({ config: { lenses: [lens('docs')] } });
    await env.runtime.runNow('p1');
    env.finish('ses_lens1', answer([]));
    const inbox = await waitFor(async () => {
      const current = await env.store.read('p1');
      return current.runs[0]?.status === 'done' ? current : null;
    });
    expect(inbox.suggestions).toEqual([]);
    expect(inbox.lastScanned).toEqual({ main: 'c2' });
    expect(env.notify).not.toHaveBeenCalled();
  });

  it('feeds dismissal reasons into the next scan and does not suggest the same thing again', async () => {
    const env = await setup({ config: { lenses: [lens('docs')] } });
    await env.runtime.runNow('p1');
    env.finish('ses_lens1', answer([{ title: 'Document the retry flag', explanation: '', files: [], confidence: 'high', severity: 'low' }]));
    const first = await waitFor(async () => (await env.store.read('p1')).suggestions[0]);
    await env.runtime.dismiss('p1', first.id, 'The flag is internal');

    await env.runtime.runNow('p1');
    expect(env.sessions.get('ses_lens2').prompt).toContain('[rejected] Document the retry flag. Reason: The flag is internal');
    env.finish('ses_lens2', answer([{ title: 'Document the retry flag', explanation: '', files: [], confidence: 'high', severity: 'low' }]));
    const inbox = await waitFor(async () => {
      const current = await env.store.read('p1');
      return current.runs[0]?.status === 'done' ? current : null;
    });
    expect(inbox.suggestions.filter((entry) => entry.status === 'open')).toEqual([]);
    expect(inbox.runs[0].lenses[0].dropped).toMatchObject({ duplicate: 1 });
  });

  it('stops every lens of a run that goes over its token budget', async () => {
    const env = await setup({ config: { lenses: [lens('a'), lens('b')], limits: { ...DEFAULT_CONFIG.limits, tokenBudget: 10_000 } } });
    await env.runtime.runNow('p1');
    env.emit({ type: 'session.updated', properties: { sessionID: 'ses_lens1', info: { tokens: { input: 9_000, output: 2_000, reasoning: 0 } } } });
    await waitFor(() => env.interrupted.length === 2);
    env.finish('ses_lens1', 'partial', 'interrupted');
    env.finish('ses_lens2', 'partial', 'interrupted');
    const run = await waitFor(async () => {
      const current = (await env.store.read('p1')).runs[0];
      return current?.status !== 'running' ? current : null;
    });
    expect(run.lenses.map((entry) => entry.status)).toEqual(['stopped', 'stopped']);
    expect(run.lenses[0].error).toMatch(/token budget/);
    expect(run.lenses[0].tokens).toBe(11_000);
  });

  it('skips an incremental scan when nothing in scope changed, without starting a session', async () => {
    const env = await setup({
      config: { lenses: [lens('docs')], scope: { ...DEFAULT_CONFIG.scope, incremental: true, include: ['src/**'] } },
      git: { listChangedPathsSince: vi.fn(async () => ['README.md']) },
    });
    const { store } = env;
    await store.update('p1', (inbox) => ({ inbox: { ...inbox, lastScanned: { main: 'c1' } } }));
    await env.runtime.runNow('p1');
    expect(env.createdSessions).toHaveLength(0);
    expect((await store.read('p1')).runs[0]).toMatchObject({ status: 'skipped', skipped: 'no-changes' });
  });

  it('scans another branch in a temporary checkout and removes it afterwards', async () => {
    const env = await setup({ config: { lenses: [lens('docs')], scope: { ...DEFAULT_CONFIG.scope, baseBranch: 'release' } } });
    await env.runtime.runNow('p1');
    const checkout = env.git.addDetachedWorktree.mock.calls[0][1];
    expect(env.git.addDetachedWorktree).toHaveBeenCalledWith(env.projectPath, checkout, 'release');
    expect(env.createdSessions[0].location).toEqual({ directory: checkout });
    env.finish('ses_lens1', answer([{ title: 'Fix it', files: [{ path: `${checkout}/src/a.ts` }], confidence: 'high', severity: 'high' }]));
    const inbox = await waitFor(async () => {
      const current = await env.store.read('p1');
      return current.runs[0]?.status === 'done' && current.runs[0].finalized ? current : null;
    });
    expect(inbox.suggestions[0].files).toEqual([{ path: 'src/a.ts' }]);
    expect(env.git.removeDetachedWorktree).toHaveBeenCalledWith(env.projectPath, checkout);
  });

  it('applies a lens action automatically to what it adds', async () => {
    const env = await setup({ config: { lenses: [lens('todos', { action: 'todo' })] } });
    await env.runtime.runNow('p1');
    env.finish('ses_lens1', answer([{ title: 'Finish the export', files: [], confidence: 'high', severity: 'medium' }]));
    const approved = await waitFor(async () => (await env.store.read('p1')).suggestions.find((entry) => entry.status === 'approved'));
    expect(approved.conversion).toEqual({ kind: 'todo', auto: true, todoId: 'todo_new' });
  });

  it('refuses to run while the feature is off', async () => {
    const env = await setup({ config: { enabled: false, lenses: [lens('docs')] } });
    await expect(env.runtime.runNow('p1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('approving and snoozing', () => {
  const seeded = async (dependencyOverrides = {}) => {
    const env = await setup({ config: { lenses: [lens('docs')] }, dependencyOverrides });
    await env.runtime.runNow('p1');
    env.finish('ses_lens1', answer([{ title: 'Split the router', explanation: 'It is 2,000 lines.', files: [{ path: 'src/router.ts', startLine: 1, endLine: 40 }], confidence: 'high', severity: 'medium' }]));
    const suggestion = await waitFor(async () => (await env.store.read('p1')).suggestions[0]);
    return { env, suggestion };
  };

  it('starts a worktree session with the suggestion as its prompt', async () => {
    const { env, suggestion } = await seeded();
    const approved = await env.runtime.approve('p1', suggestion.id, { action: 'worktree' });
    const payload = env.sessionService.create.mock.calls[0][0];
    expect(payload.worktree).toEqual({ name: 'suggested-split-the-router' });
    expect(payload.prompt).toContain('## Split the router');
    expect(payload.prompt).toContain('- src/router.ts:1-40');
    expect(approved).toMatchObject({ status: 'approved', conversion: { kind: 'worktree', sessionId: 'ses_work' } });
    await expect(env.runtime.approve('p1', suggestion.id, { action: 'session' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reconciles an uncertain bot delivery to the same item without losing evidence or changing bots', async () => {
    // Given a bot admission whose first response is lost after the item exists.
    const admitted = new Map();
    const deliveries = [];
    let lost = true;
    const { env, suggestion } = await seeded({ deliverSuggestionToBot: async (request) => {
      const persisted = (await env.store.read('p1')).suggestions.find((entry) => entry.id === request.suggestion.id);
      expect(persisted.conversion).toMatchObject({ kind: 'bot', botId: request.botId });
      expect(persisted.conversionPending).toBe(true);
      deliveries.push(request);
      admitted.set(request.suggestion.id, admitted.get(request.suggestion.id) ?? 'item-one');
      if (lost) { lost = false; throw new Error('Admission response lost'); }
      return { itemId: admitted.get(request.suggestion.id) };
    } });
    const evidence = [{ source: 'Jira', summary: 'Verified defect', url: 'https://example.test/BUG-1' }];
    await env.store.update('p1', (inbox) => ({ inbox: { ...inbox, suggestions: inbox.suggestions.map((entry) => ({ ...entry, evidence })) } }));
    // When the same delivery is retried, another target and Restore remain refused.
    await expect(env.runtime.approve('p1', suggestion.id, { action: 'bot', botId: 'bugs' })).rejects.toThrow('Admission response lost');
    await expect(env.runtime.approve('p1', suggestion.id, { action: 'bot', botId: 'other' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(env.runtime.restore('p1', suggestion.id)).rejects.toMatchObject({ statusCode: 409 });
    const result = await env.runtime.approve('p1', suggestion.id, { action: 'bot', botId: 'bugs' });
    // Then the completed response can itself be replayed without another admission.
    expect(result).toMatchObject({ status: 'approved', conversion: { kind: 'bot', botId: 'bugs', itemId: 'item-one' } });
    expect(deliveries.at(-1).suggestion.evidence).toEqual(evidence);
    expect(deliveries.at(-1).suggestion.files).toEqual(suggestion.files);
    expect(admitted.size).toBe(1);
    expect(await env.runtime.approve('p1', suggestion.id, { action: 'bot', botId: 'bugs' })).toEqual(result);
    expect(deliveries).toHaveLength(2);
  });

  it('keeps draft-PR work behind explicit approval and dispatches it as a goal in a worktree', async () => {
    const { env, suggestion } = await seeded();
    expect(env.sessionService.create).not.toHaveBeenCalled();
    const approved = await env.runtime.approve('p1', suggestion.id, { action: 'draft-pr' });
    expect(env.sessionService.create.mock.calls[0][0]).toMatchObject({ goal: true, worktree: { name: 'suggested-split-the-router' } });
    expect(env.sessionService.create.mock.calls[0][0].prompt).toContain('open a draft pull request');
    expect(approved.conversion).toMatchObject({ kind: 'draft-pr', sessionId: 'ses_work' });
  });

  it('persists a conversion reservation so a second server cannot duplicate an external action', async () => {
    const { env, suggestion } = await seeded();
    await expect(env.runtime.approve('p1', suggestion.id, { action: 'issue', provider: 'missing' })).rejects.toMatchObject({ statusCode: 400 });
    expect((await env.store.read('p1')).suggestions.find((entry) => entry.id === suggestion.id)?.conversionError).toBeTruthy();
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    env.sessionService.create.mockImplementationOnce(async () => { await waiting; return { sessionId: 'ses_reserved', directory: env.projectPath }; });
    const first = env.runtime.approve('p1', suggestion.id, { action: 'session' });
    await waitFor(async () => (await env.store.read('p1')).suggestions.find((entry) => entry.id === suggestion.id)?.conversionPending);
    await expect(env.runtime.dismiss('p1', suggestion.id, 'too late')).rejects.toMatchObject({ statusCode: 409 });
    // A restart clears the process-local guard, but not the durable reservation.
    await env.restart();
    expect((await env.store.read('p1')).suggestions.find((entry) => entry.id === suggestion.id)?.conversionError).toBeUndefined();
    await expect(env.runtime.restore('p1', suggestion.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(env.runtime.approve('p1', suggestion.id, { action: 'todo' })).rejects.toMatchObject({ statusCode: 409 });
    release();
    expect(await first).toMatchObject({ status: 'approved', conversionPending: false, conversion: { sessionId: 'ses_reserved' } });
    expect(env.projectContextRuntime.createTodo).not.toHaveBeenCalled();
  });

  it('recovers a recorded session identity after its conversion owner dies', async () => {
    const { env, suggestion } = await seeded();
    await env.store.update('p1', (inbox) => ({ inbox: { ...inbox, suggestions: inbox.suggestions.map((entry) => entry.id === suggestion.id ? { ...entry, conversionPending: true, conversionOwnerPid: 2147483647, conversionOwnerHost: os.hostname(), conversion: { kind: 'session', sessionId: 'ses_before_crash', directory: env.projectPath } } : entry) } }));
    await env.restart();
    const recovered = await waitFor(async () => {
      const item = (await env.store.read('p1')).suggestions.find((entry) => entry.id === suggestion.id);
      return item.status === 'approved' ? item : null;
    });
    expect(recovered.conversion.sessionId).toBe('ses_before_crash');
    expect(recovered.conversionPending).toBe(false);
    await expect(env.runtime.approve('p1', suggestion.id, { action: 'session' })).rejects.toMatchObject({ statusCode: 409 });
    expect(env.sessionService.create).not.toHaveBeenCalled();
  });

  it('keeps the created session when dispatch fails after creation instead of permitting a duplicate', async () => {
    const { env, suggestion } = await seeded();
    env.sessionService.create.mockRejectedValueOnce(Object.assign(new Error('Prompt send failed'), { partial: true, sessionId: 'ses_partial', directory: env.projectPath }));
    await expect(env.runtime.approve('p1', suggestion.id, { action: 'session' })).rejects.toThrow('Prompt send failed');
    const stored = (await env.store.read('p1')).suggestions.find((entry) => entry.id === suggestion.id);
    expect(stored).toMatchObject({ status: 'approved', conversionPending: false, conversion: { sessionId: 'ses_partial' }, conversionError: 'Prompt send failed' });
    await expect(env.runtime.approve('p1', suggestion.id, { action: 'session' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects a stale dismissal after approval and keeps the session link', async () => {
    const { env, suggestion } = await seeded();
    const approved = await env.runtime.approve('p1', suggestion.id, { action: 'session' });
    await expect(env.runtime.dismiss('p1', suggestion.id, 'stale dialog')).rejects.toMatchObject({ statusCode: 409 });
    expect((await env.store.read('p1')).suggestions.find((entry) => entry.id === suggestion.id)).toMatchObject({ status: 'approved', conversion: approved.conversion });
  });

  it('builds a prefilled GitHub issue form from the origin remote', async () => {
    const { env, suggestion } = await seeded();
    const approved = await env.runtime.approve('p1', suggestion.id, { action: 'issue', provider: 'github' });
    const url = new URL(approved.conversion.url);
    expect(url.origin + url.pathname).toBe('https://github.com/acme/demo/issues/new');
    expect(url.searchParams.get('title')).toBe('Split the router');
    expect(url.searchParams.get('body')).toContain('`src/router.ts:1-40`');
  });

  it('hides a snoozed suggestion until its time, and restores a dismissed one', async () => {
    const { env, suggestion } = await seeded();
    await env.runtime.snooze('p1', suggestion.id, Date.now() + 60_000);
    expect((await env.runtime.getInbox('p1')).suggestions[0].status).toBe('snoozed');
    await expect(env.runtime.snooze('p1', suggestion.id, Date.now() - 1)).rejects.toMatchObject({ statusCode: 400 });
    await env.runtime.dismiss('p1', suggestion.id, '');
    const restored = await env.runtime.restore('p1', suggestion.id);
    expect(restored.status).toBe('open');
    expect(restored.dismissedAt).toBeUndefined();
  });
});

describe('settings', () => {
  it('keeps the scan task in step with the schedule', async () => {
    const env = await setup({ config: { enabled: false } });
    await env.runtime.saveConfig('p1', { enabled: true, schedule: { kind: 'weekly', time: '08:30', weekdays: [1, 3], timezone: 'Europe/Kyiv' } });
    expect(env.getTasks()).toEqual([scanTaskFor({ schedule: { kind: 'weekly', time: '08:30', weekdays: [1, 3], cron: '', timezone: 'Europe/Kyiv' } })]);
    expect(env.getTasks()[0]).toMatchObject({ id: SCAN_TASK_ID, enabled: true, suggestedScan: true });
    await env.runtime.saveConfig('p1', { enabled: false });
    expect(env.getTasks()).toEqual([]);
    await expect(env.runtime.saveConfig('p1', { enabled: true, schedule: { kind: 'cron', cron: 'not cron' } })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('runs a repository lens only after this machine enabled that exact version', async () => {
    const env = await setup();
    const directory = path.join(env.projectPath, '.agents', 'lenses');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'perf.md');
    await fs.writeFile(file, '---\nname: Perf\nweb: true\n---\nFind slow loops.\n');
    expect((await env.runtime.getSettings('p1')).repoLenses[0]).toMatchObject({ id: 'repo:perf', status: 'disabled' });

    await env.runtime.setRepoLensEnabled('p1', file, true);
    expect((await env.runtime.getSettings('p1')).repoLenses[0].status).toBe('enabled');
    await env.runtime.runNow('p1');
    expect(env.createdSessions[0].permissions).toEqual(scanPermissions(true));

    await fs.writeFile(file, '---\nname: Perf\nweb: true\naction: worktree\n---\nFind slow loops.\n');
    expect((await env.runtime.getSettings('p1')).repoLenses[0].status).toBe('changed');
  });
});

describe('isInQuietHours', () => {
  const at = (iso) => Date.parse(iso);
  it('handles windows across midnight in the schedule time zone', () => {
    const quiet = { enabled: true, start: '22:00', end: '07:00' };
    expect(isInQuietHours(quiet, 'UTC', at('2026-10-15T23:30:00Z'))).toBe(true);
    expect(isInQuietHours(quiet, 'UTC', at('2026-10-15T06:59:00Z'))).toBe(true);
    expect(isInQuietHours(quiet, 'UTC', at('2026-10-15T07:00:00Z'))).toBe(false);
    expect(isInQuietHours(quiet, 'Europe/Kyiv', at('2026-10-15T20:30:00Z'))).toBe(true);
    expect(isInQuietHours({ ...quiet, enabled: false }, 'UTC', at('2026-10-15T23:30:00Z'))).toBe(false);
  });
});
