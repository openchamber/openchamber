import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The split-lifetime contract of the shared `/api/magic-prompts` overrides
 * fetch (imported through the real `magicPrompts` module — only its
 * `runtime-fetch` seam is replaced):
 *
 * - The shared transport has its own internal deadline; a hung `/api/` read
 *   settles the shared request, clears the in-flight slot, and lets the next
 *   caller start a fresh request. That deadline is transport-internal: its
 *   rejection is translated into the plain load-failure error before it
 *   reaches any caller, so unsigned consumers degrade to the default
 *   template exactly as for any other load failure — the abort shape never
 *   crosses the shared/caller boundary, where it would be misread as the
 *   caller's own cancellation or deadline.
 * - A caller's signal bounds only its own wait: it rejects the caller
 *   promptly with an abort-named error, leaves the shared transport running,
 *   and never mutates the cache. The abandoned shared branch must not become
 *   an unhandled rejection.
 *
 * Timer control is manual: settleable transports are released by the test
 * before being awaited, and deadline-bearing transports hang until their
 * signal is fired explicitly. This avoids the real-vs-fake
 * `AbortSignal.timeout` timer seam entirely (bun fake timers do fire
 * `AbortSignal.timeout`, but manual control keeps each settle point
 * explicit).
 */
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (_url: string, init?: RequestInit): Promise<Response> => transportImpl(init),
}));

type TransportImpl = (init?: RequestInit) => Promise<Response>;
interface SettleableTransport extends TransportImpl {
  release: (overrides: Record<string, string>) => void;
  readonly callCount: number;
}
let transportImpl: TransportImpl = () => new Promise<Response>(() => {});
const transportSignals: AbortSignal[] = [];

/** A settleable transport: records its signal, resolves on demand. */
const settleable = (): SettleableTransport => {
  let release: (response: Response) => void = () => {};
  let calls = 0;
  const impl = ((init?: RequestInit) => {
    calls += 1;
    transportSignals.push(init?.signal ?? new AbortController().signal);
    return new Promise<Response>((resolve) => { release = resolve; });
  }) as SettleableTransport;
  impl.release = (overrides: Record<string, string>) => release(jsonOverrides(overrides));
  Object.defineProperty(impl, 'callCount', { get: () => calls });
  return impl;
};

/**
 * A transport that hangs until its signal aborts, then rejects with the
 * given DOMException name — the surface the internal deadline produces.
 */
const hangUntilAborted = (reason: 'TimeoutError' | 'AbortError'): TransportImpl => (init) => {
  transportSignals.push(init?.signal ?? new AbortController().signal);
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new DOMException(
        reason === 'TimeoutError' ? 'The operation timed out.' : 'The operation was aborted.',
        reason,
      ));
      return;
    }
    signal?.addEventListener('abort', () => {
      reject(new DOMException(
        reason === 'TimeoutError' ? 'The operation timed out.' : 'The operation was aborted.',
        reason,
      ));
    }, { once: true });
  });
};

const jsonOverrides = (overrides: Record<string, string>): Response =>
  new Response(JSON.stringify({ overrides }), { status: 200, headers: { 'Content-Type': 'application/json' } });

const nextTick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

import {
  fetchMagicPromptOverrides,
  getDefaultMagicPromptTemplate,
  renderMagicPrompt,
  resetMagicPromptOverridesForTests,
} from '@/lib/magicPrompts';
import { enhancePrompt, PromptEnhanceError, type EnhanceRequestBody } from '../promptEnhancer';

beforeEach(() => {
  resetMagicPromptOverridesForTests();
  transportImpl = () => new Promise<Response>(() => {});
  transportSignals.length = 0;
});

