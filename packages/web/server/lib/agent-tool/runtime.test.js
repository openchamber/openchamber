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
    instanceDir: dataDir,
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
// `hooks` collects the session hooks the plugin registers, by name, and
// `removed` the ids of OpenCode's own tools it takes away.
const loadTools = async (dataDir, tag, hooks = {}, removed = []) => {
  const entrypoint = path.join(pluginDirectoryFor(dataDir), 'index.js');
  const pluginModule = await import(`${pathToFileURL(entrypoint).href}?${tag}=${Date.now()}`);
  const registered = {};
  await pluginModule.default.setup({
    tool: {
      transform: (edit) => {
        edit({ add: (tool) => { registered[tool.name] = tool; }, remove: (id) => { removed.push(id); } });
      },
    },
    session: {
      hook: async (name, callback) => { hooks[name] = callback; },
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
  it('rejects a stale note replacement from a second session without a write or event', async () => {
    const owner = createProjectIdFromPath('/repo');
    const onChanged = vi.fn();
    const { runtime, dataDir } = await createRuntime({
      resolveSessionDirectory: async (id) => ['ses_A', 'ses_B'].includes(id) ? '/repo' : null,
      executeAction: (...args) => service.execute(...args),
    });
    const projectContextRuntime = createProjectContextRuntime({
      fsPromises: fs, path, projectsDirPath: path.join(dataDir, 'projects'),
      createId: () => 'note-1', onChanged,
    });
    const service = createOpenChamberControlService({
      projectContextRuntime,
      resolveProjectContextId: async (directory) => directory === '/repo' ? owner : '',
      sessionService: { resolveDirectory: async () => '/repo' },
    });
    const call = (sessionID, action, parameters = {}) => runtime.execute({
      tool: 'openchamber_knowledge', sessionID, input: { action, ...parameters },
    });
    await call('ses_A', 'save', { kind: 'note', body: 'v1' });
    const a = (await call('ses_A', 'list')).data.notes[0];
    const b = (await call('ses_B', 'list')).data.notes[0];
    expect(a.body).toBe('v1');
    expect(b.body).toBe('v1');
    expect(await call('ses_A', 'save', { kind: 'note', id: a.id, body: 'v2', expected: a.body }))
      .toMatchObject({ ok: true, action: 'knowledge.save', data: { projectId: owner, note: { body: 'v2' } } });
    const committed = await fs.readFile(projectContextRuntime.contextPathFor(owner), 'utf8');
    const events = onChanged.mock.calls.length;
    expect(await call('ses_B', 'save', { kind: 'note', id: b.id, body: 'v3', expected: b.body }))
      .toEqual({ schemaVersion: 1, ok: false, action: 'knowledge.save', error: {
        kind: 'usage', message: 'Project note changed; reload before saving',
      } });
    expect(await fs.readFile(projectContextRuntime.contextPathFor(owner), 'utf8')).toBe(committed);
    expect(onChanged).toHaveBeenCalledTimes(events);
    const reread = (await call('ses_B', 'list')).data.notes[0];
    expect(reread).toMatchObject({ body: 'v2', origin: { sessionId: 'ses_A' } });
    expect(await call('ses_B', 'save', { kind: 'note', id: b.id, body: 'v3', expected: reread.body }))
      .toMatchObject({ ok: true, data: { note: { body: 'v3', origin: { sessionId: 'ses_A' } } } });
  });

  it('runs generated knowledge calls through authenticated HTTP and persistent storage', async () => {
    const directory = '/repo';
    const owner = createProjectIdFromPath(directory);
    const onChanged = vi.fn();
    const showPlan = vi.fn(() => 1);
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
      showPlan,
    });
    const prepared = await prepareManagedEnv(runtime, { includeControl: false, includeWeb: false, includeMemory: false, includeKnowledge: true });
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
    const call = async (action, parameters = {}) => JSON.parse((await tools.openchamber_knowledge.execute(
      { action, parameters }, { sessionID: 'ses_caller', progress: async () => {} },
    )).content);
    try {
      const created = await call('save', { kind: 'note', body: 'Agent note', source: 'manual', origin: { sessionId: 'spoof' } });
      expect(created).toMatchObject({ ok: true, schemaVersion: 1, data: { projectId: owner, note: { body: 'Agent note', source: 'agent', origin: { sessionId: 'ses_caller' } } } });
      const noteId = created.data.note.id;
      const note = (await call('list')).data.notes.find((entry) => entry.id === noteId);
      expect((await call('save', { kind: 'note', id: noteId, body: 'Edited note', expected: note.body })).ok).toBe(true);
      const beforeNoteConflict = onChanged.mock.calls.length;
      const beforeNoteWrite = await fs.readFile(projectContextRuntime.contextPathFor(owner), 'utf8');
      expect(await call('save', { kind: 'note', id: noteId, body: 'Stale note', expected: note.body })).toMatchObject({
        ok: false, error: { kind: 'usage', message: expect.stringContaining('reload before saving') },
      });
      expect(onChanged).toHaveBeenCalledTimes(beforeNoteConflict);
      expect(await fs.readFile(projectContextRuntime.contextPathFor(owner), 'utf8')).toBe(beforeNoteWrite);

      const todoId = (await call('save', { kind: 'todo', body: 'First' })).data.todo.id;
      await projectContextRuntime.createTodo(owner, { text: 'UI item' });
      expect((await call('save', { kind: 'todo', id: todoId, completed: true })).data.todo).toMatchObject({ id: todoId, completed: true });

      const createdPlan = (await call('save', { kind: 'plan', body: '# Agent plan\n\n- [ ] Original' })).data.plan;
      const planId = createdPlan.id;
      // The agent reads and ticks the plan through its file, by the path save gave.
      const original = await fs.readFile(createdPlan.path, 'utf8');
      expect(original).toBe('# Agent plan\n\n- [ ] Original');
      await fs.writeFile(createdPlan.path, original.replace('- [ ]', '- [x]'));
      const raw = '# Agent plan\r\n\r\n- [x] Original, rewritten';
      expect((await call('save', { kind: 'plan', id: planId, body: raw, expected: '# Agent plan\n\n- [x] Original' })).data.plan.path).toBe(createdPlan.path);
      const beforeConflict = onChanged.mock.calls.length;
      expect(await call('save', { kind: 'plan', id: planId, body: '# Stale', expected: original })).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(onChanged).toHaveBeenCalledTimes(beforeConflict);
      expect((await call('show', { kind: 'plan', id: planId })).data).toEqual({ projectId: owner, planId, shown: true });
      expect(showPlan).toHaveBeenCalledWith({ projectId: owner, planId, title: 'Agent plan', directory, sessionId: 'ses_caller' });

      const listed = (await call('list')).data;
      expect(listed.notes[0]).toMatchObject({ id: noteId, body: 'Edited note', source: 'agent' });
      expect(listed.todos.map((todo) => todo.text)).toEqual(['UI item', 'First']);
      expect(listed.plans).toEqual([expect.objectContaining({ id: planId, title: 'Agent plan', path: createdPlan.path })]);
      expect(await fs.readFile(listed.plans[0].path, 'utf8')).toBe(raw);

      // Plan work: links, dependencies, filters and the plan session through the
      // generated tool; null and [] reach storage as clears, never as omissions.
      const one = (await call('save', { kind: 'todo', body: 'Step one', planId })).data.todo;
      const two = (await call('save', { kind: 'todo', body: 'Step two', planId, dependsOn: [one.id] })).data.todo;
      // A model can send dependsOn as a JSON string, nested or beside the
      // action as a recorded GLM call did. It is parsed once and kept only as an
      // array; every other value reaches the strict server check unchanged.
      expect((await call('save', { kind: 'todo', id: two.id, dependsOn: '[]' })).data.todo).not.toHaveProperty('dependsOn');
      const flat = await tools.openchamber_knowledge.execute(
        { action: 'knowledge.save', kind: 'todo', id: two.id, dependsOn: JSON.stringify([one.id]) },
        { sessionID: 'ses_caller', progress: async () => {} },
      );
      expect(JSON.parse(flat.content).data.todo).toMatchObject({ dependsOn: [one.id] });
      for (const dependsOn of ['[not json', JSON.stringify({ id: one.id }), one.id, '[1]']) {
        expect(await call('save', { kind: 'todo', id: two.id, dependsOn }))
          .toMatchObject({ ok: false, error: { message: 'dependsOn must be an array of todo ids' } });
      }
      expect((await call('save', { kind: 'note', id: noteId, planId })).data.note)
        .toMatchObject({ body: 'Edited note', planId, origin: { sessionId: 'ses_caller' } });
      const readyInPlan = async () => (await call('list', { planId, ready: true })).data.todos.map((todo) => todo.text);
      expect(await readyInPlan()).toEqual(['Step one']);
      expect((await call('save', { kind: 'todo', id: one.id, completed: true })).ok).toBe(true);
      expect(await readyInPlan()).toEqual(['Step two']);
      expect((await call('list', { planId })).data).toMatchObject({
        notes: [{ id: noteId }], todos: [{ id: two.id }, { id: one.id }], plans: [{ id: planId, path: createdPlan.path }],
      });

      expect((await call('save', { kind: 'plan', id: planId, sessionId: 'ses_worker' })).data.plan)
        .toMatchObject({ id: planId, path: createdPlan.path, session: { sessionId: 'ses_worker' } });
      const beforeMixed = await fs.readFile(projectContextRuntime.contextPathFor(owner), 'utf8');
      expect(await call('save', { kind: 'plan', id: planId, sessionId: 'ses_other', body: '# Mixed' })).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(await fs.readFile(projectContextRuntime.contextPathFor(owner), 'utf8')).toBe(beforeMixed);
      expect(await fs.readFile(createdPlan.path, 'utf8')).toBe(raw);
      expect((await call('save', { kind: 'plan', id: planId, sessionId: null })).data.plan).not.toHaveProperty('session');

      expect((await call('save', { kind: 'note', id: noteId, planId: null })).data.note).not.toHaveProperty('planId');
      // Deleting the first step drops it from the second's dependencies.
      expect((await call('delete', { kind: 'todo', id: one.id })).ok).toBe(true);
      expect((await call('list', { planId })).data.todos).toEqual([expect.not.objectContaining({ dependsOn: expect.anything() })]);
      expect((await call('delete', { kind: 'todo', id: two.id })).ok).toBe(true);

      await fs.mkdir(path.join(dataDir, 'shared-plans'));
      await fs.writeFile(path.join(dataDir, 'shared-plans', 'team.md'), '# Team\n');
      const sharedId = 'shared:team.md';
      expect((await call('save', { kind: 'plan', id: sharedId, body: '# Team edited\n', expected: '# Team\n' })).ok).toBe(true);
      expect(await fs.readFile(path.join(dataDir, 'shared-plans', 'team.md'), 'utf8')).toBe('# Team edited\n');
      for (const [kind, id] of [['plan', sharedId], ['note', noteId], ['todo', todoId], ['plan', planId]]) {
        expect((await call('delete', { kind, id })).ok).toBe(true);
      }
      expect((await call('show', { kind: 'plan', id: planId })).ok).toBe(false);
      expect(await projectContextRuntime.readContext(owner)).toMatchObject({ notes: [], plans: [], todos: [{ text: 'UI item' }] });
      expect(onChanged.mock.calls.every(([projectId]) => projectId === owner)).toBe(true);
      process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = 'wrong-token';
      expect((await call('list')).ok).toBe(false);
    } finally {
      if (originalUrl === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
      else process.env.OPENCHAMBER_AGENT_TOOL_URL = originalUrl;
      if (originalToken === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      else process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = originalToken;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('exposes project knowledge as its own tool carrying only its own inputs', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeKnowledge: true });
    const tools = await loadTools(dataDir, 'knowledge-schema');
    const knowledge = tools.openchamber_knowledge;
    expect(knowledge.description).toContain('Project knowledge panel');
    const actions = knowledge.input.properties.action.oneOf.map((entry) => entry.const);
    expect(actions).toEqual(['knowledge.list', 'knowledge.save', 'knowledge.delete', 'knowledge.show']);
    const parameters = knowledge.input.properties.parameters.properties;
    expect(Object.keys(parameters).sort()).toEqual(['body', 'completed', 'dependsOn', 'directory', 'expected', 'id', 'kind', 'planId', 'projectId', 'ready', 'sessionId']);
    expect(parameters.kind.enum).toEqual(['note', 'todo', 'plan']);
    expect(parameters.completed.type).toBe('boolean');
    expect(parameters.ready.type).toBe('boolean');
    expect(parameters.planId.type).toEqual(['string', 'null']);
    expect(parameters.sessionId.type).toEqual(['string', 'null']);
    expect(parameters.dependsOn).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(tools.openchamber.input.properties.action.oneOf.map((entry) => entry.const)).not.toContain('knowledge.list');
    // The control tool keeps its own session id, a plain string.
    expect(tools.openchamber.input.properties.parameters.properties.sessionId).toEqual({ type: 'string' });
    for (const tool of ['openchamber', 'openchamber_web', 'openchamber_memory']) {
      for (const field of ['kind', 'expected', 'completed', 'planId', 'dependsOn', 'ready']) {
        expect(tools[tool].input.properties.parameters.properties).not.toHaveProperty(field);
      }
    }
    await runtime.materializePlugin({ includeKnowledge: false });
    expect(await loadTools(dataDir, 'knowledge-disabled')).not.toHaveProperty('openchamber_knowledge');
  });

  it('tells an agent how to recover from a knowledge save conflict', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeKnowledge: true });
    const tools = await loadTools(dataDir, 'knowledge-recovery');
    const knowledge = tools.openchamber_knowledge;

    // The loaded tool the model reads carries the recovery path.
    const expected = knowledge.input.properties.parameters.properties.expected;
    expect(expected.description).toContain('knowledge.list');
    expect(expected.description).toContain('same id');
    expect(knowledge.description).toContain('retry the save with the same id');
  });

  it('uses the callback session for knowledge scope and provenance', async () => {
    const { runtime, executeAction } = await createRuntime({ resolveSessionDirectory: async (id) => id === 'ses_real' ? '/real' : null });
    const input = { action: 'knowledge.save', kind: 'note', body: 'Note', origin: { sessionId: 'spoof' }, sessionId: 'spoof' };
    await runtime.execute({ tool: 'openchamber_knowledge', input, sessionID: 'ses_real', contextDirectory: '/spoof', contextSessionId: 'spoof' });
    expect(executeAction).toHaveBeenCalledWith('knowledge.save', input, '/real', { contextSessionId: 'ses_real' });
    await runtime.execute({ tool: 'openchamber_knowledge', input, sessionID: 'missing', contextDirectory: '/spoof' });
    expect(executeAction).toHaveBeenLastCalledWith('knowledge.save', input, undefined, { contextSessionId: 'missing' });
    const rejected = await runtime.execute({ tool: 'openchamber_memory', input });
    expect(rejected.ok).toBe(false);
    expect(executeAction).toHaveBeenCalledTimes(2);
  });


  it('introduces the worktree move and leaves the choice to the user', async () => {
    const { runtime, dataDir } = await createRuntime();

    await runtime.materializePlugin({});
    const tool = await loadTools(dataDir, 'worktree-intro');

    expect(tool.openchamber.description).toContain('Whether that fits depends on how the user works');
    expect(tool.openchamber.description).toContain('such as a pull request of its own');
    // OpenCode's own worktree_create makes a detached copy of the current commit.
    expect(tool.openchamber.description).toContain('Unlike git worktree add, the session moves along');
    expect(tool.openchamber.description).not.toContain('without asking');
    expect(tool.openchamber.input.properties.action.oneOf.map((entry) => entry.const)).toContain('session.moveToWorktree');
    expect(tool.openchamber.input.properties.parameters.properties.carry).toEqual(expect.objectContaining({ type: 'array' }));
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
    expect(tool.openchamber.description).toContain('returnResult brings its final answer back here');
    // Agents also have OpenCode's own subagent tool; the line between the two is drawn up front.
    expect(tool.openchamber.description).toContain('use the subagent tool');
    expect(tool.openchamber.input.properties.action.oneOf).toContainEqual({
      const: 'session.messages',
      description: 'Text messages and sessionStatus of sessionId',
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
    expect(webActions).toContain('browser.close');
    expect(webActions).toContain('browser.select');
    expect(controlActions).not.toContain('browser.open');
    expect(webActions).not.toContain('session.create');

    // Turning one tool off has to remove its inputs too, not just its actions.
    expect(Object.keys(tool.openchamber_web.input.properties.parameters.properties)).toContain('url');
    expect(Object.keys(tool.openchamber_web.input.properties.parameters.properties)).toContain('label');
    expect(Object.keys(tool.openchamber_web.input.properties.parameters.properties)).toContain('value');
    expect(Object.keys(tool.openchamber.input.properties.parameters.properties)).not.toContain('selector');
    // The control tool's own `url` names the pull request pr.watch follows, not a page.
    expect(tool.openchamber.input.properties.parameters.properties.url.description).toContain('pr.watch');
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

  it('declares inputs only inside parameters and lets flattened ones through', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: true, includeMemory: true, includeKnowledge: true, includeNotify: true, includeRender: true });
    const tools = await loadTools(dataDir, 'root-shape');

    for (const tool of Object.values(tools)) {
      expect(Object.keys(tool.input.properties).sort()).toEqual(['action', 'parameters']);
      expect(tool.input.additionalProperties).toBe(true);
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

  it('declares the workflow tool only when asked, with the scripting guide on script', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWorkflow: true });
    const tools = await loadTools(dataDir, 'workflow-tool');

    expect(tools.openchamber_workflow.input.properties.action.oneOf.map((entry) => entry.const)).toEqual([
      'workflow.check', 'workflow.run', 'workflow.status', 'workflow.result', 'workflow.stop', 'workflow.resume', 'workflow.save', 'workflow.list',
    ]);
    const parameters = tools.openchamber_workflow.input.properties.parameters.properties;
    expect(parameters.script.description).toContain('agent(prompt, { label, phase, agent, model, schema })');
    expect(Object.keys(parameters)).toEqual(['script', 'name', 'args', 'runId', 'agent', 'overwrite']);
    // The answer tool comes along, direct; the managed config denies it outside workflow agents.
    expect(tools.openchamber_workflow_answer.options).toEqual({ codemode: false });
    expect(Object.keys(tools.openchamber_workflow_answer.input.properties.parameters.properties)).toEqual(['answer']);

    await prepareManagedEnv(runtime, { includeControl: true });
    const off = await loadTools(dataDir, 'workflow-tool-off');
    expect(off.openchamber_workflow).toBeUndefined();
    expect(off.openchamber_workflow_answer).toBeUndefined();
  });

  it('runs the one action of a single-action tool, reviving a call stuffed into the action as JSON', async () => {
    const { runtime, dataDir } = await createRuntime();
    const prepared = await prepareManagedEnv(runtime, { includeControl: true, includeRender: true });
    const tools = await loadTools(dataDir, 'single-action');

    // Nothing to choose: the schema takes any string and does not require one.
    expect(tools.openchamber_render.input.properties.action).toEqual({ type: 'string', description: expect.stringContaining('render.page: ') });
    expect(tools.openchamber_render.input.required).toEqual([]);
    // A tool with several actions keeps its strict list.
    expect(tools.openchamber.input.properties.action.oneOf.length).toBeGreaterThan(1);
    expect(tools.openchamber.input.required).toEqual(['action']);

    const sent = [];
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    const originalToken = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
    process.env.OPENCHAMBER_AGENT_TOOL_URL = prepared.OPENCHAMBER_AGENT_TOOL_URL;
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = prepared.OPENCHAMBER_AGENT_TOOL_TOKEN;
    globalThis.fetch = async (_endpoint, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ schemaVersion: 1, ok: true, action: 'render.page', data: {} }));
    };
    const context = { sessionID: 'ses_1', agent: 'build', messageID: 'msg_1', id: 'call_1', signal: new AbortController().signal, progress: async () => {} };

    try {
      // The shape a model produced: title inside a JSON action, html beside it.
      await tools.openchamber_render.execute({ action: '{"action": "render.page", "title": "Commits"}', html: '<p>a</p>' }, context);
      // A revived field never replaces one the call carried itself.
      await tools.openchamber_render.execute({ action: '{"parameters": {"title": "Stuffed"}}', parameters: { html: '<p>b</p>', title: 'Real' } }, context);
      // No action at all still runs the only one.
      await tools.openchamber_render.execute({ parameters: { html: '<p>c</p>', title: 'Bare' } }, context);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.OPENCHAMBER_AGENT_TOOL_URL = originalUrl;
      process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = originalToken;
    }

    expect(sent[0].input).toEqual({ action: 'render.page', html: '<p>a</p>', title: 'Commits' });
    expect(sent[1].input).toEqual({ action: 'render.page', html: '<p>b</p>', title: 'Real' });
    expect(sent[2].input).toEqual({ action: 'render.page', html: '<p>c</p>', title: 'Bare' });
  });

  it('normalizes the two string boolean spellings a model sends, and nothing else', async () => {
    const { runtime, dataDir } = await createRuntime();
    const prepared = await prepareManagedEnv(runtime, { includeKnowledge: true });
    const tools = await loadTools(dataDir, 'boolean-strings');

    const sent = [];
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    const originalToken = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
    process.env.OPENCHAMBER_AGENT_TOOL_URL = prepared.OPENCHAMBER_AGENT_TOOL_URL;
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = prepared.OPENCHAMBER_AGENT_TOOL_TOKEN;
    globalThis.fetch = async (_endpoint, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ schemaVersion: 1, ok: true, action: 'session.list', data: {} }));
    };
    const context = { sessionID: 'ses_1', agent: 'build', messageID: 'msg_1', id: 'call_1', progress: async () => {} };

    try {
      const call = (tool, input) => tools[tool].execute(input, context);
      // Real booleans travel unchanged in both shapes.
      await call('openchamber', { action: 'session.list', parameters: { withStatus: true } });
      await call('openchamber', { action: 'session.list', parameters: { withStatus: false } });
      await call('openchamber', { action: 'session.list', withStatus: true });
      await call('openchamber', { action: 'session.list', withStatus: false });
      // Exactly the stringified "true"/"false" spellings are normalized.
      await call('openchamber', { action: 'session.list', parameters: { withStatus: 'true' } });
      await call('openchamber', { action: 'session.list', parameters: { withStatus: 'false' } });
      await call('openchamber', { action: 'session.list', withStatus: 'true' });
      await call('openchamber', { action: 'session.list', withStatus: 'false' });
      // The field names come from the calling tool's own schema, so other
      // tools' booleans normalize there too, not only `completed`.
      await call('openchamber_web', { action: 'browser.type', parameters: { selector: '#q', value: 'x', submit: 'true' } });
      await call('openchamber_knowledge', { action: 'knowledge.save', parameters: { kind: 'todo', id: 't1', completed: 'false' } });
      // Every other spelling or value keeps its identity for the strict check.
      for (const value of ['TRUE', 'False', 'yes', '1', 1, 0, null]) {
        await call('openchamber', { action: 'session.list', parameters: { withStatus: value } });
      }
      // A boolean another tool declares is not a field of this tool, so it is
      // left alone here.
      await call('openchamber_web', { action: 'browser.type', parameters: { selector: '#q', value: 'x', withStatus: 'true' } });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
      else process.env.OPENCHAMBER_AGENT_TOOL_URL = originalUrl;
      if (originalToken === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      else process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = originalToken;
    }

    expect(sent.slice(0, 8).map(({ input }) => input.withStatus)).toEqual([true, false, true, false, true, false, true, false]);
    expect(sent[8].input.submit).toBe(true);
    expect(sent[9].input.completed).toBe(false);
    expect(sent.slice(10, 17).map(({ input }) => input.withStatus)).toEqual(['TRUE', 'False', 'yes', '1', 1, 0, null]);
    expect(sent[17].input.withStatus).toBe('true');
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

  it('exposes image generation as its own tool only when switched on, never behind Code Mode', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: false, includeMemory: false, includeImage: true, codeMode: true });
    const tool = await loadTools(dataDir, 'image');

    expect(Object.keys(tool)).toEqual(['openchamber', 'openchamber_image']);
    expect(Object.keys(tool.openchamber_image.input.properties.parameters.properties).sort())
      .toEqual(['aspect', 'count', 'images', 'path', 'prompt', 'resolution']);
    expect(tool.openchamber_image.options).toEqual({ codemode: false });
    expect(tool.openchamber_image.description.length).toBeLessThanOrEqual(2048);
  });

  it('exposes render as its own tool carrying only the page and its title', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: false, includeMemory: false, includeRender: true });
    const tool = await loadTools(dataDir, 'render');

    expect(Object.keys(tool)).toEqual(['openchamber', 'openchamber_render']);
    expect(Object.keys(tool.openchamber_render.input.properties.parameters.properties).sort()).toEqual(['awaitAnswer', 'html', 'title']);
    expect(Object.keys(tool.openchamber.input.properties.parameters.properties)).not.toContain('html');
    // How to write the page rides on its input, which no client cuts short.
    expect(tool.openchamber_render.input.properties.parameters.properties.html.description).toContain('--chart-1');
    expect(tool.openchamber_render.input.properties.parameters.properties.html.description)
      .toContain('do not build paths from directory and filename fragments');
    expect(tool.openchamber_render.input.properties.parameters.properties.html.description)
      .toContain("image.src = images[key]");
    expect(tool.openchamber_render.description).toContain('add no outer card, border or banner title');
  });

  it('exposes secret as its own direct tool whose every call waits for the user', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: false, includeWeb: false, includeMemory: false, includeSecret: true, codeMode: true });
    const hooks = {};
    const tools = await loadTools(dataDir, 'secret', hooks);

    expect(Object.keys(tools)).toEqual(['openchamber_secret']);
    expect(Object.keys(tools.openchamber_secret.input.properties.parameters.properties).sort()).toEqual(['label', 'placeholder', 'reason']);
    expect(tools.openchamber_secret.options).toEqual({ codemode: false });
    expect(tools.openchamber_secret.description.length).toBeLessThanOrEqual(2048);
    // A chat message ends the wait, like a page's.
    expect(hooks.prompt).toBeInstanceOf(Function);
  });

  it('takes away the OpenCode tools the control tool replaces, and only while it is on', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: false, includeMemory: false });
    const removed = [];
    await loadTools(dataDir, 'replaced', {}, removed);
    expect(removed).toEqual(['opencode_worktree_create', 'opencode_models']);

    await runtime.materializePlugin({ includeControl: false, includeWeb: true });
    const kept = [];
    await loadTools(dataDir, 'replaced-off', {}, kept);
    expect(kept).toEqual([]);
  });

  it('exposes scheduled tasks as their own tool, out of the control tool', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeSchedule: true, includeWeb: false, includeMemory: false });
    const tools = await loadTools(dataDir, 'schedule');

    expect(Object.keys(tools)).toEqual(['openchamber', 'openchamber_schedule']);
    const scheduleActions = tools.openchamber_schedule.input.properties.action.oneOf.map((entry) => entry.const);
    expect(scheduleActions).toEqual(['schedule.list', 'schedule.create', 'schedule.update', 'schedule.run', 'schedule.delete', 'schedule.toggle']);
    expect(tools.openchamber.input.properties.action.oneOf.map((entry) => entry.const).filter((action) => action.startsWith('schedule.'))).toEqual([]);
    const scheduleParameters = tools.openchamber_schedule.input.properties.parameters.properties;
    expect(Object.keys(scheduleParameters)).toEqual(expect.arrayContaining(['taskId', 'daily', 'cron', 'prompt', 'model', 'projectId']));
    for (const field of ['taskId', 'daily', 'cron', 'disabled', 'targetSessionId']) {
      expect(tools.openchamber.input.properties.parameters.properties).not.toHaveProperty(field);
    }
    expect(scheduleParameters.disabled.type).toBe('boolean');

    await runtime.materializePlugin({ includeControl: true, includeSchedule: false });
    expect(await loadTools(dataDir, 'schedule-disabled')).not.toHaveProperty('openchamber_schedule');
  });

  it('runs a schedule action from the schedule tool and no longer from the control tool', async () => {
    const { runtime, executeAction } = await createRuntime();
    const listed = await runtime.execute({ tool: 'openchamber_schedule', input: { action: 'list' }, sessionID: 'ses_a' });
    expect(listed.ok).toBe(true);
    expect(executeAction).toHaveBeenCalledWith('schedule.list', expect.anything(), undefined, expect.anything());
    const refused = await runtime.execute({ tool: 'openchamber', input: { action: 'schedule.list' }, sessionID: 'ses_a' });
    expect(refused.ok).toBe(false);
  });

  it('keeps every tool description within the length Claude Code passes on whole', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, {
      includeSchedule: true,
      includeKnowledge: true,
      includeNotify: true,
      includeRender: true,
      includeWorkflow: true,
      includeImage: true,
    });
    const tools = await loadTools(dataDir, 'description-length');

    expect(Object.keys(tools).sort()).toEqual([
      'openchamber',
      'openchamber_image',
      'openchamber_knowledge',
      'openchamber_memory',
      'openchamber_notify',
      'openchamber_render',
      'openchamber_schedule',
      'openchamber_web',
      'openchamber_workflow',
      'openchamber_workflow_answer',
    ]);
    for (const tool of Object.values(tools)) {
      // Claude Code before 2.1.296 cuts an MCP tool description at 2048
      // characters, and OpenCode's Claude Agent provider cuts at 2048 itself.
      expect(tool.description.length).toBeLessThanOrEqual(2048);
    }
  });

  it('returns the answer a page waited for, or ends the wait when the user writes in the chat', async () => {
    const service = createOpenChamberControlService({ sessionService: { resolveDirectory: async () => '/repo' } });
    const { runtime, dataDir } = await createRuntime({
      resolveSessionDirectory: async () => '/repo',
      executeAction: (...args) => service.execute(...args),
    });
    const prepared = await prepareManagedEnv(runtime, { includeControl: false, includeWeb: false, includeMemory: false, includeRender: true });
    const hooks = {};
    const tools = await loadTools(dataDir, 'render-answer', hooks);
    const app = express();
    runtime.registerRoutes(app, express);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const originalUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    const originalToken = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
    process.env.OPENCHAMBER_AGENT_TOOL_URL = `http://127.0.0.1:${server.address().port}/api/openchamber/agent-tool`;
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = prepared.OPENCHAMBER_AGENT_TOOL_TOKEN;
    const ask = (id, awaitAnswer = true) => tools.openchamber_render.execute(
      { action: 'render.page', parameters: { html: '<p>Pick</p>', title: 'Pick a layout', awaitAnswer } },
      { sessionID: 'ses_caller', id, signal: new AbortController().signal, progress: async () => {} },
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const answered = ask('call_1');
      await vi.waitFor(() => service.answerPage({ sessionId: 'ses_caller', callId: 'call_1', summary: 'Layout B', data: { layout: 'b' } }));
      const result = await answered;
      expect(JSON.parse(result.content)).toMatchObject({ ok: true, data: { answer: { answered: true, summary: 'Layout B', data: { layout: 'b' } } } });
      expect(result.metadata.openchamber).toMatchObject({ ok: true, answer: { answered: true, summary: 'Layout B', data: { layout: 'b' } } });
      // Bun would otherwise end the waiting request after about six minutes;
      // a page that only shows keeps the default.
      expect(fetchSpy.mock.lastCall?.[1]).toMatchObject({ timeout: false });
      await ask('call_shown', false);
      expect(fetchSpy.mock.lastCall?.[1]).not.toHaveProperty('timeout');

      const closed = ask('call_2');
      // Lets the call reach the server and start waiting there.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await hooks.prompt({ sessionID: 'ses_other' });
      await hooks.prompt({ sessionID: 'ses_caller' });
      const closedResult = await closed;
      expect(JSON.parse(closedResult.content)).toMatchObject({ ok: true, data: { answer: { answered: false, reason: 'chat' } } });
      expect(closedResult.metadata.openchamber).toMatchObject({ ok: true, answer: { answered: false, reason: 'chat' } });
      // The server let go of the page too, so a late answer finds nothing.
      await vi.waitFor(() => expect(() => service.answerPage({ sessionId: 'ses_caller', callId: 'call_2', summary: 'B' }))
        .toThrow(expect.objectContaining({ statusCode: 404 })));
    } finally {
      fetchSpy.mockRestore();
      if (originalUrl === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
      else process.env.OPENCHAMBER_AGENT_TOOL_URL = originalUrl;
      if (originalToken === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      else process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = originalToken;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('registers every tool as a direct tool unless Code Mode is asked for, and the render tool always direct', async () => {
    const { runtime, dataDir } = await createRuntime();
    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: true, includeMemory: true, includeNotify: true });
    const direct = await loadTools(dataDir, 'direct');
    for (const tool of Object.values(direct)) {
      expect(tool.options).toEqual({ codemode: false });
    }

    await prepareManagedEnv(runtime, { includeControl: true, includeWeb: true, includeMemory: true, includeNotify: true, includeRender: true, codeMode: true });
    const { openchamber_render: render, ...behindExecute } = await loadTools(dataDir, 'codemode');
    expect(Object.keys(behindExecute).length).toBeGreaterThan(0);
    for (const tool of Object.values(behindExecute)) {
      expect(tool.options).toEqual({ codemode: true });
    }
    expect(render.options).toEqual({ codemode: false });
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

  it.each([
    ['session.create', 'openchamber', { prompt: 'x', goal: 'true' }, 'goal'],
    ['session.list', 'openchamber', { withStatus: 'true' }, 'withStatus'],
    ['browser.type', 'openchamber_web', { selector: '#q', value: 'x', submit: 'yes' }, 'submit'],
    ['knowledge.save', 'openchamber_knowledge', { kind: 'todo', id: 't1', completed: 'false' }, 'completed'],
    ['notify.send', 'openchamber_notify', { title: 't', showWhenFocused: 1 }, 'showWhenFocused'],
  ])('refuses a %s whose boolean %s field is not a boolean', async (action, tool, input, field) => {
    const { runtime, executeAction } = await createRuntime();
    const result = await runtime.execute({ input: { action, ...input }, sessionID: 'ses_1', tool });

    expect(result).toEqual(expect.objectContaining({ ok: false, action, error: { message: `${field} must be a boolean`, kind: 'usage' } }));
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('passes a real boolean goal through', async () => {
    const { runtime, executeAction } = await createRuntime();
    const result = await runtime.execute({ input: { action: 'session.create', prompt: 'x', goal: true }, sessionID: 'ses_1', tool: 'openchamber' });

    expect(result.ok).toBe(true);
    expect(executeAction).toHaveBeenCalledTimes(1);
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

describe('session.link parameter normalization', () => {
  it('revives a stringified link and leaves every other string alone', async () => {
    const executeAction = vi.fn(async () => ({ linked: true }));
    const { runtime, dataDir } = await createRuntime({ executeAction });
    const prepared = await prepareManagedEnv(runtime, { includeControl: true, includeWeb: false, includeMemory: false });
    const tools = await loadTools(dataDir, 'link-normalization');
    const app = express();
    runtime.registerRoutes(app, express);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const previousUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    const previousToken = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
    process.env.OPENCHAMBER_AGENT_TOOL_URL = `http://127.0.0.1:${server.address().port}/api/openchamber/agent-tool`;
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = prepared.OPENCHAMBER_AGENT_TOOL_TOKEN;
    const call = (action, input = {}) => tools.openchamber.execute(
      { action, ...input },
      { sessionID: 'ses_caller', progress: async () => {} },
    );
    const forwarded = () => executeAction.mock.calls.at(-1)[1];
    const link = { url: 'https://github.com/acme/app/issues/7', title: 'Crash on save', kind: 'issue', identifier: '#7' };
    try {
      // The documented shape, as it arrives from the model: nested objects come
      // through the transport JSON-stringified (issue #4591).
      await call('session.link', { parameters: { link: JSON.stringify(link) } });
      expect(forwarded().link).toEqual(link);

      // A genuine nested object passes through untouched.
      await call('session.link', { parameters: { link: { ...link } } });
      expect(forwarded().link).toEqual(link);

      // The bare-name alias behaves the same.
      await call('link', { parameters: { link: JSON.stringify(link) } });
      expect(forwarded().link).toEqual(link);

      // Flat fields beside the action still reach the service, and an explicit
      // parameters object still wins key conflicts.
      await call('session.link', { url: link.url, title: 'Flat title', kind: 'issue', parameters: { title: 'Nested title' } });
      expect(forwarded()).toMatchObject({ url: link.url, title: 'Nested title', kind: 'issue' });

      // Parse once, accept only plain objects: stringified nulls, arrays,
      // scalars, double-encoded objects and malformed JSON arrive exactly as
      // sent, for the service to reject with its own validation error.
      for (const value of ['null', '[1,2]', '"text"', '"{\\"url\\":\\"x\\"}"', '{not json']) {
        await call('session.link', { parameters: { link: value } });
        expect(forwarded().link).toBe(value);
      }

      // Free-form strings that merely look like JSON stay text.
      await call('session.create', { parameters: { title: '[]', prompt: '{"task":"summarize"}' } });
      expect(forwarded()).toMatchObject({ title: '[]', prompt: '{"task":"summarize"}' });
    } finally {
      if (previousUrl === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
      else process.env.OPENCHAMBER_AGENT_TOOL_URL = previousUrl;
      if (previousToken === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      else process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = previousToken;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
