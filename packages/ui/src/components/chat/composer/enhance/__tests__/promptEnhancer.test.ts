import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// The enhance path reaches the network through two seams, both replaced here:
// the small-model request layer (so responses are scripted per test) and the
// magic-prompt override fetch (so an override proves the effective template
// is what lands in `system`). The store import inside magicPrompts.ts is
// unused by this path but still loads, so the store module is mocked too.
const DEFAULT_INSTRUCTIONS = 'You rewrite drafts. DEFAULT-INSTRUCTIONS-V1.';
let overrideText: string | null = null;
const renderCalls: string[] = [];
// Default: a settled response when one is scripted, else a hang. Timeout
// tests leave nothing scripted and let the composed deadline fire.
const defaultTransport = (): Promise<Response> => {
  if (scriptedError) return Promise.reject(scriptedError);
  if (scriptedResponse) return Promise.resolve(scriptedResponse);
  return new Promise<Response>(() => {});
};
let transport: (init: RequestInit) => Promise<Response> = defaultTransport;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => {
    throw new Error('network transport must be replaced by smallModelRequest mock');
  },
}));
mock.module('@/lib/magicPrompts', () => ({
  renderMagicPrompt: async (id: string) => {
    renderCalls.push(id);
    return overrideText ?? DEFAULT_INSTRUCTIONS;
  },
  getDefaultMagicPromptTemplate: (id: string) => `${id} default`,
}));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ currentProviderId: null, currentModelId: null }) },
}));
mock.module('@/lib/smallModelRequest', () => ({
  requestSmallModel: (init: RequestInit, options?: { silentStatuses?: number[] }) => {
    requestSmallModelCalls.push({ init, options });
    return transport(init);
  },
}));

let scriptedResponse: Response | null = null;
let scriptedError: Error | null = null;
const requestSmallModelCalls: Array<{ init: RequestInit; options?: { silentStatuses?: number[] } }> = [];

/**
 * A transport that only resolves when the composed deadline aborts it,
 * rejecting with the reason's DOMException name (the surface real fetch
 * gives when its signal fires). An already-aborted signal rejects
 * immediately, like real fetch does.
 */
const abortAwareHang = (reason: 'TimeoutError' | 'AbortError'): ((init: RequestInit) => Promise<Response>) => {
  const rejectWithReason = (reject: (error: Error) => void): void => {
    reject(new DOMException(
      reason === 'TimeoutError' ? 'The operation timed out.' : 'The operation was aborted.',
      reason,
    ));
  };
  return (init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init.signal?.aborted) {
      rejectWithReason(reject);
      return;
    }
    init.signal?.addEventListener('abort', () => rejectWithReason(reject), { once: true });
  });
};

interface JsonBody {
  text?: string;
  error?: string;
  code?: string;
}

const jsonResponse = (payload: JsonBody, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const lastBody = (): EnhanceRequestBody => {
  const raw = requestSmallModelCalls.at(-1)?.init.body;
  if (!raw) throw new Error('no request was sent');
  // SAFETY: the body under test is JSON.stringify of EnhanceRequestBody in
  // the module; parse into that owner type and rely on assertions below.
  return JSON.parse(String(raw)) as EnhanceRequestBody;
};

import {
  buildEnhanceRequestBody,
  cleanEnhancedPromptText,
  enhancePrompt,
  ENHANCE_REQUEST_TIMEOUT_MS,
  type EnhanceRequestBody,
  PromptEnhanceError,
  type PromptEnhanceFailure,
} from '../promptEnhancer';

const context = (overrides: Partial<Parameters<typeof buildEnhanceRequestBody>[2]> = {}) => ({
  directory: '/repo',
  ...overrides,
});

beforeEach(() => {
  requestSmallModelCalls.length = 0;
  renderCalls.length = 0;
  overrideText = null;
  scriptedResponse = null;
  scriptedError = null;
  transport = defaultTransport;
});

const expectFailure = async (promise: Promise<string>, reason: PromptEnhanceFailure): Promise<PromptEnhanceError> => {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof PromptEnhanceError)) throw error;
    expect(error.reason).toBe(reason);
    return error;
  }
  throw new Error(`expected ${reason} failure, but enhancePrompt resolved`);
};

