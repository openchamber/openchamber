import { describe, expect, it, vi } from 'vitest';

import { createFusionRuntime } from './fusion.js';

const createRunner = (overrides = {}) => {
  const runner = {
    getClient: vi.fn(async () => ({})),
    validateModels: vi.fn(async () => {}),
    createChildSession: vi.fn(async ({ parentID }) => ({ id: `child-${parentID}-${Math.random().toString(36).slice(2)}` })),
    runPromptOnSession: vi.fn(async ({ model }) => ({
      text: `output for ${model.modelID}`,
      truncated: false,
      durationMs: 10,
    })),
    abortSessions: vi.fn(async () => 1),
    ...overrides,
  };
  return runner;
};

const createRuntime = (runner) => createFusionRuntime({ runner });

describe('model fusion runtime', () => {
  it('rejects missing required inputs', async () => {
    const runtime = createRuntime(createRunner());
    await expect(runtime.execute({})).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('sessionId') });
    await expect(runtime.execute({ sessionId: 's1' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('directory') });
    await expect(runtime.execute({ sessionId: 's1', directory: '/work' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('prompt') });
    await expect(runtime.execute({ sessionId: 's1', directory: '/work', prompt: 'hi' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('models') });
  });

  it('rejects invalid or oversized model lists before any side effect', async () => {
    const runner = createRunner();
    const runtime = createRuntime(runner);
    await expect(runtime.execute({
      sessionId: 's1',
      directory: '/work',
      prompt: 'hi',
      models: ['not-a-model'],
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('provider/model') });
    await expect(runtime.execute({
      sessionId: 's1',
      directory: '/work',
      prompt: 'hi',
      models: ['a/b', 'c/d', 'e/f', 'g/h', 'i/j'],
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('at most 4') });
    expect(runner.createChildSession).not.toHaveBeenCalled();
  });

  it('rejects unknown models against the provider snapshot before creating children', async () => {
    const runner = createRunner({
      validateModels: vi.fn(async () => {
        throw Object.assign(new Error('Unknown model: foo/bar for /work'), { statusCode: 400 });
      }),
    });
    const runtime = createRuntime(runner);
    await expect(runtime.execute({
      sessionId: 's1',
      directory: '/work',
      prompt: 'hi',
      models: ['foo/bar', 'foo/baz'],
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Unknown model') });
    expect(runner.createChildSession).not.toHaveBeenCalled();
  });

  it('rejects a single model (fusion needs at least two)', async () => {
    const runner = createRunner();
    const runtime = createRuntime(runner);
    await expect(runtime.execute({
      sessionId: 's1',
      directory: '/work',
      prompt: 'hi',
      models: ['anthropic/claude-sonnet-4'],
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('at least 2 models') });
    expect(runner.createChildSession).not.toHaveBeenCalled();
  });

  it('creates one child per model with Fused titles and collects results', async () => {
    const runner = createRunner();
    const runtime = createRuntime(runner);
    const result = await runtime.execute({
      sessionId: 'parent-1',
      directory: '/work',
      prompt: 'Write a debounce hook',
      models: ['anthropic/claude-sonnet-4', 'openai/gpt-5'],
    });

    expect(runner.validateModels).toHaveBeenCalledWith('/work', ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
    expect(runner.createChildSession).toHaveBeenCalledTimes(2);
    expect(runner.createChildSession.mock.calls.map(([{ parentID, title }]) => ({ parentID, title }))).toEqual([
      { parentID: 'parent-1', title: 'Fused: anthropic/claude-sonnet-4' },
      { parentID: 'parent-1', title: 'Fused: openai/gpt-5' },
    ]);
    expect(runner.createChildSession.mock.calls.every(([{ directory }]) => directory === '/work')).toBe(true);
    const dispatchCalls = runner.runPromptOnSession.mock.calls.map(([args]) => args);
    expect(dispatchCalls).toHaveLength(2);
    expect(dispatchCalls.map(({ model }) => model)).toEqual([
      { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      { providerID: 'openai', modelID: 'gpt-5' },
    ]);
    expect(dispatchCalls.every(({ prompt }) => prompt === 'Write a debounce hook')).toBe(true);
    expect(dispatchCalls.every(({ sessionID }) => sessionID !== 'parent-1')).toBe(true);
    expect(dispatchCalls.every(({ directory }) => directory === '/work')).toBe(true);

    expect(result.allOk).toBe(true);
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]).toMatchObject({
      status: 'ok',
      result: 'output for claude-sonnet-4',
      durationMs: 10,
    });
    expect(result.runs[0].sessionId).not.toBe('parent-1');
  });

  it('publishes child session ids as soon as they are created', async () => {
    const runner = createRunner();
    const emitChildrenCreated = vi.fn();
    const runtime = createFusionRuntime({ runner, emitChildrenCreated });
    const result = await runtime.execute({
      sessionId: 'parent-1',
      directory: '/work',
      prompt: 'Compare',
      models: ['anthropic/claude-sonnet-4', 'openai/gpt-5'],
      preset: 'deep-dive',
      runId: 'fusion-run-1',
    });

    expect(emitChildrenCreated).toHaveBeenCalledTimes(1);
    const payload = emitChildrenCreated.mock.calls[0][0];
    expect(payload.sessionId).toBe('parent-1');
    expect(payload.runId).toBe('fusion-run-1');
    expect(payload.directory).toBe('/work');
    expect(payload.preset).toBe('deep-dive');
    expect(payload.children).toHaveLength(2);
    expect(payload.children.map(({ model }) => model)).toEqual(['anthropic/claude-sonnet-4', 'openai/gpt-5']);
    expect(payload.children.map(({ sessionId }) => sessionId).every((id) => typeof id === 'string' && id !== 'parent-1')).toBe(true);
    expect(result.allOk).toBe(true);
    expect(result.runId).toBe('fusion-run-1');
  });

  it('never lets a failing event channel fail the run', async () => {
    const runner = createRunner();
    const runtime = createFusionRuntime({
      runner,
      emitChildrenCreated: () => {
        throw new Error('channel down');
      },
    });
    await expect(runtime.execute({
      sessionId: 'parent-1',
      directory: '/work',
      prompt: 'hi',
      models: ['anthropic/claude-sonnet-4', 'openai/gpt-5'],
    })).resolves.toMatchObject({ allOk: true });
  });

  it('aborts already-created children when one creation fails', async () => {
    const runner = createRunner();
    runner.createChildSession
      .mockImplementationOnce(async () => ({ id: 'child-1' }))
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('boom'), { statusCode: 500 });
      });
    const runtime = createRuntime(runner);
    await expect(runtime.execute({
      sessionId: 'parent-1',
      directory: '/work',
      prompt: 'hi',
      models: ['a/b', 'c/d'],
    })).rejects.toMatchObject({ message: 'boom' });
    expect(runner.abortSessions).toHaveBeenCalledWith(expect.objectContaining({
      sessionIDs: ['child-1'],
      directory: '/work',
    }));
  });

  it('returns partial results when one model fails', async () => {
    const runner = createRunner();
    const runtime = createRuntime(runner);
    runner.runPromptOnSession.mockImplementation(async ({ model }) => {
      if (model?.modelID === 'gpt-5') throw new Error('rate limited');
      return { text: `ok ${model?.modelID}`, truncated: false, durationMs: 5 };
    });
    const result = await runtime.execute({
      sessionId: 'parent-1',
      directory: '/work',
      prompt: 'hi',
      models: ['anthropic/claude-sonnet-4', 'openai/gpt-5'],
    });

    expect(result.allOk).toBe(false);
    expect(result.runs).toEqual([
      expect.objectContaining({ model: 'anthropic/claude-sonnet-4', status: 'ok' }),
      expect.objectContaining({ model: 'openai/gpt-5', status: 'error', error: 'rate limited' }),
    ]);
    expect(runner.abortSessions).toHaveBeenCalledWith(expect.objectContaining({
      sessionIDs: expect.arrayContaining([expect.any(String)]),
      directory: '/work',
    }));
  });

  it('aborts children and surfaces cancellation when the signal fires', async () => {
    const runner = createRunner();
    const runtime = createRuntime(runner);
    runner.runPromptOnSession.mockImplementation(async ({ signal }) => {
      await new Promise((_, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error('Agent capability run was cancelled'), { statusCode: 499 }));
          return;
        }
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Agent capability run was cancelled'), { statusCode: 499 })), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = runtime.execute({
      sessionId: 'parent-1',
      directory: '/work',
      prompt: 'hi',
      models: ['anthropic/claude-sonnet-4', 'openai/gpt-5'],
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ statusCode: 499 });
    expect(runner.abortSessions).toHaveBeenCalledWith(expect.objectContaining({
      sessionIDs: expect.any(Array),
      directory: '/work',
    }));
  });
});
