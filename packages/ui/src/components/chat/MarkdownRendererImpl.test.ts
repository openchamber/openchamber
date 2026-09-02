import { describe, expect, mock, test } from 'bun:test';

import { localPathFromFileUrl, parseFileReference, type ParsedFileReference } from './fileReferenceParser';

const parse = (value: string): ParsedFileReference | null => parseFileReference(value);

type FakeElement = {
    childNodes: FakeElement[];
    children: FakeElement[];
    parentNode: FakeElement | null;
    attributes: Map<string, string>;
    style: { display: string; setProperty: () => void };
    innerHTML: string;
    setAttribute: (name: string, value: string) => void;
    getAttribute: (name: string) => string | null;
    appendChild: (child: FakeElement) => FakeElement;
    replaceWith: (replacement: FakeElement) => void;
    remove: () => void;
    querySelector: (selector: string) => FakeElement | null;
    querySelectorAll: <T>(selector: string) => T[];
    addEventListener: () => void;
    removeEventListener: () => void;
    contains: (child: FakeElement) => boolean;
    isEqualNode: () => boolean;
};

type FakeDocument = { createElement: () => FakeElement };
type FakeJsxProps = {
    ref?: { current: FakeElement | null };
    children?: FakeElement | FakeElement[];
    className?: string;
    'data-markdown-content'?: boolean;
};

let syncRenderCalls = 0;
let morphCalls = 0;
let decorateCalls = 0;
let mermaidRegistryCreates = 0;
let mermaidRegistryCleanups = 0;
let cachedRendererBlocks: Array<{ id: string; html: string }> | null = null;
let renderedRendererBlocks: Array<{ id: string; html: string }> = [];
let renderMarkdownBlocksForTest = async () => renderedRendererBlocks;
let currentContextVersion = 0;
const layoutEffects: Array<() => void> = [];
const passiveEffects: Array<() => void | (() => void)> = [];
let hookCursor = 0;
let hookStates: Array<{ current: null } | undefined> = [];
let activeFakeDocument: FakeDocument | null = null;

const makeFakeElement = (ownerDocument: { createElement: () => FakeElement }): FakeElement => {
    void ownerDocument;
    let html = '';
    const element: FakeElement = {
        childNodes: [],
        children: [],
        parentNode: null,
        attributes: new Map(),
        style: { display: '', setProperty: () => undefined },
        get innerHTML() {
            return html;
        },
        set innerHTML(value: string) {
            html = value;
        },
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
        getAttribute(name) {
            return this.attributes.get(name) ?? null;
        },
        appendChild(child) {
            child.parentNode = this;
            this.childNodes.push(child);
            this.children.push(child);
            return child;
        },
        replaceWith(replacement) {
            if (!this.parentNode) return;
            const parent = this.parentNode;
            const index = parent.children.indexOf(this);
            if (index < 0) return;
            replacement.parentNode = parent;
            parent.children[index] = replacement;
            parent.childNodes[index] = replacement;
            this.parentNode = null;
        },
        remove() {
            if (!this.parentNode) return;
            const parent = this.parentNode;
            parent.children = parent.children.filter((child) => child !== this);
            parent.childNodes = parent.childNodes.filter((child) => child !== this);
            this.parentNode = null;
        },
        querySelector(selector) {
            if (selector === '[data-markdown-content]') {
                return this.children.find((child) => child.getAttribute('data-markdown-content') === '') ?? null;
            }
            if (selector === '[data-markdown="mermaid-block"]' && html.includes('data-markdown="mermaid-block"')) {
                return this;
            }
            for (const child of this.children) {
                const match = child.querySelector(selector);
                if (match) return match;
            }
            return null;
        },
        querySelectorAll: () => [],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        contains(child) {
            return child === this || this.children.some((candidate) => candidate.contains(child));
        },
        isEqualNode: () => false,
    };
    return element;
};

const installRendererDom = () => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    const documentStub: FakeDocument = { createElement: () => makeFakeElement(documentStub) };
    activeFakeDocument = documentStub;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            matchMedia: () => ({ matches: false }),
            setTimeout,
            clearTimeout,
            requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
        },
    });
    Object.defineProperty(globalThis, 'MutationObserver', {
        configurable: true,
        value: class {
            observe() {}
            disconnect() {}
        },
    });
    return () => {
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else Reflect.deleteProperty(globalThis, 'document');
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousMutationObserver) Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver);
        else Reflect.deleteProperty(globalThis, 'MutationObserver');
        activeFakeDocument = null;
    };
};