describe('enhancePrompt — request shape', () => {
  test('the draft is the only user content in the request body', async () => {
    scriptedResponse = jsonResponse({ text: 'rewritten draft' });
    const draft = 'fix the login bug @src/auth.ts /review #snippet';
    await enhancePrompt(draft, context({ sessionId: 'session-1' }), new AbortController().signal);

    const body = lastBody();
    expect(body.prompt).toBe(draft);
    expect(Object.keys(body).sort()).toEqual([
      'directory', 'onOverflow', 'prompt', 'restrictToPreferredProvider', 'sessionID', 'system',
    ]);
  });

  test('the rendered magic prompt lands in system — an override is honored', async () => {
    overrideText = overrideText ?? 'You rewrite drafts. OVERRIDE-INSTRUCTIONS-V2.';
    scriptedResponse = jsonResponse({ text: 'rewritten' });
    await enhancePrompt('my draft', context(), new AbortController().signal);

    expect(renderCalls).toEqual(['composer.enhance.instructions']);
    expect(lastBody().system).toBe(overrideText);
  });

  test('restrictToPreferredProvider and onOverflow are always set', async () => {
    scriptedResponse = jsonResponse({ text: 'rewritten' });
    await enhancePrompt('draft', context(), new AbortController().signal);
    const body = lastBody();
    expect(body.restrictToPreferredProvider).toBe(true);
    expect(body.onOverflow).toBe('error');
  });

  test('directory, sessionID and preferred ids pass through when present', async () => {
    scriptedResponse = jsonResponse({ text: 'rewritten' });
    await enhancePrompt('draft', context({
      sessionId: 'session-9',
      preferredProviderId: 'anthropic',
      preferredModelId: 'claude-haiku-4-5',
    }), new AbortController().signal);

    const body = lastBody();
    expect(body.directory).toBe('/repo');
    expect(body.sessionID).toBe('session-9');
    expect(body.preferredProviderID).toBe('anthropic');
    expect(body.preferredModelID).toBe('claude-haiku-4-5');
  });

  test('nullish session and preferred ids are omitted from the body', async () => {
    scriptedResponse = jsonResponse({ text: 'rewritten' });
    await enhancePrompt('draft', context({
      sessionId: null,
      preferredProviderId: null,
      preferredModelId: undefined,
    }), new AbortController().signal);

    const body = lastBody();
    expect(body.sessionID).toBeUndefined();
    expect(body.preferredProviderID).toBeUndefined();
    expect(body.preferredModelID).toBeUndefined();
  });

  test('404 responses request silence from the shared toast', async () => {
    scriptedResponse = jsonResponse({ error: 'No small model available' }, 404);
    await enhancePrompt('draft', context(), new AbortController().signal).catch(() => undefined);
    expect(requestSmallModelCalls.at(-1)?.options?.silentStatuses).toContain(404);
  });

  test('413 responses request silence from the shared toast too', async () => {
    scriptedResponse = jsonResponse({ error: 'Input is too large' }, 413);
    await enhancePrompt('draft', context(), new AbortController().signal).catch(() => undefined);
    const silentStatuses = requestSmallModelCalls.at(-1)?.options?.silentStatuses;
    expect(silentStatuses).toContain(404);
    expect(silentStatuses).toContain(413);
  });
});

describe('enhancePrompt — response cleaning', () => {
  test('trims surrounding whitespace', async () => {
    scriptedResponse = jsonResponse({ text: '  rewritten draft  ' });
    const enhanced = await enhancePrompt('draft', context(), new AbortController().signal);
    expect(enhanced).toBe('rewritten draft');
  });

  test('strips exactly one outer markdown fence, keeping an inner one', async () => {
    scriptedResponse = jsonResponse({ text: '```text\nrewritten draft\n```' });
    const enhanced = await enhancePrompt('draft', context(), new AbortController().signal);
    expect(enhanced).toBe('rewritten draft');
  });

  test('keeps the fence content including an inner fence', async () => {
    scriptedResponse = jsonResponse({ text: '```\n## Snippet\n```\nmore\n```' });
    const enhanced = await enhancePrompt('draft', context(), new AbortController().signal);
    expect(enhanced).toBe('## Snippet\n```\nmore');
  });

  test('strips one pair of straight double quotes', async () => {
    scriptedResponse = jsonResponse({ text: '"rewritten draft"' });
    const enhanced = await enhancePrompt('draft', context(), new AbortController().signal);
    expect(enhanced).toBe('rewritten draft');
  });

  test('strips one pair of straight single quotes', async () => {
    scriptedResponse = jsonResponse({ text: "'rewritten draft'" });
    const enhanced = await enhancePrompt('draft', context(), new AbortController().signal);
    expect(enhanced).toBe('rewritten draft');
  });

  test('a double-wrapped quote survives the first strip', async () => {
    scriptedResponse = jsonResponse({ text: '"\'quoted\' text"' });
    const enhanced = await enhancePrompt('draft', context(), new AbortController().signal);
    expect(enhanced).toBe('\'quoted\' text');
  });

  test('a text field that decodes to nothing fails as empty-result', async () => {
    scriptedResponse = jsonResponse({ text: '   ' });
    await expectFailure(enhancePrompt('draft', context(), new AbortController().signal), 'empty-result');
  });

  test('a response without a text field fails as empty-result', async () => {
    scriptedResponse = jsonResponse({});
    await expectFailure(enhancePrompt('draft', context(), new AbortController().signal), 'empty-result');
  });
});

