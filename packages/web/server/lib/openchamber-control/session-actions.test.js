import { describe, expect, it, vi } from 'vitest';

import { OpenChamberControlError } from './error.js';
import {
  SESSION_EXTRA_ACTION_DEFINITIONS,
  SESSION_EXTRA_PARAMETERS,
  createSessionExtraActions,
} from './session-actions.js';

const DIRECTORY = '/repo';

const createClient = () => ({
  session: {
    get: vi.fn(async () => ({ id: 'ses_target', model: { providerID: 'anthropic', id: 'claude', variant: 'low' }, agent: 'build' })),
    update: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    switchAgent: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => ({ interrupted: true })),
    active: vi.fn(async () => ({})),
    prompt: vi.fn(async () => ({ id: 'inbox_1' })),
    revert: {
      stage: vi.fn(async () => ({ messageID: 'msg_u2' })),
      clear: vi.fn(async () => undefined),
    },
    message: {
      get: vi.fn(async ({ messageID }) => ({ id: messageID, type: 'assistant', time: { created: 42 } })),
    },
  },
  message: {
    list: vi.fn(async () => ({ data: [] })),
  },
  model: {
    list: vi.fn(async () => ({
      data: [
        { providerID: 'anthropic', modelID: 'claude', variants: [{ id: 'low' }, { id: 'high' }] },
        { providerID: 'openai', modelID: 'gpt', variants: [] },
      ],
    })),
  },
  agent: {
    list: vi.fn(async () => ({
      data: [
        { id: 'build', mode: 'primary', hidden: false },
        { id: 'plan', mode: 'primary', hidden: false },
        { id: 'explore', mode: 'subagent', hidden: false },
      ],
    })),
  },
});

const setup = ({ metadata = {}, knowledge = true } = {}) => {
  const client = createClient();
  let stored = metadata;
  const sessionService = {
    getMetadata: vi.fn(async () => ({ metadata: stored })),
    setMetadata: vi.fn(async (_sessionID, { patch }) => {
      stored = { ...stored, openchamber: { ...stored.openchamber, ...patch.openchamber } };
      return { metadata: stored };
    }),
  };
  const sessionKnowledgeRuntime = knowledge
    ? { setPin: vi.fn(async (_s, _d, kind, id, pinned) => ({ notes: kind === 'note' && pinned ? [id] : [], plans: kind === 'plan' && pinned ? [id] : [] })) }
    : null;
  const createSessionGoal = vi.fn(async ({ sessionID, directory, objective, tokenBudget, persistSessionGoal }) => {
    const goal = {
      id: 'goal_new',
      objective: '',
      objectiveFile: true,
      status: 'active',
      tokenBudget: tokenBudget || null,
      tokensUsed: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      note: '',
      statusReason: '',
      lastAccountedMessageID: '',
      createdAt: 1000,
      updatedAt: 1000,
    };
    objectives.set(sessionID, objective);
    await persistSessionGoal(sessionID, directory, goal);
    return { goal, spec: null };
  });
  const objectives = new Map();
  const readObjective = vi.fn(async (sessionID) => objectives.get(sessionID) ?? null);
  const deleteObjective = vi.fn(async (sessionID) => { objectives.delete(sessionID); });
  const actions = createSessionExtraActions({
    sessionService,
    sessionKnowledgeRuntime,
    createSessionGoal,
    readObjective,
    deleteObjective,
  });
  const ctx = {
    contextDirectory: DIRECTORY,
    contextSessionId: 'ses_caller',
    getClient: vi.fn(async () => client),
    resolveSessionDirectory: vi.fn(async (input) => input.directory || DIRECTORY),
  };
  const run = (action, input = {}) => actions.execute(action, { sessionId: 'ses_target', ...input }, ctx);
  return { actions, client, sessionService, sessionKnowledgeRuntime, createSessionGoal, objectives, readObjective, deleteObjective, ctx, run, getStored: () => stored };
};

const expectControlError = async (promise, status, pattern) => {
  const error = await promise.then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(OpenChamberControlError);
  expect(error.statusCode).toBe(status);
  if (pattern) expect(error.message).toMatch(pattern);
};