const rendererThemes = [{
    metadata: { id: 'renderer-test' },
    colors: {
        surface: { elevated: '#fff', foreground: '#000', mutedForeground: '#666', muted: '#eee' },
        interactive: { border: '#ccc' },
        primary: { base: '#00f' },
    },
}, {
    metadata: { id: 'renderer-test-next' },
    colors: {
        surface: { elevated: '#eee', foreground: '#111', mutedForeground: '#555', muted: '#ddd' },
        interactive: { border: '#bbb' },
        primary: { base: '#f00' },
    },
}];
let rendererThemeIndex = 0;
const rendererTheme = () => rendererThemes[rendererThemeIndex] ?? rendererThemes[0];
const rendererUiState = {
    codeBlockLineWrap: false,
    mermaidRenderingMode: 'svg',
    setCodeBlockLineWrap: () => undefined,
    openContextPreview: () => undefined,
};

const fakeReact = {
    useCallback: <T>(callback: T): T => {
        hookCursor += 1;
        return callback;
    },
    useEffect: (effect: () => void | (() => void)) => { passiveEffects.push(effect); },
    useLayoutEffect: (effect: () => void) => { layoutEffects.push(effect); },
    useMemo: <T>(factory: () => T): T => {
        hookCursor += 1;
        return factory();
    },
    useRef: <T>(current: T) => {
        void current;
        const index = hookCursor;
        hookCursor += 1;
        if (!hookStates[index]) hookStates[index] = { current: null };
        // SAFETY: this test hook preserves one mutable ref slot per hook index.
        return hookStates[index] as { current: T };
    },
    memo: <T>(component: T): T => component,
    createContext: <T>(defaultValue: T) => ({ Provider: 'provider', defaultValue }),
    useContext: <T>(context: { defaultValue: T }): T => context.defaultValue,
};

const fakeJsx = (_type: string, props: FakeJsxProps | null, ...children: FakeElement[]): FakeElement => {
    const ref = props?.ref;
    // SAFETY: the renderer test installs the typed fake document before JSX is
    // evaluated; this branch only supplies its fake element factory.
    const fakeDocument = activeFakeDocument;
    if (!fakeDocument) throw new Error('Renderer fake document is not installed');
    const element = ref?.current ?? makeFakeElement(fakeDocument);
    if (!ref?.current) {
        element.childNodes.length = 0;
        element.children.length = 0;
    }
    if (props) {
        if (ref) ref.current = element;
        if (props.className) element.setAttribute('class', props.className);
        if (props['data-markdown-content']) element.setAttribute('data-markdown-content', '');
    }
    const jsxChildren = props?.children;
    const allChildren = jsxChildren === undefined ? children : Array.isArray(jsxChildren) ? jsxChildren : [jsxChildren];
    for (const child of allChildren) {
        if (child) element.appendChild(child);
    }
    return element;
};

mock.module('react', () => ({ default: fakeReact }));
mock.module('react/jsx-runtime', () => ({ jsx: fakeJsx, jsxs: fakeJsx, Fragment: 'fragment' }));
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: fakeJsx, Fragment: 'fragment' }));
mock.module('beautiful-mermaid', () => ({
    renderMermaidASCII: () => '',
    renderMermaidSVG: (_source: string, colors: { bg: string }) => colors.bg,
}));
mock.module('@/lib/utils', () => ({ cn: (...values: string[]) => values.filter(Boolean).join(' ') }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => `${key}:${currentContextVersion}` }) }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => ({ ok: false }) }));
mock.module('@/lib/url', () => ({
    getUrlScheme: () => null,
    isAppLinkUrl: () => false,
    isExternalHttpUrl: () => false,
    openConfirmedAppLinkUrl: async () => false,
    openExternalUrl: async () => undefined,
}));
mock.module('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => ({ currentTheme: rendererTheme() }) }));
mock.module('@/lib/theme/themes', () => ({ getDefaultTheme: () => rendererTheme() }));
mock.module('./message/FadeInOnReveal', () => ({ FadeInOnReveal: ({ children }: { children: FakeElement | FakeElement[] }) => children }));
type RendererUiSelectorResult = boolean | string | (() => void);
const fakeUseUIStore = Object.assign(
    (selector: (state: typeof rendererUiState) => RendererUiSelectorResult) => selector(rendererUiState),
    { getState: () => rendererUiState },
);
mock.module('@/stores/useUIStore', () => ({ useUIStore: fakeUseUIStore }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => null }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ editor: undefined, runtime: { isVSCode: false } }) }));
mock.module('@/lib/desktop', () => ({ isDesktopLocalOriginActive: () => false, isDesktopShell: () => false, isVSCodeRuntime: () => false }));
mock.module('@/lib/runtimeSurface', () => ({ isMobileSurfaceRuntime: () => false }));
mock.module('@/lib/outsideFileGrants', () => ({ ensureOutsideFileGrantForDesktop: async () => undefined }));
mock.module('@/lib/path-utils', () => ({ getDirectoryForFilePath: () => '', isFilePathWithinDirectory: () => true, toAbsoluteFilePath: () => '' }));
mock.module('./markdown/markdownCore', () => ({
    getCachedMarkdownBlocks: () => cachedRendererBlocks,
    renderMarkdownBlocks: () => renderMarkdownBlocksForTest(),
    renderMarkdownSync: () => {
        syncRenderCalls += 1;
        return '<p>cold</p>';
    },
}));
mock.module('./markdown/markdownTheme', () => ({ ensureMarkdownShikiTheme: () => undefined }));
mock.module('./markdown/markdownSyntaxVars', () => ({ getMarkdownSyntaxVars: () => ({}) }));
mock.module('./markdown/detachedMarkdownDomCache', () => ({
    detachedMarkdownDomCache: {
        take: () => null,
        store: () => undefined,
    },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'runtime' }));
