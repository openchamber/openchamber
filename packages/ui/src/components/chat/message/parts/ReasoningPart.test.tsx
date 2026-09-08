import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type Part } from '@opencode-ai/sdk/v2';
import { SyncProvider } from '@/sync/sync-context';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';

import { I18nProvider } from '@/lib/i18n';
import ReasoningPart, { ReasoningTimelineBlock } from './ReasoningPart';
import type { StreamPhase } from '../types';

// Bun does not implement Vite's asset-query imports. Preserve the real asset
// URL while keeping the renderer and worker client modules unchanged.
plugin({
  name: 'reasoning-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const unavailable = (): never => { throw new Error('Reasoning scrolling must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
  get tools() { return unavailable(); },
};
const sdk = createOpencodeClient({
  baseUrl: 'http://localhost',
  fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
});
const TestProviders = ({ children }: { children: React.ReactNode }) => (
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider sdk={sdk} directory="">
      <I18nProvider>{children}</I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>
);

type ReasoningPartFixture = Extract<Part, { type: 'reasoning' }>;

/**
 * Mounts a real client root against a happy-dom document so mount/unmount
 * lifecycle is observable. bun test shares globalThis across a file, so the
 * globals React DOM reads are defined here and restored afterwards; defining
 * them directly avoids asserting that happy-dom's objects are the platform
 * `Window`/`Document`.
 */
const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'customElements',
  'Node',
  'NodeList',
  'Element',
  'HTMLElement',
  'SVGElement',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'ResizeObserver',
  'MutationObserver',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDomStub = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const observers: ResizeObserverStub[] = [];
  class ResizeObserverStub implements ResizeObserver {
    readonly targets = new Set<Element>();
    disconnectCount = 0;

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() {
      this.disconnectCount += 1;
      this.targets.clear();
    }
    notify() {
      if (this.targets.size > 0) this.callback([], this);
    }
  }
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: ResizeObserverStub,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  // Read back through the global bindings just installed, so the container is
  // typed as the DOM element React expects rather than happy-dom's own class.
  const container = document.createElement('div');
  document.body.appendChild(container);

  return {
    container,
    observers,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

// A reasoning text whose summary (first 120 chars) fits in the header but
// whose expanded body content should only appear when the disclosure is open.
const LONG_REASONING =
  'First thought about the task at hand and how to approach it carefully.\n' +
  'This second line goes into much deeper detail about the internal reasoning ' +
  'process that should remain hidden in the collapsed header view.';

// A long text that should render the collapsible header with a label
const LONG_JUSTIFICATION =
  'Sorting by activity first because the active session needs immediate attention.\n' +
  'Secondary sort by last updated timestamp ensures a stable deterministic ordering ' +
  'when multiple sessions have the same activity state.';

describe('ReasoningTimelineBlock', () => {
  test('renders reasoning traces behind an accessible collapsed disclosure by default', () => {
    const markup = renderToStaticMarkup(
      <TestProviders>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="reasoning-test"
          showDuration={false}
        />
      </TestProviders>,
    );

    // Accessible toggle row is rendered
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');

    // Summary preview (beginning of text) is visible in the header
    expect(markup).toContain('First thought');

    // Historical collapsed blocks do not mount the expanded body, avoiding a
    // first-frame flash when Activity reveals previously hidden rows.
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('renders "Justification" label for justification variant when pre-expanded and not streaming', () => {
    const markup = renderToStaticMarkup(
      <TestProviders>
        <ReasoningTimelineBlock
          text={LONG_JUSTIFICATION}
          variant="justification"
          blockId="justification-test"
          showDuration={false}
          defaultExpanded={true}
        />
      </TestProviders>,
    );

    // Label shown in expanded header should be "Justification" not "Thinking"
    expect(markup).toContain('Justification');
    expect(markup).not.toContain('Thinking');
  });

  test('renders "Thinking" label for thinking variant when pre-expanded and not streaming', () => {
    const markup = renderToStaticMarkup(
      <TestProviders>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="thinking-test"
          showDuration={false}
          defaultExpanded={true}
        />
      </TestProviders>,
    );

    // Label shown in expanded header should be "Thinking"
    expect(markup).toContain('Thinking');
  });

  test('header summary is a truncated excerpt from the beginning', () => {
    const markup = renderToStaticMarkup(
      <TestProviders>
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="reasoning-test"
          showDuration={false}
        />
      </TestProviders>,
    );

    // Deep body content beyond 120 chars should be cut from the summary span
    expect(markup).not.toContain('remain hidden in the collapsed header view');
    // The ellipsis character marks that the text was truncated
    expect(markup).toContain('…');
  });

  test('omits trailing empty HTML comments from the header summary', () => {
    const markup = renderToStaticMarkup(
      <TestProviders>
        <ReasoningTimelineBlock
          text={'Planning accessible icon labels with translations <!-- -->'}
          variant="thinking"
          blockId="reasoning-comment-test"
          showDuration={false}
        />
      </TestProviders>,
    );

    expect(markup).toContain('Planning accessible icon labels with translations');
    expect(markup).not.toContain('&lt;!-- --&gt;');
  });
});

// Regression tests for issue #2020: a persisted reasoning part must not be
// presented as live streaming just because cached data lacks `time.end` or a
// stream phase. Live activity derives from the live stream phase only.
describe('ReasoningPart streaming gating (issue #2020)', () => {
  // Short enough (< 80 chars) that the collapsed header summary contains the
  // complete text, letting us assert full content on first paint.
  const SHORT_REASONING = 'Persisted reasoning text that is already fully available.';

  const BUSY_INDICATOR = 'animate-busy-pulse';

  const makeReasoningPart = (
    time: ReasoningPartFixture['time'],
    text: string = SHORT_REASONING,
  ): ReasoningPartFixture => ({
    id: 'prt_reasoning_2020',
    sessionID: 'ses_2020',
    messageID: 'msg_2020',
    type: 'reasoning',
    text,
    time,
  });

  // Server rendering reads the UI store's initial state, which is
  // chatRenderMode 'live' — the mode in which the streaming presentation is
  // reachable and the issue reproduces.
  const renderPart = (part: ReasoningPartFixture, streamPhase?: StreamPhase): string =>
    renderToStaticMarkup(
      <TestProviders>
        <ReasoningPart part={part} messageId="msg_2020" streamPhase={streamPhase} />
      </TestProviders>,
    );

  test('reasoning without time.end and without a live stream phase renders complete, not streaming', () => {
    // Freshly opened completed session: cached part never received `time.end`
    // and no message-level stream phase is available. The full text is already
    // local, so the block must render as finished content on first paint.
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), undefined);

    expect(markup).not.toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(SHORT_REASONING);
  });

  test('reasoning without time.end in a completed message renders complete, not streaming', () => {
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), 'completed');

    expect(markup).not.toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(SHORT_REASONING);
  });

  test('reasoning with time.end is never treated as streaming, even when the phase claims streaming', () => {
    const markup = renderPart(makeReasoningPart({ start: 1_000, end: 2_000 }), 'streaming');

    expect(markup).not.toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(SHORT_REASONING);
  });

  test('live in-progress reasoning still renders as streaming', () => {
    // Genuinely live: the message-level stream phase reports streaming and the
    // part has not ended. The block auto-expands and shows the busy indicator.
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), 'streaming');

    expect(markup).toContain(BUSY_INDICATOR);
    expect(markup).toContain('aria-expanded="true"');
  });

  test('streaming reasoning stays inside the capped nested scroll box', () => {
    // The box is capped while streaming too, so a long thought scrolls inside
    // its own box instead of growing the timeline; it is marked as a nested
    // scroller so an upward wheel over it scrolls the box before the chat.
    const markup = renderPart(makeReasoningPart({ start: 1_000 }), 'streaming');

    expect(markup).toContain('max-h-80');
    expect(markup).toContain('data-scrollable="true"');
  });

  test('a live part with no committed text yet shows the busy header and no empty summary', () => {
    // The streaming early-return keeps the block mounted before the block-level
    // reveal commits a first line. The header must read as busy and must not
    // paint an empty summary row.
    const markup = renderPart(makeReasoningPart({ start: 1_000 }, ''), 'streaming');
    const withText = renderPart(makeReasoningPart({ start: 1_000 }), undefined);

    expect(markup).toContain(BUSY_INDICATOR);
    expect(markup).toContain('role="button"');
    // The summary span carries `title="<summary>"`; with no text there must be
    // no summary span at all rather than an empty one.
    expect(withText).toContain('title="');
    expect(markup).not.toContain('title="');
  });

  test('remounting a completed reasoning part does not re-trigger the streaming presentation', async () => {
    // renderToStaticMarkup cannot observe this: it has no mount lifecycle, so
    // comparing two server renders is true by construction. Mount, unmount and
    // remount a real client root instead, watching the busy indicator across
    // every commit.
    const dom = installDomStub();
    const part = makeReasoningPart({ start: 1_000 });
    const busySeen: boolean[] = [];
    const root = createRoot(dom.container);

    const renderTree = () =>
      React.createElement(
        TestProviders,
        null,
        React.createElement(ReasoningPart, { part, messageId: 'msg_2020', streamPhase: undefined }),
      );

    try {
      await act(async () => {
        root.render(renderTree());
      });
      busySeen.push(dom.container.innerHTML.includes(BUSY_INDICATOR));
      expect(dom.container.textContent).toContain(SHORT_REASONING);

      await act(async () => {
        root.render(null);
      });
      await act(async () => {
        root.render(renderTree());
      });
      busySeen.push(dom.container.innerHTML.includes(BUSY_INDICATOR));

      expect(busySeen).toEqual([false, false]);
      expect(dom.container.textContent).toContain(SHORT_REASONING);
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.restore();
    }
  });
});

