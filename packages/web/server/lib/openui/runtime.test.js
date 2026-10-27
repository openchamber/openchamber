import { expect, it, vi } from 'vitest';
import { createOpenUIRuntime } from './runtime.js';

const ui = 'root = Stack([])';
const call = { sessionId: 'ses_1', callId: 'call_1', directory: '/repo' };
const saved = { type: 'assistant', content: [{ type: 'tool', id: call.callId, name: 'prompt_openui', state: { input: { ui } } }] };
const fixture = () => {
  const onWaitChange = vi.fn();
  const list = vi.fn(async () => ({ data: [saved] }));
  const isEnabled = vi.fn(async () => true);
  const runtime = createOpenUIRuntime({ isEnabled, onWaitChange, getClient: async () => ({ message: { list } }) });
  const start = async (signal) => {
    const started = Promise.withResolvers();
    onWaitChange.mockImplementation((event) => { if (event.type === 'waiting') started.resolve(event); });
    const pending = runtime.prompt({ ui }, { ...call, signal });
    pending.catch(() => {});
    const event = await started.promise;
    const answer = (fields = {}) => runtime.answer({ ...call, sourceRevision: event.sourceRevision, summary: 'Done', ...fields });
    return { pending, answer };
  };
  return { runtime, list, isEnabled, onWaitChange, start };
};

