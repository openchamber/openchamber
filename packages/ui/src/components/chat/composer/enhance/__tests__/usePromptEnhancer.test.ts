import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

// The hook reaches the network only through `enhancePrompt`; that seam is
// mocked. `@/lib/i18n` is typed-only for the hook but still loads its store,
// so it is mocked to keep the test hermetic.
mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// happy-dom supplies the document identity React's host renderer needs; the
// hook under test touches no DOM beyond React's own host bookkeeping.
const win = new Window({ url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { configurable: true, value: win.window ?? win });
Object.defineProperty(globalThis, 'document', { configurable: true, value: win.document });
// SAFETY: only the boolean flag is assigned on globalThis; React's act reads
// it to decide whether state updates are inside an awaited act() scope.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The mocked PromptEnhanceError must be defined outside the mock factory so
// the hook's `instanceof` check sees the same class the thrown errors carry.
class MockPromptEnhanceError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PromptEnhanceError';
    this.reason = reason;
  }
}

// Scripted transport: each test pushes a resolution the in-flight enhance
// call awaits, so ordering across two concurrent requests stays explicit.
type ScriptedResolve = { text: string; delayMs?: number } | { error: Error; delayMs?: number };
type EnhancePromptImpl = (draft: string, context: PromptEnhanceContext, signal: AbortSignal) => Promise<string>;
let script: ScriptedResolve[] = [];
const scriptedEnhancePrompt: EnhancePromptImpl = async (_draft, _context, signal) => {
  const step = script.shift();
  if (!step) throw new Error('no scripted enhance response');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, step.delayMs ?? 0);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      // The transport layer surfaces a cancellation as a raw DOMException-
      // shaped Error, not as the typed error — mirror that here.
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      reject(abortError);
    }, { once: true });
  });
  if ('error' in step) throw step.error;
  return step.text;
};
// A test may swap the scripted transport entirely (e.g. a raw abort that
// rejects independently of the signal, or a never-settling request that
// proves a new operation does not wait for the old transport); the default
// is restored after.
let enhancePromptImpl: EnhancePromptImpl = scriptedEnhancePrompt;
const mockEnhancePromptImplementation = (impl: EnhancePromptImpl): void => {
  enhancePromptImpl = impl;
};
const restoreEnhancePromptImplementation = (): void => {
  enhancePromptImpl = scriptedEnhancePrompt;
};

mock.module('../promptEnhancer', () => ({
  ENHANCE_INSTRUCTIONS_ID: 'composer.enhance.instructions',
  PromptEnhanceError: MockPromptEnhanceError,
  enhancePrompt: (draft: string, context: PromptEnhanceContext, signal: AbortSignal): Promise<string> =>
    enhancePromptImpl(draft, context, signal),
}));

import { usePromptEnhancer } from '../usePromptEnhancer';
import type { PromptEnhanceContext } from '../promptEnhancer';
import type { ComposerLanguageContext } from '../../language/tokenize';

const languageContext: ComposerLanguageContext = {
  inputMode: 'normal',
  knownAgentNames: new Set(),
  confirmedMentions: new Set(),
  knownSlashNames: new Set(),
  knownSnippetTriggers: new Set(),
  attachmentFilenames: [],
};

const enhanceContext = { directory: '/repo', sessionId: null };

/** The hook's result, as ChatInput consumes it. */
type EnhanceOutcome = Awaited<ReturnType<ReturnType<typeof usePromptEnhancer>['enhance']>>;

