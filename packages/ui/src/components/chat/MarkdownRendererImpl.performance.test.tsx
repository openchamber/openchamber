import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TextPart } from '@/lib/opencode/model';
import { getUrlScheme, isAppLinkUrl } from '@/lib/url';

const classifyAppLinkUrl = isAppLinkUrl;
const readUrlScheme = getUrlScheme;
let fileLinkTestDirectory: string | null = null;
// Files the stat route reports as existing, and references inside the
// workspace (probed) rather than outside it (linked without a probe).
let existingTestFiles = new Set<string>();
let fileLinksInsideWorkspace = false;
const statRequests: string[] = [];
const openedTestFiles: string[] = [];
let mobileSurfaceForTest = false;

type OperationCounts = {
  innerHTMLWrites: number;
  spriteIconInnerHTMLWrites: number;
  querySelectorAllCalls: number;
  appendCalls: number;
  replaceCalls: number;
  removeCalls: number;
  getBoundingClientRectCalls: number;
  tableProbeReads: number;
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
  // A settled message renders one block per top-level token: heading,
  // paragraph, table, code and two diagrams.
  domBlocksPerRenderer: 6,
  mermaidBlocksPerRenderer: 2,
};

let windowInstance: Window;
let previousGlobals: Map<string, PropertyDescriptor | undefined>;
let activeCounts: OperationCounts | null = null;
let animationFrameQueue: FrameRequestCallback[] = [];
let tableProbeWidths: Map<string, number> | null = null;
type ResizeNotifier = (entries: Array<{ target: Element; contentRect: { width: number; height: number } }>) => void;
let notifyResize: ResizeNotifier | null = null;
let notifyTableResize: ResizeNotifier | null = null;
let MarkdownRenderer: React.ComponentType<{
  content: string;
  messageId: string;
  part?: TextPart;
  isAnimated?: boolean;
  isStreaming?: boolean;
  enableFileReferences?: boolean;
}>;
let clearDetachedMarkdownDomCache: () => void;
// The worker is mocked; a test that needs highlighting swaps this in.
let highlightCodeForTest: (code: string, lang: string) => Promise<string | null> = async () => null;
let detachedMarkdownDomCacheStats: () => { sessions: number; entries: number };

