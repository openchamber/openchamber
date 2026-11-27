import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { Window } from 'happy-dom';
import { buildWalkthroughView } from '@/lib/walkthrough/model';
import type { WalkthroughResult } from '@/lib/walkthrough/types';
import { findRunKey } from './walkthroughFind';

plugin({
  name: 'walkthrough-worker-url',
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
  },
});

const makeResult = (): WalkthroughResult => ({
  source: { kind: 'working-tree', scope: 'all' },
  walkthrough: {
    title: 'Walkthrough',
    focus: 'Review focus',
    chapters: [
      {
        id: 'c1',
        title: 'Chapter 1',
        icon: 'wrench',
        blurb: '',
        stops: [
          {
            id: 's1',
            title: 'First step',
            hunkIds: ['h1', 'h2'],
            importance: 'normal',
            prose: 'Step one prose.',
          },
        ],
      },
    ],
  },
  hunks: [
    {
      id: 'h1',
      path: 'src/a.ts',
      oldPath: null,
      status: 'modified',
      scope: 'all',
      header: '@@ -1,1 +1,1 @@',
      newStart: 1,
      added: 1,
      deleted: 1,
      patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-oldA\n+newA\n',
    },
    {
      id: 'h2',
      path: 'src/b.ts',
      oldPath: null,
      status: 'modified',
      scope: 'all',
      header: '@@ -1,1 +1,1 @@',
      newStart: 1,
      added: 1,
      deleted: 1,
      patch: 'diff --git a/src/b.ts b/src/b.ts\n@@ -1,1 +1,1 @@\n-oldB\n+newB\n',
    },
  ],
  hunkCount: 2,
});

test('WalkthroughStream folds steps and files, collapses reviewed files, and reveals on find', async () => {
  const dom = new Window({ url: 'http://localhost' });
  dom.happyDOM.setWindowSize({ width: 1280, height: 800 });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const noopObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    location: dom.location,
    localStorage: dom.localStorage,
    Element: dom.Element,
    Document: dom.Document,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLDivElement: dom.HTMLDivElement,
    HTMLInputElement: dom.HTMLInputElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement,
    SVGElement: dom.SVGElement,
    Node: dom.Node,
    customElements: dom.customElements,
    CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: noopObserver,
    IntersectionObserver: noopObserver,
    Worker: class {
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
    },
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), previousFetch);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);

  try {
    const { OpenCode } = await import('@opencode/client');
    const { SyncProvider } = await import('@/sync/sync-context');
    const { I18nProvider } = await import('@/lib/i18n');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const { WalkthroughStream } = await import('./WalkthroughStream');
    const sdk = OpenCode.make({ baseUrl: 'http://walkthrough.test', fetch: () => new Promise<Response>(() => undefined) });
    const result = makeResult();
    const view = buildWalkthroughView(result)!;
    const runKeyA = findRunKey('s1', 0, [result.hunks[0]]);

    const EMPTY_SET: ReadonlySet<string> = new Set();

    const Harness = ({
      reviewed = EMPTY_SET,
      revealRequest = null,
    }: {
      reviewed?: ReadonlySet<string>;
      revealRequest?: { stopId: string; runKey: string; path: string; nonce: number } | null;
    }) => {
      const [reviewedPaths, setReviewedPaths] = React.useState<ReadonlySet<string>>(reviewed);
      React.useEffect(() => {
        setReviewedPaths(reviewed);
      }, [reviewed]);
      return (
        <SyncProvider sdk={sdk} directory="/repo">
          <I18nProvider>
            <TooltipProvider>
              <WalkthroughStream
                view={view}
                activeStopId="s1"
                scrollToStopId={null}
                onActiveStopChange={() => {}}
                onScrollHandled={() => {}}
                renderSideBySide={false}
                wrapLines={false}
                reviewedPaths={reviewedPaths}
                onToggleFileReviewed={(path) => {
                  setReviewedPaths((prev) => {
                    const next = new Set(prev);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  });
                }}
                revealRequest={revealRequest}
              />
            </TooltipProvider>
          </I18nProvider>
        </SyncProvider>
      );
    };

    const render = async (props?: Parameters<typeof Harness>[0]) => {
      await act(async () => {
        root.render(<Harness {...props} />);
      });
    };

    await render();

    // Initially step and both files are expanded
    expect(host.textContent).toContain('Step one prose.');
    const fileButtons = () => Array.from(host.querySelectorAll<HTMLElement>('[role="button"][aria-expanded]'));
    expect(fileButtons().length).toBe(2);
    expect(fileButtons()[0].getAttribute('aria-expanded')).toBe('true');
    expect(fileButtons()[1].getAttribute('aria-expanded')).toBe('true');

    // Fold file A individually
    await act(async () => {
      fileButtons()[0].click();
    });
    expect(fileButtons()[0].getAttribute('aria-expanded')).toBe('false');
    expect(fileButtons()[1].getAttribute('aria-expanded')).toBe('true');

    // Unfold file A again, then mark file A as reviewed -> collapses automatically
    await act(async () => {
      fileButtons()[0].click();
    });
    expect(fileButtons()[0].getAttribute('aria-expanded')).toBe('true');

    const reviewButtons = () => Array.from(
      host.querySelectorAll<HTMLButtonElement>('button[aria-label="Mark as reviewed"], button[aria-label="Unmark as reviewed"]'),
    );
    expect(reviewButtons().length).toBe(2);
    await act(async () => {
      reviewButtons()[0].click();
    });
    expect(fileButtons()[0].getAttribute('aria-expanded')).toBe('false');
    expect(reviewButtons()[0].getAttribute('aria-pressed')).toBe('true');

    // Fold the whole step -> prose and file headers disappear
    const stepButton = host.querySelector<HTMLButtonElement>('button[aria-label="Collapse step: First step"]');
    expect(stepButton).not.toBeNull();
    await act(async () => {
      stepButton?.click();
    });
    expect(host.textContent).not.toContain('Step one prose.');
    expect(fileButtons().length).toBe(0);

    // Find reveal opens both the collapsed step and the collapsed reviewed file A
    await render({
      reviewed: new Set(['src/a.ts']),
      revealRequest: { stopId: 's1', runKey: runKeyA, path: 'src/a.ts', nonce: 1 },
    });
    expect(host.textContent).toContain('Step one prose.');
    expect(fileButtons()[0].getAttribute('aria-expanded')).toBe('true');

    // Marking a Find-revealed file as reviewed again clears the reveal override and collapses it
    await render({
      reviewed: new Set(),
      revealRequest: { stopId: 's1', runKey: runKeyA, path: 'src/a.ts', nonce: 2 },
    });
    expect(fileButtons()[0].getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      reviewButtons()[0].click();
    });
    expect(fileButtons()[0].getAttribute('aria-expanded')).toBe('false');
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = previousFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
