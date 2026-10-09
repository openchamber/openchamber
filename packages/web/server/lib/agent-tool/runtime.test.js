import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentToolRuntime } from './runtime.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { createProjectContextRuntime } from '../project-context/runtime.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, OPENCHAMBER_CONTROL_ACTION_DEFINITIONS } from '../openchamber-control/actions.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createRuntime = async (overrides = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agent-tool-'));
  temporaryDirectories.push(dataDir);
  const executeAction = vi.fn(async () => ({ projects: [] }));
  const runtime = createAgentToolRuntime({
    crypto,
    fsPromises: fs,
    path,
    dataDir,
    getActivePort: () => 3901,
    executeAction,
    ...overrides,
  });
  return { runtime, dataDir, executeAction };
};

const pluginDirectoryFor = (dataDir) => path.join(dataDir, 'agent-tool', 'openchamber-agent-tool');

/** What a managed OpenCode child start does: write the plugin, mint a token. */
const prepareManagedEnv = async (runtime, options) => {
  const pluginDirectory = await runtime.materializePlugin(options);
  return { pluginDirectory, ...runtime.createChildEnv() };
};

/** Loads the generated plugin and returns the tools it registers, by name. */
const loadTools = async (dataDir, tag) => {
  const entrypoint = path.join(pluginDirectoryFor(dataDir), 'index.js');
  const pluginModule = await import(`${pathToFileURL(entrypoint).href}?${tag}=${Date.now()}`);
  const registered = {};
  await pluginModule.default.setup({
    tool: {
      transform: (edit) => {
        edit({ add: (tool) => { registered[tool.name] = tool; } });
      },
    },
  });
  return registered;
};

describe('agent tool action allowlist', () => {
  it('defines a short title and agent description for every action', () => {
    expect(OPENCHAMBER_CONTROL_ACTION_DEFINITIONS.every(({ action, title, description }) => action && title && description)).toBe(true);
  });

  it.each([
    'projects.list',
    'models.list',
    'session.list',
    'session.create',
    'session.send',
    'session.fork',
    'session.status',
    'session.messages',
    'schedule.list',
    'schedule.create',
    'schedule.run',
    'schedule.delete',
    'schedule.toggle',
    'file.open',
  ])('delegates %s to the shared control service', async (action) => {
    const { runtime, executeAction } = await createRuntime();
    const input = { action, projectId: 'project-1' };
    await runtime.execute({ input, contextDirectory: '/work/project' });
    expect(executeAction).toHaveBeenCalledWith(action, input, '/work/project', {});
  });

  it.each([
    'session.delete',
    'schedule.status',
  ])('rejects %s outside the agent allowlist without invoking the service', async (action) => {
    const { runtime, executeAction } = await createRuntime();
    await expect(runtime.execute({ input: { action } })).resolves.toEqual(expect.objectContaining({
      ok: false,
      action,
      error: expect.objectContaining({ kind: 'usage' }),
    }));
    expect(executeAction).not.toHaveBeenCalled();
  });
});