describe('session extra actions contract', () => {
  it('declares every action it executes, and only new parameters', () => {
    const { actions } = setup();
    expect(actions.actions).toEqual(SESSION_EXTRA_ACTION_DEFINITIONS.map((definition) => definition.action));
    expect(actions.actions).toEqual([
      'session.rename', 'session.subagentPolicy', 'session.model', 'session.agent', 'session.goal', 'session.retry', 'session.pin', 'session.abort',
    ]);
    for (const definition of SESSION_EXTRA_ACTION_DEFINITIONS) {
      expect(definition.title).toBeTruthy();
      expect(definition.description).toBeTruthy();
    }
    expect(Object.keys(SESSION_EXTRA_PARAMETERS).sort()).toEqual(['goalAction', 'objective', 'pinId', 'pinKind', 'pinned', 'subagentPolicy']);
  });

  it('session.subagentPolicy PATCHes the whole policy through session.update', async () => {
    const { run, client } = setup();
    const subagentPolicy = {
      models: ['anthropic/claude-haiku-5-5', 'opencode-go/*'],
      excludedModels: ['openai/gpt-5'],
      agentOverrides: { build: { force: true } },
    };
    await expect(run('session.subagentPolicy', { subagentPolicy })).resolves.toEqual({
      sessionId: 'ses_target', subagentPolicy, directory: DIRECTORY,
    });
    expect(client.session.update).toHaveBeenCalledWith({ sessionID: 'ses_target', subagentPolicy });
  });

  it('session.subagentPolicy refuses a policy that is not an object', async () => {
    const { run, client } = setup();
    await expectControlError(run('session.subagentPolicy', { subagentPolicy: 'anthropic/claude' }), 400, /subagentPolicy/);
    await expectControlError(run('session.subagentPolicy', {}), 400, /subagentPolicy/);
    expect(client.session.update).not.toHaveBeenCalled();
  });

  it('rejects unknown actions', async () => {
    const { actions, ctx } = setup();
    await expectControlError(actions.execute('session.nope', {}, ctx), 400, /Unsupported/);
  });

  it('defaults sessionId to the calling session and scopes the client to its directory', async () => {
    const { actions, ctx, client } = setup();
    const result = await actions.execute('session.rename', { title: 'Hi' }, ctx);
    expect(result).toEqual({ sessionId: 'ses_caller', title: 'Hi', directory: DIRECTORY });
    expect(ctx.resolveSessionDirectory).toHaveBeenCalledWith({ title: 'Hi', sessionId: 'ses_caller' }, ctx);
    expect(ctx.getClient).toHaveBeenCalledWith(DIRECTORY);
    expect(client.session.update).toHaveBeenCalledWith({ sessionID: 'ses_caller', title: 'Hi' });
  });

  it('requires a session when there is no calling session', async () => {
    const { actions, ctx } = setup();
    await expectControlError(actions.execute('session.rename', { title: 'x' }, { ...ctx, contextSessionId: undefined }), 400, /sessionId is required/);
  });

  it('fails when the session directory cannot be resolved', async () => {
    const { run, ctx } = setup();
    ctx.resolveSessionDirectory.mockResolvedValueOnce(null);
    await expectControlError(run('session.rename', { title: 'x' }), 404, /directory/);
    expect(ctx.getClient).not.toHaveBeenCalled();
  });
});

describe('session.rename', () => {
  it('sets a trimmed title', async () => {
    const { run, client } = setup();
    await expect(run('session.rename', { title: '  New name ' })).resolves.toEqual({ sessionId: 'ses_target', title: 'New name', directory: DIRECTORY });
    expect(client.session.update).toHaveBeenCalledWith({ sessionID: 'ses_target', title: 'New name' });
  });

  it('asks for a generated title with an empty one', async () => {
    const { run, client } = setup();
    await expect(run('session.rename', { title: '' })).resolves.toMatchObject({ title: null, regenerating: true });
    expect(client.session.update).toHaveBeenCalledWith({ sessionID: 'ses_target', title: '' });
  });

  it('requires title to be present', async () => {
    const { run, client } = setup();
    await expectControlError(run('session.rename', {}), 400, /title is required/);
    expect(client.session.update).not.toHaveBeenCalled();
  });
});

