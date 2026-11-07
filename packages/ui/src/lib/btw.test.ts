import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { OpencodeApiError, opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  BTW_INSTRUCTION,
  BTW_PROMOTION_NOTICE,
  buildBtwPrompt,
  buildBtwSyntheticTexts,
  dismissBtw,
  disposeBtwRequests,
  openBtwComposer,
  runBtwQuestion,
} from './btw';
import { useBtwStore } from '@/stores/useBtwStore';

type GenerateOptions = { directory?: string | null; signal?: AbortSignal };
type GenerateCall = { sessionId: string; prompt: string; options?: GenerateOptions };

let generateImpl: (sessionId: string, prompt: string, options?: GenerateOptions) => Promise<string>;
let generateSpy: ReturnType<typeof spyOn>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useBtwStore.setState({ byParent: {} });
  generateImpl = () => Promise.resolve('side answer');
  generateSpy = spyOn(opencodeClient, 'generateSessionText').mockImplementation((sessionId, prompt, options) => (
    generateImpl(sessionId, prompt, options)
  ));
});

afterEach(() => {
  generateSpy.mockRestore();
  useBtwStore.setState({ byParent: {} });
});

describe('buildBtwPrompt', () => {
  test('frames the question with the native no-tools instruction', () => {
    expect(buildBtwPrompt('  why did step 2 fail?  '))
      .toBe(`${BTW_INSTRUCTION}\n\nwhy did step 2 fail?`);
  });
});

describe('buildBtwSyntheticTexts', () => {
  test('answers the old boundary instructions only in a promoted legacy session', () => {
    expect(buildBtwSyntheticTexts({ isPromotedBtwSession: true })).toEqual([BTW_PROMOTION_NOTICE]);
    expect(buildBtwSyntheticTexts({ isPromotedBtwSession: false })).toEqual([]);
  });
});

describe('runBtwQuestion', () => {
  test('calls only the transient generation and stores the answer', async () => {
    const calls: GenerateCall[] = [];
    generateImpl = (sessionId, prompt, options) => {
      calls.push({ sessionId, prompt, options });
      return Promise.resolve('  the test used the stale fixture  ');
    };

    await runBtwQuestion({
      parentSessionId: 'parent-1',
      ownerKey: 'main:parent-1',
      directory: '/repo',
      question: 'why did the test fail?',
    });

    expect(calls[0]?.sessionId).toBe('parent-1');
    expect(calls[0]?.prompt).toBe(buildBtwPrompt('why did the test fail?'));
    expect(calls[0]?.options?.directory).toBe('/repo');
    expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    const request = useBtwStore.getState().byParent['parent-1'];
    expect(request?.status).toBe('answered');
    expect(request?.answer).toBe('the test used the stale fixture');
    expect(request?.question).toBe('why did the test fail?');
  });

  test('an empty reply is a retryable failure, not an answer', async () => {
    generateImpl = () => Promise.resolve('   ');

    await runBtwQuestion({ parentSessionId: 'parent-1', ownerKey: 'main:parent-1', directory: null, question: 'anything' });

    const request = useBtwStore.getState().byParent['parent-1'];
    expect(request?.status).toBe('failed');
    expect(request?.failure?.reason).toBe('empty');
  });

  test('maps a missing session apart from an unsupported server', async () => {
    generateImpl = () => Promise.reject(new OpencodeApiError('session.generate', 'missing', {
      status: 404,
      tag: 'SessionNotFoundError',
    }));
    await runBtwQuestion({ parentSessionId: 'parent-1', ownerKey: 'main:parent-1', directory: null, question: 'first' });
    expect(useBtwStore.getState().byParent['parent-1']?.failure?.reason).toBe('session-missing');

    useBtwStore.setState({ byParent: {} });
    generateImpl = () => Promise.reject(new OpencodeApiError('session.generate', 'not found', { status: 404 }));
    await runBtwQuestion({ parentSessionId: 'parent-1', ownerKey: 'main:parent-1', directory: null, question: 'second' });
    expect(useBtwStore.getState().byParent['parent-1']?.failure?.reason).toBe('unsupported');
  });


  test('a request that outlives the timeout is aborted and marked retryable', async () => {
    jest.useFakeTimers();
    try {
      generateImpl = (_sessionId, _prompt, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });

      const running = runBtwQuestion({ parentSessionId: 'parent-1', ownerKey: 'main:parent-1', directory: null, question: 'slow' });
      await Promise.resolve();
      jest.advanceTimersByTime(300_000);
      await running;

      expect(useBtwStore.getState().byParent['parent-1']?.failure?.reason).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  test('dismiss aborts its own request and ignores the late answer', async () => {
    let resolveAnswer: (answer: string) => void = () => {};
    let signal: AbortSignal | undefined;
    generateImpl = (_sessionId, _prompt, options) => {
      signal = options?.signal;
      return new Promise((resolve) => { resolveAnswer = resolve; });
    };

    const running = runBtwQuestion({ parentSessionId: 'parent-1', ownerKey: 'main:parent-1', directory: null, question: 'slow' });
    await settle();
    expect(useBtwStore.getState().byParent['parent-1']?.status).toBe('running');
    expect(signal?.aborted).toBe(false);

    dismissBtw('parent-1');
    expect(signal?.aborted).toBe(true);
    expect(useBtwStore.getState().byParent['parent-1']).toBeUndefined();

    resolveAnswer('late answer');
    await running;
    expect(useBtwStore.getState().byParent['parent-1']).toBeUndefined();
  });

  test('a runtime switch discards the pending request and its store state', async () => {
    generateImpl = (_sessionId, _prompt, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });

    const running = runBtwQuestion({ parentSessionId: 'parent-1', ownerKey: 'main:parent-1', directory: null, question: 'slow' });
    await settle();
    disposeBtwRequests();
    await running;

    expect(useBtwStore.getState().byParent).toEqual({});
  });

  test('a stale runtime key cannot publish an answer', async () => {
    generateImpl = () => Promise.resolve('answer from the old runtime');

    await runBtwQuestion({
      parentSessionId: 'parent-1',
      ownerKey: 'main:parent-1',
      directory: null,
      question: 'old runtime',
      runtimeKey: 'runtime-from-before-the-switch',
    });

    expect(getRuntimeKey()).not.toBe('runtime-from-before-the-switch');
    expect(useBtwStore.getState().byParent['parent-1']).toBeUndefined();
  });

  test('openBtwComposer leaves a running request alone', async () => {
    generateImpl = (_sessionId, _prompt, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const running = runBtwQuestion({ parentSessionId: 'parent-1', ownerKey: 'main:parent-1', directory: null, question: 'running' });
    await settle();

    expect(openBtwComposer('parent-1', 'main:parent-1', null, 'second')).toBe(false);
    expect(useBtwStore.getState().byParent['parent-1']?.question).toBe('running');

    dismissBtw('parent-1');
    await running;
  });
});