describe('enhancePrompt — failure mapping', () => {
  test('404 maps to unavailable', async () => {
    scriptedResponse = jsonResponse({ error: 'No small model available' }, 404);
    const error = await expectFailure(enhancePrompt('draft', context(), new AbortController().signal), 'unavailable');
    expect(error.message).toContain('No small model available');
  });

  test('413 with code context-too-small maps to context-too-small', async () => {
    scriptedResponse = jsonResponse({ error: 'Input is too large: 20000 exceeds 16000', code: 'context-too-small' }, 413);
    const error = await expectFailure(enhancePrompt('draft', context(), new AbortController().signal), 'context-too-small');
    expect(error.message).toContain('20000');
  });

  test('500 maps to provider-failed and carries the backend message', async () => {
    scriptedResponse = jsonResponse({ error: 'provider exploded', code: 'upstream' }, 500);
    const error = await expectFailure(enhancePrompt('draft', context(), new AbortController().signal), 'provider-failed');
    expect(error.message).toBe('provider exploded');
  });

  test('an aborted fetch maps to aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    scriptedError = new DOMException('The operation was aborted.', 'AbortError');
    await expectFailure(enhancePrompt('draft', context(), controller.signal), 'aborted');
  });

  test('a caller cancel during flight maps to aborted, not timed-out', async () => {
    // The caller's controller cancels the composed deadline, so even though
    // the rejection is an abort-shaped error it must stay silent `aborted`.
    const controller = new AbortController();
    transport = abortAwareHang('AbortError');
    const promise = enhancePrompt('draft', context(), controller.signal, { timeoutMs: 90_000 });
    controller.abort();
    await expectFailure(promise, 'aborted');
  });

  test('a deadline that fires before any response maps to timed-out', async () => {
    // A transport that never answers (a lost relay frame): the composed
    // deadline rejects the fetch with the timeout reason, and the service
    // maps it to the surfaced failure, not a silent abort.
    transport = abortAwareHang('TimeoutError');
    const error = await expectFailure(
      enhancePrompt('draft', context(), new AbortController().signal, { timeoutMs: 30 }),
      'timed-out',
    );
    expect(error.cause).toBeInstanceOf(Error);
    // SAFETY: the transport under test rejects with a DOMException-shaped
    // Error; the assertion above already confirmed the instance.
    expect((error.cause as Error).name).toBe('TimeoutError');
  });

  test('a deadline firing as a plain AbortError also maps to timed-out', async () => {
    // Engines without `AbortSignal.timeout` reasons surface a plain
    // AbortError; that must still read as a deadline, not a cancellation.
    transport = abortAwareHang('AbortError');
    await expectFailure(
      enhancePrompt('draft', context(), new AbortController().signal, { timeoutMs: 30 }),
      'timed-out',
    );
  });

  test('the exported deadline constant is the production value', () => {
    expect(ENHANCE_REQUEST_TIMEOUT_MS).toBe(90_000);
  });

  test('a non-abort thrown error propagates unchanged', async () => {
    scriptedError = new Error('socket hangup');
    await expect(enhancePrompt('draft', context(), new AbortController().signal)).rejects.toThrow('socket hangup');
  });
});