describe('fetchMagicPromptOverrides — shared transport lifetime', () => {
  test('the shared transport carries its own internal deadline signal, not a caller signal', async () => {
    const transport = settleable();
    transportImpl = transport;
    const wait = fetchMagicPromptOverrides();
    await nextTick();
    expect(transport.callCount).toBe(1);
    const sharedSignal = transportSignals[0];
    expect(sharedSignal).toBeInstanceOf(AbortSignal);
    expect(sharedSignal.aborted).toBe(false);
    transport.release({ 'composer.enhance.instructions': 'OVR' });
    const resolved = await wait;
    expect(resolved['composer.enhance.instructions']).toBe('OVR');
  });

  test('a caller signal rejects promptly and leaves the shared request running', async () => {
    const transport = settleable();
    transportImpl = transport;
    const caller = new AbortController();
    const wait = fetchMagicPromptOverrides({ signal: caller.signal });
    await nextTick();
    expect(transport.callCount).toBe(1);
    const sharedSignal = transportSignals[0];

    caller.abort();
    let rejection: unknown = null;
    try { await wait; } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).name).toBe('AbortError');

    // The shared transport never saw the caller's signal, and the aborted
    // caller's wait touched neither the cache nor the in-flight slot.
    expect(sharedSignal.aborted).toBe(false);

    // The abandoned shared branch still completes and fills the cache —
    // without becoming an unhandled rejection.
    transport.release({ 'composer.enhance.instructions': 'LATE' });
    await nextTick();
    const cached = await fetchMagicPromptOverrides();
    expect(cached['composer.enhance.instructions']).toBe('LATE');
  });

  test('a caller leaving early does not disturb consumer B on the same in-flight request', async () => {
    const transport = settleable();
    transportImpl = transport;
    const callerA = new AbortController();
    const waitA = fetchMagicPromptOverrides({ signal: callerA.signal });
    const waitB = fetchMagicPromptOverrides(); // unsigned consumer joins the in-flight
    await nextTick();
    expect(transport.callCount).toBe(1); // coalesced: one transport call

    callerA.abort();
    let rejection: unknown = null;
    try { await waitA; } catch (error) { rejection = error; }
    expect((rejection as Error | null)?.name).toBe('AbortError');

    transport.release({ 'composer.enhance.instructions': 'SHARED' });
    const shared = await waitB;
    expect(shared['composer.enhance.instructions']).toBe('SHARED');
    // The cache was set by the shared completion only.
    expect((await fetchMagicPromptOverrides())['composer.enhance.instructions']).toBe('SHARED');
  });

  test('a shared rejection after a caller left is swallowed and the next caller starts fresh', async () => {
    // Caller A waits on a hung shared request, leaves; the shared transport
    // then rejects (its own timeout). The abandoned branch must not become
    // an unhandled rejection, the in-flight slot must be cleared, and the
    // next caller must start a NEW request that succeeds.
    let firstReject: ((error: unknown) => void) | undefined;
    transportImpl = (init) => {
      transportSignals.push(init?.signal ?? new AbortController().signal);
      return new Promise<Response>((_resolve, reject) => { firstReject = reject; });
    };
    const callerA = new AbortController();
    const waitA = fetchMagicPromptOverrides({ signal: callerA.signal });
    await nextTick();
    callerA.abort();
    await expect(waitA).rejects.toThrow();

    // The abandoned shared request then rejects on its own.
    // SAFETY: the hung transport above always captured its reject function
    // before any of this code can run.
    firstReject!(new DOMException('The operation timed out.', 'TimeoutError'));
    await nextTick(); // let the .finally clear the slot and the catch settle

    // The next caller starts a NEW transport call. Release it before
    // awaiting (an unreleased settleable request would deadlock the test).
    const transport = settleable();
    transportImpl = transport;
    const settled = fetchMagicPromptOverrides();
    transport.release({ 'composer.enhance.instructions': 'RETRIED' });
    expect(transport.callCount).toBe(1); // a fresh request, not the cleared in-flight
    expect((await settled)['composer.enhance.instructions']).toBe('RETRIED');
  });

  test('the internal deadline aborts a hung transport and clears the in-flight slot for a retry', async () => {
    // Real deadline path: the transport hangs; the internal deadline aborts
    // it; the rejection clears the in-flight slot; a fresh caller gets a new
    // transport call that succeeds.
    transportImpl = hangUntilAborted('TimeoutError');
    const first = fetchMagicPromptOverrides();
    await nextTick();
    expect(transportSignals).toHaveLength(1);
    const sharedSignal = transportSignals[0];
    expect(sharedSignal.aborted).toBe(false);

    // Fire the internal deadline signal: the transport rejects.
    Object.defineProperty(sharedSignal, 'aborted', { value: true });
    sharedSignal.dispatchEvent(new Event('abort'));
    await expect(first).rejects.toThrow('Failed to load magic prompts');
    await nextTick();

    // Slot cleared → the next caller starts a fresh request. Release it
    // before awaiting (an unreleased settleable request would deadlock).
    const transport = settleable();
    transportImpl = transport;
    const second = fetchMagicPromptOverrides();
    transport.release({ 'composer.enhance.instructions': 'RETRY-OK' });
    expect((await second)['composer.enhance.instructions']).toBe('RETRY-OK');
    expect(transport.callCount).toBe(1);
  });

  test('an already-aborted caller signal rejects immediately without starting a transport call', async () => {
    transportImpl = () => {
      transportSignals.push(new AbortController().signal);
      return Promise.resolve(jsonOverrides({}));
    };
    const caller = new AbortController();
    caller.abort();
    let rejection: unknown = null;
    try { await fetchMagicPromptOverrides({ signal: caller.signal }); } catch (error) { rejection = error; }
    expect((rejection as Error | null)?.name).toBe('AbortError');
    // No fetch was started: the rejected wait never reached the transport.
    expect(transportSignals).toHaveLength(0);
  });

  test('unsigned callers coalesce onto one in-flight request', async () => {
    const transport = settleable();
    transportImpl = transport;
    const w1 = fetchMagicPromptOverrides();
    const w2 = fetchMagicPromptOverrides();
    const w3 = fetchMagicPromptOverrides();
    await nextTick();
    expect(transport.callCount).toBe(1);
    transport.release({ key: 'shared' });
    const first = await w1;
    expect(first['key']).toBe('shared');
    expect(await w2).toBe(first);
    expect(await w3).toBe(first);
  });

  test('a cache hit returns before any transport call, even for a signaled caller', async () => {
    const transport = settleable();
    transportImpl = transport;
    const firstCall = fetchMagicPromptOverrides();
    transport.release({ key: 'first' });
    const first = await firstCall;
    expect(transport.callCount).toBe(1);
    expect(first['key']).toBe('first');

    transportImpl = () => { throw new Error('must not be called'); };
    const cached = await fetchMagicPromptOverrides({ signal: new AbortController().signal });
    expect(cached).toBe(first);
  });
});