describe('session.model', () => {
  it('switches model and variant', async () => {
    const { run, client } = setup();
    await expect(run('session.model', { model: 'anthropic/claude', variant: 'high' }))
      .resolves.toMatchObject({ model: 'anthropic/claude', variant: 'high' });
    expect(client.session.switchModel).toHaveBeenCalledWith({
      sessionID: 'ses_target',
      model: { id: 'claude', providerID: 'anthropic', variant: 'high' },
    });
  });

  it('drops the variant when only the model changes', async () => {
    const { run, client } = setup();
    await expect(run('session.model', { model: 'openai/gpt' })).resolves.toMatchObject({ model: 'openai/gpt', variant: null });
    expect(client.session.switchModel).toHaveBeenCalledWith({ sessionID: 'ses_target', model: { id: 'gpt', providerID: 'openai' } });
  });

  it('keeps the session model when only the variant changes', async () => {
    const { run, client } = setup();
    await run('session.model', { variant: 'high' });
    expect(client.session.get).toHaveBeenCalledWith({ sessionID: 'ses_target' });
    expect(client.session.switchModel).toHaveBeenCalledWith({
      sessionID: 'ses_target',
      model: { id: 'claude', providerID: 'anthropic', variant: 'high' },
    });
  });

  it('returns to the default effort with an empty variant', async () => {
    const { run, client } = setup();
    await expect(run('session.model', { variant: '' })).resolves.toMatchObject({ variant: null });
    expect(client.session.switchModel).toHaveBeenCalledWith({ sessionID: 'ses_target', model: { id: 'claude', providerID: 'anthropic' } });
  });

  it('refuses a variant-only change on a session without a model', async () => {
    const { run, client } = setup();
    client.session.get.mockResolvedValueOnce({ id: 'ses_target' });
    await expectControlError(run('session.model', { variant: 'high' }), 409, /no model/);
  });

  it('validates input and the catalogue', async () => {
    const { run, client } = setup();
    await expectControlError(run('session.model', {}), 400, /model or variant/);
    await expectControlError(run('session.model', { model: 'nope' }), 400, /provider\/model/);
    await expectControlError(run('session.model', { model: 'openchamber/auto' }), 400, /Auto/);
    await expectControlError(run('session.model', { model: 'x/y' }), 400, /Unknown model/);
    await expectControlError(run('session.model', { model: 'anthropic/claude', variant: 'max' }), 400, /use one of: low, high/);
    await expectControlError(run('session.model', { model: 'openai/gpt', variant: 'max' }), 400, /it has none/);
    expect(client.session.switchModel).not.toHaveBeenCalled();
  });

  it('does not refuse when the catalogue cannot be read', async () => {
    const { run, client } = setup();
    client.model.list.mockRejectedValueOnce(new Error('down'));
    await run('session.model', { model: 'x/y', variant: 'max' });
    expect(client.session.switchModel).toHaveBeenCalledWith({ sessionID: 'ses_target', model: { id: 'y', providerID: 'x', variant: 'max' } });
  });
});

describe('session.agent', () => {
  it('switches to a primary agent', async () => {
    const { run, client } = setup();
    await expect(run('session.agent', { agent: 'plan' })).resolves.toMatchObject({ sessionId: 'ses_target', agent: 'plan' });
    expect(client.session.switchAgent).toHaveBeenCalledWith({ sessionID: 'ses_target', agent: 'plan' });
  });

  it('rejects missing, unknown and subagent names', async () => {
    const { run, client } = setup();
    await expectControlError(run('session.agent', {}), 400, /agent is required/);
    await expectControlError(run('session.agent', { agent: 'ghost' }), 400, /use one of: build, plan/);
    await expectControlError(run('session.agent', { agent: 'explore' }), 400, /subagent/);
    expect(client.session.switchAgent).not.toHaveBeenCalled();
  });

  it('does not refuse when the agent list cannot be read', async () => {
    const { run, client } = setup();
    client.agent.list.mockRejectedValueOnce(new Error('down'));
    await run('session.agent', { agent: 'custom' });
    expect(client.session.switchAgent).toHaveBeenCalledWith({ sessionID: 'ses_target', agent: 'custom' });
  });
});

const activeGoal = {
  id: 'goal_old',
  objective: '',
  objectiveFile: true,
  status: 'active',
  tokenBudget: 5000,
  tokensUsed: 700,
  tokensBaseline: 10,
  turnsUsed: 4,
  blockedStreak: 1,
  statusReason: '',
  createdAt: 1,
  updatedAt: 1,
};