interface Harness {
  isEnhancing: () => boolean;
  /** Runs one enhance to settlement and resolves its outcome. */
  enhance: (draft: string) => Promise<EnhanceOutcome>;
  /** Starts an enhance without awaiting; resolves the hook's raw promise. */
  startEnhance: (draft: string) => Promise<EnhanceOutcome>;
  cancel: () => void;
  /** Reports a draft change to the hook, as ChatInput's change handler does. */
  noteDraftChanged: (liveDraft: string) => void;
  unmount: () => void;
  /** Swaps the language context the hook is rendered with, as a re-render would. */
  setLanguageContext: (next: ComposerLanguageContext) => void;
  /** Swaps the draft scope key the hook is rendered with, as a session switch would. */
  setScopeKey: (next: string | null) => void;
  /**
   * Per-render (scopeKey, isEnhancing) log in render order. The entry for the
   * first render carrying a new scopeKey isolates the render-phase
   * derivation: React renders before passive effects, so the scope effect
   * has not run for that render yet.
   */
  renderLog: () => ReadonlyArray<{ scopeKey: string | null; isEnhancing: boolean }>;
  /**
   * Arms an enhance that starts from a useLayoutEffect on the next commit.
   * React runs layout effects before passive effects within the same commit,
   * so the armed enhance overwrites the hook's active operation BEFORE the
   * hook's passive scope effect runs — the "user clicks enhance in the new
   * scope before the scope effect ran" interleaving, made deterministic.
   */
  armEnhanceOnScopeSwitch: (draft: string) => void;
  /** The armed enhance's promise (null when the layout effect never started one). */
  armedEnhance: () => Promise<EnhanceOutcome>;
}

function renderHarness(
  initialContext: ComposerLanguageContext = languageContext,
  initialScopeKey: string | null = 'scope-a',
): Harness {
  const container = document.createElement('div');
  const root = createRoot(container);
  let captured: {
    isEnhancing: boolean;
    enhance: (draft: string, context: typeof enhanceContext) => Promise<EnhanceOutcome>;
    cancel: () => void;
    noteDraftChanged: (liveDraft: string) => void;
  } | null = null;
  // Read at render time so tests can swap the context the way ChatInput does:
  // its languageContext memo returns a fresh object whenever its inputs
  // recompute, so a re-render can hand the hook a rebuilt object.
  let currentContext = initialContext;
  let currentScopeKey = initialScopeKey;
  const renderLog: Array<{ scopeKey: string | null; isEnhancing: boolean }> = [];
  let scheduledEnhanceDraft: string | null = null;
  let scheduledEnhancePromise: Promise<EnhanceOutcome> | null = null;

  function Probe() {
    const hook = usePromptEnhancer({
      languageContext: currentContext,
      scopeKey: currentScopeKey,
    });
    captured = {
      isEnhancing: hook.isEnhancing,
      enhance: hook.enhance,
      cancel: hook.cancel,
      noteDraftChanged: hook.noteDraftChanged,
    };
    renderLog.push({ scopeKey: currentScopeKey, isEnhancing: hook.isEnhancing });
    // Runs on every commit; only an armed draft starts an enhance. Layout
    // effects fire before passive effects in the same commit, so this
    // intercepts the hook's scope effect deterministically.
    React.useLayoutEffect(() => {
      if (scheduledEnhanceDraft === null) return;
      const draft = scheduledEnhanceDraft;
      scheduledEnhanceDraft = null;
      scheduledEnhancePromise = hook.enhance(draft, enhanceContext);
    });
    return null;
  }

  act(() => { root.render(React.createElement(Probe)); });
  const getEnhance = () => {
    if (!captured) throw new Error('hook was not rendered');
    return captured.enhance;
  };
  return {
    isEnhancing: () => captured?.isEnhancing ?? false,
    enhance: async (draft: string) => {
      // React's act thenable resolves before the callback's continuation
      // runs, so the result must be read after awaiting act, never through
      // a chained .then.
      let result: EnhanceOutcome | undefined;
      await act(async () => {
        result = await getEnhance()(draft, enhanceContext);
      });
      // SAFETY: the awaited act callback settled the enhance before returning.
      return result!;
    },
    startEnhance: (draft: string) => getEnhance()(draft, enhanceContext),
    cancel: () => { act(() => { captured?.cancel(); }); },
    noteDraftChanged: (nextDraft: string) => {
      act(() => { captured?.noteDraftChanged(nextDraft); });
    },
    unmount: () => { act(() => { root.unmount(); }); },
    setLanguageContext: (next: ComposerLanguageContext) => {
      currentContext = next;
      act(() => { root.render(React.createElement(Probe)); });
    },
    setScopeKey: (next: string | null) => {
      currentScopeKey = next;
      act(() => { root.render(React.createElement(Probe)); });
    },
    renderLog: () => renderLog,
    armEnhanceOnScopeSwitch: (draft: string) => {
      scheduledEnhanceDraft = draft;
    },
    armedEnhance: () => {
      if (!scheduledEnhancePromise) throw new Error('armed enhance never started');
      return scheduledEnhancePromise;
    },
  };
}

