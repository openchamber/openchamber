import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentToolRuntime } from './runtime.js';
import { OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, OPENCHAMBER_CONTROL_ACTION_DEFINITIONS } from '../openchamber-control/actions.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createRuntime = async (overrides = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agent-tool-'));
  temporaryDirectories.push(dataDir);
  const executeAction = vi.fn(async () => ({ projects: [] }));
  const env = {};
  const runtime = createAgentToolRuntime({
    crypto,
    fsPromises: fs,
    path,
    dataDir,
    getActivePort: () => 3901,
    executeAction,
    env,
    ...overrides,
  });
  return { runtime, dataDir, executeAction, env };
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
  it('materializes the plugin and preserves configured plugin entries', async () => {
    const { runtime, dataDir, env } = await createRuntime();
    env.OPENCODE_CONFIG_CONTENT = '{ // existing\n "plugin": ["file:///existing.js", ["example-plugin", {"flag": true}]], "model": "test/model" }';

    const preparedEnv = await runtime.prepareManagedOpenCodeEnv();
    const config = JSON.parse(preparedEnv.OPENCODE_CONFIG_CONTENT);
    const pluginPath = path.join(dataDir, 'agent-tool', 'openchamber-plugin.js');
    const source = await fs.readFile(pluginPath, 'utf8');

    expect(config.model).toBe('test/model');
    expect(config.plugin).toEqual([
      'file:///existing.js',
      ['example-plugin', { flag: true }],
      expect.stringContaining('/agent-tool/openchamber-plugin.js'),
    ]);
    expect(preparedEnv.OPENCHAMBER_AGENT_TOOL_URL).toBe('http://127.0.0.1:3901/api/openchamber/agent-tool');
    expect(preparedEnv.OPENCHAMBER_AGENT_TOOL_TOKEN).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(source).toContain('openchamber: {');
    for (const { action, description } of OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS) {
      expect(source).toContain(JSON.stringify({ const: action, description }));
    }
    expect(source).not.toContain('"schedule.status"');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?schema=${Date.now()}`);
    const hooks = await pluginModule.OpenChamberPlugin();
    expect(hooks.tool.openchamber.description).toContain('Session dispatches return immediately by default');
    expect(hooks.tool.openchamber.description).toContain('Set wait only when the user asks or the next step requires the completed result');
    expect(hooks.tool.openchamber.args.action.oneOf).toContainEqual({
      const: 'session.messages',
      description: 'Read text-only messages and current sessionStatus for sessionId; directory and limit 10 are defaults',
    });
    expect(hooks.tool.openchamber.args.parameters.properties.wait.description).toBe(
      'Wait for current session activity to become idle. Omit by default; use only when the user asks or the next step requires the completed result',
    );
    expect(hooks.tool.openchamber.args.parameters.properties.sessionId).toEqual({ type: 'string' });
    expect(source).not.toContain('title: "OpenChamber"');
    expect(source).not.toContain('@opencode-ai/plugin');
    expect(source).not.toContain(preparedEnv.OPENCHAMBER_AGENT_TOOL_TOKEN);
  });

  it('emits both tools, each carrying only its own actions and inputs', async () => {
    const { runtime, dataDir } = await createRuntime();
    await runtime.prepareManagedOpenCodeEnv();
    const pluginPath = path.join(dataDir, 'agent-tool', 'openchamber-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?both=${Date.now()}`);
    const { tool } = await pluginModule.OpenChamberPlugin();

    const controlActions = tool.openchamber.args.action.enum;
    const webActions = tool.openchamber_web.args.action.enum;
    expect(webActions).toContain('browser.open');
    expect(controlActions).not.toContain('browser.open');
    expect(webActions).not.toContain('session.create');

    // Turning one tool off has to remove its inputs too, not just its actions.
    expect(Object.keys(tool.openchamber_web.args.parameters.properties)).toContain('url');
    expect(Object.keys(tool.openchamber.args.parameters.properties)).not.toContain('url');
    expect(Object.keys(tool.openchamber.args.parameters.properties)).toContain('sessionId');
  });

  it('accepts inputs passed beside the action, not only inside parameters', async () => {
    const { runtime, dataDir } = await createRuntime();
    const prepared = await runtime.prepareManagedOpenCodeEnv();
    const pluginPath = path.join(dataDir, 'agent-tool', 'openchamber-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?flat=${Date.now()}`);
    const { tool } = await pluginModule.OpenChamberPlugin();

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
    const context = { directory: '/work/project', abort: new AbortController().signal, metadata: () => {} };

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
  });

  it('omits a tool the user turned off', async () => {
    const { runtime, dataDir } = await createRuntime();
    await runtime.prepareManagedOpenCodeEnv({ includeControl: false, includeWeb: true, includeMemory: false });
    const pluginPath = path.join(dataDir, 'agent-tool', 'openchamber-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?web=${Date.now()}`);
    const { tool } = await pluginModule.OpenChamberPlugin();

    expect(Object.keys(tool)).toEqual(['openchamber_web']);
  });

  it('exposes memory as its own tool carrying only its own inputs', async () => {
    const { runtime, dataDir } = await createRuntime();
    await runtime.prepareManagedOpenCodeEnv({ includeControl: true, includeWeb: false, includeMemory: true });
    const pluginPath = path.join(dataDir, 'agent-tool', 'openchamber-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?memory=${Date.now()}`);
    const { tool } = await pluginModule.OpenChamberPlugin();

    expect(Object.keys(tool)).toEqual(['openchamber', 'openchamber_memory']);
    expect(Object.keys(tool.openchamber_memory.args.parameters.properties).sort())
      .toEqual(['body', 'memoryId', 'scope', 'title', 'type']);
    // Memory inputs must not leak into the control tool's schema, which the
    // model pays for on every unrelated call.
    expect(Object.keys(tool.openchamber.args.parameters.properties)).not.toContain('memoryId');
  });

  it('omits memory entirely when the user turns it off', async () => {
    const { runtime, dataDir } = await createRuntime();
    await runtime.prepareManagedOpenCodeEnv({ includeControl: true, includeWeb: false, includeMemory: false });
    const pluginPath = path.join(dataDir, 'agent-tool', 'openchamber-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?nomemory=${Date.now()}`);
    const { tool } = await pluginModule.OpenChamberPlugin();

    expect(Object.keys(tool)).toEqual(['openchamber']);
  });

  it('injects the plugin when memory is the only tool left on', async () => {
    const { runtime, dataDir } = await createRuntime();
    await runtime.prepareManagedOpenCodeEnv({ includeControl: false, includeWeb: false, includeMemory: true });
    const pluginPath = path.join(dataDir, 'agent-tool', 'openchamber-plugin.js');
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?onlymemory=${Date.now()}`);
    const { tool } = await pluginModule.OpenChamberPlugin();

    expect(Object.keys(tool)).toEqual(['openchamber_memory']);
  });

  it('refuses to inject a plugin with no tools in it', async () => {
    const { runtime } = await createRuntime();
    let failed = false;
    try {
      await runtime.prepareManagedOpenCodeEnv({ includeControl: false, includeWeb: false, includeMemory: false });
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
      tool: 'openchamber_memory',
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('memory.read');
    expect(executeAction).toHaveBeenCalledWith(
      'memory.read',
      { action: 'memory.read', title: 'Uses bun' },
      '/work/project',
      {},
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

  it('requires the per-child token on the loopback route', async () => {
    const { runtime } = await createRuntime();
    const env = await runtime.prepareManagedOpenCodeEnv();
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
      const env = await runtime.prepareManagedOpenCodeEnv();
      process.env.OPENCHAMBER_AGENT_TOOL_URL = env.OPENCHAMBER_AGENT_TOOL_URL;
      process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      const pluginPath = path.join(dataDir, 'agent-tool', 'openchamber-plugin.js');
      const pluginModule = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
      const hooks = await pluginModule.OpenChamberPlugin();
      const metadata = vi.fn();

      const result = await hooks.tool.openchamber.execute(
        { action: 'projects.list', parameters: {} },
        { directory: '/work/project', abort: new AbortController().signal, metadata },
      );

      expect(JSON.parse(result.output)).toEqual({
        schemaVersion: 1,
        ok: true,
        action: 'projects.list',
        data: { projects: [] },
      });
      expect(result.title).toBe('List configured projects');
      expect(result.metadata.openchamber.description).toBe('List configured projects');
      expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
        title: 'List configured projects',
        metadata: expect.objectContaining({
          openchamber: expect.objectContaining({ description: 'List configured projects' }),
        }),
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