describe('renderMagicPrompt — split lifetimes through the effective-template path', () => {
  test('a fired caller deadline during the shared wait surfaces an abort-named rejection, not the transport error', async () => {
    // The wait-scoped rejection must be abort-shaped and survive the
    // default-template catch so enhancePrompt's catch can read it as a
    // deadline — never as a transport failure.
    const transport = settleable();
    transportImpl = transport;
    const caller = new AbortController();
    const deadline = AbortSignal.any([caller.signal, AbortSignal.timeout(90_000)]);
    const renderWait = renderMagicPrompt('composer.enhance.instructions', {}, { signal: deadline });
    await nextTick();

    // The caller's deadline fires (not a caller cancel): the wait rejects
    // with the fired signal's reason.
    caller.abort();
    let rejection: unknown = null;
    try { await renderWait; } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(Error);
    const name = (rejection as Error).name;
    expect(name === 'AbortError' || name === 'TimeoutError').toBe(true);

    // The shared transport is untouched and still fills the cache.
    expect(transportSignals[0].aborted).toBe(false);
    transport.release({ 'composer.enhance.instructions': 'LATE' });
    await nextTick();
    expect((await fetchMagicPromptOverrides())['composer.enhance.instructions']).toBe('LATE');
  });

  test('a transport failure during the shared wait still resolves the default template', async () => {
    const transport = settleable();
    transportImpl = transport;
    const renderWait = renderMagicPrompt('composer.enhance.instructions');
    transport.release({ unrelated: 'x' });
    const instructions = await renderWait;
    // The override map has no entry for the enhance id, so the default
    // template is what lands — the transport succeeded, the miss is a miss.
    expect(instructions).toBe(getDefaultMagicPromptTemplate('composer.enhance.instructions'));
    expect(instructions.length).toBeGreaterThan(0);
  });

  test('the shared transport deadline firing resolves an unsigned consumer the default template, not a throw', async () => {
    // THE legacy-consumer regression: unsigned `renderMagicPrompt` callers
    // (linear start session, git integrate, PlanView, reviewFlow, commit
    // generation, …) have no signal of their own, so an abort-named
    // rejection could only come from the shared transport's internal
    // deadline — and it must degrade to the default template like any other
    // load failure, never surface as a TimeoutError throw.
    transportImpl = hangUntilAborted('TimeoutError');
    const renderWait = renderMagicPrompt('composer.enhance.instructions');
    await nextTick();
    const sharedSignal = transportSignals[0];
    Object.defineProperty(sharedSignal, 'aborted', { value: true });
    sharedSignal.dispatchEvent(new Event('abort'));

    const instructions = await renderWait;
    expect(instructions).toBe(getDefaultMagicPromptTemplate('composer.enhance.instructions'));
    expect(instructions.length).toBeGreaterThan(0);

    // The slot cleared, so the next caller starts a fresh request. Release
    // it before awaiting (an unreleased settleable request would deadlock).
    const transport = settleable();
    transportImpl = transport;
    const retry = fetchMagicPromptOverrides();
    transport.release({ 'composer.enhance.instructions': 'RETRIED' });
    expect((await retry)['composer.enhance.instructions']).toBe('RETRIED');
  });
});