type TestDecorateContext = {
    labels: { copy: string };
    codeBlockLineWrap: boolean;
    renderMermaid: (source: string) => { svg?: string };
};
mock.module('./markdown/decorate', () => ({
    attachMarkdownInteractions: () => () => undefined,
    applyMarkdownCodeBlockWrapState: () => undefined,
    decorateMarkdown: (root: FakeElement, ctx: TestDecorateContext) => {
        decorateCalls += 1;
        if (root.getAttribute('data-test-decoration-marker') === 'true') return;
        root.setAttribute('data-test-decoration-marker', 'true');
        root.setAttribute(
            'data-test-decoration',
            `${ctx.labels.copy}|${ctx.codeBlockLineWrap}|${ctx.renderMermaid('test').svg ?? ''}`,
        );
    },
    getMarkdownCodeText: () => '',
}));
mock.module('./markdown/textPosition', () => ({ findTextPosition: () => null }));
mock.module('./markdown/mermaidViewer', () => ({
    createMermaidViewerRegistry: () => {
        mermaidRegistryCreates += 1;
        return {
            refresh: () => undefined,
            cleanup: () => { mermaidRegistryCleanups += 1; },
        };
    },
    MERMAID_BLOCK_SELECTOR: '[data-markdown="mermaid-block"]',
    shouldRefreshMermaidViewers: (container: Pick<FakeElement, 'querySelector'>) => container.querySelector('[data-markdown="mermaid-block"]') !== null,
}));
mock.module('@/stores/utils/streamDebug', () => ({ streamPerfCount: () => undefined, streamPerfObserve: () => undefined }));
mock.module('morphdom', () => ({ default: () => { morphCalls += 1; } }));

const { MarkdownRenderer } = await import('./MarkdownRendererImpl');

const resetRendererTestState = () => {
    cachedRendererBlocks = null;
    renderedRendererBlocks = [];
    renderMarkdownBlocksForTest = async () => renderedRendererBlocks;
    syncRenderCalls = 0;
    morphCalls = 0;
    decorateCalls = 0;
    mermaidRegistryCreates = 0;
    mermaidRegistryCleanups = 0;
    hookCursor = 0;
    hookStates = [];
    layoutEffects.length = 0;
    passiveEffects.length = 0;
    currentContextVersion = 0;
    rendererThemeIndex = 0;
    rendererUiState.codeBlockLineWrap = false;
};

const beginRendererRender = () => {
    hookCursor = 0;
    return renderMarkdownForTest();
};

const rendererRoot = (value: ReturnType<typeof renderMarkdownForTest>): FakeElement => {
    if (!(value instanceof Object) || !('childNodes' in value) || !('getAttribute' in value)) {
        throw new Error('Renderer test did not return its fake JSX root');
    }
    // SAFETY: the structural check confirms this ReactNode is the object
    // returned by the mocked JSX runtime.
    const candidate = value as object;
    // SAFETY: the mocked JSX runtime creates the complete FakeElement shape.
    return candidate as FakeElement;
};

const runRendererLayoutEffects = () => {
    const pending = layoutEffects.splice(0);
    for (const effect of pending) effect();
};

const runRendererPassiveEffects = () => passiveEffects.splice(0).map((effect) => effect());

const findBlock = (root: FakeElement, id: string): FakeElement | null => {
    if (root.getAttribute('data-md-id') === id) return root;
    for (const child of root.children) {
        const match = findBlock(child, id);
        if (match) return match;
    }
    return null;
};

