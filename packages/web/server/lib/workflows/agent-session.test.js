import { describe, expect, it } from 'vitest';

import { WorkflowAgentStopped, createWorkflowAgentSessions } from './agent-session.js';

/** Creates an agent's session and stops before its prompt, to read the request. */
const createSessionRequest = async ({ parent, allowTools, model }) => {
  const created = [];
  const sessions = createWorkflowAgentSessions({
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

  it("runs on the parent's model when the call names none", async () => {
    const model = { providerID: 'openai', id: 'gpt-6-luna', variant: 'high' };
    const request = await createSessionRequest({ parent: { id: 'ses_parent', model }, allowTools: [] });
    expect(request.model).toEqual(model);
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
});
