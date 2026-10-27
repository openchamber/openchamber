import { describe, expect, test } from 'bun:test';

import type { WorkflowRun } from './model';
import { createWorkflowRunsStore } from './store';

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'wf_one',
  parentSessionId: 'ses_parent',
  directory: '/repo',
  name: 'audit-routes',
  description: 'Audit every route',
  state: 'awaiting-approval',
  attempt: 0,
  createdAt: 1,
  currentPhase: null,
  phases: ['Audit'],
  agents: [],
  logs: [],
  ...overrides,
});

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('workflow runs store', () => {
  test('reads a session once and then follows events', async () => {
    const store = createWorkflowRunsStore(async () => [run()]);
    await store.getState().load('ses_parent');
    store.getState().apply(run({ state: 'running', attempt: 1 }));
    store.getState().apply(run({ id: 'wf_two', createdAt: 2 }));

    const held = store.getState().bySession.ses_parent;
    expect(held?.status).toBe('ready');
    expect(held?.runs.map((entry) => [entry.id, entry.state])).toEqual([['wf_one', 'running'], ['wf_two', 'awaiting-approval']]);
  });

  test('keeps a deleted run out, even from a read or an event that was on its way', async () => {
    const reply = deferred<WorkflowRun[]>();
    const store = createWorkflowRunsStore(() => reply.promise);
    store.getState().apply(run({ state: 'completed' }));
    const loading = store.getState().load('ses_parent');
    store.getState().remove('ses_parent', 'wf_one');
    store.getState().apply(run({ state: 'completed', attempt: 2 }));
    reply.resolve([run({ state: 'completed' })]);
    await loading;
    expect(store.getState().bySession.ses_parent?.runs).toEqual([]);
  });

  test("reads a directory's runs of every session into their sessions, keeping deleted ones out", async () => {
    const store = createWorkflowRunsStore(async () => [], async () => [
      run({ id: 'wf_a', parentSessionId: 'ses_a', state: 'completed' }),
      run({ id: 'wf_b', parentSessionId: 'ses_b', state: 'running' }),
      run({ id: 'wf_gone', parentSessionId: 'ses_b', state: 'completed' }),
    ]);
    store.getState().remove('ses_b', 'wf_gone');
    await store.getState().loadDirectory(['/repo']);
    const state = store.getState();
    expect(state.byDirectory['/repo']).toBe('ready');
    expect(state.bySession.ses_a?.runs.map((entry) => entry.id)).toEqual(['wf_a']);
    expect(state.bySession.ses_b?.runs.map((entry) => entry.id)).toEqual(['wf_b']);
  });

  test('keeps a run an event changed while a read was on its way', async () => {
    const reply = deferred<WorkflowRun[]>();
    const store = createWorkflowRunsStore(() => reply.promise);
    const loading = store.getState().load('ses_parent');
    store.getState().apply(run({ state: 'running' }));
    reply.resolve([run({ state: 'awaiting-approval' })]);
    await loading;

    expect(store.getState().bySession.ses_parent?.runs.map((entry) => entry.state)).toEqual(['running']);
  });

  test('a failed read keeps the runs already held', async () => {
    const store = createWorkflowRunsStore(async () => {
      throw new Error('offline');
    });
    store.getState().apply(run({ state: 'running' }));
    await store.getState().load('ses_parent');

    const held = store.getState().bySession.ses_parent;
    expect(held?.status).toBe('error');
    expect(held?.runs.map((entry) => entry.state)).toEqual(['running']);
  });

  test('only the newest read writes', async () => {
    const first = deferred<WorkflowRun[]>();
    const second = deferred<WorkflowRun[]>();
    const replies = [first, second];
    const store = createWorkflowRunsStore(() => replies.shift()!.promise);
    const older = store.getState().load('ses_parent');
    const newer = store.getState().load('ses_parent');
    second.resolve([run({ state: 'completed' })]);
    await newer;
    first.resolve([run({ state: 'awaiting-approval' })]);
    await older;

    expect(store.getState().bySession.ses_parent?.runs.map((entry) => entry.state)).toEqual(['completed']);
  });

  test('a read that was on its way when the runtime changed never lands', async () => {
    const stale = deferred<WorkflowRun[]>();
    const replies = [stale.promise, Promise.resolve([run({ id: 'wf_new' })])];
    const store = createWorkflowRunsStore(() => replies.shift()!);
    const old = store.getState().load('ses_parent');
    store.getState().reset();
    await store.getState().load('ses_parent');
    stale.resolve([run({ id: 'wf_old' })]);
    await old;

    expect(store.getState().bySession.ses_parent?.runs.map((entry) => entry.id)).toEqual(['wf_new']);
  });

  test('reads again the sessions a surface asked about, after a gap in events', async () => {
    let reads = 0;
    const store = createWorkflowRunsStore(async (sessionId) => {
      reads += 1;
      return [run({ parentSessionId: sessionId, state: reads > 1 ? 'completed' : 'running' })];
    });
    await store.getState().load('ses_parent');
    // A session known only from an event was never shown, so it is not read.
    store.getState().apply(run({ id: 'wf_other', parentSessionId: 'ses_other' }));
    store.getState().reloadLoaded();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reads).toBe(2);
    expect(store.getState().bySession.ses_parent?.runs.map((entry) => entry.state)).toEqual(['completed']);
  });
});