beforeEach(() => {
  script = [];
});

describe('usePromptEnhancer', () => {
  test('a successful enhance applies the rewrite to the unchanged draft', async () => {
    script = [{ text: 'improved draft' }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('my draft');
      expect(result.outcome).toBe('applied');
      if (result.outcome === 'applied') {
        expect(result.text).toBe('improved draft');
        expect(result.sourceSnapshot).toBe('my draft');
      }
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a response landing after a rebuilt-but-equal context still applies', async () => {
    // ChatInput rebuilds its languageContext memo whenever its inputs
    // recompute — including the setIsEnhancing(true) render that starts the
    // request. Staleness is judged by the registry values, not object
    // identity, so this response must apply.
    script = [{ text: 'improved draft', delayMs: 30 }];
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.setLanguageContext({
        inputMode: 'normal',
        knownAgentNames: new Set(),
        confirmedMentions: new Set(),
        knownSlashNames: new Set(),
        knownSnippetTriggers: new Set(),
        attachmentFilenames: [],
      });
      const result = await promise;
      // settle() flips isEnhancing outside act (the promise resolves before
      // React flushes), so flush once before asserting the spinner state.
      await act(async () => {});
      expect(result.outcome).toBe('applied');
      if (result.outcome === 'applied') {
        expect(result.text).toBe('improved draft');
        expect(result.sourceSnapshot).toBe('my draft');
      }
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a response landing after a materially changed context stays stale', async () => {
    // A registry change (here: shell mode) between request and response means
    // the rewrite answered for a different composer language — stale. The
    // context change alone must NOT cancel the op: only scope and draft do,
    // so the promise still resolves through the normal response path.
    script = [{ text: 'improved draft', delayMs: 30 }];
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.setLanguageContext({
        inputMode: 'shell',
        knownAgentNames: new Set(),
        confirmedMentions: new Set(),
        knownSlashNames: new Set(),
        knownSnippetTriggers: new Set(),
        attachmentFilenames: [],
      });
      const result = await promise;
      await act(async () => {});
      expect(result.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a rewrite that loses a protected mention fails as invalid-result', async () => {
    script = [{ text: 'improved draft without the token' }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('fix @src/auth.ts');
      expect(result).toEqual({ outcome: 'failed', reason: 'invalid-result' });
    } finally {
      harness.unmount();
    }
  });

  test('a rewrite that invents a protected token fails as invalid-result', async () => {
    script = [{ text: 'improved draft #snippet' }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('plain draft text');
      expect(result).toEqual({ outcome: 'failed', reason: 'invalid-result' });
    } finally {
      harness.unmount();
    }
  });

  test('a failure keeps the outcome with its reason and no text', async () => {
    script = [{ error: new MockPromptEnhanceError('empty-result', 'empty') }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('my draft');
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toBe('empty-result');
        expect('text' in result).toBe(false);
      }
    } finally {
      harness.unmount();
    }
  });

  test('a deadline failure surfaces as timed-out, not stale', async () => {
    // The service maps a fired deadline to the typed reason; the hook must
    // pass it through so ChatInput can toast it (unlike a silent abort).
    script = [{ error: new MockPromptEnhanceError('timed-out', 'deadline') }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('my draft');
      expect(result).toEqual({ outcome: 'failed', reason: 'timed-out' });
    } finally {
      harness.unmount();
    }
  });

  test('a raw transport abort resolves silently as stale', async () => {
    // The mocked transport rejects with a plain Error named AbortError — the
    // shape a fetch cancellation surfaces when it bypasses the service layer.
    // SAFETY: the holder only ever stores the mocked promise's reject fn.
    const rejectHolder = { reject: undefined as ((error: Error) => void) | undefined };
    mockEnhancePromptImplementation(() => new Promise<string>((_resolve, reject) => {
      rejectHolder.reject = reject;
    }));
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.cancel();
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      rejectHolder.reject?.(abortError);
      const result = await promise;
      expect(result.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
      restoreEnhancePromptImplementation();
    }
  });

  test('cancel during flight resolves silently and never applies', async () => {
    script = [{ text: 'late rewrite', delayMs: 50 }];
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.cancel();
      const result = await promise;
      expect(result.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a second enhance invalidates the first (first resolves late → stale)', async () => {
    script = [
      { text: 'first rewrite', delayMs: 50 },
      { text: 'second rewrite' },
    ];
    const harness = renderHarness();
    try {
      const firstPromise = harness.startEnhance('first draft');
      const second = await harness.enhance('second draft');
      expect(second.outcome).toBe('applied');
      if (second.outcome === 'applied') {
        expect(second.text).toBe('second rewrite');
      }
      const first = await firstPromise;
      expect(first.outcome).toBe('stale');
    } finally {
      harness.unmount();
    }
  });

  test('isEnhancing turns off once the request settles', async () => {
    script = [{ text: 'rewrite' }];
    const harness = renderHarness();
    try {
      expect(harness.isEnhancing()).toBe(false);
      await harness.enhance('my draft');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a late response after unmount resolves stale, not applied', async () => {
    script = [{ text: 'late rewrite', delayMs: 50 }];
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.unmount();
      const result = await promise;
      expect(result.outcome).toBe('stale');
    } finally {
      // Idempotent for the already-unmounted root.
      harness.unmount();
    }
  });

  test('a scope switch invalidates the running enhance and the new scope enhances immediately', async () => {
    // Session switch A→B while A's transport is still settling: A's operation
    // is invalidated at once, B's enhance starts immediately, and A's late
    // response is ignored. A's finally must not clear B's busy state — B
    // runs on a transport that never settles on its own, so isEnhancing only
    // drops when B is cancelled.
    // A transport that never resolves on its own but honors abort — proving
    // the busy state survives the old op's cleanup until B itself settles.
    const neverSettlingAbortAware = (_draft: string, _context: PromptEnhanceContext, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted.');
          abortError.name = 'AbortError';
          reject(abortError);
        }, { once: true });
      });
    script = [
      { text: 'late rewrite for A', delayMs: 30 },
      { text: 'rewrite for B' },
    ];
    const harness = renderHarness(languageContext, 'session-a');
    try {
      const firstPromise = harness.startEnhance('draft A');
      // Flush the setIsEnhancing(true) render before asserting.
      await act(async () => {});
      expect(harness.isEnhancing()).toBe(true);

      // Switch scope while A is still in flight.
      harness.setScopeKey('session-b');
      expect(harness.isEnhancing()).toBe(false);

      // B starts immediately on the never-settling transport.
      mockEnhancePromptImplementation(neverSettlingAbortAware);
      const secondPromise = harness.startEnhance('draft B');
      // Let A's aborted transport settle and its finally fire; flush B's
      // busy-state render in the same pass.
      await act(async () => {});
      const first = await firstPromise;
      expect(first.outcome).toBe('stale');
      // A's cleanup must not have released B's spinner.
      expect(harness.isEnhancing()).toBe(true);

      // Cancel B and verify the spinner finally settles.
      harness.cancel();
      const second = await secondPromise;
      expect(second.outcome).toBe('stale');
      await act(async () => {});
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
      restoreEnhancePromptImplementation();
    }
  });

  test('switching back to the previous scope starts clean (no spinner, enhance works)', async () => {
    // A→B→A: when returning to A the op started under A was already
    // invalidated, so no spinner survives the round trip and a new enhance
    // in A works normally. The first scripted step is the one A's request
    // consumed before the switch discarded it.
    script = [
      { text: 'discarded rewrite for A', delayMs: 30 },
      { text: 'rewrite for A again' },
    ];
    const harness = renderHarness(languageContext, 'session-a');
    try {
      const firstPromise = harness.startEnhance('draft A');
      await act(async () => {});
      expect(harness.isEnhancing()).toBe(true);

      harness.setScopeKey('session-b');
      const first = await firstPromise;
      expect(first.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);

      harness.setScopeKey('session-a');
      expect(harness.isEnhancing()).toBe(false);
      const result = await harness.enhance('draft A again');
      expect(result.outcome).toBe('applied');
      if (result.outcome === 'applied') {
        expect(result.text).toBe('rewrite for A again');
      }
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a scope switch renders B non-busy in that very render, before the scope effect runs', async () => {
    // The busy state is DERIVED against the current scope during render, not
    // stored and cleared by an effect: the first render carrying session B
    // must already report isEnhancing=false while A's operation is still the
    // hook's active one. Render order proves the derivation is what is under
    // test: React renders before passive effects, so the log entry for B's
    // first render was written before the scope effect could have invalidated
    // anything.
    script = [{ text: 'late rewrite for A', delayMs: 30 }];
    const harness = renderHarness(languageContext, 'session-a');
    try {
      const firstPromise = harness.startEnhance('draft A');
      await act(async () => {});
      expect(harness.isEnhancing()).toBe(true);
      const rendersBeforeSwitch = harness.renderLog().length;

      // Switch scope while A is still in flight.
      harness.setScopeKey('session-b');
      expect(harness.isEnhancing()).toBe(false);

      // The very first B render — written before any effect could flush —
      // already saw B as non-busy even though A's operation was still active.
      const bRenders = harness.renderLog().slice(rendersBeforeSwitch);
      expect(bRenders.length).toBeGreaterThan(0);
      expect(bRenders[0]).toEqual({ scopeKey: 'session-b', isEnhancing: false });

      // And A's transport really was still live across that render: its late
      // response settles stale only through the effect-side invalidation.
      const first = await firstPromise;
      expect(first.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('an enhance started in B before the scope effect ran survives that effect and owns the op', async () => {
    // Theoretical-but-proven interleaving: A runs, the scope switches to B,
    // and an enhance for B starts BEFORE the hook's passive scope effect ran
    // (here via a layout effect, which React runs before passive effects in
    // the same commit — a stronger ordering than any real user event, which
    // effects always precede). The B enhance overwrites the active operation
    // with B's scope; the scope effect must then NOT invalidate it (it only
    // cleans up an op belonging to the previous scope), A's late finally is a
    // no-op on the generation mismatch, and B stays busy until it settles.
    script = [
      { text: 'late rewrite for A', delayMs: 30 },
      { text: 'rewrite for B' },
    ];
    const harness = renderHarness(languageContext, 'session-a');
    try {
      const firstPromise = harness.startEnhance('draft A');
      await act(async () => {});
      expect(harness.isEnhancing()).toBe(true);

      // Arm B's enhance so the scope-switch commit starts it from a layout
      // effect — before the hook's passive scope effect runs.
      harness.armEnhanceOnScopeSwitch('draft B');
      harness.setScopeKey('session-b');
      const secondPromise = harness.armedEnhance();

      // B's op survived the scope effect (its generation still settles
      // 'applied' — A's invalidation would have made it stale) and B is busy.
      const second = await secondPromise;
      expect(second.outcome).toBe('applied');
      if (second.outcome === 'applied') {
        expect(second.text).toBe('rewrite for B');
      }
      // settle() flips the derived state outside act (the promise resolves
      // before React flushes), so flush once before asserting the spinner.
      await act(async () => {});
      expect(harness.isEnhancing()).toBe(false);

      // A stayed stale: B's overwrite bumped the generation before A settled.
      const first = await firstPromise;
      expect(first.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a draft edit while enhancing cancels the op promptly; the late result is ignored and a new enhance starts', async () => {
    // Enhance("draft 1") → noteDraftChanged("draft 2"): the op settles as
    // cancelled without awaiting its response, the late "draft 1" rewrite is
    // not applied, and a new enhance for "draft 2" starts immediately — the
    // old op's finally cannot clear the new op's busy state.
    const neverSettlingAbortAware = (_draft: string, _context: PromptEnhanceContext, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted.');
          abortError.name = 'AbortError';
          reject(abortError);
        }, { once: true });
      });
    mockEnhancePromptImplementation(neverSettlingAbortAware);
    const harness = renderHarness();
    try {
      const firstPromise = harness.startEnhance('draft 1');
      await act(async () => {});
      expect(harness.isEnhancing()).toBe(true);

      // The draft changed → the op is invalidated synchronously, without
      // awaiting its response.
      harness.noteDraftChanged('draft 2');
      expect(harness.isEnhancing()).toBe(false);

      // A new enhance for the new draft starts immediately even though the
      // old transport never settles on its own.
      const secondPromise = harness.startEnhance('draft 2');
      await act(async () => {});
      const first = await firstPromise;
      expect(first.outcome).toBe('stale');
      // The old op's cleanup must not clear the new op's spinner.
      expect(harness.isEnhancing()).toBe(true);

      // Cancel the new op and verify the spinner settles.
      harness.cancel();
      const second = await secondPromise;
      expect(second.outcome).toBe('stale');
      await act(async () => {});
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
      restoreEnhancePromptImplementation();
    }
  });

  test('an equal draft notification is a no-op while enhancing', async () => {
    // noteDraftChanged with the same text must not cancel the running op —
    // ordinary change events that do not move the draft stay harmless.
    script = [{ text: 'improved draft', delayMs: 30 }];
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.noteDraftChanged('my draft');
      const result = await promise;
      expect(result.outcome).toBe('applied');
      await act(async () => {});
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a scope-key change is ignored while nothing is active', async () => {
    // The invalidation effect must be a no-op when no op is running: switching
    // scope with nothing in flight does not spin anything up or corrupt state,
    // and the next enhance in the new scope works.
    script = [{ text: 'rewrite in scope b' }];
    const harness = renderHarness(languageContext, 'session-a');
    try {
      harness.setScopeKey('session-b');
      expect(harness.isEnhancing()).toBe(false);
      const result = await harness.enhance('my draft');
      expect(result.outcome).toBe('applied');
      if (result.outcome === 'applied') {
        expect(result.text).toBe('rewrite in scope b');
      }
    } finally {
      harness.unmount();
    }
  });

  test('unmount during flight cancels the transport (no late landings after remount)', async () => {
    // Unmount bumps the generation and aborts; a fresh mount afterwards must
    // start with no spinner and a working enhance — the old op's late
    // rejection resolves stale against the new generation.
    script = [{ text: 'late rewrite', delayMs: 30 }];
    const first = renderHarness();
    const firstPromise = first.startEnhance('my draft');
    first.unmount();
    const firstResult = await firstPromise;
    expect(firstResult.outcome).toBe('stale');

    // Fresh mount: clean state, new enhance works.
    script = [{ text: 'fresh rewrite' }];
    const harness = renderHarness();
    try {
      expect(harness.isEnhancing()).toBe(false);
      const result = await harness.enhance('my draft');
      expect(result.outcome).toBe('applied');
      if (result.outcome === 'applied') {
        expect(result.text).toBe('fresh rewrite');
      }
    } finally {
      harness.unmount();
    }
  });

  test('success after an explicit cancel: a new enhance applies normally', async () => {
    // cancel() → silent stale → the next enhance is a fresh authoritative op
    // that applies.
    script = [
      { text: 'late rewrite', delayMs: 30 },
      { text: 'second rewrite' },
    ];
    const harness = renderHarness();
    try {
      const firstPromise = harness.startEnhance('my draft');
      harness.cancel();
      const first = await firstPromise;
      expect(first.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);

      const second = await harness.enhance('my draft');
      expect(second.outcome).toBe('applied');
      if (second.outcome === 'applied') {
        expect(second.text).toBe('second rewrite');
      }
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });
});