describe('session.goal', () => {
  it('validates goalAction', async () => {
    const { run } = setup();
    await expectControlError(run('session.goal', {}), 400, /goalAction/);
    await expectControlError(run('session.goal', { goalAction: 'explode' }), 400, /goalAction/);
  });

  it('gets the goal with its objective text', async () => {
    const { run, objectives } = setup({ metadata: { openchamber: { goal: activeGoal } } });
    objectives.set('ses_target', 'Ship it');
    await expect(run('session.goal', { goalAction: 'get' })).resolves.toMatchObject({
      sessionId: 'ses_target',
      goal: { id: 'goal_old', objective: 'Ship it', status: 'active' },
    });
  });

  it('gets null when there is no goal', async () => {
    const { run } = setup();
    await expect(run('session.goal', { goalAction: 'get' })).resolves.toMatchObject({ goal: null });
  });

  it('creates a goal through create.js', async () => {
    const { run, createSessionGoal, sessionService, getStored } = setup();
    const result = await run('session.goal', { goalAction: 'set', objective: ' Fix the build ', goalTokenBudget: 20_000 });
    expect(createSessionGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_target',
      directory: DIRECTORY,
      objective: 'Fix the build',
      tokenBudget: 20_000,
      providerID: 'anthropic',
      modelID: 'claude',
    }));
    expect(sessionService.setMetadata).toHaveBeenCalledWith('ses_target', expect.objectContaining({ directory: DIRECTORY }));
    expect(getStored().openchamber.goal).toMatchObject({ id: 'goal_new', status: 'active', tokenBudget: 20_000 });
    expect(result).toMatchObject({ created: true, goal: { id: 'goal_new', objective: 'Fix the build' } });
  });

  it('replaces a completed goal and deletes its stale keys', async () => {
    const { run, sessionService } = setup({ metadata: { openchamber: { goal: { ...activeGoal, status: 'complete', evaluationModelID: 'jev' } } } });
    await run('session.goal', { goalAction: 'set', objective: 'Next' });
    const { patch } = sessionService.setMetadata.mock.calls[0][1];
    expect(patch.openchamber.goal).toMatchObject({ id: 'goal_new', tokensBaseline: null, evaluationModelID: null, turnsUsed: 0 });
  });

  it('edits an unfinished goal in place, keeping id and counters', async () => {
    const { run, getStored } = setup({ metadata: { openchamber: { goal: { ...activeGoal, status: 'blocked' } } } });
    const result = await run('session.goal', { goalAction: 'set', objective: 'Rewritten' });
    expect(getStored().openchamber.goal).toMatchObject({
      id: 'goal_old',
      tokensUsed: 700,
      turnsUsed: 4,
      tokenBudget: 5000,
      status: 'active',
      statusReason: 'resumed',
      blockedStreak: 0,
      objectiveFile: true,
    });
    expect(result).toMatchObject({ created: false, goal: { objective: 'Rewritten' } });
  });

  it('validates set input', async () => {
    const { run, createSessionGoal } = setup();
    await expectControlError(run('session.goal', { goalAction: 'set' }), 400, /objective is required/);
    await expectControlError(run('session.goal', { goalAction: 'set', objective: 'x', goalTokenBudget: 10 }), 400, /goalTokenBudget/);
    await expectControlError(run('session.goal', { goalAction: 'set', objective: 'x', goalTokenBudget: 1.5e3 + 0.5 }), 400, /goalTokenBudget/);
    expect(createSessionGoal).not.toHaveBeenCalled();
  });

  it('pauses: stops the turn, then writes paused', async () => {
    const { run, client, getStored } = setup({ metadata: { openchamber: { goal: activeGoal } } });
    const result = await run('session.goal', { goalAction: 'pause' });
    expect(client.session.interrupt).toHaveBeenCalledWith({ sessionID: 'ses_target' });
    expect(getStored().openchamber.goal).toMatchObject({ id: 'goal_old', status: 'paused', statusReason: '', blockedStreak: 0, turnsUsed: 4 });
    expect(result).toMatchObject({ interrupted: true, goal: { status: 'paused' } });
  });

  it('resumes with a fresh turn allowance and the kickoff signal', async () => {
    const { run, client, getStored } = setup({ metadata: { openchamber: { goal: { ...activeGoal, status: 'paused' } } } });
    await run('session.goal', { goalAction: 'resume' });
    expect(getStored().openchamber.goal).toMatchObject({ status: 'active', statusReason: 'resumed', turnsUsed: 0, blockedStreak: 0 });
    expect(client.session.interrupt).not.toHaveBeenCalled();
  });

  it('completes as marked by the user', async () => {
    const { run, getStored } = setup({ metadata: { openchamber: { goal: activeGoal } } });
    await run('session.goal', { goalAction: 'complete' });
    expect(getStored().openchamber.goal).toMatchObject({ status: 'complete', statusReason: 'marked by user' });
  });

  it('refuses status changes without a goal', async () => {
    const { run, sessionService } = setup();
    await expectControlError(run('session.goal', { goalAction: 'pause' }), 404, /no goal/);
    await expectControlError(run('session.goal', { goalAction: 'resume' }), 404);
    await expectControlError(run('session.goal', { goalAction: 'complete' }), 404);
    expect(sessionService.setMetadata).not.toHaveBeenCalled();
  });

  it('clears an active goal: null patch, objective file deleted, turn stopped', async () => {
    const { run, client, sessionService, deleteObjective } = setup({ metadata: { openchamber: { goal: activeGoal } } });
    await expect(run('session.goal', { goalAction: 'clear' })).resolves.toMatchObject({ goal: null, cleared: true, interrupted: true });
    expect(sessionService.setMetadata).toHaveBeenCalledWith('ses_target', { patch: { openchamber: { goal: null } }, directory: DIRECTORY });
    expect(deleteObjective).toHaveBeenCalledWith('ses_target');
    expect(client.session.interrupt).toHaveBeenCalledTimes(1);
  });

  it('clears a paused goal without stopping anything', async () => {
    const { run, client } = setup({ metadata: { openchamber: { goal: { ...activeGoal, status: 'paused' } } } });
    await expect(run('session.goal', { goalAction: 'clear' })).resolves.toMatchObject({ cleared: true, interrupted: false });
    expect(client.session.interrupt).not.toHaveBeenCalled();
  });

  it('refuses to let the calling session settle its own goal, but lets it read or set one', async () => {
    const { actions, ctx, sessionService } = setup({ metadata: { openchamber: { goal: activeGoal } } });
    for (const goalAction of ['pause', 'complete', 'clear']) {
      await expectControlError(actions.execute('session.goal', { goalAction }, ctx), 409, /progress check or the user/);
    }
    expect(sessionService.setMetadata).not.toHaveBeenCalled();
    await expect(actions.execute('session.goal', { goalAction: 'get' }, ctx)).resolves.toMatchObject({ sessionId: 'ses_caller' });
    await expect(actions.execute('session.goal', { goalAction: 'set', objective: 'More' }, ctx)).resolves.toMatchObject({ created: false });
  });
});