describe('ReasoningTimelineBlock live follow', () => {
  test('scrollbar scrolling releases live follow and returning to the bottom resumes it', async () => {
    const dom = installDomStub();
    const root = createRoot(dom.container);
    const renderBlock = (isStreaming: boolean) => (
      <TestProviders>
        <ReasoningTimelineBlock
          text="Working through the task step by step."
          variant="thinking"
          blockId="reasoning-follow"
          defaultExpanded
          isStreaming={isStreaming}
          showDuration={false}
        />
      </TestProviders>
    );

    try {
      await act(async () => { root.render(renderBlock(true)); });
      const scroller = dom.container.querySelector<HTMLElement>('[data-scrollable="true"]');
      if (!scroller) throw new Error('Expected the mounted reasoning scroll box');
      const body = scroller.firstElementChild;
      const followObserver = dom.observers.find((observer) => observer.targets.size === 1 && body && observer.targets.has(body));
      if (!followObserver) throw new Error('Expected an observer of the reasoning body');

      let contentHeight = 800;
      Object.defineProperties(scroller, {
        clientHeight: { configurable: true, value: 320 },
        scrollHeight: { configurable: true, get: () => contentHeight },
      });
      await act(async () => { followObserver.notify(); });
      expect(scroller.scrollTop).toBe(480);

      // A scrollbar drag emits scroll, without a wheel or touch event.
      await act(async () => {
        scroller.scrollTop = 120;
        scroller.dispatchEvent(new window.Event('scroll'));
      });
      contentHeight = 1000;
      await act(async () => { followObserver.notify(); });
      expect(scroller.scrollTop).toBe(120);

      await act(async () => {
        scroller.scrollTop = 680;
        scroller.dispatchEvent(new window.Event('scroll'));
      });
      contentHeight = 1200;
      await act(async () => { followObserver.notify(); });
      expect(scroller.scrollTop).toBe(880);

      await act(async () => { root.render(renderBlock(false)); });
      expect(followObserver.disconnectCount).toBe(1);
      expect(followObserver.targets.size).toBe(0);
      contentHeight = 1400;
      await act(async () => { followObserver.notify(); });
      expect(scroller.scrollTop).toBe(880);
    } finally {
      await act(async () => { root.unmount(); });
      dom.restore();
    }
  });
});