it('finds saved source newest-first and follows opaque cursors without order', async () => {
  const { list, start, onWaitChange } = fixture();
  list.mockResolvedValueOnce({ data: [{ type: 'user', text: 'Newer' }], cursor: { next: 'older' } });
  const controller = new AbortController();
  const { pending, answer } = await start(controller.signal);
  expect(() => answer({ callId: 'other' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  expect(() => answer({ sessionId: 'other' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  await expect(answer({ summary: ' Done ' })).resolves.toEqual({ answered: true });
  await expect(pending).resolves.toMatchObject({ answer: { summary: 'Done', data: null } });
  expect(() => answer()).toThrow(expect.objectContaining({ statusCode: 404 }));
  expect(onWaitChange.mock.calls.map(([event]) => event.type)).toEqual(['waiting', 'settled']);
  expect(list.mock.calls).toEqual([
    [{ sessionID: 'ses_1', limit: 100, order: 'desc' }, { signal: controller.signal }],
    [{ sessionID: 'ses_1', limit: 100, cursor: 'older' }, { signal: controller.signal }],
  ]);
});

it.each(['network', 'malformed', 'cursor-loop'])('keeps a wait available after a %s source read failure', async (failure) => {
  const { list, start, onWaitChange } = fixture();
  if (failure === 'network') list.mockRejectedValueOnce(new Error('offline'));
  if (failure === 'malformed') list.mockResolvedValueOnce({ data: null });
  if (failure === 'cursor-loop') {
    const page = { data: [{ type: 'user', text: 'No tool' }], cursor: { next: 'same' } };
    list.mockResolvedValueOnce(page).mockResolvedValueOnce(page);
  }
  const { pending, answer } = await start();
  await expect(answer()).rejects.toMatchObject({ statusCode: 503 });
  expect(onWaitChange).toHaveBeenCalledTimes(1);
  await expect(answer()).resolves.toEqual({ answered: true });
  await expect(pending).resolves.toMatchObject({ answer: { answered: true } });
});

it.each(['removed', 'replaced'])('retires the wait when saved source is %s', async (reason) => {
  const { list, start, onWaitChange } = fixture();
  list.mockResolvedValue({ data: reason === 'removed' ? [] : [{ ...saved, content: [{ ...saved.content[0], state: { input: { ui: 'root = Stack([TextContent("Changed")])' } } }] }] });
  const { pending, answer } = await start();
  await expect(answer()).rejects.toMatchObject({ statusCode: 409 });
  await expect(pending).rejects.toMatchObject({ statusCode: 409 });
  expect(onWaitChange.mock.calls.map(([event]) => event.type)).toEqual(['waiting', 'settled']);
});

it('aborts an in-flight source read when the prompt request is cancelled', async () => {
  const { list, start, onWaitChange } = fixture();
  const reading = Promise.withResolvers();
  list.mockImplementationOnce((_input, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    reading.resolve();
  }));
  const controller = new AbortController();
  const { pending, answer } = await start(controller.signal);
  const submitted = answer();
  await reading.promise;
  controller.abort();
  await expect(submitted).rejects.toMatchObject({ statusCode: 503 });
  await expect(pending).rejects.toMatchObject({ statusCode: 499 });
  expect(() => answer()).toThrow(expect.objectContaining({ statusCode: 404 }));
  expect(onWaitChange.mock.calls.map(([event]) => event.type)).toEqual(['waiting', 'settled']);
});

it.each(['unchanged', 'replaced'])('keeps a new wait after a cancelled source read returns %s source', async (result) => {
  const { list, start, onWaitChange } = fixture();
  const reading = Promise.withResolvers();
  const late = Promise.withResolvers();
  list.mockImplementationOnce(() => { reading.resolve(); return late.promise; });
  const controller = new AbortController();
  const old = await start(controller.signal);
  const submitted = old.answer();
  await reading.promise;
  controller.abort();
  await expect(old.pending).rejects.toMatchObject({ statusCode: 499 });
  const current = await start();
  const changed = { ...saved, content: [{ ...saved.content[0], state: { input: { ui: 'root = Stack([TextContent("Changed")])' } } }] };
  late.resolve({ data: [result === 'unchanged' ? saved : changed] });
  await expect(submitted).rejects.toMatchObject({ statusCode: result === 'unchanged' ? 404 : 409 });
  expect(onWaitChange.mock.calls.map(([event]) => event.type)).toEqual(['waiting', 'settled', 'waiting']);
  await expect(current.answer()).resolves.toEqual({ answered: true });
  await expect(current.pending).resolves.toMatchObject({ answer: { answered: true } });
});

it('accepts only one of two answers whose source reads overlap', async () => {
  const { list, start, onWaitChange } = fixture();
  const reading = Promise.withResolvers();
  const late = Promise.withResolvers();
  list.mockImplementationOnce(() => { reading.resolve(); return late.promise; });
  const { pending, answer } = await start();
  const first = answer();
  await reading.promise;
  await expect(answer()).resolves.toEqual({ answered: true });
  late.resolve({ data: [saved] });
  await expect(first).rejects.toMatchObject({ statusCode: 404 });
  await expect(pending).resolves.toMatchObject({ answer: { answered: true } });
  expect(onWaitChange.mock.calls.map(([event]) => event.type)).toEqual(['waiting', 'settled']);
});

it('refuses a feature disabled during the source read', async () => {
  const { list, start, isEnabled } = fixture();
  list.mockImplementationOnce(async () => { isEnabled.mockResolvedValue(false); return { data: [saved] }; });
  const { pending, answer } = await start();
  await expect(answer()).rejects.toMatchObject({ statusCode: 403 });
  await expect(pending).rejects.toMatchObject({ statusCode: 403 });
});

it('cancels every OpenUI wait', async () => {
  const { runtime, start, onWaitChange } = fixture();
  const { pending } = await start();
  const second = runtime.prompt({ ui }, { ...call, callId: 'call_2' });
  second.catch(() => {});
  await vi.waitFor(() => expect(onWaitChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'waiting', callId: 'call_2' })));
  runtime.cancel();
  await expect(pending).rejects.toMatchObject({ statusCode: 403 });
  await expect(second).rejects.toMatchObject({ statusCode: 403 });
});

it.each([false, true])('revokes pending admission even when re-enabled is %s', async (reenabled) => {
  const { runtime, isEnabled, onWaitChange, start } = fixture();
  const admission = Promise.withResolvers();
  isEnabled.mockReturnValueOnce(admission.promise);
  const observed = Promise.withResolvers();
  onWaitChange.mockImplementation((event) => { if (event.type === 'waiting') observed.resolve('waiting'); });
  const pending = runtime.prompt({ ui }, call);
  pending.then(() => observed.resolve('answered'), (error) => observed.resolve(error.statusCode));
  isEnabled.mockResolvedValue(false);
  runtime.cancel();
  if (reenabled) isEnabled.mockResolvedValue(true);
  admission.resolve(true);
  try {
    expect(await observed.promise).toBe(403);
    expect(onWaitChange).not.toHaveBeenCalled();
    isEnabled.mockResolvedValue(true);
    const current = await start();
    await current.answer();
    await expect(current.pending).resolves.toMatchObject({ answer: { answered: true } });
  } finally {
    runtime.cancel();
    await pending.catch(() => {});
  }
});

it('rejects stale revisions and invalid answers without consuming the wait', async () => {
  const { start, list } = fixture();
  const { pending, answer } = await start();
  const cyclic = {};
  cyclic.self = cyclic;
  for (const [fields, statusCode] of [
    [{ sourceRevision: 'stale' }, 409], [{ sourceRevision: '' }, 400],
    [{ sessionId: '' }, 400], [{ callId: '' }, 400],
    [{ summary: '' }, 400], [{ summary: 's'.repeat(501) }, 400],
    [{ data: Number.NaN }, 400], [{ data: cyclic }, 400],
    [{ data: '你'.repeat(16_000) }, 413],
  ]) expect(() => answer(fields)).toThrow(expect.objectContaining({ statusCode }));
  expect(list).not.toHaveBeenCalled();
  await answer({ data: '你'.repeat(15_998) });
  await expect(pending).resolves.toMatchObject({ answer: { answered: true } });
});

it('refuses empty, oversized or unaddressable prompts before announcing a wait', async () => {
  const { runtime, onWaitChange, isEnabled } = fixture();
  for (const [input, context] of [
    [{}, call], [{ ui: '   ' }, call], [{ ui: 'x'.repeat(200_001) }, call],
    [{ ui }, { ...call, callId: '' }], [{ ui }, { ...call, sessionId: '' }],
  ]) await expect(runtime.prompt(input, context)).rejects.toMatchObject({ statusCode: 400 });
  isEnabled.mockResolvedValue(false);
  await expect(runtime.prompt({ ui }, call)).rejects.toMatchObject({ statusCode: 403 });
  expect(onWaitChange).not.toHaveBeenCalled();
});