describe('managed agent tool runtime', () => {
  it('runs generated knowledge calls through authenticated HTTP and persistent storage', async () => {
    const directory = '/repo';
    const owner = createProjectIdFromPath(directory);
    const onChanged = vi.fn();
    const { runtime, dataDir } = await createRuntime({
      resolveSessionDirectory: async (id) => id === 'ses_caller' ? directory : null,
      executeAction: (...args) => service.execute(...args),
    });
    const projectContextRuntime = createProjectContextRuntime({
      fsPromises: fs, path, projectsDirPath: path.join(dataDir, 'projects'),
      createId: () => crypto.randomUUID(), onChanged,
      resolveSharedPlansDir: async () => path.join(dataDir, 'shared-plans'),
    });
    const service = createOpenChamberControlService({
      projectContextRuntime,
      resolveProjectContextId: async (resolved) => resolved === directory ? owner : '',
      sessionService: { resolveDirectory: async () => directory },
    });
    const prepared = await prepareManagedEnv(runtime, { includeWeb: false, includeMemory: false });
    const tools = await loadTools(dataDir, 'persistent-knowledge');
    const app = express();
    runtime.registerRoutes(app, express);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const originalUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    const originalToken = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
    process.env.OPENCHAMBER_AGENT_TOOL_URL = `http://127.0.0.1:${server.address().port}/api/openchamber/agent-tool`;
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = prepared.OPENCHAMBER_AGENT_TOOL_TOKEN;
    const call = async (action, parameters = {}) => JSON.parse((await tools.openchamber.execute(
      { action, parameters }, { sessionID: 'ses_caller', progress: async () => {} },
    )).content);
    try {
      const created = await call('notes.create', { body: 'Agent note', source: 'manual', origin: { sessionId: 'spoof' } });
      expect(created).toMatchObject({ ok: true, schemaVersion: 1, data: { projectId: owner, note: { body: 'Agent note', source: 'agent', origin: { sessionId: 'ses_caller' } } } });
      const noteId = created.data.note.id;
      const note = (await call('notes.read', { noteId })).data.note;
      expect(note.id).toBe(noteId);
      expect((await call('notes.update', { noteId, body: 'Edited note', expectedBody: note.body })).ok).toBe(true);
      expect((await call('notes.list')).data.notes[0]).toMatchObject({ id: noteId, body: 'Edited note', source: 'agent' });
      const beforeNoteConflict = onChanged.mock.calls.length;
      const beforeNoteWrite = await fs.readFile(projectContextRuntime.contextPathFor(owner), 'utf8');
      expect(await call('notes.update', { noteId, body: 'Stale note', expectedBody: note.body })).toMatchObject({
        schemaVersion: 1, ok: false, action: 'notes.update', error: { kind: 'usage', message: expect.stringContaining('reload before saving') },
      });
      expect(onChanged).toHaveBeenCalledTimes(beforeNoteConflict);
      expect(await fs.readFile(projectContextRuntime.contextPathFor(owner), 'utf8')).toBe(beforeNoteWrite);
      expect((await call('notes.read', { noteId })).data.note).toMatchObject({ id: noteId, body: 'Edited note', source: 'agent', origin: { sessionId: 'ses_caller' } });
      const first = await call('todos.create', { text: 'First' });
      const todoId = first.data.context.todos[0].id;
      await projectContextRuntime.createTodo(owner, { text: 'UI item' });
      expect((await call('todos.update', { todoId, completed: true })).data.context.todos).toHaveLength(2);
      expect((await call('todos.list')).data.todos.find((todo) => todo.id === todoId)).toMatchObject({ id: todoId, completed: true });
      await expect(projectContextRuntime.saveTodos(owner, first.data.context.todos, { expectedTodos: first.data.context.todos })).rejects.toMatchObject({ status: 409 });
      await call('todos.update', { todoId, completed: false });
      expect((await call('todos.list')).data.todos.find((todo) => todo.id === todoId).completed).toBe(false);
      const planCreated = await call('plans.create', { title: 'Agent plan', body: 'Original' });
      const planId = planCreated.data.plan.id;
      const plan = (await call('plans.read', { planId })).data.plan;
      const raw = '# Updated\r\n\r\nExact raw';
      expect((await call('plans.update', { planId, raw, expectedRaw: plan.raw })).ok).toBe(true);
      const beforeConflict = onChanged.mock.calls.length;
      expect(await call('plans.update', { planId, raw: '# Stale', expectedRaw: plan.raw })).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(onChanged).toHaveBeenCalledTimes(beforeConflict);
      expect((await call('plans.read', { planId })).data.plan.raw).toBe(raw);
      expect((await call('plans.list')).data.plans[0].id).toBe(planId);
      const stored = JSON.parse(await fs.readFile(projectContextRuntime.contextPathFor(owner), 'utf8'));
      expect(stored.notes[0]).toMatchObject({ id: noteId, body: 'Edited note', origin: { sessionId: 'ses_caller' } });
      expect(stored.todos).toHaveLength(2);
      expect(stored.plans[0].id).toBe(planId);
      await fs.mkdir(path.join(dataDir, 'shared-plans'));
      await fs.writeFile(path.join(dataDir, 'shared-plans', 'team.md'), '# Team\n');
      const sharedId = 'shared:team.md';
      expect((await call('plans.list')).data.plans).toContainEqual(expect.objectContaining({ id: sharedId, source: 'shared' }));
      expect((await call('plans.read', { planId: sharedId })).data.plan.raw).toBe('# Team\n');
      expect((await call('plans.update', { planId: sharedId, raw: '# Team edited\n', expectedRaw: '# Team\n' })).ok).toBe(true);
      expect(await fs.readFile(path.join(dataDir, 'shared-plans', 'team.md'), 'utf8')).toBe('# Team edited\n');
      expect((await call('plans.delete', { planId: sharedId })).ok).toBe(true);
      expect((await call('notes.delete', { noteId })).ok).toBe(true);
      expect((await call('todos.delete', { todoId })).data.context.todos).toHaveLength(1);
      expect((await call('plans.delete', { planId })).ok).toBe(true);
      expect((await call('plans.read', { planId })).ok).toBe(false);
      expect(await projectContextRuntime.readContext(owner)).toMatchObject({ notes: [], plans: [], todos: [{ text: 'UI item' }] });
      expect(onChanged.mock.calls.every(([projectId]) => projectId === owner)).toBe(true);
      process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = 'wrong-token';
      expect((await call('todos.list')).ok).toBe(false);
    } finally {
      if (originalUrl === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
      else process.env.OPENCHAMBER_AGENT_TOOL_URL = originalUrl;
      if (originalToken === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      else process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = originalToken;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('adds project knowledge inputs only to the existing control tool', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime);
    const tools = await loadTools(dataDir, 'knowledge-schema');
    expect(tools.openchamber.description).toContain('Read and manage project Notes, Todos and Plans with notes.*, todos.* and plans.* actions.');
    const actions = tools.openchamber.input.properties.action.oneOf.map((entry) => entry.const);
    for (const action of ['notes.list', 'notes.read', 'notes.create', 'notes.update', 'notes.delete', 'todos.list', 'todos.create', 'todos.update', 'todos.delete', 'plans.list', 'plans.read', 'plans.create', 'plans.update', 'plans.delete']) {
      expect(actions).toContain(action);
    }
    const parameters = tools.openchamber.input.properties.parameters.properties;
    for (const field of ['noteId', 'todoId', 'planId', 'body', 'expectedBody', 'text', 'raw', 'expectedRaw']) {
      expect(parameters[field].type).toBe('string');
    }
    expect(parameters.completed.type).toBe('boolean');
    expect(parameters.expectedBody.description).toContain('Last body returned by notes.read');
    expect(tools.openchamber.input.properties.action.oneOf.find((entry) => entry.const === 'notes.update').description).toContain('pass its body as expectedBody');
    expect(parameters).not.toHaveProperty('origin');
    expect(parameters).not.toHaveProperty('source');
    expect(parameters).not.toHaveProperty('pinned');
    expect(tools.openchamber_web.input.properties.parameters.properties).not.toHaveProperty('todoId');
    expect(tools.openchamber_web.input.properties.parameters.properties).not.toHaveProperty('expectedBody');
    expect(tools.openchamber_memory.input.properties.parameters.properties).not.toHaveProperty('expectedRaw');
    expect(tools.openchamber_memory.input.properties.parameters.properties).not.toHaveProperty('expectedBody');
    await runtime.materializePlugin({ includeControl: false });
    expect(await loadTools(dataDir, 'knowledge-disabled')).not.toHaveProperty('openchamber');
  });

  it('uses the callback session for knowledge scope and provenance', async () => {
    const { runtime, executeAction } = await createRuntime({ resolveSessionDirectory: async (id) => id === 'ses_real' ? '/real' : null });
    const input = { action: 'notes.create', body: 'Note', origin: { sessionId: 'spoof' }, sessionId: 'spoof' };
    await runtime.execute({ tool: 'openchamber', input, sessionID: 'ses_real', contextDirectory: '/spoof', contextSessionId: 'spoof' });
    expect(executeAction).toHaveBeenCalledWith('notes.create', input, '/real', { contextSessionId: 'ses_real' });
    await runtime.execute({ tool: 'openchamber', input, sessionID: 'missing', contextDirectory: '/spoof' });
    expect(executeAction).toHaveBeenLastCalledWith('notes.create', input, undefined, { contextSessionId: 'missing' });
    const rejected = await runtime.execute({ tool: 'openchamber_memory', input });
    expect(rejected.ok).toBe(false);
    expect(executeAction).toHaveBeenCalledTimes(2);
  });

  it('materializes the plugin and mints a per-child callback token', async () => {
    const { runtime, dataDir } = await createRuntime();

    const preparedEnv = await prepareManagedEnv(runtime);
    const source = await fs.readFile(path.join(pluginDirectoryFor(dataDir), 'index.js'), 'utf8');
    const manifest = JSON.parse(await fs.readFile(path.join(pluginDirectoryFor(dataDir), 'package.json'), 'utf8'));

    // The managed config layer names this directory; the runtime only writes it.
    expect(preparedEnv.pluginDirectory).toBe(pluginDirectoryFor(dataDir));
    expect(manifest.exports).toEqual({ '.': './index.js' });
    expect(preparedEnv.OPENCHAMBER_AGENT_TOOL_URL).toBe('http://127.0.0.1:3901/api/openchamber/agent-tool');
    expect(preparedEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(source).toContain('openchamber: {');
    for (const { action, description } of OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS) {
      expect(source).toContain(JSON.stringify({ const: action, description }));
    }
    expect(source).not.toContain('"schedule.status"');
    const tool = await loadTools(dataDir, 'schema');
    expect(tool.openchamber.description).toContain('A dispatch returns at once');
    expect(tool.openchamber.description).toContain('final answer then arrives in this session as a message');
    // Agents also have OpenCode's own subagent tool; the line between the two is drawn up front.
    expect(tool.openchamber.description).toContain('use the subagent tool');
    expect(tool.openchamber.input.properties.action.oneOf).toContainEqual({
      const: 'session.messages',
      description: 'Read text-only messages and current sessionStatus for sessionId; directory and limit 10 are defaults',
    });
    // An agent never blocks on a session: no wait or timeout in its schema.
    const controlParameters = tool.openchamber.input.properties.parameters.properties;
    expect(controlParameters).not.toHaveProperty('wait');
    expect(controlParameters).not.toHaveProperty('timeout');
    expect(controlParameters.returnResult.type).toBe('boolean');
    expect(tool.openchamber.input.properties.parameters.properties.sessionId).toEqual({ type: 'string' });
    expect(source).not.toContain('title: "OpenChamber"');
    // Nothing resolves from the generated directory, so the file must not import.
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).not.toContain(preparedEnv.OPENCHAMBER_AGENT_TOOL_TOKEN);
  });

  it('emits both tools, each carrying only its own actions and inputs', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime);
    const tool = await loadTools(dataDir, 'both');

    const controlActions = tool.openchamber.input.properties.action.oneOf.map((entry) => entry.const);
    const webActions = tool.openchamber_web.input.properties.action.oneOf.map((entry) => entry.const);
    expect(webActions).toContain('browser.open');
    expect(controlActions).not.toContain('browser.open');
    expect(webActions).not.toContain('session.create');

    // Turning one tool off has to remove its inputs too, not just its actions.
    expect(Object.keys(tool.openchamber_web.input.properties.parameters.properties)).toContain('url');
    expect(Object.keys(tool.openchamber.input.properties.parameters.properties)).not.toContain('url');
    expect(Object.keys(tool.openchamber.input.properties.parameters.properties)).toContain('sessionId');
    expect(Object.keys(tool.openchamber.input.properties.parameters.properties)).toContain('path');
    expect(Object.keys(tool.openchamber_web.input.properties.parameters.properties)).not.toContain('path');
  });

  it('keeps the action schema to one validator keyword', async () => {
    // A node carrying both `enum` and `oneOf` is valid JSON Schema, but some
    // OpenAI-compatible gateways reject it and answer with an empty completion
    // instead of an error. `oneOf` is the keyword that stayed. Its branches
    // carry the per-action descriptions the model reads.
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime);
    const tool = await loadTools(dataDir, 'validator');

    for (const entry of Object.values(tool)) {
      expect(entry.input.properties.action.oneOf).toBeInstanceOf(Array);
      expect(entry.input.properties.action).not.toHaveProperty('enum');
    }
  });

  it('accepts inputs passed beside the action, not only inside parameters', async () => {
    const { runtime, dataDir } = await createRuntime();
    const prepared = await prepareManagedEnv(runtime);
    const tool = await loadTools(dataDir, 'flat');

    const sent = [];
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    const originalToken = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
    process.env.OPENCHAMBER_AGENT_TOOL_URL = prepared.OPENCHAMBER_AGENT_TOOL_URL;
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = prepared.OPENCHAMBER_AGENT_TOOL_TOKEN;
    globalThis.fetch = async (_endpoint, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ schemaVersion: 1, ok: true, action: 'browser.open', data: {} }));
    };
    const context = { sessionID: 'ses_1', agent: 'build', messageID: 'msg_1', id: 'call_1', progress: async () => {} };

    try {
      // The shape a model actually produced: url and viewport next to action.
      await tool.openchamber_web.execute(
        { action: 'browser.open', url: 'https://example.test', viewport: 'mobile' },
        context,
      );
      // The documented shape must keep working, and win when both are present.
      await tool.openchamber_web.execute(
        { action: 'browser.open', url: 'https://ignored.test', parameters: { url: 'https://example.test/nested' } },
        context,
      );
      // Both tools come from one template, so session control accepts it too.
      await tool.openchamber.execute(
        { action: 'session.messages', sessionId: 'ses_1', limit: 3 },
        context,
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.OPENCHAMBER_AGENT_TOOL_URL = originalUrl;
      process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = originalToken;
    }

    expect(sent[0].input).toEqual({ action: 'browser.open', url: 'https://example.test', viewport: 'mobile' });
    expect(sent[1].input.url).toBe('https://example.test/nested');
    expect(sent[2].input).toEqual({ action: 'session.messages', sessionId: 'ses_1', limit: 3 });
    // v2 tools get no directory; the session id is what OpenChamber resolves from.
    expect(sent[2].sessionID).toBe('ses_1');
    expect(sent[2].contextDirectory).toBeUndefined();
  });

  it('omits a tool the user turned off', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: false, includeWeb: true, includeMemory: false });
    const tool = await loadTools(dataDir, 'web');

    expect(Object.keys(tool)).toEqual(['openchamber_web']);
  });

  it('exposes memory as its own tool carrying only its own inputs', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: false, includeMemory: true });
    const tool = await loadTools(dataDir, 'memory');

    expect(Object.keys(tool)).toEqual(['openchamber', 'openchamber_memory']);
    expect(Object.keys(tool.openchamber_memory.input.properties.parameters.properties).sort())
      .toEqual(['body', 'memoryId', 'scope', 'title', 'type']);
    // Memory inputs must not leak into the control tool's schema, which the
    // model pays for on every unrelated call.
    expect(Object.keys(tool.openchamber.input.properties.parameters.properties)).not.toContain('memoryId');
  });

  it('omits memory entirely when the user turns it off', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: false, includeMemory: false });
    const tool = await loadTools(dataDir, 'nomemory');

    expect(Object.keys(tool)).toEqual(['openchamber']);
  });

  it('injects the plugin when memory is the only tool left on', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: false, includeWeb: false, includeMemory: true });
    const tool = await loadTools(dataDir, 'onlymemory');

    expect(Object.keys(tool)).toEqual(['openchamber_memory']);
  });

  it('exposes notify as its own tool only when switched on', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: false, includeMemory: false, includeNotify: true });
    const tool = await loadTools(dataDir, 'notify');

    expect(Object.keys(tool)).toEqual(['openchamber', 'openchamber_notify']);
    expect(Object.keys(tool.openchamber_notify.input.properties.parameters.properties).sort())
      .toEqual(['body', 'showWhenFocused', 'title']);
    expect(Object.keys(tool.openchamber.input.properties.parameters.properties)).not.toContain('showWhenFocused');

    const { runtime: plain, dataDir: plainDir } = await createRuntime();
    await prepareManagedEnv(plain, { includeControl: true, includeWeb: false, includeMemory: false });
    expect(Object.keys(await loadTools(plainDir, 'nonotify'))).toEqual(['openchamber']);
  });

  it('registers every tool as a direct tool unless Code Mode is asked for', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: true, includeMemory: true, includeNotify: true });
    const direct = await loadTools(dataDir, 'direct');
    for (const tool of Object.values(direct)) {
      expect(tool.options).toEqual({ codemode: false });
    }

    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: true, includeMemory: true, includeNotify: true, codeMode: true });
    const behindExecute = await loadTools(dataDir, 'codemode');
    for (const tool of Object.values(behindExecute)) {
      expect(tool.options).toEqual({ codemode: true });
    }
  });

  it('refuses to inject a plugin with no tools in it', async () => {
    const { runtime } = await createRuntime();
    let failed = false;
    try {
      await prepareManagedEnv(runtime, { includeControl: false, includeWeb: false, includeMemory: false });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('accepts the bare action a tool name already qualifies', async () => {
    // Observed: the model called `read` on openchamber_memory, having taken the
    // tool's own name for the namespace.
    const executeAction = vi.fn(async () => ({ memory: {} }));
    const { runtime } = await createRuntime({ executeAction });

    const result = await runtime.execute({
      input: { action: 'read', title: 'Uses bun' },
      contextDirectory: '/work/project',
      contextSessionId: 'ses_1',
      tool: 'openchamber_memory',
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('memory.read');
    expect(executeAction).toHaveBeenCalledWith(
      'memory.read',
      { action: 'memory.read', title: 'Uses bun' },
      '/work/project',
      { contextSessionId: 'ses_1' },
    );
  });

  it.each([
    ['session.send', { sessionId: 'ses_2', prompt: 'x', wait: true }, 'returnResult'],
    ['session.create', { prompt: 'x', timeout: 30 }, 'returnResult'],
    ['session.fork', { sessionId: 'ses_2', prompt: 'x', lastAssistant: true }, 'returnResult'],
    ['session.messages', { sessionId: 'ses_2', wait: true }, 'does not wait'],
  ])('answers an agent asking %s to wait with what replaced it', async (action, input, hint) => {
    const { runtime, executeAction } = await createRuntime();
    const result = await runtime.execute({ input: { action, ...input }, sessionID: 'ses_1', tool: 'openchamber' });

    expect(result).toEqual(expect.objectContaining({ ok: false, action, error: expect.objectContaining({ kind: 'usage' }) }));
    expect(result.error.message).toContain(hint);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('passes returnResult through with the calling session', async () => {
    const { runtime, executeAction } = await createRuntime();
    await runtime.execute({ input: { action: 'session.create', prompt: 'x', returnResult: true }, sessionID: 'ses_1', tool: 'openchamber' });

    expect(executeAction).toHaveBeenCalledWith(
      'session.create',
      { action: 'session.create', prompt: 'x', returnResult: true },
      undefined,
      { contextSessionId: 'ses_1' },
    );
  });

  it('tells an unresolvable action what the calling tool can do', async () => {
    const { runtime } = await createRuntime();

    const result = await runtime.execute({
      input: { action: 'get' },
      tool: 'openchamber_memory',
    });

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('memory.read');
    expect(result.error.message).not.toContain('browser.open');
  });

  it('does not let one tool reach another tool\'s actions', async () => {
    const executeAction = vi.fn(async () => ({}));
    const { runtime } = await createRuntime({ executeAction });

    const result = await runtime.execute({
      input: { action: 'open', url: 'https://example.test' },
      tool: 'openchamber_memory',
    });

    expect(result.ok).toBe(false);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('executes actions through the shared control service', async () => {
    const executeAction = vi.fn(async () => ({ projects: [] }));
    const { runtime } = await createRuntime({ executeAction });
    const result = await runtime.execute({
      input: { action: 'projects.list' },
      contextDirectory: '/work/project',
    });

    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      action: 'projects.list',
      data: { projects: [] },
    });
    expect(executeAction).toHaveBeenCalledWith('projects.list', { action: 'projects.list' }, '/work/project', {});
  });

  it('resolves the directory from the session id the plugin sends', async () => {
    const executeAction = vi.fn(async () => ({}));
    const resolveSessionDirectory = vi.fn(async () => '/work/other-worktree');
    const { runtime } = await createRuntime({ executeAction, resolveSessionDirectory });

    await runtime.execute({ input: { action: 'session.messages', sessionId: 'ses_1' }, sessionID: 'ses_1' });

    expect(resolveSessionDirectory).toHaveBeenCalledWith('ses_1');
    // The calling session also scopes the action (browser pages are per session).
    expect(executeAction).toHaveBeenCalledWith(
      'session.messages',
      { action: 'session.messages', sessionId: 'ses_1' },
      '/work/other-worktree',
      { contextSessionId: 'ses_1' },
    );
  });

  it('runs without a directory when the session cannot be resolved', async () => {
    const executeAction = vi.fn(async () => ({}));
    const { runtime } = await createRuntime({
      executeAction,
      resolveSessionDirectory: vi.fn(async () => { throw new Error('unavailable'); }),
    });

    await runtime.execute({ input: { action: 'projects.list' }, sessionID: 'ses_1' });

    expect(executeAction).toHaveBeenCalledWith('projects.list', { action: 'projects.list' }, undefined, { contextSessionId: 'ses_1' });
  });

  it('keeps service failures as structured tool results', async () => {
    const error = Object.assign(new Error('Task not found'), { statusCode: 404 });
    const { runtime } = await createRuntime({ executeAction: vi.fn(async () => { throw error; }) });

    await expect(runtime.execute({
      input: { action: 'schedule.run', taskId: 'missing' },
      contextDirectory: '/work/project',
    })).resolves.toEqual(expect.objectContaining({
      schemaVersion: 1,
      ok: false,
      action: 'schedule.run',
      error: { message: 'Task not found', kind: 'usage' },
    }));
  });

  it('forwards cancellation to the shared control service', async () => {
    const executeAction = vi.fn(async (_action, _input, _directory, options) => {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('OpenChamber action was cancelled'), { statusCode: 499 })), { once: true });
      });
    });
    const { runtime } = await createRuntime({ executeAction });
    const controller = new AbortController();
    const pending = runtime.execute({ input: { action: 'projects.list' } }, { signal: controller.signal });

    controller.abort();

    await expect(pending).resolves.toEqual(expect.objectContaining({
      ok: false,
      action: 'projects.list',
      error: { message: 'OpenChamber action was cancelled', kind: 'runtime' },
    }));
    expect(executeAction).toHaveBeenCalledWith('projects.list', { action: 'projects.list' }, undefined, { signal: controller.signal });
  });

  it('aborts the actions a session still has running when its turn is cancelled', async () => {
    // Safety net beside the plugin's forwarded abort signal: the server also
    // ends the action itself when the event stream reports the cancel.
    const executeAction = vi.fn(async (_action, _input, _directory, options) => {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('OpenChamber action was cancelled'), { statusCode: 499 })), { once: true });
      });
    });
    const { runtime } = await createRuntime({ executeAction });
    const env = await prepareManagedEnv(runtime);
    const app = express();
    runtime.registerRoutes(app, express);

    // supertest only sends when awaited; `.then` starts both requests now.
    const pending = request(app)
      .post('/api/openchamber/agent-tool')
      .set('authorization', `Bearer ${env.OPENCHAMBER_AGENT_TOOL_TOKEN}`)
      .send({ input: { action: 'projects.list' }, sessionID: 'ses_cancel' })
      .then((response) => response);
    const other = request(app)
      .post('/api/openchamber/agent-tool')
      .set('authorization', `Bearer ${env.OPENCHAMBER_AGENT_TOOL_TOKEN}`)
      .send({ input: { action: 'projects.list' }, sessionID: 'ses_other' })
      .then((response) => response);
    // Let both requests reach the service before cancelling one session.
    await vi.waitFor(() => expect(executeAction).toHaveBeenCalledTimes(2));

    expect(runtime.abortSession('ses_cancel')).toBe(1);
    const response = await pending;
    expect(response.body).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ message: 'OpenChamber action was cancelled' }) }));

    // The other session's action is untouched until it is told otherwise.
    expect(runtime.abortSession('ses_other')).toBe(1);
    await other;
  });

  it('requires the per-child token on the loopback route', async () => {
    const { runtime } = await createRuntime();
    const env = await prepareManagedEnv(runtime);
    const app = express();
    runtime.registerRoutes(app, express);

    await request(app)
      .post('/api/openchamber/agent-tool')
      .send({ input: { action: 'projects.list' } })
      .expect(401);

    const response = await request(app)
      .post('/api/openchamber/agent-tool')
      .set('authorization', `Bearer ${env.OPENCHAMBER_AGENT_TOOL_TOKEN}`)
      .send({ input: { action: 'projects.list' } })
      .expect(200);
    expect(response.body).toEqual(expect.objectContaining({ ok: true, action: 'projects.list' }));
  });

  it.each([
    ['0.0.0.0', 'http://127.0.0.1:3901/api/openchamber/agent-tool'],
    ['::', 'http://127.0.0.1:3901/api/openchamber/agent-tool'],
    [null, 'http://127.0.0.1:3901/api/openchamber/agent-tool'],
    ['127.0.0.1', 'http://127.0.0.1:3901/api/openchamber/agent-tool'],
    ['100.100.0.3', 'http://100.100.0.3:3901/api/openchamber/agent-tool'],
    ['fd7a:115c::3', 'http://[fd7a:115c::3]:3901/api/openchamber/agent-tool'],
  ])('points the callback at where a listener bound to %s answers', async (boundAddress, expectedUrl) => {
    const { runtime } = await createRuntime({ getActiveHost: () => boundAddress });
    const env = await prepareManagedEnv(runtime);
    expect(env.OPENCHAMBER_AGENT_TOOL_URL).toBe(expectedUrl);
  });

  it.each([
    ['100.100.0.3', '100.100.0.3', 200],
    ['100.100.0.3', '::ffff:100.100.0.3', 200],
    ['100.100.0.3', '100.100.0.7', 401],
    ['fd7a:115c::3', 'fd7a:115c::3', 200],
    ['fd7a:115c::3', 'fd7a:115c::7', 401],
    ['0.0.0.0', '192.168.1.20', 401],
    ['0.0.0.0', '0.0.0.0', 401],
    [null, '192.168.1.20', 401],
  ])('bound to %s, answers a token-bearing caller from %s with %i', async (boundAddress, remoteAddress, status) => {
    const { runtime } = await createRuntime({ getActiveHost: () => boundAddress });
    const env = await prepareManagedEnv(runtime);
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
      next();
    });
    runtime.registerRoutes(app, express);

    await request(app)
      .post('/api/openchamber/agent-tool')
      .set('authorization', `Bearer ${env.OPENCHAMBER_AGENT_TOOL_TOKEN}`)
      .send({ input: { action: 'projects.list' } })
      .expect(status);
  });

  it.each([
    ['http://100.100.0.3:3901/api/openchamber/agent-tool', 'localhost,127.0.0.1', 'localhost,127.0.0.1,100.100.0.3'],
    ['http://[fd7a:115c::3]:3901/api/openchamber/agent-tool', undefined, 'fd7a:115c::3'],
    ['http://100.100.0.3:3901/api/openchamber/agent-tool', '100.100.0.3', '100.100.0.3'],
    ['not a url', 'localhost', 'localhost'],
  ])('keeps the callback %s away from an environment proxy', async (callbackUrl, existing, expected) => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime);
    const keys = ['OPENCHAMBER_AGENT_TOOL_URL', 'NO_PROXY', 'no_proxy'];
    const previous = keys.map((key) => process.env[key]);
    try {
      process.env.OPENCHAMBER_AGENT_TOOL_URL = callbackUrl;
      for (const key of ['NO_PROXY', 'no_proxy']) {
        if (existing === undefined) delete process.env[key];
        else process.env[key] = existing;
      }
      await loadTools(dataDir, 'proxy');

      expect(process.env.NO_PROXY).toBe(expected);
      expect(process.env.no_proxy).toBe(expected);
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });

  it('executes through the materialized plugin and authenticated callback', async () => {
    let activePort = null;
    const { runtime, dataDir } = await createRuntime({ getActivePort: () => activePort });
    const app = express();
    runtime.registerRoutes(app, express);
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    activePort = server.address().port;

    const previousUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    const previousToken = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
    try {
      const env = await prepareManagedEnv(runtime);
      process.env.OPENCHAMBER_AGENT_TOOL_URL = env.OPENCHAMBER_AGENT_TOOL_URL;
      process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      const tool = await loadTools(dataDir, 'callback');
      const progress = vi.fn(async () => {});

      const result = await tool.openchamber.execute(
        { action: 'projects.list', parameters: {} },
        { sessionID: 'ses_1', agent: 'build', messageID: 'msg_1', id: 'call_1', progress },
      );

      // No output schema is declared, so the envelope has to travel as content.
      expect(result.output).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({
        schemaVersion: 1,
        ok: true,
        action: 'projects.list',
        data: { projects: [] },
      });
      expect(result.metadata.openchamber.description).toBe('List configured projects');
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({
        openchamber: expect.objectContaining({ description: 'List configured projects' }),
      }));
    } finally {
      if (previousUrl === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
      else process.env.OPENCHAMBER_AGENT_TOOL_URL = previousUrl;
      if (previousToken === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      else process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = previousToken;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