describe('enhancePrompt — without AbortSignal.any (WKWebView < 17.4)', () => {
  // WKWebView gained `AbortSignal.any` in 17.4; engines below it (iOS
  // 16.4–17.3) have `AbortSignal.timeout` but throw a TypeError on `.any`.
  // Every test here hides the static so the deadline composition must fall
  // back to the manual controller path, and restores it afterwards.
  const nativeAny = AbortSignal.any;

  beforeEach(() => {
    // SAFETY: deleting the host constructor's static emulates WKWebView
    // < 17.4, where `AbortSignal.any` does not exist; afterEach restores it.
    delete (AbortSignal as { any?: unknown }).any;
  });

  afterEach(() => {
    // SAFETY: re-adds the static deleted in beforeEach so later tests see
    // the real host `AbortSignal.any` again.
    (AbortSignal as { any?: unknown }).any = nativeAny;
  });

  test('still resolves with a scripted response — no TypeError before the await', async () => {
    scriptedResponse = jsonResponse({ text: 'rewritten without .any' });
    const enhanced = await enhancePrompt('draft', context(), new AbortController().signal);
    expect(enhanced).toBe('rewritten without .any');
  });

  test('a deadline that fires while .any is absent still maps to timed-out', async () => {
    transport = abortAwareHang('TimeoutError');
    await expectFailure(
      enhancePrompt('draft', context(), new AbortController().signal, { timeoutMs: 30 }),
      'timed-out',
    );
  });

  test('a caller abort while .any is absent still maps to aborted', async () => {
    const controller = new AbortController();
    transport = abortAwareHang('AbortError');
    const promise = enhancePrompt('draft', context(), controller.signal, { timeoutMs: 90_000 });
    controller.abort();
    await expectFailure(promise, 'aborted');
  });
});

describe('enhancePrompt — empty instructions guard', () => {
  test('an override rendering to whitespace fails before any request', async () => {
    overrideText = '   ';
    await expectFailure(enhancePrompt('draft', context(), new AbortController().signal), 'empty-result');
    expect(requestSmallModelCalls).toHaveLength(0);
  });
});

describe('buildEnhanceRequestBody', () => {
  test('carries only the draft, instructions, and routing fields', () => {
    const body = buildEnhanceRequestBody('the draft', 'instructions', context({ sessionId: 's' }));
    expect(Object.keys(body).sort()).toEqual([
      'directory', 'onOverflow', 'prompt', 'restrictToPreferredProvider', 'sessionID', 'system',
    ]);
  });
});

describe('cleanEnhancedPromptText', () => {
  test('trims surrounding whitespace', () => {
    expect(cleanEnhancedPromptText('  text  ')).toBe('text');
  });

  test('strips one outer fence with a language tag', () => {
    expect(cleanEnhancedPromptText('```text\nrewritten\n```')).toBe('rewritten');
  });

  test('strips one outer fence without a language tag', () => {
    expect(cleanEnhancedPromptText('```\nrewritten\n```')).toBe('rewritten');
  });

  test('keeps an inner fence inside the outer one', () => {
    expect(cleanEnhancedPromptText('```\n## Snippet\n```\nmore\n```')).toBe('## Snippet\n```\nmore');
  });

  test('an unterminated fence stays as-is', () => {
    expect(cleanEnhancedPromptText('```text\nrewritten')).toBe('```text\nrewritten');
  });

  test('strips one pair of double quotes', () => {
    expect(cleanEnhancedPromptText('"rewritten"')).toBe('rewritten');
  });

  test('strips one pair of single quotes', () => {
    expect(cleanEnhancedPromptText("'rewritten'")).toBe('rewritten');
  });

  test('a wrapped value whose inner text is itself quote-wrapped is not double-stripped', () => {
    expect(cleanEnhancedPromptText('"\'quoted\' text"')).toBe('\'quoted\' text');
  });

  test('a string that merely starts and ends with the same character is still stripped when whole-wrapped', () => {
    // The spec strips any whole-response matching quote pair; "don't" only
    // keeps its quote when the outer characters are not a wrapper pair.
    expect(cleanEnhancedPromptText('"don\'t"')).toBe('don\'t');
    expect(cleanEnhancedPromptText('say "hello" now')).toBe('say "hello" now');
  });

  test('quotes inside the text are untouched', () => {
    expect(cleanEnhancedPromptText('say "hello" now')).toBe('say "hello" now');
  });
});
