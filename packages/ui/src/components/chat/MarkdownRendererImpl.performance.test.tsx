import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TextPart } from '@opencode-ai/sdk/v2';

type OperationCounts = {
  innerHTMLWrites: number;
  spriteIconInnerHTMLWrites: number;
  querySelectorAllCalls: number;
  appendCalls: number;
  replaceCalls: number;
  removeCalls: number;
  getBoundingClientRectCalls: number;
  viewBoxWrites: number;
  resizeObserverCreates: number;
  resizeObserverObserveCalls: number;
  geometrySequence: Array<'read' | 'write'>;
};

type FixtureMetrics = OperationCounts & {
  renderers: number;
  markdownBlocks: number;
  mermaidBlocks: number;
  mermaidRenderedCount: number;
  mermaidSvgCount: number;
};

const fixture = [
  '# Synthetic mount fixture',
  '',
  'A paragraph with **bold text**, a table, and a stable link.',
  '',
  '| name | value |',
  '| --- | ---: |',
  '| alpha | 1 |',
  '| beta | 2 |',
  '',
  '```typescript',
  'const answer = 42;',
  'console.log(answer);',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B[Finish]',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  Client[Client] --> Server[Server]',
  '```',
].join('\n');

const fixtureWorkload = {
  rendererCount: 3,
  domBlocksPerRenderer: 1,
  mermaidBlocksPerRenderer: 2,
};

let windowInstance: Window;
let previousGlobals: Map<string, PropertyDescriptor | undefined>;
let activeCounts: OperationCounts | null = null;
let animationFrameQueue: FrameRequestCallback[] = [];
let notifyResize: ((entries: Array<{ target: Element; contentRect: { width: number; height: number } }>) => void) | null = null;
let MarkdownRenderer: React.ComponentType<{
  content: string;
  messageId: string;
  part?: TextPart;
  isAnimated?: boolean;
  isStreaming?: boolean;
  enableFileReferences?: boolean;
}>;
let clearDetachedMarkdownDomCache: () => void;
let detachedMarkdownDomCacheStats: () => { sessions: number; entries: number };

const makeCounts = (): OperationCounts => ({
  innerHTMLWrites: 0,
  spriteIconInnerHTMLWrites: 0,
  querySelectorAllCalls: 0,
  appendCalls: 0,
  replaceCalls: 0,
  removeCalls: 0,
  getBoundingClientRectCalls: 0,
  viewBoxWrites: 0,
  resizeObserverCreates: 0,
  resizeObserverObserveCalls: 0,
  geometrySequence: [],
});

const installGlobal = (name: string, value: Window[keyof Window]): void => {
  previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

const waitForSettledEffects = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  await Promise.resolve();
};

const flushAnimationFrame = async (): Promise<void> => {
  const callbacks = animationFrameQueue;
  animationFrameQueue = [];
  await act(async () => {
    for (const callback of callbacks) callback(windowInstance.performance.now());
    await Promise.resolve();
  });
};

const flushDeferredMermaidInitialization = async (): Promise<void> => {
  await flushAnimationFrame();
  await flushAnimationFrame();
};

const mountFixture = async (rendererCount: number): Promise<{
  root: Root;
  host: HTMLDivElement;
  operations: OperationCounts;
  counts: FixtureMetrics;
}> => {
  const counts = makeCounts();
  activeCounts = counts;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <>
        {Array.from({ length: rendererCount }, (_, index) => (
          <MarkdownRenderer
            key={`fixture-${index}`}
            content={fixture}
            messageId={`fixture-message-${index}`}
            isAnimated={false}
            enableFileReferences={false}
          />
        ))}
      </>,
    );
    await waitForSettledEffects();
  });
  await act(async () => waitForSettledEffects());

  const mermaidBlocks = host.querySelectorAll('[data-markdown="mermaid-block"]').length;
  const mermaidRenderedCount = host.querySelectorAll('[data-mermaid-render]').length;
  const mermaidSvgCount = host.querySelectorAll('[data-markdown="mermaid"] svg').length;
  return {
    root,
    host,
    operations: counts,
    counts: {
      ...counts,
      renderers: rendererCount,
      markdownBlocks: host.querySelectorAll('[data-md-block]').length,
      mermaidBlocks,
      mermaidRenderedCount,
      mermaidSvgCount,
    },
  };
};

