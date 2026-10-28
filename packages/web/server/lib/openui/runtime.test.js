import { expect, it, vi } from 'vitest';
import { createOpenUIRuntime } from './runtime.js';

const ui = 'root = Stack([])';
const call = { sessionId: 'ses_1', callId: 'call_1', directory: '/repo' };
const fixture = () => {
  const onWaitChange = vi.fn();
  const isEnabled = vi.fn(async () => true);
  const runtime = createOpenUIRuntime({ isEnabled, onWaitChange });
  const start = async (signal) => {
    const started = Promise.withResolvers();
    onWaitChange.mockImplementation((event) => { if (event.type === 'waiting') started.resolve(); });
    const pending = runtime.prompt({ ui }, { ...call, signal });
    pending.catch(() => {});
    await started.promise;
    const answer = (fields = {}) => runtime.answer({ ...call, summary: 'Done', ...fields });
    return { pending, answer };
  };
  return { runtime, isEnabled, onWaitChange, start };
};

it('answers by session and call ID without reading messages or requiring a digest', async () => {
  const { start, onWaitChange } = fixture();
  const { pending, answer } = await start();
  expect(() => answer({ callId: 'other' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  expect(() => answer({ sessionId: 'other' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  expect(answer({ summary: ' Done ', data: { choice: 1 } })).toEqual({ answered: true });
  await expect(pending).resolves.toEqual({ answer: { answered: true, summary: 'Done', data: { choice: 1 } } });
  expect(() => answer()).toThrow(expect.objectContaining({ statusCode: 404 }));
  expect(onWaitChange.mock.calls.map(([event]) => event.type)).toEqual(['waiting', 'settled']);
});

it('releases an aborted call and permits a new wait with the same ID', async () => {
  const { start, onWaitChange } = fixture();
  const controller = new AbortController();
  const first = await start(controller.signal);
  controller.abort();
  await expect(first.pending).rejects.toMatchObject({ statusCode: 499 });
  expect(() => first.answer()).toThrow(expect.objectContaining({ statusCode: 404 }));
  const next = await start();
  next.answer();
  await expect(next.pending).resolves.toMatchObject({ answer: { answered: true } });
  expect(onWaitChange.mock.calls.map(([event]) => event.type)).toEqual(['waiting', 'settled', 'waiting', 'settled']);
});

it('rejects duplicate and already aborted waits without replacing the pending call', async () => {
  const { runtime, start, onWaitChange } = fixture();
  const first = await start();
  await expect(runtime.prompt({ ui }, call)).rejects.toMatchObject({ statusCode: 409 });
  await expect(runtime.prompt({ ui }, { ...call, callId: 'aborted', signal: AbortSignal.abort() })).rejects.toMatchObject({ statusCode: 499 });
  expect(onWaitChange).toHaveBeenCalledTimes(1);
  first.answer();
  await first.pending;
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
  const pending = runtime.prompt({ ui }, call);
  isEnabled.mockResolvedValue(false);
  runtime.cancel();
  if (reenabled) isEnabled.mockResolvedValue(true);
  admission.resolve(true);
  await expect(pending).rejects.toMatchObject({ statusCode: 403 });
  expect(onWaitChange).not.toHaveBeenCalled();
  isEnabled.mockResolvedValue(true);
  const current = await start();
  current.answer();
  await expect(current.pending).resolves.toMatchObject({ answer: { answered: true } });
});

it('rejects invalid answers without consuming the wait', async () => {
  const { start } = fixture();
  const { pending, answer } = await start();
  const cyclic = {};
  cyclic.self = cyclic;
  for (const [fields, statusCode] of [
    [{ sessionId: '' }, 400], [{ callId: '' }, 400],
    [{ summary: '' }, 400], [{ summary: 's'.repeat(501) }, 400],
    [{ data: Number.NaN }, 400], [{ data: cyclic }, 400],
    [{ data: '你'.repeat(16_000) }, 413],
  ]) expect(() => answer(fields)).toThrow(expect.objectContaining({ statusCode }));
  answer({ data: '你'.repeat(15_998) });
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