const renderMarkdownForTest = () => MarkdownRenderer({
    content: 'cached markdown',
    messageId: 'message-1',
    isAnimated: false,
    isStreaming: false,
});

const withRendererDom = async (run: () => void | Promise<void>): Promise<void> => {
    const restoreDom = installRendererDom();
    const previousThemeIndex = rendererThemeIndex;
    try {
        await run();
    } finally {
        rendererThemeIndex = previousThemeIndex;
        restoreDom();
    }
};

describe('parseFileReference', () => {
    test('returns null for empty or whitespace input', () => {
        expect(parse('')).toBeNull();
        expect(parse('   ')).toBeNull();
    });

    test('parses bare path', () => {
        expect(parse('src/foo.ts')).toEqual({ path: 'src/foo.ts' });
    });

    test('parses path with single line', () => {
        expect(parse('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42 });
    });

    test('parses path with line and column', () => {
        expect(parse('src/foo.ts:42:8')).toEqual({ path: 'src/foo.ts', line: 42, column: 8 });
    });

    test('parses path with line range', () => {
        expect(parse('src/foo.ts:42-58')).toEqual({
            path: 'src/foo.ts',
            line: 42,
            endLine: 58,
        });
    });

    test('parses path with single-line range (start equals end)', () => {
        expect(parse('src/foo.ts:10-10')).toEqual({
            path: 'src/foo.ts',
            line: 10,
            endLine: 10,
        });
    });

    test('rejects range with end before start', () => {
        expect(parse('src/foo.ts:20-10')).toBeNull();
    });

    test('falls back to path-only when range endpoint is non-numeric', () => {
        // `src/foo.ts:10-abc` and `src/foo.ts:abc-20` are malformed; the
        // line info is discarded and only the path is returned (the trailing
        // `:`-suffix is stripped).
        expect(parse('src/foo.ts:10-abc')).toEqual({ path: 'src/foo.ts' });
        expect(parse('src/foo.ts:abc-20')).toEqual({ path: 'src/foo.ts' });
    });

    test('strips backtick and quote wrapping from range forms', () => {
        expect(parse('`src/foo.ts:10-20`')).toEqual({
            path: 'src/foo.ts',
            line: 10,
            endLine: 20,
        });
        expect(parse('"src/foo.ts:1-3"')).toEqual({
            path: 'src/foo.ts',
            line: 1,
            endLine: 3,
        });
    });

    test('parses absolute Windows path with line range', () => {
        expect(parse('C:/repo/src/foo.ts:5-9')).toEqual({
            path: 'C:/repo/src/foo.ts',
            line: 5,
            endLine: 9,
        });
    });

    test('preserves line:col form (does not interpret as range)', () => {
        expect(parse('src/foo.ts:42:8')).toEqual({ path: 'src/foo.ts', line: 42, column: 8 });
    });

    test('preserves hash form', () => {
        expect(parse('src/foo.ts#L42C8')).toEqual({
            path: 'src/foo.ts',
            line: 42,
            column: 8,
        });
        expect(parse('src/foo.ts#L42')).toEqual({
            path: 'src/foo.ts',
            line: 42,
        });
    });

    test('range form takes precedence over line-only when suffix matches digits-dash-digits', () => {
        const result = parse('src/foo.ts:42-58');
        expect(result).toEqual({ path: 'src/foo.ts', line: 42, endLine: 58 });
    });
});

describe('localPathFromFileUrl', () => {
    test('converts local file URLs to absolute paths', () => {
        expect(localPathFromFileUrl('file:///private/tmp/report%20viewer.html')).toBe('/private/tmp/report viewer.html');
        expect(localPathFromFileUrl('file://localhost/private/tmp/REPORT.md')).toBe('/private/tmp/REPORT.md');
        expect(localPathFromFileUrl('file:///C:/Users/test/report.html')).toBe('C:/Users/test/report.html');
    });

    test('rejects non-file URLs and remote file hosts', () => {
        expect(localPathFromFileUrl('https://example.com/report.html')).toBeNull();
        expect(localPathFromFileUrl('file://remote-host/share/report.html')).toBeNull();
        expect(localPathFromFileUrl('file:///tmp/bad%ZZpath')).toBeNull();
    });
});

describe('MarkdownRenderer warm settled path', () => {
    test('installs cached blocks without sync fallback and skips same-ID morph', async () => {
        await withRendererDom(async () => {
            resetRendererTestState();
            cachedRendererBlocks = [{ id: 'full:cached', html: '<p>cached</p>' }];
            renderedRendererBlocks = cachedRendererBlocks;
            syncRenderCalls = 0;
            morphCalls = 0;
            decorateCalls = 0;

            // SAFETY: the test JSX adapter returns the fake element assigned to the
            // renderer container ref and exposes the DOM members used below.
            const root = rendererRoot(beginRendererRender());
            runRendererLayoutEffects();
            expect(syncRenderCalls).toBe(0);
            const block = findBlock(root, 'full:cached');
            expect(block).not.toBeNull();
            expect(block?.innerHTML).toBe('<p>cached</p>');
            expect(block?.getAttribute('data-md-block')).toBe('');
            expect(block?.getAttribute('data-md-id')).toBe('full:cached');
            expect(block?.style.display).toBe('contents');
            expect(decorateCalls).toBe(1);

            runRendererPassiveEffects();
            await Promise.resolve();
            expect(morphCalls).toBe(0);
        });
    });

    test('recreates the Mermaid registry after StrictMode-like cleanup without remounting blocks', () => {
        return withRendererDom(() => {
            resetRendererTestState();
            const mermaidHtml = '<div data-markdown="mermaid-block"><svg></svg></div>';
            cachedRendererBlocks = [{ id: 'full:mermaid', html: mermaidHtml }];
            renderedRendererBlocks = cachedRendererBlocks;
            mermaidRegistryCreates = 0;
            mermaidRegistryCleanups = 0;
            morphCalls = 0;

            const root = rendererRoot(beginRendererRender());
            runRendererLayoutEffects();
            expect(mermaidRegistryCreates).toBe(1);
            const cleanups = runRendererPassiveEffects();
            for (const cleanup of cleanups) cleanup?.();
            expect(mermaidRegistryCleanups).toBe(1);

            beginRendererRender();
            runRendererLayoutEffects();
            expect(mermaidRegistryCreates).toBe(2);
            expect(findBlock(root, 'full:mermaid')).not.toBeNull();
            expect(morphCalls).toBe(0);
        });
    });

    test('redecorates a same-ID block when decoration context changes before async completion', async () => {
        await withRendererDom(async () => {
            resetRendererTestState();
            cachedRendererBlocks = [{
                id: 'full:context',
                html: '<div data-markdown="mermaid-block"><p>cached</p></div>',
            }];
            renderedRendererBlocks = cachedRendererBlocks;

            const root = rendererRoot(beginRendererRender());
            runRendererLayoutEffects();
            const block = findBlock(root, 'full:context');
            const firstDecorationId = block?.getAttribute('data-md-decoration-id');
            expect(firstDecorationId).not.toBeNull();
            const firstDecorateCalls = decorateCalls;

            rendererThemeIndex = 1;
            currentContextVersion = 1;
            rendererUiState.codeBlockLineWrap = true;
            beginRendererRender();
            runRendererLayoutEffects();
            runRendererPassiveEffects();
            await Promise.resolve();

            expect(decorateCalls).toBeGreaterThan(firstDecorateCalls);
            expect(syncRenderCalls).toBe(0);
            expect(morphCalls).toBe(0);
            const updatedBlock = findBlock(root, 'full:context');
            expect(updatedBlock?.getAttribute('data-md-decoration-id')).not.toBe(firstDecorationId);
            expect(updatedBlock?.getAttribute('data-test-decoration')).toContain(':1|true|#eee');
            expect(updatedBlock?.getAttribute('data-test-decoration-marker')).toBe('true');
            expect(mermaidRegistryCleanups).toBeGreaterThan(0);
            expect(mermaidRegistryCreates).toBeGreaterThan(1);
        });
    });

    test('rejects an older async render after a newer layout commit', async () => {
        await withRendererDom(async () => {
            resetRendererTestState();
            cachedRendererBlocks = [{ id: 'full:initial', html: '<p>initial</p>' }];
            let resolveOldRender: ((blocks: Array<{ id: string; html: string }>) => void) | undefined;
            const oldRender = new Promise<Array<{ id: string; html: string }>>((resolve) => {
                resolveOldRender = resolve;
            });
            renderMarkdownBlocksForTest = () => oldRender;

            beginRendererRender();
            runRendererLayoutEffects();
            runRendererPassiveEffects();

            cachedRendererBlocks = [{ id: 'full:new', html: '<p>new</p>' }];
            beginRendererRender();
            runRendererLayoutEffects();
            expect(resolveOldRender).toBeDefined();
            resolveOldRender?.([{ id: 'full:old-late', html: '<p>old late</p>' }]);
            await Promise.resolve();

            expect(morphCalls).toBe(0);
        });
    });

});