describe('session.retry', () => {
  const userMessage = {
    id: 'msg_u2',
    type: 'user',
    time: { created: 20 },
    text: 'Do the thing',
    files: [
      { data: 'aGk=', mime: 'text/plain', source: { type: 'inline' }, name: 'a.txt' },
      { data: '', mime: 'image/png', source: { type: 'uri', uri: 'file:///x.png' } },
    ],
    agents: [{ name: 'explore' }],
    skills: [{ id: 'sk', name: 'Skill' }],
  };

  it('does not interrupt a prototype-named session that is not active (#2311)', async () => {
    const { run, client } = setup();
    client.message.list.mockResolvedValueOnce({ data: [userMessage] });
    const result = await run('session.retry', { sessionId: 'constructor' });
    expect(client.session.interrupt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sessionId: 'constructor', interrupted: false });
  });

  it('reverts to the last prompt and sends it again', async () => {
    const { run, client } = setup();
    client.message.list.mockResolvedValueOnce({ data: [{ id: 'msg_u1', type: 'user', time: { created: 10 }, text: 'old' }, userMessage] });
    const result = await run('session.retry');
    expect(client.message.list).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_target', order: 'desc', type: 'user' }));
    expect(client.session.interrupt).not.toHaveBeenCalled();
    expect(client.session.revert.stage).toHaveBeenCalledWith({ sessionID: 'ses_target', messageID: 'msg_u2' });
    expect(client.session.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_target',
      text: 'Do the thing',
      files: [
        { uri: 'data:text/plain;base64,aGk=', name: 'a.txt' },
        { uri: 'file:///x.png' },
      ],
      agents: [{ name: 'explore' }],
      skills: [{ id: 'sk' }],
    });
    expect(client.session.switchModel).not.toHaveBeenCalled();
    expect(result).toEqual({
      sessionId: 'ses_target',
      retriedMessageId: 'msg_u2',
      interrupted: false,
      promptDispatched: true,
      messageId: 'inbox_1',
      directory: DIRECTORY,
    });
    expect(client.session.revert.stage.mock.invocationCallOrder[0]).toBeLessThan(client.session.prompt.mock.invocationCallOrder[0]);
  });

  it('stops a running turn first', async () => {
    const { run, client } = setup();
    client.message.list.mockResolvedValueOnce({ data: [userMessage] });
    client.session.active.mockResolvedValueOnce({ ses_target: { type: 'running' } });
    await expect(run('session.retry')).resolves.toMatchObject({ interrupted: true });
    expect(client.session.interrupt.mock.invocationCallOrder[0]).toBeLessThan(client.session.revert.stage.mock.invocationCallOrder[0]);
  });

  it('retries a chosen user message', async () => {
    const { run, client } = setup();
    client.session.message.get.mockResolvedValueOnce({ ...userMessage, id: 'msg_u1', text: 'earlier' });
    await run('session.retry', { messageId: 'msg_u1' });
    expect(client.session.revert.stage).toHaveBeenCalledWith({ sessionID: 'ses_target', messageID: 'msg_u1' });
    expect(client.session.prompt).toHaveBeenCalledWith(expect.objectContaining({ text: 'earlier' }));
  });

  it('refuses a non-user or missing message', async () => {
    const { run, client } = setup();
    await expectControlError(run('session.retry', { messageId: 'msg_a' }), 400, /user message/);
    client.session.message.get.mockRejectedValueOnce(Object.assign(new Error('gone'), { _tag: 'MessageNotFoundError' }));
    await expectControlError(run('session.retry', { messageId: 'msg_x' }), 404, /not found/);
    expect(client.session.revert.stage).not.toHaveBeenCalled();
  });

  it('refuses a session without prompts', async () => {
    const { run, client } = setup();
    await expectControlError(run('session.retry'), 409, /no prompt/);
    expect(client.session.revert.stage).not.toHaveBeenCalled();
  });

  it('clears the staged revert when the prompt fails', async () => {
    const { run, client } = setup();
    client.message.list.mockResolvedValueOnce({ data: [userMessage] });
    client.session.prompt.mockRejectedValueOnce(new Error('rejected'));
    await expect(run('session.retry')).rejects.toThrow('rejected');
    expect(client.session.revert.clear).toHaveBeenCalledWith({ sessionID: 'ses_target' });
  });

  it('reports a prompt that queued nothing', async () => {
    const { run, client } = setup();
    client.message.list.mockResolvedValueOnce({ data: [userMessage] });
    client.session.prompt.mockResolvedValueOnce({});
    await expect(run('session.retry')).resolves.toMatchObject({ promptDispatched: false, promptError: expect.any(String) });
  });

  it('refuses the calling session', async () => {
    const { actions, ctx, client } = setup();
    await expectControlError(actions.execute('session.retry', {}, ctx), 400, /running in/);
    expect(client.message.list).not.toHaveBeenCalled();
  });
});