describe('enhancePrompt end-to-end through the real magicPrompts module', () => {
  /**
   * The full service with the real magic-prompt fetch behind it: the only
   * additional seam replaced is the small-model request layer (responses are
   * scripted per test; most tests end before the generate request would
   * matter, one scripts a full response to prove the graceful-degrade path).
   */
  const smallModelCalls: Array<{ signal?: AbortSignal }> = [];
  let smallModelImpl: (init: RequestInit) => Promise<Response> = () => new Promise<Response>(() => {});
  mock.module('@/lib/smallModelRequest', () => ({
    requestSmallModel: async (init: RequestInit): Promise<Response> => {
      smallModelCalls.push({ signal: init.signal ?? undefined });
      return smallModelImpl(init);
    },
  }));
  // `smallModelRequest` imports sonner at module scope; the mock above
  // replaces the whole module, so sonner never loads.

  const enhanceContext = { directory: '/repo', sessionId: null };

  // Reset the per-test seams the module-level beforeEach cannot reach.
  beforeEach(() => {
    smallModelCalls.length = 0;
    smallModelImpl = () => new Promise<Response>(() => {});
  });

  test('a caller deadline firing during a hung overrides fetch maps to timed-out, and the shared slot clears when the transport settles', async () => {
    // The shared transport hangs; the composed CALLER deadline (1ms, far
    // inside the shared request's own 20s) aborts the shared wait;
    // enhancePrompt reads the fired caller deadline as `timed-out`. The
    // shared transport itself is NOT aborted by the caller wait — the
    // in-flight slot only clears when the shared request settles on its own.
    transportImpl = hangUntilAborted('TimeoutError');
    let timedOut: PromptEnhanceError | null = null;
    try {
      await enhancePrompt('draft', enhanceContext, new AbortController().signal, { timeoutMs: 1 });
    } catch (error) {
      // SAFETY: the failure surface is the typed service error.
      timedOut = error as PromptEnhanceError;
    }
    expect(timedOut?.reason).toBe('timed-out');
    // The shared transport's internal deadline signal was never aborted by
    // the caller wait (the wait left; the transport deadline is its own).
    expect(transportSignals[0].aborted).toBe(false);

    // The shared request is still in flight on its own deadline (which never
    // fires within this test), so the next caller coalesces onto it — one
    // transport call total.
    const transport = settleable();
    transportImpl = transport;
    const stillWaiting = renderMagicPrompt('composer.enhance.instructions');
    await nextTick();
    expect(transport.callCount).toBe(0); // still coalescing onto the first request

    // The shared transport's OWN deadline then fires: a load miss, not a
    // caller abort. The still-waiting caller resolves the default template
    // (graceful), never an abort-named rejection, and the slot clears.
    Object.defineProperty(transportSignals[0], 'aborted', { value: true });
    transportSignals[0].dispatchEvent(new Event('abort'));
    const instructions = await stillWaiting;
    expect(instructions).toBe(getDefaultMagicPromptTemplate('composer.enhance.instructions'));
    await nextTick();

    // Now a fresh caller starts a NEW request that succeeds.
    const retry = fetchMagicPromptOverrides();
    transport.release({ 'composer.enhance.instructions': 'RETRY' });
    expect(transport.callCount).toBe(1);
    expect((await retry)['composer.enhance.instructions']).toBe('RETRY');
  });

  test('a shared transport deadline inside the Enhance budget degrades to the default template and the request still carries the draft', async () => {
    // THE Enhance-side regression companion: the shared transport's internal
    // 20s deadline fires well inside Enhance's 90s budget. That is a load
    // miss, not the caller's deadline, so Enhance proceeds with the DEFAULT
    // built-in template and sends the generate request — graceful, never
    // `timed-out`.
    transportImpl = hangUntilAborted('TimeoutError');
    smallModelImpl = (init) => {
      // SAFETY: the body is `JSON.stringify(buildEnhanceRequestBody(...))`
      // from promptEnhancer; parse back into its owner type.
      const body = JSON.parse(String(init.body)) as EnhanceRequestBody;
      return Promise.resolve(new Response(JSON.stringify({ text: `rewritten:${body.prompt}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    };
    const enhanceWait = enhancePrompt('draft', enhanceContext, new AbortController().signal);
    await nextTick();
    expect(smallModelCalls).toHaveLength(0); // still waiting on the overrides fetch

    // Fire the shared transport's own internal deadline.
    Object.defineProperty(transportSignals[0], 'aborted', { value: true });
    transportSignals[0].dispatchEvent(new Event('abort'));

    const enhanced = await enhanceWait;
    // The generate request went out carrying the draft, instructed by the
    // default template — the overrides miss degraded, nothing threw.
    expect(smallModelCalls).toHaveLength(1);
    expect(enhanced).toBe('rewritten:draft');

    // The fired deadline belonged to the shared transport; its slot cleared,
    // so a fresh caller starts a NEW request. Release it before awaiting
    // (an unreleased settleable request would deadlock the test).
    const transport = settleable();
    transportImpl = transport;
    const retry = fetchMagicPromptOverrides();
    transport.release({ 'composer.enhance.instructions': 'RETRY' });
    expect(transport.callCount).toBe(1);
    expect((await retry)['composer.enhance.instructions']).toBe('RETRY');
  });

  test('a caller cancel during the shared wait maps to aborted while the shared fetch still fills the cache', async () => {
    const transport = settleable();
    transportImpl = transport;
    const controller = new AbortController();
    const enhanceWait = enhancePrompt('draft', enhanceContext, controller.signal, { timeoutMs: 90_000 });
    await nextTick();
    expect(smallModelCalls).toHaveLength(0); // never got past the instructions fetch

    controller.abort();
    let failure: PromptEnhanceError | null = null;
    try { await enhanceWait; } catch (error) {
      // SAFETY: the failure surface is the typed service error.
      failure = error as PromptEnhanceError;
    }
    expect(failure?.reason).toBe('aborted');

    // The shared fetch was not cancelled by the caller cancel; when it
    // settles it fills the cache for later callers.
    expect(transportSignals[0].aborted).toBe(false);
    transport.release({ 'composer.enhance.instructions': 'LATE-OVERRIDE' });
    await nextTick();
    expect((await fetchMagicPromptOverrides())['composer.enhance.instructions']).toBe('LATE-OVERRIDE');
  });
});