const makeCounts = (): OperationCounts => ({
  innerHTMLWrites: 0,
  spriteIconInnerHTMLWrites: 0,
  querySelectorAllCalls: 0,
  appendCalls: 0,
  replaceCalls: 0,
  removeCalls: 0,
  getBoundingClientRectCalls: 0,
  tableProbeReads: 0,
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
  for (const name of ['Document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Text', 'NodeFilter', 'MutationObserver', 'DOMParser', 'XMLSerializer', 'HTMLAnchorElement', 'HTMLButtonElement', 'MouseEvent']) {
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
  Object.defineProperty(elementPrototype, 'getBoundingClientRect', { configurable: true, value: function (this: Element): DOMRect {
    if (activeCounts) {
      activeCounts.getBoundingClientRectCalls += 1;
      activeCounts.geometrySequence.push('read');
    }
    if (this.matches('table') && this.closest('[data-md-table-measure]')) {
      if (activeCounts) activeCounts.tableProbeReads += 1;
      const key = (this.textContent ?? '').trim();
      return new windowInstance.DOMRect(0, 0, tableProbeWidths?.get(key) ?? 0, 20);
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
  // Mermaid viewports and table containers each share one observer; observe
  // calls and notifyResize follow the Mermaid one.
  class CountingResizeObserver {
    private readonly callback: ResizeNotifier;

    constructor(callback: ResizeNotifier) {
      if (activeCounts) activeCounts.resizeObserverCreates += 1;
      this.callback = callback;
    }

    observe(target: Element): void {
      if (!target.matches('[data-markdown="mermaid-viewport"]')) {
        notifyTableResize = this.callback;
        return;
      }
      notifyResize = this.callback;
      if (activeCounts) activeCounts.resizeObserverObserveCalls += 1;
    }

    unobserve(): void {}

    disconnect(): void {}
  }
  installGlobal('ResizeObserver', CountingResizeObserver);

  const fakeState = {
    openContextPreview: () => undefined,
    openContextFile: (_directory: string, path: string) => { openedTestFiles.push(path); },
    codeBlockLineWrap: false,
    tableCellWrap: false,
    mermaidRenderingMode: 'svg',
  };
  type UIStateSelection = typeof fakeState[keyof typeof fakeState];
  const { mock } = await import('bun:test');
  mock.module('@/lib/utils', () => ({ cn: (...values: string[]) => values.filter(Boolean).join(' ') }));
  mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
  mock.module('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
  mock.module('@/stores/useUIStore', () => ({ useUIStore: Object.assign((selector: (state: typeof fakeState) => UIStateSelection) => selector(fakeState), { getState: () => fakeState }) }));
  mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => fileLinkTestDirectory }));
  mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ editor: undefined, runtime: { isVSCode: false } }) }));
  mock.module('@/lib/runtime-fetch', () => ({
    runtimeFetch: async (url: string) => {
      const statPath = new URL(url, 'http://test').searchParams.get('path');
      if (!url.startsWith('/api/fs/stat') || statPath === null) return { ok: false };
      statRequests.push(statPath);
      return { ok: true, json: async () => ({ exists: existingTestFiles.has(statPath) }) };
    },
  }));
  mock.module('@/lib/url', () => ({ getUrlScheme: readUrlScheme, isAppLinkUrl: classifyAppLinkUrl, isExternalHttpUrl: () => false, openConfirmedAppLinkUrl: async () => false, openExternalUrl: async () => undefined, getExternalFaviconUrl: () => null, isLoopbackHttpUrl: () => false }));
  mock.module('@/lib/desktop', () => ({ isDesktopLocalOriginActive: () => false, isDesktopShell: () => false, isVSCodeRuntime: () => false, openDesktopPath: async () => false }));
  mock.module('./useOpenChatLink', () => ({ useOpenChatLink: () => () => undefined }));
  mock.module('@/lib/runtimeSurface', () => ({ isMobileSurfaceRuntime: () => mobileSurfaceForTest }));
  mock.module('@/lib/router/openSessionFromRoute', () => ({ openSessionLink: async () => undefined }));
  mock.module('@/lib/path-utils', () => ({ getDirectoryForFilePath: () => '', isFilePathWithinDirectory: () => fileLinksInsideWorkspace || fileLinkTestDirectory === null, toAbsoluteFilePath: (_base: string, value: string) => `/outside/${value}`, normalizeFilePath: (value: string) => value, isAbsoluteFilePath: (value: string) => value.startsWith('/') }));
  mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: async () => undefined }));
  mock.module('beautiful-mermaid', () => ({
    renderMermaidASCII: () => 'diagram',
    renderMermaidSVG: () => '<svg viewBox="0 0 240 120" width="240" height="120"><path d="M0 0h1v1z" /></svg>',
  }));
  mock.module('@/stores/utils/streamDebug', () => ({ streamPerfCount: () => undefined, streamPerfObserve: () => undefined }));
  mock.module('./markdown/markdown-worker', () => ({
    highlightCodeInWorker: (code: string, lang: string) => highlightCodeForTest(code, lang),
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
  test('skips email and numeric suffix probes while preserving file references', async () => {
    const rejected = [
      'user@gmail.com', '@someone.ts', '@scope/package.json', 'src/user@host.ts',
      'gpt-5.4', '93.00', '3.49s', 'v1.2.3', '3.1.4', 'ls.1',
      'https://example.com/file.ts',
    ];
    const accepted = [
      '.env', '.config.json', './src/entry.ts', '../src/parent.ts', '/repo/absolute.ts',
      'path with spaces/file name.ts', 'file.test.ts', 'my-file.tar.gz', 'a-b.c',
      'shader.frag2', 'component.d-ts', 'README',
      // These remain ambiguous with filenames that have letter-leading extensions.
      '150.ms', 'accounts.google.com', 'client.messages.create', 'datetime.utcnow',
      'log.transports.file.level',
    ];
    fileLinkTestDirectory = '/detector-test';
    fileLinksInsideWorkspace = true;
    const resolvedPath = (value: string) => value.startsWith('/') ? value : `/outside/${value}`;
    existingTestFiles = new Set([...accepted, ...rejected, 'block/entry.ts'].map(resolvedPath));
    statRequests.length = 0;
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const content = [
      ...[...rejected, ...accepted].map((value) => `\`${value}\``),
      '```\ngpt-5.4\nuser@gmail.com\nblock/entry.ts:7\n```',
    ].join('\n\n');
    try {
      await act(async () => {
        root.render(<MarkdownRenderer
          content={content}
          messageId="file-path-detector"
          isAnimated={false}
          isStreaming={false}
          enableFileReferences
        />);
      });
      const deadline = Date.now() + 3000;
      while (!host.querySelector('[data-openchamber-file-link]') && Date.now() < deadline) {
        await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
        await flushAnimationFrame();
      }
      expect([...statRequests].sort()).toEqual([...accepted, 'block/entry.ts'].map(resolvedPath).sort());
      const links = host.querySelectorAll('[data-openchamber-file-link]');
      expect(Array.from(links).map((link) => link.textContent)).toEqual([...accepted, 'block/entry.ts:7']);
      expect(host.textContent).toContain('gpt-5.4');
    } finally {
      await act(async () => root.unmount());
      fileLinkTestDirectory = null;
      fileLinksInsideWorkspace = false;
      existingTestFiles = new Set();
    }
  });

  test('does not treat digit-leading extensions such as backup.7z, clip.3gp, and data.001 as file references', async () => {
    const filenames = ['backup.7z', 'clip.3gp', 'data.001'];
    const control = 'digit-extension/control.ts';
    fileLinkTestDirectory = '/digit-extension-test';
    fileLinksInsideWorkspace = true;
    existingTestFiles = new Set([...filenames, control].map((value) => `/outside/${value}`));
    statRequests.length = 0;
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<MarkdownRenderer
          content={[...filenames, control].map((value) => `\`${value}\``).join('\n\n')}
          messageId="digit-leading-extension-rejection"
          isAnimated={false}
          isStreaming={false}
          enableFileReferences
        />);
      });
      const deadline = Date.now() + 3000;
      while (!host.querySelector('[data-openchamber-file-link]') && Date.now() < deadline) {
        await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
        await flushAnimationFrame();
      }
      // The existing control file proves annotation ran; the other existing files are deliberately skipped.
      expect(statRequests).toEqual([`/outside/${control}`]);
      expect(Array.from(host.querySelectorAll('[data-openchamber-file-link]')).map((link) => link.textContent)).toEqual([control]);
      expect(Array.from(host.querySelectorAll('[data-markdown="inline-code"]')).map((code) => code.textContent)).toEqual([...filenames, control]);
    } finally {
      await act(async () => root.unmount());
      fileLinkTestDirectory = null;
      fileLinksInsideWorkspace = false;
      existingTestFiles = new Set();
    }
  });

  for (const mobile of [false, true]) {
    test(`keeps the probe-free click guard for backup.7z and icon@2x.png while skipping email probes, mobile=${mobile}`, async () => {
      fileLinkTestDirectory = '/click-guard-test';
      fileLinksInsideWorkspace = true;
      mobileSurfaceForTest = mobile;
      const hrefs = ['backup.7z', 'icon@2x.png', 'file:///repo/data.001'];
      const control = 'click-guard/control.ts';
      existingTestFiles = new Set(['user@gmail.com', ...hrefs, control].map((value) => `/outside/${value}`));
      statRequests.length = 0;
      openedTestFiles.length = 0;
      const host = document.createElement('div');
      document.body.replaceChildren(host);
      const root = createRoot(host);
      try {
        await act(async () => {
          root.render(<MarkdownRenderer
            content={['`user@gmail.com`', ...hrefs.map((href) => `[download](${href})`), `\`${control}\``].join('\n\n')}
            messageId={`legacy-click-guard-${mobile}`}
            isAnimated={false}
            isStreaming={false}
            enableFileReferences
          />);
        });
        if (!mobile) {
          const deadline = Date.now() + 3000;
          while (!host.querySelector('[data-openchamber-file-link]') && Date.now() < deadline) {
            await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
            await flushAnimationFrame();
          }
        }
        expect(statRequests).toEqual(mobile ? [] : [`/outside/${control}`]);
        const anchors = Array.from(host.querySelectorAll('a')).filter((anchor) => hrefs.includes(anchor.getAttribute('href') ?? ''));
        expect(anchors).toHaveLength(hrefs.length);
        for (const anchor of anchors) {
          expect(anchor.hasAttribute('data-openchamber-file-link')).toBe(false);
          expect(anchor.getAttribute('target')).toBe('_blank');
          const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
          await act(async () => { anchor.dispatchEvent(click); });
          expect(click.defaultPrevented).toBe(true);
        }
        expect(openedTestFiles).toEqual(['/outside/backup.7z', '/outside/icon@2x.png', '/repo/data.001']);
        expect(statRequests).toEqual(mobile ? [] : [`/outside/${control}`]);
      } finally {
        await act(async () => root.unmount());
        fileLinkTestDirectory = null;
        fileLinksInsideWorkspace = false;
        mobileSurfaceForTest = false;
        existingTestFiles = new Set();
        openedTestFiles.length = 0;
      }
    });
  }

  test('does not annotate app links with file-looking labels as internal file links', async () => {
    fileLinkTestDirectory = '/repo';
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const urls = [
      'vscode://file/C:/Project/src/PlayerData.luau:42',
      'cursor://file/Project/package.json:7',
    ];
    try {
      await act(async () => {
        root.render(<MarkdownRenderer
          content={`[PlayerData.luau:42](${urls[0]})\n\n[package.json:7](${urls[1]})\n\n\`ordinary.ts:12\``}
          messageId="app-file-links"
          isAnimated={false}
          isStreaming={false}
          enableFileReferences
        />);
        await waitForSettledEffects();
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
      await flushAnimationFrame();
      await act(async () => waitForSettledEffects());
      const anchors = host.querySelectorAll('a');
      expect(Array.from(anchors).map((anchor) => anchor.getAttribute('href'))).toEqual(urls);
      for (const anchor of anchors) {
        expect(anchor.hasAttribute('data-openchamber-file-link')).toBe(false);
      }
      // The annotation pass really ran: a normal reference still opens internally.
      expect(host.querySelector('[data-markdown="inline-code"]')?.getAttribute('data-openchamber-file-link')).toBe('true');
    } finally {
      await act(async () => root.unmount());
      fileLinkTestDirectory = null;
    }
  });

  test('links a path in a code block only after its file is confirmed', async () => {
    fileLinkTestDirectory = '/repo';
    fileLinksInsideWorkspace = true;
    existingTestFiles = new Set(['/outside/src/app.ts']);
    statRequests.length = 0;
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const code = 'src/app.ts:12 failed: console.log(this.state.ts)';
    const tokens = () => Array.from(host.querySelectorAll('pre code [data-openchamber-block-path-token]'));
    try {
      await act(async () => {
        root.render(<MarkdownRenderer
          content={`\`\`\`\n${code}\n\`\`\``}
          messageId="code-block-paths"
          isAnimated={false}
          isStreaming={false}
          enableFileReferences
        />);
        await waitForSettledEffects();
      });
      // Mounting writes nothing into the block.
      expect(tokens()).toHaveLength(0);

      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
      await flushAnimationFrame();
      await act(async () => waitForSettledEffects());

      // Every path-like token was probed, and only the real file became a link.
      expect([...new Set(statRequests)].sort()).toEqual(['/outside/console.log', '/outside/src/app.ts', '/outside/this.state.ts']);
      expect(tokens().map((token) => token.textContent)).toEqual(['src/app.ts:12']);
      expect(tokens()[0]?.getAttribute('data-openchamber-file-link')).toBe('true');
      expect(tokens()[0]?.getAttribute('data-openchamber-file-path')).toBe('/outside/src/app.ts');
      expect(host.querySelector('pre code')?.textContent).toContain(code);
    } finally {
      await act(async () => root.unmount());
      fileLinkTestDirectory = null;
      fileLinksInsideWorkspace = false;
      existingTestFiles = new Set();
    }
  });

  test('preserves disclosure choices through streaming, settlement, and redecorating', async () => {
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const prefix = 'Introduction\n\n<details><summary>Review</summary>\n\n';
    const render = async (content: string, streaming: boolean) => {
      await act(async () => {
        root.render(<MarkdownRenderer content={content} messageId="disclosures" isAnimated={false} isStreaming={streaming} enableFileReferences={false} />);
        await waitForSettledEffects();
      });
      await act(async () => waitForSettledEffects());
    };
    try {
      await render(`${prefix}First`, true);
      const first = host.querySelector<HTMLDetailsElement>('details');
      expect(first).not.toBeNull();
      expect(first?.open).toBe(false);
      expect(first?.querySelector('summary [data-md-disclosure-icon] use')?.getAttribute('href')).toBe('#oc-arrow-right-s');
      if (!first) throw new Error('Expected disclosure');
      first.open = true;
      for (let count = 1; count <= 5; count += 1) {
        await render(`${prefix}First\n\n${'More text. '.repeat(count)}`, true);
        expect(host.querySelector<HTMLDetailsElement>('details')?.open).toBe(true);
      }
      const settled = `${prefix}First\n\n</details>\n\n<details open><summary>Second</summary>\n\nBody\n\n</details>`;
      await render(settled, false);
      const disclosures = host.querySelectorAll<HTMLDetailsElement>('details');
      expect(disclosures).toHaveLength(2);
      expect(disclosures[0]?.open).toBe(true);
      expect(disclosures[1]?.open).toBe(true);
      disclosures[1]!.open = false;
      // The fixture supplies a fresh theme/translation context on each render,
      // exercising whole-block replacement with unchanged source as well.
      await render(settled, false);
      expect(host.querySelectorAll<HTMLDetailsElement>('details')[0]?.open).toBe(true);
      expect(host.querySelectorAll<HTMLDetailsElement>('details')[1]?.open).toBe(false);
      expect(host.querySelectorAll('summary [data-md-disclosure-icon]')).toHaveLength(2);
      await render('<details><summary>Different</summary>\n\nNew body\n\n</details>', false);
      expect(host.querySelector<HTMLDetailsElement>('details')?.open).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('marks only the last block as it grows, settles and shrinks', async () => {
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const render = async (content: string, streaming: boolean) => {
      await act(async () => {
        root.render(<MarkdownRenderer content={content} messageId="last-block" isAnimated={false} isStreaming={streaming} enableFileReferences={false} />);
        await waitForSettledEffects();
      });
      await act(async () => waitForSettledEffects());
    };
    const markedIndexes = () => Array.from(host.querySelectorAll('[data-md-block]'))
      .map((block, index) => (block.hasAttribute('data-md-last') ? index : -1))
      .filter((index) => index >= 0);
    const blockCount = () => host.querySelectorAll('[data-md-block]').length;
    try {
      await render('First', true);
      expect(markedIndexes()).toEqual([blockCount() - 1]);
      await render('First\n\nSecond\n\nThird', true);
      expect(blockCount()).toBeGreaterThan(1);
      expect(markedIndexes()).toEqual([blockCount() - 1]);
      await render('First\n\nSecond\n\nThird', false);
      expect(markedIndexes()).toEqual([blockCount() - 1]);
      await render('Only', false);
      expect(markedIndexes()).toEqual([blockCount() - 1]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('fixes body-sized table columns once the stream settles', async () => {
    const content = [
      '| An intentionally oversized header | Another oversized header | A third oversized header |',
      '| --- | --- | --- |',
      '| short | medium body value | very long body value |',
    ].join('\n');
    tableProbeWidths = new Map([
      ['short', 48],
      ['medium body value', 186],
      ['very long body value', 800],
    ]);
    const counts = makeCounts();
    activeCounts = counts;
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const render = (isStreaming: boolean) => root.render(
      <MarkdownRenderer
        content={content}
        messageId="table-width-message"
        isAnimated={false}
        isStreaming={isStreaming}
        enableFileReferences={false}
      />,
    );

    try {
      await act(async () => {
        render(true);
        await waitForSettledEffects();
      });
      await flushAnimationFrame();
      expect(host.querySelector('[data-markdown="table"]')?.getAttribute('data-md-table-layout')).toBe('pending');
      expect(counts.tableProbeReads).toBe(0);
      const pendingScroll = host.querySelector('[data-markdown="table"]')?.parentElement;
      expect(pendingScroll).not.toBeNull();
      Object.defineProperty(pendingScroll, 'clientWidth', { configurable: true, value: 600 });

      await act(async () => {
        render(false);
        await waitForSettledEffects();
      });
      await flushAnimationFrame();

      const table = host.querySelector<HTMLTableElement>('[data-markdown="table"]');
      const cells = Array.from(table?.querySelectorAll('th, td') ?? []);
      const columnWidths = Array.from(table?.querySelectorAll<HTMLTableColElement>('colgroup[data-md-table-columns] col') ?? [])
        .map((column) => column.style.width);
      const tableProbeReads = counts.tableProbeReads;
      await flushAnimationFrame();

      expect(table).not.toBeNull();
      expect(table?.getAttribute('data-md-table-layout')).toBe('fixed');
      expect(table?.style.tableLayout).toBe('fixed');
      expect(table?.style.width).toBe('906px');
      expect(columnWidths).toEqual(['120px', '186px', '600px']);
      expect(table?.classList.contains('w-max')).toBe(true);
      expect(table?.classList.contains('min-w-full')).toBe(false);
      expect(table?.classList.contains('w-full')).toBe(false);
      expect(table?.parentElement?.classList.contains('overflow-x-auto')).toBe(true);
      const wrapper = table?.closest('[data-markdown="table-wrapper"]');
      expect(wrapper?.classList.contains('w-fit')).toBe(true);
      expect(wrapper?.classList.contains('max-w-full')).toBe(true);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((cell) => cell.classList.contains('min-w-[120px]'))).toBe(true);
      expect(cells.every((cell) => !cell.classList.contains('max-w-[320px]'))).toBe(true);
      expect(cells.every((cell) => (
        cell.classList.contains('whitespace-normal')
        && cell.classList.contains('[overflow-wrap:anywhere]')
      ))).toBe(true);
      expect(counts.tableProbeReads).toBe(tableProbeReads);

      // A wider chat lays the table out again; a height-only change does not.
      const markdown = host.querySelector('[data-markdown-content]');
      if (!markdown || !notifyTableResize || !pendingScroll) throw new Error('Expected a watched table container');
      notifyTableResize([{ target: markdown, contentRect: { width: 640, height: 200 } }]);
      notifyTableResize([{ target: markdown, contentRect: { width: 640, height: 400 } }]);
      await flushAnimationFrame();
      expect(counts.tableProbeReads).toBe(tableProbeReads);
      Object.defineProperty(pendingScroll, 'clientWidth', { configurable: true, value: 1000 });
      notifyTableResize([{ target: markdown, contentRect: { width: 1040, height: 400 } }]);
      await flushAnimationFrame();
      expect(Array.from(table?.querySelectorAll<HTMLTableColElement>('colgroup[data-md-table-columns] col') ?? [])
        .map((column) => column.style.width)).toEqual(['120px', '186px', '800px']);
      expect(table?.style.width).toBe('1106px');
    } finally {
      tableProbeWidths = null;
      await act(async () => root.unmount());
    }
  });

  test('keeps an inline-code identifier on its natural-width column when the message has room', async () => {
    const content = [
      '| Widget | Processing state | Count |',
      '| --- | --- | ---: |',
      '| `widget-alpha` | `processing_completed_successfully` | 120 |',
      '| `widget-beta` | `processing_completed_with_warning` | 45 |',
    ].join('\n');
    tableProbeWidths = new Map([
      ['widget-alphawidget-beta', 150],
      ['processing_completed_successfullyprocessing_completed_with_warning', 420],
      ['12045', 80],
    ]);
    const host = document.createElement('div');
    host.style.width = '900px';
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const render = (isStreaming: boolean) => root.render(
      <MarkdownRenderer content={content} messageId="table-identifier" isAnimated={false} isStreaming={isStreaming} enableFileReferences={false} />,
    );

    try {
      await act(async () => {
        render(true);
        await waitForSettledEffects();
      });
      await flushAnimationFrame();
      const pendingScroll = host.querySelector('[data-markdown="table"]')?.parentElement;
      expect(pendingScroll).not.toBeNull();
      Object.defineProperty(pendingScroll, 'clientWidth', { configurable: true, value: 900 });
      await act(async () => {
        render(false);
        await waitForSettledEffects();
      });
      await flushAnimationFrame();

      const table = host.querySelector<HTMLTableElement>('[data-markdown="table"]');
      const columns = Array.from(table?.querySelectorAll<HTMLTableColElement>('colgroup col') ?? [])
        .map((column) => column.style.width);
      expect(table?.querySelector('td code')?.textContent).toBe('widget-alpha');
      expect(columns).toEqual(['150px', '420px', '120px']);
      expect(table?.style.width).toBe('690px');
      expect(table?.querySelector('td')?.classList.contains('max-w-[320px]')).toBe(false);
      expect(table?.querySelectorAll('td code.whitespace-nowrap')).toHaveLength(4);
      expect(table?.closest('[data-markdown="table-wrapper"]')?.classList.contains('w-fit')).toBe(true);
    } finally {
      tableProbeWidths = null;
      await act(async () => root.unmount());
    }
  });

  test('lets an identifier wider than the message wrap inside its capped column', async () => {
    const content = [
      '| Name | Path |',
      '| --- | --- |',
      '| `short` | `packages/ui/src/components/chat/markdown/an-identifier-too-wide-for-this-message.ts` |',
    ].join('\n');
    tableProbeWidths = new Map([
      ['short', 80],
      ['packages/ui/src/components/chat/markdown/an-identifier-too-wide-for-this-message.ts', 1400],
    ]);
    const host = document.createElement('div');
    host.style.width = '700px';
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const render = (isStreaming: boolean) => root.render(
      <MarkdownRenderer content={content} messageId="table-wide-identifier" isAnimated={false} isStreaming={isStreaming} enableFileReferences={false} />,
    );

    try {
      await act(async () => {
        render(true);
        await waitForSettledEffects();
      });
      await flushAnimationFrame();
      const pendingScroll = host.querySelector('[data-markdown="table"]')?.parentElement;
      expect(pendingScroll).not.toBeNull();
      Object.defineProperty(pendingScroll, 'clientWidth', { configurable: true, value: 700 });
      await act(async () => {
        render(false);
        await waitForSettledEffects();
      });
      await flushAnimationFrame();

      const table = host.querySelector<HTMLTableElement>('[data-markdown="table"]');
      const [fitting, capped] = Array.from(table?.querySelectorAll('td code') ?? []);
      expect(capped?.textContent).toContain('an-identifier-too-wide');
      expect(fitting?.classList.contains('whitespace-nowrap')).toBe(true);
      expect(capped?.classList.contains('whitespace-nowrap')).toBe(false);
    } finally {
      tableProbeWidths = null;
      await act(async () => root.unmount());
    }
  });

  test('wraps prose wider than the available message width while keeping table overflow scrollable', async () => {
    const content = [
      '| Step | Description |',
      '| --- | --- |',
      '| 1 | A sentence long enough to wrap once its column reaches the message width. |',
    ].join('\n');
    tableProbeWidths = new Map([
      ['1', 48],
      ['A sentence long enough to wrap once its column reaches the message width.', 1400],
    ]);
    const host = document.createElement('div');
    host.style.width = '700px';
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const render = (isStreaming: boolean) => root.render(
      <MarkdownRenderer content={content} messageId="table-prose" isAnimated={false} isStreaming={isStreaming} enableFileReferences={false} />,
    );

    try {
      await act(async () => {
        render(true);
        await waitForSettledEffects();
      });
      await flushAnimationFrame();
      const pendingScroll = host.querySelector('[data-markdown="table"]')?.parentElement;
      expect(pendingScroll).not.toBeNull();
      Object.defineProperty(pendingScroll, 'clientWidth', { configurable: true, value: 700 });
      await act(async () => {
        render(false);
        await waitForSettledEffects();
      });
      await flushAnimationFrame();

      const table = host.querySelector<HTMLTableElement>('[data-markdown="table"]');
      const columns = Array.from(table?.querySelectorAll<HTMLTableColElement>('colgroup col') ?? [])
        .map((column) => column.style.width);
      const prose = table?.querySelector('tbody td:nth-child(2)');
      // happy-dom cannot lay out text; a 1400px probe capped at 700px with wrapping enabled must wrap in a browser.
      expect(columns).toEqual(['120px', '700px']);
      expect(table?.style.width).toBe('820px');
      expect(table?.parentElement?.classList.contains('overflow-x-auto')).toBe(true);
      expect(prose?.classList.contains('whitespace-normal')).toBe(true);
      expect(prose?.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
      expect(prose?.querySelector('code')).toBeNull();
    } finally {
      tableProbeWidths = null;
      await act(async () => root.unmount());
    }
  });

  test('builds Markdown sprite controls without parsing SVG markup', async () => {
    const mounted = await mountFixture(1);

    const spriteControlCount = mounted.host.querySelectorAll('[data-md-action] use[href^="#oc-"]').length;
    const spriteIconInnerHTMLWrites = mounted.operations.spriteIconInnerHTMLWrites;
    await act(async () => mounted.root.unmount());

    expect(spriteControlCount).toBeGreaterThan(0);
    expect(spriteIconInnerHTMLWrites).toBe(0);
  });

  test('keeps every block of an unhighlighted first paint when highlighting lands', async () => {
    let releaseHighlight: () => void = () => undefined;
    const highlightGate = new Promise<void>((resolve) => {
      releaseHighlight = resolve;
    });
    highlightCodeForTest = async (code) => {
      await highlightGate;
      return `<pre class="shiki" data-test-highlighted><code><span class="line"><span style="color:#f00">${code.trim()}</span></span></code></pre>`;
    };
    const content = [
      'First-paint identity check with **bold** text.',
      '',
      '```ts',
      'const firstPaintIdentity = 1;',
      '```',
      '',
      '| first | paint |',
      '| --- | --- |',
      '| identity | table |',
      '',
      '<details><summary>First paint details</summary>',
      '',
      'Body of the first-paint disclosure.',
      '',
      '</details>',
      '',
      'Closing paragraph of the first-paint check.',
    ].join('\n');
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<MarkdownRenderer content={content} messageId="first-paint-identity" isAnimated={false} enableFileReferences={false} />);
        await waitForSettledEffects();
      });
      const firstPaintBlocks = Array.from(host.querySelectorAll('[data-md-block]'));
      // One block per top-level token, as the async render will produce.
      expect(firstPaintBlocks).toHaveLength(5);
      expect(host.querySelector('[data-test-highlighted]')).toBeNull();
      const firstPaintChildren = firstPaintBlocks.map((block) => Array.from(block.children));
      const table = host.querySelector('table');
      const details = host.querySelector<HTMLDetailsElement>('details');
      expect(table).not.toBeNull();
      expect(details).not.toBeNull();
      details!.open = true;

      await act(async () => {
        releaseHighlight();
        await waitForSettledEffects();
      });
      await act(async () => waitForSettledEffects());

      expect(host.querySelector('[data-test-highlighted]')).not.toBeNull();
      const settledBlocks = Array.from(host.querySelectorAll('[data-md-block]'));
      expect(settledBlocks).toHaveLength(firstPaintBlocks.length);
      settledBlocks.forEach((block, index) => {
        expect(block).toBe(firstPaintBlocks[index]!);
        expect(block.getAttribute('data-md-id')?.endsWith(':unhighlighted')).toBe(false);
      });
      // Blocks without code were final at first paint and are not touched.
      for (const index of [0, 2, 3, 4]) {
        expect(Array.from(settledBlocks[index]!.children)).toEqual(firstPaintChildren[index]!);
      }
      expect(host.querySelector('table')).toBe(table);
      expect(host.querySelector('details')).toBe(details);
      expect(details!.open).toBe(true);
    } finally {
      highlightCodeForTest = async () => null;
      await act(async () => root.unmount());
    }
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

    // The first paint is shown without waiting for the async render, so each
    // table gets its measured column widths in the mount commit, and the one
    // shared table-width observer starts watching. Mermaid geometry waits.
    expect(critical.tableProbeReads).toBe(fixtureWorkload.rendererCount * 2);
    expect(critical.getBoundingClientRectCalls).toBe(critical.tableProbeReads);
    expect(critical.viewBoxWrites).toBe(0);
    expect(critical.resizeObserverCreates).toBe(1);
    expect(critical.resizeObserverObserveCalls).toBe(0);
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
    expect(metrics.tableProbeReads).toBe(fixtureWorkload.rendererCount * 2);
    expect(metrics.getBoundingClientRectCalls).toBe(metrics.mermaidRenderedCount + metrics.tableProbeReads);
    expect(metrics.viewBoxWrites).toBe(metrics.mermaidRenderedCount);
    expect(metrics.resizeObserverCreates).toBe(2);
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

    // Only the table layout of the mount commit read geometry.
    expect(mounted.operations.getBoundingClientRectCalls).toBe(mounted.operations.tableProbeReads);
    expect(mounted.operations.viewBoxWrites).toBe(0);
    expect(mounted.operations.resizeObserverObserveCalls).toBe(0);
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
    expect(three.resizeObserverCreates).toBe(2);
    expect(six.resizeObserverCreates).toBe(2);
    expect(six.resizeObserverObserveCalls).toBe(three.resizeObserverObserveCalls * 2);
  });
});