describe('session.pin', () => {
  it('pins a message, writing the whole list', async () => {
    const existing = { id: 'msg_old', createdAt: 1, role: 'user' };
    const { run, client, sessionService } = setup({ metadata: { openchamber: { context_obligatory_messages: [existing], other: 1 } } });
    const result = await run('session.pin', { messageId: 'msg_a' });
    expect(client.session.message.get).toHaveBeenCalledWith({ sessionID: 'ses_target', messageID: 'msg_a' });
    expect(sessionService.setMetadata).toHaveBeenCalledWith('ses_target', {
      directory: DIRECTORY,
      patch: { openchamber: { context_obligatory_messages: [existing, { id: 'msg_a', createdAt: 42, role: 'assistant' }] } },
    });
    expect(result).toMatchObject({ pinKind: 'message', pinned: true, pinnedMessages: ['msg_old', 'msg_a'] });
  });

  it('re-pinning does not duplicate', async () => {
    const { run, sessionService } = setup({ metadata: { openchamber: { context_obligatory_messages: [{ id: 'msg_a', createdAt: 42, role: 'assistant' }] } } });
    await run('session.pin', { messageId: 'msg_a' });
    expect(sessionService.setMetadata.mock.calls[0][1].patch.openchamber.context_obligatory_messages).toHaveLength(1);
  });

  it('unpins without reading the message', async () => {
    const { run, client, sessionService } = setup({ metadata: { openchamber: { context_obligatory_messages: [{ id: 'msg_a', createdAt: 42, role: 'user' }] } } });
    await expect(run('session.pin', { messageId: 'msg_a', pinned: false })).resolves.toMatchObject({ pinned: false, pinnedMessages: [] });
    expect(client.session.message.get).not.toHaveBeenCalled();
    expect(sessionService.setMetadata.mock.calls[0][1].patch.openchamber.context_obligatory_messages).toEqual([]);
  });

  it('validates message pins', async () => {
    const { run, client, sessionService } = setup();
    await expectControlError(run('session.pin', {}), 400, /messageId/);
    await expectControlError(run('session.pin', { messageId: 'm', pinned: 'yes' }), 400, /boolean/);
    await expectControlError(run('session.pin', { messageId: 'm', pinKind: 'file' }), 400, /pinKind/);
    client.session.message.get.mockResolvedValueOnce({ id: 'm', type: 'synthetic', time: { created: 1 } });
    await expectControlError(run('session.pin', { messageId: 'm' }), 400, /user and assistant/);
    client.session.message.get.mockRejectedValueOnce(Object.assign(new Error('gone'), { _tag: 'MessageNotFoundError' }));
    await expectControlError(run('session.pin', { messageId: 'm' }), 404);
    expect(sessionService.setMetadata).not.toHaveBeenCalled();
  });

  it('pins and unpins project notes and plans through session knowledge', async () => {
    const { run, sessionKnowledgeRuntime } = setup();
    await expect(run('session.pin', { pinKind: 'note', pinId: 'n1' })).resolves.toMatchObject({ pinKind: 'note', pinId: 'n1', pinned: true, pins: { notes: ['n1'] } });
    expect(sessionKnowledgeRuntime.setPin).toHaveBeenCalledWith('ses_target', DIRECTORY, 'note', 'n1', true);
    await run('session.pin', { pinKind: 'plan', pinId: 'p1', pinned: false });
    expect(sessionKnowledgeRuntime.setPin).toHaveBeenLastCalledWith('ses_target', DIRECTORY, 'plan', 'p1', false);
  });

  it('validates note and plan pins', async () => {
    const { run } = setup();
    await expectControlError(run('session.pin', { pinKind: 'note' }), 400, /pinId/);
    const bare = setup({ knowledge: false });
    await expectControlError(bare.run('session.pin', { pinKind: 'plan', pinId: 'p' }), 503);
  });
});

describe('session.abort', () => {
  it('interrupts another session', async () => {
    const { run, client } = setup();
    await expect(run('session.abort')).resolves.toEqual({ sessionId: 'ses_target', interrupted: true, directory: DIRECTORY });
    expect(client.session.interrupt).toHaveBeenCalledWith({ sessionID: 'ses_target' });
  });

  it('reports an idle session as not interrupted', async () => {
    const { run, client } = setup();
    client.session.interrupt.mockResolvedValueOnce({ interrupted: false });
    await expect(run('session.abort')).resolves.toMatchObject({ interrupted: false });
  });

  it('refuses the calling session, explicit or defaulted', async () => {
    const { actions, ctx, client } = setup();
    await expectControlError(actions.execute('session.abort', {}, ctx), 400, /running in/);
    await expectControlError(actions.execute('session.abort', { sessionId: 'ses_caller' }, ctx), 400);
    expect(client.session.interrupt).not.toHaveBeenCalled();
  });
});