const runFixture = async (rendererCount: number): Promise<FixtureMetrics> => {
  const { root, host, operations } = await mountFixture(rendererCount);
  await flushDeferredMermaidInitialization();
  const counts: FixtureMetrics = {
    ...operations,
    renderers: rendererCount,
    markdownBlocks: host.querySelectorAll('[data-md-block]').length,
    mermaidBlocks: host.querySelectorAll('[data-markdown="mermaid-block"]').length,
    mermaidRenderedCount: host.querySelectorAll('[data-mermaid-render]').length,
    mermaidSvgCount: host.querySelectorAll('[data-markdown="mermaid"] svg').length,
  };
  await act(async () => root.unmount());
  return counts;
};

const initializePerformanceDom = async (): Promise<void> => {
  windowInstance = new Window({ url: 'http://localhost/' });
  windowInstance.document.write('<!doctype html><html><head></head><body></body></html>');
  windowInstance.document.close();
  previousGlobals = new Map();
  installGlobal('window', windowInstance);
  installGlobal('document', windowInstance.document);
  installGlobal('navigator', windowInstance.navigator);
  installGlobal('customElements', windowInstance.customElements);
  for (const name of ['Document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Text', 'NodeFilter', 'MutationObserver', 'DOMParser', 'XMLSerializer', 'HTMLAnchorElement', 'HTMLButtonElement']) {
    // SAFETY: these names are the DOM constructors installed by this happy-dom Window.
    const globalValue = windowInstance[name as keyof Window];
    if (globalValue === undefined) throw new Error(`happy-dom global is unavailable: ${name}`);
    installGlobal(name, globalValue);
  }
  Object.defineProperty(windowInstance, 'matchMedia', { configurable: true, value: () => ({ matches: false, media: '', onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) });
  Object.defineProperty(windowInstance, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
    animationFrameQueue.push(callback);
    return animationFrameQueue.length;
  } });
  Object.defineProperty(windowInstance, 'cancelAnimationFrame', { configurable: true, value: () => undefined });
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  const elementPrototype = Element.prototype;
  const nodePrototype = Node.prototype;
  const documentPrototype = Document.prototype;
  const innerHTMLDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (!innerHTMLDescriptor?.set || !innerHTMLDescriptor.get) throw new Error('happy-dom innerHTML descriptor unavailable');
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: true,
    get: innerHTMLDescriptor.get,
    set(value: string) {
      if (activeCounts) {
        activeCounts.innerHTMLWrites += 1;
        if (value.includes('href="#oc-')) activeCounts.spriteIconInnerHTMLWrites += 1;
      }
      innerHTMLDescriptor.set?.call(this, value);
    },
  });
  const originalQuerySelectorAll = elementPrototype.querySelectorAll;
  Object.defineProperty(elementPrototype, 'querySelectorAll', { configurable: true, value: function (selectors: string): NodeListOf<Element> {
    if (activeCounts) activeCounts.querySelectorAllCalls += 1;
    return originalQuerySelectorAll.call(this, selectors);
  } });
  const originalDocumentQuerySelectorAll = documentPrototype.querySelectorAll;
  Object.defineProperty(documentPrototype, 'querySelectorAll', { configurable: true, value: function (selectors: string): NodeListOf<Element> {
    if (activeCounts) activeCounts.querySelectorAllCalls += 1;
    return originalDocumentQuerySelectorAll.call(this, selectors);
  } });
  const originalAppendChild = nodePrototype.appendChild;
  Object.defineProperty(nodePrototype, 'appendChild', { configurable: true, value: function (node: Node): Node {
    if (activeCounts) activeCounts.appendCalls += 1;
    return originalAppendChild.call(this, node);
  } });
  const originalReplaceWith = elementPrototype.replaceWith;
  Object.defineProperty(elementPrototype, 'replaceWith', { configurable: true, value: function (...nodes: (Node | string)[]): void {
    if (activeCounts) activeCounts.replaceCalls += 1;
    return originalReplaceWith.apply(this, nodes);
  } });
  const originalRemove = elementPrototype.remove;
  Object.defineProperty(elementPrototype, 'remove', { configurable: true, value: function (): void {
    if (activeCounts) activeCounts.removeCalls += 1;
    return originalRemove.call(this);
  } });
  const originalGetBoundingClientRect = elementPrototype.getBoundingClientRect;
  Object.defineProperty(elementPrototype, 'getBoundingClientRect', { configurable: true, value: function (): DOMRect {
    if (activeCounts) {
      activeCounts.getBoundingClientRectCalls += 1;
      activeCounts.geometrySequence.push('read');
    }
    return originalGetBoundingClientRect.call(this);
  } });
  const svgSetAttribute = SVGElement.prototype.setAttribute;
  Object.defineProperty(SVGElement.prototype, 'setAttribute', { configurable: true, value: function (name: string, value: string): void {
    if (name === 'viewBox' && activeCounts && this.closest('[data-markdown="mermaid"]')) {
      activeCounts.viewBoxWrites += 1;
      activeCounts.geometrySequence.push('write');
    }
    return svgSetAttribute.call(this, name, value);
  } });
  class CountingResizeObserver {
    constructor(callback: (entries: Array<{ target: Element; contentRect: { width: number; height: number } }>) => void) {
      if (activeCounts) activeCounts.resizeObserverCreates += 1;
      notifyResize = callback;
    }

    observe(): void {
      if (activeCounts) activeCounts.resizeObserverObserveCalls += 1;
    }

    unobserve(): void {}

    disconnect(): void {}
  }
  installGlobal('ResizeObserver', CountingResizeObserver);

  const fakeState = {
    openContextPreview: () => undefined,
    codeBlockLineWrap: false,
    mermaidRenderingMode: 'svg',
  };
  type UIStateSelection = typeof fakeState[keyof typeof fakeState];
  const { mock } = await import('bun:test');
  mock.module('@/lib/utils', () => ({ cn: (...values: string[]) => values.filter(Boolean).join(' ') }));
  mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
  mock.module('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
  mock.module('@/stores/useUIStore', () => ({ useUIStore: Object.assign((selector: (state: typeof fakeState) => UIStateSelection) => selector(fakeState), { getState: () => fakeState }) }));
  mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => null }));
  mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ editor: undefined, runtime: { isVSCode: false } }) }));
  mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => ({ ok: false }) }));
  mock.module('@/lib/url', () => ({ getUrlScheme: () => null, isAppLinkUrl: () => false, isExternalHttpUrl: () => false, openConfirmedAppLinkUrl: async () => false, openExternalUrl: async () => undefined, getExternalFaviconUrl: () => null, isLoopbackHttpUrl: () => false }));
  mock.module('@/lib/desktop', () => ({ isDesktopLocalOriginActive: () => false, isDesktopShell: () => false, isVSCodeRuntime: () => false }));
  mock.module('@/lib/runtimeSurface', () => ({ isMobileSurfaceRuntime: () => false }));
  mock.module('@/lib/outsideFileGrants', () => ({ ensureOutsideFileGrantForDesktop: async () => undefined }));
  mock.module('@/lib/path-utils', () => ({ getDirectoryForFilePath: () => '', isFilePathWithinDirectory: () => true, toAbsoluteFilePath: () => '', normalizeFilePath: (value: string) => value, isAbsoluteFilePath: (value: string) => value.startsWith('/') }));
  mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: async () => undefined }));
  mock.module('beautiful-mermaid', () => ({
    renderMermaidASCII: () => 'diagram',
    renderMermaidSVG: () => '<svg viewBox="0 0 240 120" width="240" height="120"><path d="M0 0h1v1z" /></svg>',
  }));
  mock.module('@/stores/utils/streamDebug', () => ({ streamPerfCount: () => undefined, streamPerfObserve: () => undefined }));
  mock.module('./markdown/markdown-worker', () => ({
    highlightCodeInWorker: async () => null,
    highlightLinesInWorker: async () => null,
    highlightTokensInWorker: async () => null,
  }));
  mock.module('./message/FadeInOnReveal', () => ({ FadeInOnReveal: ({ children }: { children: React.ReactNode }) => children }));
  const imported = await import('./MarkdownRendererImpl');
  MarkdownRenderer = imported.MarkdownRenderer;
  const { detachedMarkdownDomCache } = await import('./markdown/detachedMarkdownDomCache');
  clearDetachedMarkdownDomCache = () => detachedMarkdownDomCache.clear();
  detachedMarkdownDomCacheStats = () => detachedMarkdownDomCache.stats();
};

