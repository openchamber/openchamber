import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { lightenWorkflowRun, summarizeRun } from './runtime.js';
import { createWorkflowRunStore } from './store.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const run = (id = 'wf_abcdefgh') => ({
  version: 1, id, parentSessionId: 'ses_parent', directory: '/repo', name: 'test', description: '',
  phases: [], script: 'return 1', args: { value: 'original' }, state: 'awaiting-approval', attempt: 0,
  createdAt: 1, currentPhase: null, agents: [], logs: [],
});

const setup = async (rename = fs.rename) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-store-'));
  directories.push(dataDir);
  const store = createWorkflowRunStore({ fsPromises: { ...fs, rename }, path, dataDir });
  const reload = () => createWorkflowRunStore({ fsPromises: fs, path, dataDir });
  return { store, reload, file: (id) => path.join(dataDir, 'workflow-runs', `${id}.json`) };
};

describe('workflow run store durability', () => {
  it('rejects failed A, commits queued B in order, and never publishes a failed first write', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const writes = [];
    const failure = new Error('rename failed');
    const { store, reload } = await setup(async (source, target) => {
      const snapshot = JSON.parse(await fs.readFile(source, 'utf8'));
      writes.push(snapshot.id);
      if (snapshot.id === 'wf_aaaaaaaa') {
        await gate;
        throw failure;
      }
      await fs.rename(source, target);
    });
    const a = store.save(run('wf_aaaaaaaa'));
    const rejected = expect(a).rejects.toBe(failure);
    const b = store.save(run('wf_bbbbbbbb'));
    const pendingRuns = await store.list();
    release();
    await rejected;
    await b;
    expect(pendingRuns).toEqual([]);
    expect(writes).toEqual(['wf_aaaaaaaa', 'wf_bbbbbbbb']);
    expect(await store.get('wf_aaaaaaaa')).toBeNull();
    expect((await store.list()).map((item) => item.id)).toEqual(['wf_bbbbbbbb']);
    expect((await reload().list()).map((item) => item.id)).toEqual(['wf_bbbbbbbb']);
  });

  it('captures the call-time snapshot even before load and while queued, preserving working references', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { store, reload } = await setup(async (source, target) => {
      await gate;
      await fs.rename(source, target);
    });
    const original = run();
    const saving = store.save(original);
    original.args.value = 'mutated immediately';
    release();
    await saving;
    expect(await store.get(original.id)).toBe(original);
    expect((await store.list())[0]).toBe(original);
    expect((await reload().get(original.id)).args).toEqual({ value: 'original' });

    const working = await store.get(original.id);
    working.args.value = 'queued snapshot';
    const next = store.save(working);
    (await store.list())[0].args.value = 'later mutation';
    await next;
    expect((await reload().get(original.id)).args).toEqual({ value: 'queued snapshot' });
    expect((await store.get(original.id)).args).toEqual({ value: 'later mutation' });
  });

  it('keeps the last valid file and working identity when a replacement fails, then accepts a later save', async () => {
    let fail = false;
    const { store, reload, file } = await setup(async (source, target) => {
      if (fail) throw new Error('rename failed');
      await fs.rename(source, target);
    });
    const original = run();
    await store.save(original);
    const bytes = await fs.readFile(file(original.id), 'utf8');
    fail = true;
    const replacement = { ...original, args: { value: 'replacement' } };
    await expect(store.save(replacement)).rejects.toThrow('rename failed');
    expect(await store.get(original.id)).toBe(original);
    expect((await store.list())[0]).toBe(original);
    expect(await fs.readFile(file(original.id), 'utf8')).toBe(bytes);
    expect((await reload().get(original.id)).args).toEqual({ value: 'original' });
    original.args.value = 'unsaved working state';
    await expect(store.save(original)).rejects.toThrow('rename failed');
    expect((await store.get(original.id)).args.value).toBe('unsaved working state');
    expect((await reload().get(original.id)).args.value).toBe('original');
    fail = false;
    await store.save(original);
    expect((await reload().get(original.id)).args.value).toBe('unsaved working state');
  });
});

describe('workflow run store memory', () => {
  const longText = 'x'.repeat(5_000);
  const settledRun = (id, overrides = {}) => ({
    ...run(id),
    state: 'completed',
    script: longText,
    endedAt: 2,
    result: { answer: longText },
    logs: Array.from({ length: 30 }, (_, index) => ({ at: index, message: `log ${index}` })),
    agents: [
      { key: 'a', label: 'A', phase: null, prompt: longText, state: 'completed', result: longText },
      { key: 'b', label: 'B', phase: null, prompt: longText, state: 'completed', result: 'short' },
      { key: 'c', label: 'C', phase: null, prompt: longText, state: 'failed', error: 'boom' },
    ],
    ...overrides,
  });

  const setupLight = async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-store-'));
    directories.push(dataDir);
    const create = () => createWorkflowRunStore({ fsPromises: fs, path, dataDir, lighten: lightenWorkflowRun });
    return { store: create(), reload: create };
  };

  it('holds a settled run light, summarizes it the same, and reads the whole run on get', async () => {
    const { store, reload } = await setupLight();
    const full = settledRun('wf_settled1');
    await store.save(full);
    for (const current of [store, reload()]) {
      const [listed] = await current.list();
      expect(listed.script).toBe('');
      expect(listed.agents[0].prompt).toBe('');
      expect(summarizeRun(listed)).toEqual(summarizeRun(full));
      const read = await current.get('wf_settled1');
      expect(read.script).toBe(longText);
      expect(read.agents[0].prompt).toBe(longText);
      expect(read.result).toEqual({ answer: longText });
    }
  });

  it('keeps a running run and one with an undelivered report whole', async () => {
    const { store } = await setupLight();
    await store.save(settledRun('wf_running1', { state: 'running', endedAt: undefined }));
    await store.save(settledRun('wf_pending1', { report: { messageId: 'm', delivered: false, resume: false } }));
    for (const listed of await store.list()) expect(listed.script).toBe(longText);
  });

  it('every caller of a settled run gets the same working object, concurrent first reads included', async () => {
    const { store } = await setupLight();
    await store.save(settledRun('wf_shared01'));
    const [first, second] = await Promise.all([store.get('wf_shared01'), store.get('wf_shared01')]);
    expect(first).toBe(second);
    expect(await store.get('wf_shared01')).toBe(first);
    first.state = 'running';
    expect((await store.list()).find((item) => item.id === 'wf_shared01').state).toBe('running');
  });
});
