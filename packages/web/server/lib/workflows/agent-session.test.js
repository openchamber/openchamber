import { OpenCode } from '@opencode/client';
import { describe, expect, it } from 'vitest';

import { WorkflowAgentStopped, createWorkflowAgentSessions } from './agent-session.js';
import { createSessionDirectoryCanonicalizer } from '../opencode/directory-canonicalization.js';

/** Creates an agent's session and stops before its prompt, to read the request. */
const createSessionRequest = async ({ parent, allowTools, model, getSessionDirectoryCanonicalizer }) => {
  const created = [];
  const sessions = createWorkflowAgentSessions({
    getSessionDirectoryCanonicalizer,
    buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    globalEventHub: { subscribeEvent: () => () => {} },
    createClient: () => ({
      session: {
        get: async () => parent,
        create: async (request) => {
          created.push(request);
          return { id: 'ses_agent' };
        },
      },
    }),
  });
  const controller = new AbortController();
  await expect(sessions.start({
    directory: '/repo',
    parentSessionId: 'ses_parent',
    title: 'agent',
    model,
    allowTools,
    text: 'work',
    signal: controller.signal,
    onSession: () => controller.abort(),
  })).rejects.toBeInstanceOf(WorkflowAgentStopped);
  return created[0];
};

describe('workflow agent sessions', () => {
  it.each([false, true])('awaits the child-id checkpoint before prompting, rejection=%s', async (rejectCheckpoint) => {
    let release;
    let seen;
    const checkpoint = new Promise((resolve, reject) => { release = () => rejectCheckpoint ? reject(new Error('checkpoint failed')) : resolve(); });
    void checkpoint.catch(() => {});
    const created = new Promise((resolve) => { seen = resolve; });
    const prompts = [];
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (route) => `http://localhost:4096${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: {
          get: async () => ({ id: 'ses_parent' }),
          create: async () => ({ id: 'ses_empty_child' }),
          prompt: async ({ text }) => { prompts.push(text); throw new Error('prompt reached'); },
        },
        message: { list: async () => ({ data: [] }) },
      }),
    });
    const starting = sessions.start({
      directory: '/repo', parentSessionId: 'ses_parent', title: 'agent', model: 'test/model',
      text: 'work', signal: new AbortController().signal,
      onSession: (id) => { seen(id); return checkpoint; },
    });
    const ended = starting.then(() => null, (error) => error);
    expect(await created).toBe('ses_empty_child');
    await new Promise((resolve) => setImmediate(resolve));
    const prematurePrompts = [...prompts];
    release();
    expect((await ended)?.message).toBe(rejectCheckpoint ? 'checkpoint failed' : 'prompt reached');
    expect(prematurePrompts).toEqual([]);
    expect(prompts).toEqual(rejectCheckpoint ? [] : ['work']);
    sessions.stop();
  });

  it('links the agent to its parent by metadata, without an OpenCode parentID that would wake the parent', async () => {
    const request = await createSessionRequest({
      parent: { id: 'ses_parent', location: { directory: '/repo/worktree' } },
      allowTools: [],
      model: 'openai/gpt-6-luna',
    });
    expect(request).not.toHaveProperty('parentID');
    expect(request).toMatchObject({
      metadata: { openchamber: { kind: 'workflow-agent', parentID: 'ses_parent' } },
      location: { directory: '/repo/worktree' },
    });
  });

  it.each([
    [true, '/data/repo/worktree'],
    [false, '/repo/worktree'],
  ])('resolves the parent directory only while OpenCode shares this filesystem (shared=%s)', async (shared, expected) => {
    const getSessionDirectoryCanonicalizer = createSessionDirectoryCanonicalizer({
      sharesFilesystem: () => shared,
      realpath: async (value) => (value === '/repo/worktree' ? '/data/repo/worktree' : value),
    });
    const request = await createSessionRequest({
      parent: { id: 'ses_parent', location: { directory: '/repo/worktree' } },
      allowTools: [],
      getSessionDirectoryCanonicalizer,
    });
    expect(request.location).toEqual({ directory: expected });
  });

  it("runs on the parent's model when the call names none", async () => {
    const model = { providerID: 'openai', id: 'gpt-6-luna', variant: 'high' };
    const request = await createSessionRequest({ parent: { id: 'ses_parent', model }, allowTools: [] });
    expect(request.model).toEqual(model);
  });

  it('passes an explicitly undefined parent variant through to the client', async () => {
    const model = { providerID: 'openai', id: 'test-model', variant: undefined };
    const request = await createSessionRequest({ parent: { id: 'ses_parent', model }, allowTools: [] });
    expect(request.model).toEqual(model);
    expect(Object.hasOwn(request.model, 'variant')).toBe(true);
  });

  it('uses the real client for a parent model without a variant', async () => {
    const requests = [];
    const controller = new AbortController();
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (route) => `http://localhost:4096${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        const data = init.method === 'GET'
          ? { id: 'ses_parent', model: { providerID: 'test', id: 'model' } }
          : { id: 'ses_agent' };
        return Response.json({ data });
      },
    });
    await expect(sessions.start({
      directory: '/repo', parentSessionId: 'ses_parent', title: 'agent',
      text: 'work', signal: controller.signal, onSession: () => controller.abort(),
    })).rejects.toBeInstanceOf(WorkflowAgentStopped);
    expect(requests.map(({ url }) => url)).toEqual([
      'http://localhost:4096/api/session/ses_parent',
      'http://localhost:4096/api/session',
    ]);
    expect(JSON.parse(requests[1].init.body).model).toEqual({ providerID: 'test', id: 'model' });
    sessions.stop();
  });

  it('accepts an explicitly undefined variant at the real SDK serialization boundary', async () => {
    const bodies = [];
    const client = OpenCode.make({
      baseUrl: 'http://localhost:4096',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return Response.json({ data: { id: 'ses_agent' } });
      },
    });
    await client.session.create({ model: { providerID: 'test', id: 'model', variant: undefined } });
    expect(bodies).toEqual([{ model: { providerID: 'test', id: 'model' } }]);
  });

  it("allows the asked tools after the parent's own rules", async () => {
    const parentRule = { action: 'bash', resource: '*', effect: 'deny' };
    const request = await createSessionRequest({
      parent: { id: 'ses_parent', permissions: [parentRule] },
      allowTools: ['openchamber_workflow_answer'],
      model: 'openai/gpt-6-luna',
    });
    expect(request.permissions).toEqual([parentRule, { action: 'openchamber_workflow_answer', resource: '*', effect: 'allow' }]);
  });

  it("copies the parent's rules without tools to allow", async () => {
    const parentRule = { action: 'bash', resource: '*', effect: 'deny' };
    const request = await createSessionRequest({ parent: { id: 'ses_parent', permissions: [parentRule] }, allowTools: [], model: 'openai/gpt-6-luna' });
    expect(request.permissions).toEqual([parentRule]);
  });

  it('sets no permissions when neither the parent nor the call has any', async () => {
    const request = await createSessionRequest({ parent: { id: 'ses_parent' }, allowTools: [], model: 'openai/gpt-6-luna' });
    expect(request).not.toHaveProperty('permissions');
  });

  it("starts no session when the parent's rules cannot be read", async () => {
    const created = [];
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: {
          get: async () => { throw new Error('OpenCode is down'); },
          create: async (request) => { created.push(request); return { id: 'ses_agent' }; },
        },
      }),
    });
    await expect(sessions.start({
      directory: '/repo', parentSessionId: 'ses_parent', title: 'agent', model: 'openai/gpt-6-luna',
      allowTools: [], text: 'work', signal: new AbortController().signal, onSession: () => {},
    })).rejects.toThrow('OpenCode is down');
    expect(created).toEqual([]);
  });

  it('forks the source session and keeps its rules, agent and model before prompting', async () => {
    const calls = [];
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: {
          // A fork copies no permissions, agent, or model, so they are read
          // from the source session itself.
          get: async ({ sessionID }) => { calls.push(['get', sessionID]); return { id: 'ses_explore', agent: 'explore', model: { providerID: 'openai', id: 'gpt-6-luna' }, permissions: [{ action: 'bash', resource: '*', effect: 'allow' }, { action: 'openchamber_workflow_answer', resource: '*', effect: 'allow' }] }; },
          fork: async ({ sessionID }) => { calls.push(['fork', sessionID]); return { id: 'ses_branch' }; },
          create: async () => { calls.push(['create']); return { id: 'ses_wrong' }; },
          update: async ({ sessionID, title, metadata, permissions }) => { calls.push(['update', sessionID, title, metadata, permissions]); },
          switchAgent: async ({ sessionID, agent }) => { calls.push(['switchAgent', sessionID, agent]); },
          switchModel: async ({ sessionID, model }) => { calls.push(['switchModel', sessionID, model]); },
          prompt: async () => { calls.push(['prompt']); throw new Error('prompt reached'); },
        },
        message: { list: async () => ({ data: [] }) },
      }),
    });
    await expect(sessions.start({
      directory: '/repo', parentSessionId: 'ses_parent', forkFromSessionId: 'ses_explore',
      title: 'branch', text: 'work', signal: new AbortController().signal,
      onSession: () => {},
    })).rejects.toThrow('prompt reached');
    expect(calls[0]).toEqual(['get', 'ses_explore']);
    expect(calls[1]).toEqual(['fork', 'ses_explore']);
    // The link to the run's proposer is written on the fork itself; the
    // source's rules carry over, and without a schema the answer tool is
    // denied outright: a copied allow would let a branch answer a schema it
    // was never asked.
    expect(calls[2]).toEqual(['update', 'ses_branch', 'branch',
      { openchamber: { kind: 'workflow-agent', parentID: 'ses_parent' } },
      [
        { action: 'bash', resource: '*', effect: 'allow' },
        { action: 'openchamber_workflow_answer', resource: '*', effect: 'deny' },
      ],
    ]);
    expect(calls[3]).toEqual(['switchAgent', 'ses_branch', 'explore']);
    expect(calls[4]).toEqual(['switchModel', 'ses_branch', { providerID: 'openai', id: 'gpt-6-luna' }]);
    expect(calls[5]).toEqual(['prompt']);
    sessions.stop();
  });

  it('re-allows the answer tool on a fork asked for a schema', async () => {
    const updates = [];
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: {
          get: async () => ({ id: 'ses_explore', permissions: [{ action: 'openchamber_workflow_answer', resource: '*', effect: 'deny' }] }),
          fork: async () => ({ id: 'ses_branch' }),
          update: async (request) => { updates.push(request); },
          prompt: async () => { throw new Error('prompt reached'); },
        },
        message: { list: async () => ({ data: [] }) },
      }),
    });
    await expect(sessions.start({
      directory: '/repo', parentSessionId: 'ses_parent', forkFromSessionId: 'ses_explore',
      title: 'branch', text: 'work', allowTools: ['openchamber_workflow_answer'],
      signal: new AbortController().signal, onSession: () => {},
    })).rejects.toThrow('prompt reached');
    expect(updates[0].permissions).toEqual([{ action: 'openchamber_workflow_answer', resource: '*', effect: 'allow' }]);
    sessions.stop();
  });

  it.each([
    ['the source read rejects', async () => { throw new Error('source session is gone'); }, 'source session is gone'],
    ['the source answers a malformed payload', async () => ({ title: 'not a session' }), 'Invalid'],
  ])('fails before forking when %s: no fork, no permission replacement, no prompt', async (_when, sourceGet, reason) => {
    const calls = [];
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: {
          get: async ({ sessionID }) => { calls.push(['get', sessionID]); return sourceGet({ sessionID }); },
          ...Object.fromEntries(['create', 'fork', 'update', 'switchAgent', 'switchModel'].map(
            (name) => [name, async () => { calls.push([name]); return { id: 'ses_new' }; }],
          )),
          prompt: async () => { calls.push(['prompt']); throw new Error('prompt reached'); },
        },
        message: { list: async () => ({ data: [] }) },
      }),
    });
    const failure = await sessions.start({
      directory: '/repo', parentSessionId: 'ses_parent', forkFromSessionId: 'ses_explore',
      title: 'branch', text: 'work', signal: new AbortController().signal,
      onSession: () => { calls.push(['onSession']); },
    }).then(() => null, (error) => error);
    expect(failure?.message).toContain(reason);
    expect(calls).toEqual([['get', 'ses_explore']]);
    sessions.stop();
  });

  it('a fork whose records cannot be read sends no prompt, so a copied idle never answers for it', async () => {
    const calls = [];
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: {
          get: async () => ({ id: 'ses_explore' }),
          fork: async () => ({ id: 'ses_new' }),
          update: async () => undefined,
          prompt: async () => { calls.push('prompt'); },
        },
        message: { list: async () => ({ data: null }) },
      }),
    });
    const failure = await sessions.start({
      directory: '/repo', parentSessionId: 'ses_parent', forkFromSessionId: 'ses_explore',
      title: 'branch', text: 'work', signal: new AbortController().signal, onSession: () => {},
    }).then(() => null, (error) => error);
    expect(failure?.message).toContain('ses_new');
    expect(calls).toEqual([]);
    sessions.stop();
  });

  it('a stop during the source read never forks and never records a session', async () => {
    const calls = [];
    let finishRead;
    let readBegun;
    const begun = new Promise((resolve) => { readBegun = resolve; });
    const read = new Promise((resolve) => { finishRead = resolve; });
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: {
          get: async ({ sessionID }) => { calls.push(['get', sessionID]); readBegun(); await read; return { id: 'ses_explore' }; },
          ...Object.fromEntries(['create', 'fork', 'update', 'switchAgent', 'switchModel'].map(
            (name) => [name, async () => { calls.push([name]); return { id: 'ses_new' }; }],
          )),
          prompt: async () => { calls.push(['prompt']); throw new Error('prompt reached'); },
        },
        message: { list: async () => ({ data: [] }) },
      }),
    });
    const controller = new AbortController();
    const starting = sessions.start({
      directory: '/repo', parentSessionId: 'ses_parent', forkFromSessionId: 'ses_explore',
      title: 'branch', text: 'work', signal: controller.signal,
      onSession: () => { calls.push(['onSession']); },
    });
    // Stop the run while the source read is still in flight, then let it land.
    await begun;
    controller.abort();
    finishRead();
    await expect(starting).rejects.toBeInstanceOf(WorkflowAgentStopped);
    expect(calls).toEqual([['get', 'ses_explore']]);
    sessions.stop();
  });

  it('switches nothing a fork already inherited, and only what an override changes', async () => {
    const run = async (overrides) => {
      const calls = [];
      const sessions = createWorkflowAgentSessions({
        buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
        getOpenCodeAuthHeaders: () => ({}),
        globalEventHub: { subscribeEvent: () => () => {} },
        createClient: () => ({
          session: {
            get: async () => ({ id: 'ses_explore', agent: 'explore', model: { providerID: 'openai', id: 'gpt-6-luna', variant: 'high' } }),
            // OpenCode's native fork copies the source's agent and model.
            fork: async () => ({ id: 'ses_branch', agent: 'explore', model: { providerID: 'openai', id: 'gpt-6-luna', variant: 'high' } }),
            update: async () => {},
            switchAgent: async ({ agent }) => { calls.push(['switchAgent', agent]); },
            switchModel: async ({ model }) => { calls.push(['switchModel', model]); },
            prompt: async () => { throw new Error('prompt reached'); },
          },
          message: { list: async () => ({ data: [] }) },
        }),
      });
      await expect(sessions.start({
        directory: '/repo', parentSessionId: 'ses_parent', forkFromSessionId: 'ses_explore',
        title: 'branch', text: 'work', signal: new AbortController().signal, onSession: () => {}, ...overrides,
      })).rejects.toThrow('prompt reached');
      sessions.stop();
      return calls;
    };
    // A switch to the same agent still writes a switch record into the branch.
    expect(await run({})).toEqual([]);
    expect(await run({ agent: 'explore', model: 'openai/gpt-6-luna#high' })).toEqual([]);
    expect(await run({ agent: 'review' })).toEqual([['switchAgent', 'review']]);
    expect(await run({ model: 'openai/gpt-6-luna' })).toEqual([['switchModel', { providerID: 'openai', id: 'gpt-6-luna' }]]);
  });

  it.each([
    ['OpenCode says the session is not found', Object.assign(new Error('Session not found'), { _tag: 'SessionNotFoundError' }), true],
    ['the read fails for another reason', new Error('OpenCode is down'), false],
    ['the session reads', null, false],
  ])('sessionGone is true only when %s', async (_when, failure, gone) => {
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: { get: async () => { if (failure) throw failure; return { id: 'ses_explore' }; } },
        message: { list: async () => ({ data: [] }) },
      }),
    });
    expect(await sessions.sessionGone({ directory: '/repo', sessionId: 'ses_explore', signal: new AbortController().signal })).toBe(gone);
    sessions.stop();
  });

  it('gives up a stalled sessionGone read when the run stops, keeping the saved answer', async () => {
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: { get: () => new Promise(() => {}) },
        message: { list: async () => ({ data: [] }) },
      }),
    });
    const controller = new AbortController();
    const pending = sessions.sessionGone({ directory: '/repo', sessionId: 'ses_explore', signal: controller.signal });
    controller.abort();
    expect(await pending).toBe(false);
    sessions.stop();
  });

  it('lets a call override the agent and model a fork inherits', async () => {
    const calls = [];
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: { subscribeEvent: () => () => {} },
      createClient: () => ({
        session: {
          get: async () => ({ id: 'ses_explore', agent: 'explore', model: { providerID: 'openai', id: 'gpt-6-luna' } }),
          fork: async () => ({ id: 'ses_branch' }),
          update: async () => {},
          switchAgent: async ({ sessionID, agent }) => { calls.push(['switchAgent', sessionID, agent]); },
          switchModel: async ({ sessionID, model }) => { calls.push(['switchModel', sessionID, model]); },
          prompt: async () => { throw new Error('prompt reached'); },
        },
        message: { list: async () => ({ data: [] }) },
      }),
    });
    await expect(sessions.start({
      directory: '/repo', parentSessionId: 'ses_parent', forkFromSessionId: 'ses_explore',
      title: 'branch', text: 'work', agent: 'review', model: 'anthropic/claude-sonnet-5#low',
      signal: new AbortController().signal, onSession: () => {},
    })).rejects.toThrow('prompt reached');
    expect(calls).toEqual([
      ['switchAgent', 'ses_branch', 'review'],
      ['switchModel', 'ses_branch', { providerID: 'anthropic', id: 'claude-sonnet-5', variant: 'low' }],
    ]);
    sessions.stop();
  });
});