await initializePerformanceDom();

afterAll(() => {
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('MarkdownRenderer DOM mount performance contract', () => {
  test('builds Markdown sprite controls without parsing SVG markup', async () => {
    const mounted = await mountFixture(1);

    const spriteControlCount = mounted.host.querySelectorAll('[data-md-action] use[href^="#oc-"]').length;
    const spriteIconInnerHTMLWrites = mounted.operations.spriteIconInnerHTMLWrites;
    await act(async () => mounted.root.unmount());

    expect(spriteControlCount).toBeGreaterThan(0);
    expect(spriteIconInnerHTMLWrites).toBe(0);
  });

  test('reuses settled Markdown DOM without parsing or decorating it again', async () => {
    clearDetachedMarkdownDomCache();
    const content = '# Cached viewport\n\nA settled paragraph.';
    const part: TextPart = {
      id: 'part-cache',
      sessionID: 'session-cache',
      messageID: 'message-cache',
      type: 'text',
      text: content,
      time: { start: 0, end: 1 },
    };
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const render = (root: Root) => root.render(
      <MarkdownRenderer
        content={content}
        messageId="message-cache"
        part={part}
        isAnimated={false}
        enableFileReferences={false}
      />,
    );

    const firstCounts = makeCounts();
    activeCounts = firstCounts;
    const firstRoot = createRoot(host);
    await act(async () => {
      render(firstRoot);
      await waitForSettledEffects();
    });
    const originalBlock = host.querySelector('[data-md-block]');
    expect(originalBlock).not.toBeNull();
    expect(firstCounts.innerHTMLWrites).toBeGreaterThan(0);
    await act(async () => firstRoot.unmount());

    const secondCounts = makeCounts();
    activeCounts = secondCounts;
    const secondRoot = createRoot(host);
    await act(async () => {
      render(secondRoot);
      await waitForSettledEffects();
    });
    expect(host.querySelector('[data-md-block]')).toBe(originalBlock);
    expect(secondCounts.innerHTMLWrites).toBe(0);
    await act(async () => secondRoot.unmount());
    clearDetachedMarkdownDomCache();
  });

  test('does not cache streaming, unfinished, or Mermaid DOM', async () => {
    clearDetachedMarkdownDomCache();
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const renderScoped = (
      root: Root,
      content: string,
      partId: string,
      isStreaming = false,
    ) => root.render(
      <MarkdownRenderer
        content={content}
        messageId="message-cache"
        part={{
          id: partId,
          sessionID: 'session-cache',
          messageID: 'message-cache',
          type: 'text',
          text: content,
          time: { start: 0, end: 1 },
        }}
        isAnimated={false}
        isStreaming={isStreaming}
        enableFileReferences={false}
      />,
    );

    const streamingRoot = createRoot(host);
    await act(async () => {
      renderScoped(streamingRoot, 'streaming content', 'part-streaming', true);
      await waitForSettledEffects();
    });
    await act(async () => streamingRoot.unmount());
    expect(detachedMarkdownDomCacheStats().entries).toBe(0);

    const unfinalizedRoot = createRoot(host);
    await act(async () => {
      unfinalizedRoot.render(
        <MarkdownRenderer
          content="unfinalized content"
          messageId="message-unfinalized"
          part={{
            id: 'part-unfinalized',
            sessionID: 'session-cache',
            messageID: 'message-unfinalized',
            type: 'text',
            text: 'unfinalized content',
          }}
          isAnimated={false}
          enableFileReferences={false}
        />,
      );
      await waitForSettledEffects();
    });
    await act(async () => unfinalizedRoot.unmount());
    expect(detachedMarkdownDomCacheStats().entries).toBe(0);

    const mermaidRoot = createRoot(host);
    await act(async () => {
      renderScoped(mermaidRoot, '```mermaid\ngraph TD\nA --> B\n```', 'part-mermaid');
      await waitForSettledEffects();
    });
    await act(async () => mermaidRoot.unmount());
    expect(detachedMarkdownDomCacheStats().entries).toBe(0);

    clearDetachedMarkdownDomCache();
  });

  test('does not detach Markdown DOM that intersects the active selection', async () => {
    clearDetachedMarkdownDomCache();
    const content = 'selected content';
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={content}
          messageId="message-selected"
          part={{
            id: 'part-selected',
            sessionID: 'session-selected',
            messageID: 'message-selected',
            type: 'text',
            text: content,
            time: { start: 0, end: 1 },
          }}
          isAnimated={false}
          enableFileReferences={false}
        />,
      );
      await waitForSettledEffects();
    });
    const markdown = host.querySelector<HTMLElement>('[data-markdown-content]');
    if (!markdown) throw new Error('Expected mounted Markdown content');
    const originalGetSelection = window.getSelection;
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => ({
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => ({ intersectsNode: (node: Node) => node === markdown }),
      }),
    });

    try {
      await act(async () => root.unmount());
      expect(detachedMarkdownDomCacheStats().entries).toBe(0);
    } finally {
      Object.defineProperty(window, 'getSelection', { configurable: true, value: originalGetSelection });
      clearDetachedMarkdownDomCache();
    }
  });

  test('defers and batches Mermaid controller initialization after Markdown mount', async () => {
    const mounted = await mountFixture(fixtureWorkload.rendererCount);
    const critical = mounted.counts;

    expect(critical.getBoundingClientRectCalls).toBe(0);
    expect(critical.viewBoxWrites).toBe(0);
    expect(critical.resizeObserverCreates).toBe(0);
    expect(mounted.host.querySelectorAll('[data-markdown="mermaid"] svg')).toHaveLength(6);

    await flushDeferredMermaidInitialization();
    const metrics = {
      ...mounted.operations,
      renderers: fixtureWorkload.rendererCount,
      markdownBlocks: mounted.host.querySelectorAll('[data-md-block]').length,
      mermaidBlocks: mounted.host.querySelectorAll('[data-markdown="mermaid-block"]').length,
      mermaidRenderedCount: mounted.host.querySelectorAll('[data-mermaid-render]').length,
      mermaidSvgCount: mounted.host.querySelectorAll('[data-markdown="mermaid"] svg').length,
    };

    expect(metrics.renderers).toBe(3);
    expect(metrics.markdownBlocks).toBe(fixtureWorkload.rendererCount * fixtureWorkload.domBlocksPerRenderer);
    expect(metrics.mermaidBlocks).toBe(fixtureWorkload.rendererCount * fixtureWorkload.mermaidBlocksPerRenderer);
    expect(metrics.mermaidRenderedCount).toBeGreaterThan(0);
    expect(metrics.innerHTMLWrites).toBeGreaterThan(0);
    expect(metrics.querySelectorAllCalls).toBeGreaterThan(0);
    expect(metrics.appendCalls).toBeGreaterThan(0);
    expect(metrics.getBoundingClientRectCalls).toBe(metrics.mermaidRenderedCount);
    expect(metrics.viewBoxWrites).toBe(metrics.mermaidRenderedCount);
    expect(metrics.resizeObserverCreates).toBe(1);
    expect(metrics.resizeObserverObserveCalls).toBe(metrics.mermaidRenderedCount);
    expect(metrics.geometrySequence.lastIndexOf('read')).toBeLessThan(metrics.geometrySequence.indexOf('write'));

    const viewport = mounted.host.querySelector<HTMLElement>('[data-markdown="mermaid-viewport"]');
    if (!viewport || !notifyResize) throw new Error('Expected initialized Mermaid viewport and shared observer');
    const readsBeforeResize = mounted.operations.getBoundingClientRectCalls;
    const writesBeforeResize = mounted.operations.viewBoxWrites;
    notifyResize([{ target: viewport, contentRect: { width: 320, height: 180 } }]);
    expect(mounted.operations.getBoundingClientRectCalls).toBe(readsBeforeResize);
    expect(mounted.operations.viewBoxWrites).toBe(writesBeforeResize + 1);
    console.log(JSON.stringify({ fixture: fixtureWorkload, baseline: metrics }));
    await act(async () => mounted.root.unmount());
  });

  test('cancels deferred Mermaid initialization when the renderer unmounts first', async () => {
    const mounted = await mountFixture(1);
    await act(async () => mounted.root.unmount());
    await flushDeferredMermaidInitialization();

    expect(mounted.operations.getBoundingClientRectCalls).toBe(0);
    expect(mounted.operations.viewBoxWrites).toBe(0);
    expect(mounted.operations.resizeObserverCreates).toBe(0);
  });

  test('keeps DOM operation fanout linear when renderer count doubles', async () => {
    const three = await runFixture(3);
    const six = await runFixture(6);

    expect(six.mermaidBlocks).toBe(three.mermaidBlocks * 2);
    expect(six.mermaidRenderedCount).toBe(three.mermaidRenderedCount * 2);
    expect(six.innerHTMLWrites).toBeLessThanOrEqual(three.innerHTMLWrites * 2 + 6);
    expect(six.querySelectorAllCalls).toBeLessThanOrEqual(three.querySelectorAllCalls * 2 + 12);
    expect(six.appendCalls).toBeLessThanOrEqual(three.appendCalls * 2 + 12);
    expect(six.getBoundingClientRectCalls).toBe(three.getBoundingClientRectCalls * 2);
    expect(six.viewBoxWrites).toBe(three.viewBoxWrites * 2);
    expect(three.resizeObserverCreates).toBe(1);
    expect(six.resizeObserverCreates).toBe(1);
    expect(six.resizeObserverObserveCalls).toBe(three.resizeObserverObserveCalls * 2);
  });
});
