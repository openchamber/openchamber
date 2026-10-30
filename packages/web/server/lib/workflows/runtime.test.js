import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WorkflowAgentStopped } from './agent-session.js';
import { createWorkflowRuntime } from './runtime.js';
import { createWorkflowRunStore } from './store.js';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const waitFor = async (check, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * Agent sessions without OpenCode: `answer(prompt, attempt)` decides each
 * reply. A prompt listed in `hang` runs until the run stops it.
 */
const fakeAgentSessions = ({ answer = (prompt) => `done: ${prompt}`, hang = [], duringTurn = async () => {} } = {}) => {
  let nextSession = 0;
  let running = 0;
  const fake = {
    started: [],
    allowed: [],
    followUps: [],
    interrupted: [],
    maxRunning: 0,
    reports: [],
    start: async ({ text, allowTools, signal, onSession }) => {
      nextSession += 1;
      const sessionId = `ses_agent${nextSession}`;
      fake.started.push(text);
      fake.allowed.push(allowTools);
      onSession(sessionId);
      running += 1;
      fake.maxRunning = Math.max(fake.maxRunning, running);
      try {
        await duringTurn(sessionId, text);
        if (hang.some((prompt) => text.startsWith(prompt))) {
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new WorkflowAgentStopped()), { once: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        const reply = answer(text, fake.started.filter((prompt) => prompt === text).length);
        return { sessionId, outcome: reply === null ? { state: 'error', text: '', errorMessage: 'agent failed' } : { state: 'completed', text: reply, errorMessage: '' } };
      } finally {
        running -= 1;
      }
    },
    followUp: async ({ text }) => {
      fake.followUps.push(text);
      return { state: 'completed', text: '{"files":["a.ts"]}', errorMessage: '' };
    },
    interrupt: async (_, sessionId) => {
      fake.interrupted.push(sessionId);
    },
    createSession: async ({ title }) => `ses_new_${title}`,
    readUsage: async ({ sessionId }) => ({
      model: 'openai/gpt-6-luna',
      usage: { cost: 0.01, input: 100, output: sessionId.length, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  };
  return fake;
};

const setup = async (agentSessions, options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-workflows-'));
  directories.push(dataDir);
  const store = createWorkflowRunStore({ fsPromises: fs, path, dataDir });
  const events = [];
  const runtime = createWorkflowRuntime({
    store,
    agentSessions,
    postSynthetic: async (sessionId, body) => {
      agentSessions.reports.push({ sessionId, body });
    },
    broadcast: (event) => events.push(event),
    fsPromises: fs,
    path,
    sleep: async () => {},
    ...options,
  });
  const scope = { sessionId: 'ses_parent', directory: dataDir };
  const act = (action, input = {}) => runtime.executeAction(action, input, scope);
  const finished = (runId) => waitFor(async () => {
    const status = await act('workflow.status', { runId });
    return ['completed', 'failed', 'stopped', 'declined'].includes(status.state) && agentSessions.reports.some((report) => report.body.metadata.runId === runId) ? status : null;
  });
  return { runtime, store, events, act, finished, dataDir };
};

const script = (body, phases = "['Work']") => `export const meta = { name: 'test-flow', description: 'A test', phases: ${phases} }\n${body}`;

describe('workflow runtime', () => {
  it('waits for approval, runs the agents and reports into the session', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, finished, events } = await setup(agents);
    const proposed = await act('workflow.run', { script: script("phase('Work')\nreturn pipeline(args.items, (item) => agent('check ' + item))"), args: { items: ['a', 'b'] } });
    expect(proposed).toMatchObject({ state: 'awaiting-approval', name: 'test-flow', phases: ['Work'] });
    expect(agents.started).toEqual([]);

    await runtime.approve({ runId: proposed.runId });
    const status = await finished(proposed.runId);

    expect(status.state).toBe('completed');
    expect(status.agents.map((agent) => [agent.label, agent.phase, agent.state])).toEqual([['check a', 'Work', 'completed'], ['check b', 'Work', 'completed']]);
    const [report] = agents.reports;
    expect(report.sessionId).toBe('ses_parent');
    expect(report.body).toMatchObject({ resume: true, delivery: 'steer', metadata: { source: 'openchamber-workflow', runId: proposed.runId, state: 'completed' } });
    expect(report.body.text).toContain('done: check a');
    expect(events.some((event) => event.type === 'openchamber:workflow-run' && event.properties.run.state === 'completed')).toBe(true);
    expect(await act('workflow.result', { runId: proposed.runId, agent: status.agents[1].sessionId })).toMatchObject({ agent: { result: 'done: check b' } });
    // The panel's numbers and its detail reads.
    expect(status.agents[0]).toMatchObject({ model: 'openai/gpt-6-luna', usage: { cost: 0.01, input: 100 } });
    expect(await runtime.detail({ runId: proposed.runId })).toMatchObject({ script: expect.stringContaining('pipeline(args.items'), args: { items: ['a', 'b'] }, result: ['done: check a', 'done: check b'] });
    expect(await runtime.agentDetail({ runId: proposed.runId, key: status.agents[1].key })).toMatchObject({ prompt: 'check b', result: 'done: check b' });
  });

  it('keeps at most the concurrency limit of agents working', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, finished } = await setup(agents, { maxConcurrentAgents: 2 });
    const { runId } = await act('workflow.run', { script: script("return parallel([1, 2, 3, 4, 5].map((n) => () => agent('n' + n)))") });
    await runtime.approve({ runId });
    await finished(runId);
    expect(agents.started).toHaveLength(5);
    expect(agents.maxRunning).toBe(2);
  });

  it('asks again in the same session until the answer matches the schema', async () => {
    const agents = fakeAgentSessions({ answer: () => 'not json' });
    const { runtime, act, finished } = await setup(agents);
    const schema = "{ type: 'object', required: ['files'], properties: { files: { type: 'array' } } }";
    const { runId } = await act('workflow.run', { script: script(`return agent('list files', { schema: ${schema} })`) });
    await runtime.approve({ runId });
    const status = await finished(runId);
    expect(agents.started[0]).toContain('openchamber_workflow_answer');
    expect(agents.allowed[0]).toEqual(['openchamber_workflow_answer']);
    expect(agents.followUps).toEqual(['No accepted answer yet: the answer is not JSON. Hand it over with the openchamber_workflow_answer tool, or end your turn with only the JSON value.']);
    expect(await act('workflow.result', { runId })).toMatchObject({ result: { files: ['a.ts'] } });
    expect(status.state).toBe('completed');
  });

  it('takes the answer the tool accepted over the final text, and refuses one that does not match', async () => {
    let runtimeRef = null;
    const replies = [];
    const agents = fakeAgentSessions({
      answer: () => 'Done, see the tool call.',
      duringTurn: async (sessionId) => {
        const submit = (value) => runtimeRef.executeAction('workflow.answer', { answer: value }, { sessionId, directory: '/repo' }).then(
          (data) => replies.push(data),
          (error) => replies.push(error.message),
        );
        await submit('{"files":"a.ts"}');
        await submit('{"files":["b.ts"]}');
      },
    });
    const { runtime, act, finished } = await setup(agents);
    runtimeRef = runtime;
    const schema = "{ type: 'object', required: ['files'], properties: { files: { type: 'array' } } }";
    const { runId } = await act('workflow.run', { script: script(`return agent('list files', { schema: ${schema} })`) });
    await runtime.approve({ runId });
    expect((await finished(runId)).state).toBe('completed');
    expect(replies[0]).toContain('does not match the schema');
    expect(replies[1]).toMatchObject({ accepted: true });
    expect(agents.followUps).toEqual([]);
    expect(await act('workflow.result', { runId })).toMatchObject({ result: { files: ['b.ts'] } });
  });

  it('keeps an accepted answer when the turn then ends in an error, and takes "42" as a string where a string is wanted', async () => {
    let runtimeRef = null;
    const replies = [];
    const agents = fakeAgentSessions({
      answer: () => null,
      duringTurn: async (sessionId) => {
        replies.push(await runtimeRef.executeAction('workflow.answer', { answer: '42' }, { sessionId, directory: '/repo' }));
      },
    });
    const { runtime, act, finished } = await setup(agents);
    runtimeRef = runtime;
    const { runId } = await act('workflow.run', { script: script("return agent('pick a number', { schema: { type: 'string' } })") });
    await runtime.approve({ runId });
    expect((await finished(runId)).state).toBe('completed');
    expect(replies[0]).toMatchObject({ accepted: true });
    expect(await act('workflow.result', { runId })).toMatchObject({ result: '42' });
  });

  it('counts an agent against the limit only once it starts, and moves the run to the phase its agent names', async () => {
    const agents = fakeAgentSessions({ hang: ['slow'] });
    const { runtime, act, finished, store } = await setup(agents, { maxConcurrentAgents: 1 });
    const body = "return parallel([() => agent('slow', { phase: 'Verify' }), () => agent('b'), () => agent('c')])";
    const { runId } = await act('workflow.run', { script: script(body) });
    await runtime.approve({ runId });
    await waitFor(async () => (await act('workflow.status', { runId })).agents.some((agent) => agent.state === 'running'));
    const running = await act('workflow.status', { runId });
    expect(running.currentPhase).toBe('Verify');
    expect(running.phases).toEqual(['Work', 'Verify']);

    await runtime.stop({ runId });
    await finished(runId);
    // b and c were still waiting for a slot.
    expect((await store.get(runId)).agentsStarted).toBe(1);
  });

  it('deletes a finished run and announces it, and refuses one that is still waiting', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, finished, store, events } = await setup(agents);
    const waiting = await act('workflow.run', { script: script("return agent('x')") });
    await expect(runtime.remove({ runId: waiting.runId })).rejects.toThrow('Stop or decline');

    const { runId } = await act('workflow.run', { script: script("return agent('y')") });
    await runtime.approve({ runId });
    await finished(runId);
    await expect(runtime.remove({ runId })).resolves.toEqual({ runId, removed: true });
    expect(await store.get(runId)).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'openchamber:workflow-run-removed', properties: { runId, parentSessionId: 'ses_parent' } });
    expect((await runtime.list({ sessionId: 'ses_parent' })).map((run) => run.id)).toEqual([waiting.runId]);
  });

  it('takes an answer as a JSON object, and as { value } for a schema that is not an object', async () => {
    let runtimeRef = null;
    const agents = fakeAgentSessions({
      answer: () => 'done',
      duringTurn: async (sessionId, text) => {
        const answer = text.includes('pick') ? { value: 'blue' } : { files: ['a.ts'] };
        await runtimeRef.executeAction('workflow.answer', { answer }, { sessionId, directory: '/repo' });
      },
    });
    const { runtime, act, finished } = await setup(agents);
    runtimeRef = runtime;
    const body = "return parallel([() => agent('pick a color', { schema: { type: 'string' } }), () => agent('list files', { schema: { type: 'object', required: ['files'] } })])";
    const { runId } = await act('workflow.run', { script: script(body) });
    await runtime.approve({ runId });
    expect((await finished(runId)).state).toBe('completed');
    expect(agents.started[0]).toContain('pass { "value": <your value> }');
    expect(await act('workflow.result', { runId })).toMatchObject({ result: ['blue', { files: ['a.ts'] }] });
  });

  it('keeps a run deleted while its report was still on its way', async () => {
    const agents = fakeAgentSessions();
    let release = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    let reportSent = false;
    const { runtime, act, store } = await setup(agents, { postSynthetic: () => { reportSent = true; return held; } });
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await runtime.approve({ runId });
    // The run reads as completed while it is still settling; the report goes out after.
    await waitFor(() => reportSent);

    await runtime.remove({ runId });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.flush();
    expect(await store.get(runId)).toBeNull();
  });

  it('deletes a run in the moment its end is saved but its execution is still winding down', async () => {
    // The end state becomes observable before the execution leaves the
    // runtime's active set: that happens only once the end save resolves.
    // A delete in that overlap used to be refused as if the run were still
    // going. The gated save holds the run in exactly that moment.
    const agents = fakeAgentSessions();
    const { runtime, act, store } = await setup(agents);
    const originalSave = store.save;
    let releaseSave = () => {};
    const gate = new Promise((resolve) => { releaseSave = resolve; });
    store.save = (run) => {
      const saved = originalSave(run);
      return run.state === 'completed' ? gate.then(() => saved) : saved;
    };
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await runtime.approve({ runId });
    await waitFor(async () => (await act('workflow.status', { runId })).state === 'completed');

    await runtime.remove({ runId });
    releaseSave();
    await store.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.get(runId)).toBeNull();
    // The report never went out and must not wake the session afterwards.
    expect(agents.reports.some((report) => report.body.metadata.runId === runId)).toBe(false);
  });

  it('refuses to delete a run that is still working', async () => {
    const agents = fakeAgentSessions({ hang: ['slow'] });
    const { runtime, act, finished } = await setup(agents);
    const { runId } = await act('workflow.run', { script: script("return agent('slow 1')") });
    await runtime.approve({ runId });
    await waitFor(async () => (await act('workflow.status', { runId })).agents.some((agent) => agent.state === 'running' && agent.sessionId));

    await expect(runtime.remove({ runId })).rejects.toThrow('Stop or decline the run before deleting it');
    await runtime.stop({ runId });
    await finished(runId);
  });

  it('takes an answer accepted during a correction even when that turn ends in an error', async () => {
    let runtimeRef = null;
    const agents = fakeAgentSessions({ answer: () => 'not json' });
    agents.followUp = async ({ sessionId }) => {
      await runtimeRef.executeAction('workflow.answer', { answer: { files: ['a.ts'] } }, { sessionId, directory: '/repo' });
      return { state: 'error', text: '', errorMessage: 'provider dropped the stream' };
    };
    const { runtime, act, finished } = await setup(agents);
    runtimeRef = runtime;
    const { runId } = await act('workflow.run', { script: script("return agent('list files', { schema: { type: 'object', required: ['files'] } })") });
    await runtime.approve({ runId });
    expect((await finished(runId)).state).toBe('completed');
    expect(await act('workflow.result', { runId })).toMatchObject({ result: { files: ['a.ts'] } });
  });

  it("runs a saved workflow at once in the given session, or in a new one, and lists a directory's runs", async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, dataDir } = await setup(agents);
    await act('workflow.save', { script: script("return agent('x')") });
    expect(await runtime.listSaved({ directory: dataDir })).toEqual({ workflows: [{ name: 'test-flow', description: 'A test' }] });

    const here = await runtime.startSaved({ directory: dataDir, sessionId: 'ses_parent', name: 'test-flow' });
    const fresh = await runtime.startSaved({ directory: dataDir, sessionId: null, name: 'test-flow' });
    expect(here.sessionId).toBe('ses_parent');
    expect(fresh.sessionId).toBe('ses_new_test-flow');
    await waitFor(() => agents.reports.length === 2);
    const runs = await runtime.listByDirectory({ directories: [dataDir, '/elsewhere'] });
    expect(runs.map((run) => [run.parentSessionId, run.state]).sort()).toEqual([['ses_new_test-flow', 'completed'], ['ses_parent', 'completed']]);
    // Started by the user's click, yet the session's own run: its report wakes it.
    expect(agents.reports.every((report) => report.body.resume === true)).toBe(true);
  });

  it('refuses the answer tool to a session that is not a workflow agent asked for one', async () => {
    const agents = fakeAgentSessions();
    const { runtime } = await setup(agents);
    await expect(runtime.executeAction('workflow.answer', { answer: '{}' }, { sessionId: 'ses_other', directory: '/repo' }))
      .rejects.toThrow('only for a workflow agent');
  });

  it('resumes a failed run and reuses the agents that completed', async () => {
    const agents = fakeAgentSessions({ answer: (prompt, attempt) => (prompt === 'two' && attempt === 1 ? null : `done: ${prompt}`) });
    const { runtime, act, finished } = await setup(agents);
    const body = "const one = await agent('one')\nconst two = await agent('two')\nif (two === null) throw new Error('two failed')\nreturn [one, two]";
    const { runId } = await act('workflow.run', { script: script(body) });
    await runtime.approve({ runId });
    expect((await finished(runId)).state).toBe('failed');
    expect(agents.reports[0].body.text).toContain('two failed');

    await act('workflow.resume', { runId });
    await waitFor(() => agents.reports.length === 2);
    const status = await act('workflow.status', { runId });
    expect(status.state).toBe('completed');
    expect(agents.started).toEqual(['one', 'two', 'two']);
    expect(status.agents.map((agent) => [agent.label, Boolean(agent.replayed)])).toEqual([['one', true], ['two', false]]);
  });

  it('counts the agent limit across attempts, not per attempt', async () => {
    const agents = fakeAgentSessions({ answer: () => null });
    const { runtime, act, finished } = await setup(agents, { maxAgentsPerRun: 3 });
    const body = "const answers = await parallel([() => agent('a'), () => agent('b')])\nif (answers.includes(null)) throw new Error('an agent failed')\nreturn answers";
    const { runId } = await act('workflow.run', { script: script(body) });
    await runtime.approve({ runId });
    expect((await finished(runId)).state).toBe('failed');

    await act('workflow.resume', { runId });
    await waitFor(() => agents.reports.length === 2);
    // Two in the first attempt, one more in the second, then the limit refuses.
    expect(agents.started).toHaveLength(3);
    expect((await act('workflow.status', { runId })).logs.some((line) => line.message.includes('across its attempts'))).toBe(true);
  });

  it('stops a run: running agents are interrupted and the report does not wake the session', async () => {
    const agents = fakeAgentSessions({ hang: ['slow'] });
    const { runtime, act, finished } = await setup(agents);
    const { runId } = await act('workflow.run', { script: script("return parallel([() => agent('slow 1'), () => agent('slow 2')])") });
    await runtime.approve({ runId });
    // Working means in a session: an agent is saved as running just before its session exists.
    await waitFor(async () => (await act('workflow.status', { runId })).agents.filter((agent) => agent.state === 'running' && agent.sessionId).length === 2);

    await runtime.stop({ runId });
    const status = await finished(runId);

    expect(status.state).toBe('stopped');
    expect(status.agents.map((agent) => agent.state)).toEqual(['stopped', 'stopped']);
    expect(agents.interrupted.sort()).toEqual(['ses_agent1', 'ses_agent2']);
    expect(agents.reports[0].body.resume).toBe(false);
  });

  it('honours a stop that arrives right after the approval', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, finished } = await setup(agents);
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await runtime.approve({ runId });
    await runtime.stop({ runId });
    expect((await finished(runId)).state).toBe('stopped');
  });

  it('resumes only a failed or stopped run', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, finished } = await setup(agents);
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await runtime.approve({ runId });
    await finished(runId);
    await expect(act('workflow.resume', { runId })).rejects.toThrow(/only a failed or stopped run resumes/);
  });

  it('keeps answers an attempt did not reach for the next attempt', async () => {
    // Attempt 1: A fails, B and C complete, the script then fails on A.
    // Attempt 2: A answers "stop" and the script fails before asking B or C,
    // whose answers must still be there for the attempt after it.
    const agents = fakeAgentSessions({ answer: (prompt, attempt) => (prompt === 'A' ? (attempt === 1 ? null : 'stop') : `done: ${prompt}`) });
    const { runtime, act } = await setup(agents);
    const body = "const a = await agent('A')\nif (a === 'stop') throw new Error('early')\nconst b = await agent('B')\nconst c = await agent('C')\nif (a === null) throw new Error('A failed')\nreturn [a, b, c]";
    const { runId } = await act('workflow.run', { script: script(body) });
    await runtime.approve({ runId });
    await waitFor(() => agents.reports.length === 1);
    await act('workflow.resume', { runId });
    await waitFor(() => agents.reports.length === 2);

    const status = await act('workflow.status', { runId });
    expect(status).toMatchObject({ state: 'failed', error: 'early' });
    expect(status.agents.filter((agent) => agent.state === 'completed').map((agent) => agent.label).sort()).toEqual(['A', 'B', 'C']);
  });

  it('records a decline without waking the session', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act } = await setup(agents);
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await runtime.decline({ runId });
    expect(agents.started).toEqual([]);
    expect(agents.reports[0].body).toMatchObject({ resume: false, metadata: { state: 'declined' } });
    await expect(runtime.approve({ runId })).rejects.toThrow(/declined, not waiting/);
  });

  it('refuses a bad script before anything runs, and another session reading a run', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act } = await setup(agents);
    await expect(act('workflow.run', { script: 'return 1' })).rejects.toThrow(/must start with export const meta/);
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await expect(runtime.executeAction('workflow.status', { runId }, { sessionId: 'ses_other', directory: '/tmp' })).rejects.toThrow(/belongs to another session/);
  });

  it('saves a workflow and runs it by name', async () => {
    const agents = fakeAgentSessions();
    const { act, dataDir } = await setup(agents);
    const saved = await act('workflow.save', { script: script("return agent('x')") });
    expect(saved.path).toBe(path.join(dataDir, '.openchamber', 'workflows', 'test-flow.js'));
    await expect(act('workflow.save', { script: script("return agent('x')") })).rejects.toThrow(/exists/);
    expect(await act('workflow.list')).toMatchObject({ workflows: [{ name: 'test-flow', description: 'A test' }] });
    expect(await act('workflow.run', { name: 'test-flow' })).toMatchObject({ state: 'awaiting-approval', name: 'test-flow' });
  });

  it('leaves a run alone when the server running it is still alive', async () => {
    const agents = fakeAgentSessions({ hang: ['slow'] });
    const first = await setup(agents);
    const { runId } = await first.act('workflow.run', { script: script("return agent('slow')") });
    await first.runtime.approve({ runId });
    await waitFor(async () => (await first.act('workflow.status', { runId })).agents.length === 1);
    await first.store.flush();

    // A second OpenChamber over the same data directory, while the first still runs it.
    const store = createWorkflowRunStore({ fsPromises: fs, path, dataDir: first.dataDir });
    const second = createWorkflowRuntime({ store, agentSessions: agents, postSynthetic: async () => {}, fsPromises: fs, path, sleep: async () => {}, pid: process.pid + 1, isProcessAlive: () => true });
    await second.start();
    expect(await second.executeAction('workflow.status', { runId }, { sessionId: 'ses_parent', directory: first.dataDir })).toMatchObject({ state: 'running' });

    first.runtime.shutdown();
    await waitFor(async () => (await first.act('workflow.status', { runId })).state !== 'running');
    await first.store.flush();
  });

  it('marks a run that was going when the server stopped, and reports it once OpenCode answers', async () => {
    const agents = fakeAgentSessions({ hang: ['slow'] });
    const first = await setup(agents);
    const { runId } = await first.act('workflow.run', { script: script("return agent('slow')") });
    await first.runtime.approve({ runId });
    await waitFor(async () => (await first.act('workflow.status', { runId })).agents.length === 1);
    await first.store.flush();

    // A second runtime over the same directory: the first one's worker is gone.
    const store = createWorkflowRunStore({ fsPromises: fs, path, dataDir: first.dataDir });
    const restarted = createWorkflowRuntime({ store, agentSessions: agents, postSynthetic: async (sessionId, body) => agents.reports.push({ sessionId, body }), fsPromises: fs, path, sleep: async () => {} });
    await restarted.start();
    const status = await restarted.executeAction('workflow.status', { runId }, { sessionId: 'ses_parent', directory: first.dataDir });
    expect(status).toMatchObject({ state: 'stopped', error: 'OpenChamber restarted while the workflow ran.' });
    await restarted.deliverPending();
    expect(agents.reports.at(-1).body.metadata).toMatchObject({ runId, state: 'stopped' });

    // Let the first runtime wind down before its directory goes.
    first.runtime.shutdown();
    await waitFor(() => agents.reports.filter((report) => report.body.metadata.runId === runId).length === 2);
    await first.store.flush();
  });
});
