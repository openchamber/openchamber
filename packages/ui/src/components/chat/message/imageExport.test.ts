import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import { buildTurnImageExportSource, cloneMessageImageExportSource, fitMessageImageExportLayout, MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE, resolveMessageImageExportPixelRatio, resolveMessageImageExportWidth, widenMessageImageExportOverflow } from './imageExport';

const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement,
    HTMLAnchorElement: browser.HTMLAnchorElement,
    Element: browser.Element,
    Node: browser.Node,
    Text: browser.Text,
    SVGElement: browser.SVGElement,
    MutationObserver: browser.MutationObserver,
    DOMParser: browser.DOMParser,
    DOMRect: browser.DOMRect,
    XMLSerializer: browser.XMLSerializer,
    IntersectionObserver: browser.IntersectionObserver,
    ResizeObserver: browser.ResizeObserver,
    customElements: browser.customElements,
});
const requests: string[] = [];
const bootstrapPaths = new Set(['/api/fs/home', '/api/location', '/api/session-folders', '/api/config/settings']);
const fetchBoundary = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url.endsWith('/api/fs/home')) return Response.json({ home: '/project' });
    if (url.endsWith('/api/location')) return Response.json({ directory: '/project', project: { directory: '/project' } });
    if (new URL(url, browser.location.href).pathname === '/api/session-folders') return new Response(null, { status: 404 });
    if (new URL(url, browser.location.href).pathname === '/api/config/settings') return Response.json({});
    throw new Error(`Unexpected export request: ${url}`);
});
afterAll(() => { fetchBoundary.mockRestore(); return browser.happyDOM.abort(); });

describe('message image export', () => {
    test('omits favicon and native controls without removing content or mutating the source', () => {
        const source = document.createElement('div');
        source.innerHTML = `
            <span ${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true">
                <img src="https://icons.duckduckgo.com/ip3/example.com.ico" alt="">
            </span>
            <div data-export-ignore><button>Copy</button></div>
            <p>Message content</p>
            <img src="data:image/png;base64,content" alt="Message image">
        `;
        const clone = cloneMessageImageExportSource(source);
        expect(Boolean(clone.querySelector(`[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true"]`))).toBe(false);
        expect(Boolean(clone.querySelector('img[src^="https://icons.duckduckgo.com/"]'))).toBe(false);
        expect(Boolean(clone.querySelector('[data-export-ignore]'))).toBe(false);
        expect(clone.textContent).toContain('Message content');
        expect(Boolean(clone.querySelector('img[alt="Message image"]'))).toBe(true);
        expect(Boolean(source.querySelector(`[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true"]`))).toBe(true);
        expect(Boolean(source.querySelector('[data-export-ignore]'))).toBe(true);
    });

    test('canvas width follows the message column instead of the widest line', () => {
        const column = document.createElement('div');
        column.getBoundingClientRect = () => ({ width: 720.5 }) as DOMRect;
        expect(resolveMessageImageExportWidth(column)).toBe(721);
        expect(resolveMessageImageExportWidth(document.createElement('div'))).toBe(0);
        expect(resolveMessageImageExportWidth(null)).toBe(0);
    });

    test('pixel ratio decreases near the squash limit and stops at the density floor', () => {
        expect(resolveMessageImageExportPixelRatio(769, 1055)).toBe(2);
        expect(resolveMessageImageExportPixelRatio(10000, 1000)).toBe(1.63);
        expect(resolveMessageImageExportPixelRatio(40000, 1000)).toBe(0.5);
        expect(resolveMessageImageExportPixelRatio(1000, 40000)).toBe(0.5);
    });

    test('un-clips an unwrappable block and reports the canvas growth it needs', () => {
        const root = document.createElement('div');
        const scroller = document.createElement('div');
        scroller.style.overflowX = 'auto';
        scroller.style.overflowY = 'hidden';
        scroller.style.maxWidth = '100%';
        root.style.width = '721px';
        const table = document.createElement('table');
        const paragraph = document.createElement('p');
        scroller.append(table);
        root.append(scroller, paragraph);
        root.getBoundingClientRect = () => new DOMRect(0, 0, 721, 100);
        table.getBoundingClientRect = () => new DOMRect(0, 0, 961, 50);
        paragraph.getBoundingClientRect = () => new DOMRect(0, 50, 700, 50);

        expect(widenMessageImageExportOverflow(root)).toEqual({ left: 0, right: 240 });
        expect(scroller.style.overflowX).toBe('visible');
        expect(scroller.style.overflowY).toBe('visible');
        expect(scroller.style.width).toBe('max-content');
        expect(scroller.style.maxWidth).toBe('none');
        expect(root.style.width).toBe('721px');
    });

    test('ignores overflow in the clipped MathML twin of a visible formula', () => {
        const root = document.createElement('div');
        root.innerHTML = '<span style="clip: rect(1px, 1px, 1px, 1px)"><span>MathML</span></span><span>Visible formula</span>';
        document.body.append(root);
        const hiddenFormula = root.querySelector('span span')!;
        root.getBoundingClientRect = () => new DOMRect(0, 0, 721, 100);
        hiddenFormula.getBoundingClientRect = () => new DOMRect(-1000, 0, 2000, 50);
        root.lastElementChild!.getBoundingClientRect = () => new DOMRect(0, 0, 700, 50);
        try {
            expect(widenMessageImageExportOverflow(root)).toEqual({ left: 0, right: 0 });
            expect(root.firstElementChild!.getAttribute('style')).toBe('clip: rect(1px, 1px, 1px, 1px)');
        } finally {
            root.remove();
        }
    });

    test('leaves the layout alone when every block fits the column', () => {
        const root = document.createElement('div');
        const scroller = document.createElement('div');
        scroller.style.overflowX = 'auto';
        const paragraph = document.createElement('p');
        scroller.append(paragraph);
        root.append(scroller);
        root.getBoundingClientRect = () => new DOMRect(0, 0, 721, 100);
        paragraph.getBoundingClientRect = () => new DOMRect(0, 0, 700, 50);

        expect(widenMessageImageExportOverflow(root)).toEqual({ left: 0, right: 0 });
        expect(scroller.style.overflowX).toBe('auto');
        expect(scroller.style.width).toBe('');
    });

    test('measures both edges again after releasing a formula width cap', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div style="overflow: hidden"><span>Formula</span></div>';
        const scroller = root.firstElementChild as HTMLElement;
        const formula = scroller.firstElementChild!;
        root.getBoundingClientRect = () => new DOMRect(100, 0, 721, 100);
        formula.getBoundingClientRect = () => scroller.style.width === 'max-content'
            ? new DOMRect(-100, 0, 1100, 50)
            : new DOMRect(100, 0, 1000, 50);
        expect(widenMessageImageExportOverflow(root)).toEqual({ left: 200, right: 179 });
    });

    test('reserves left overflow and anchors an RTL column without changing its text direction', () => {
        const wrapper = document.createElement('div');
        wrapper.style.direction = 'rtl';
        const root = document.createElement('div');
        root.innerHTML = '<div style="overflow: auto"><table></table></div>';
        wrapper.append(root);
        document.body.append(wrapper);
        root.getBoundingClientRect = () => new DOMRect(100, 0, 721, 100);
        root.querySelector('table')!.getBoundingClientRect = () => new DOMRect(-140, 0, 961, 50);
        try {
            fitMessageImageExportLayout(wrapper, root, 721);
            expect(wrapper.style.direction).toBe('ltr');
            expect(root.style.direction).toBe('rtl');
            expect(root.style.width).toBe('721px');
            expect(root.style.marginLeft).toBe('240px');
            expect(root.style.marginRight).toBe('auto');
            expect(wrapper.style.width).toBe('961px');
            expect((root.firstElementChild as HTMLElement).style.overflowX).toBe('visible');
        } finally {
            wrapper.remove();
        }
    });
});

describe('turn image export', () => {
    test('renders every source segment with real native code, table, disclosure and safe media labels', async () => {
        const source = await buildTurnImageExportSource([
            'Earlier folded **step**.\n\n```mermaid\nsequenceDiagram\n A->>B: Hello\n```',
            '```ts\nconst files = 2\n```\n\n| name | value |\n| --- | --- |\n| [docs](https://example.com/docs) | 2 |',
            '<details><summary>More</summary>Hidden answer.</details>\n\n![remote](https://example.com/pixel.png)\n\n![local](/project/chart.png)\n\nFinal answer.',
        ], '--md-syntax-string: red');
        expect(source.children.length).toBe(3);
        expect(source.children[0]?.textContent).toContain('Earlier folded step.');
        expect(source.children[1]?.textContent).toContain('const files = 2');
        expect(source.children[2]?.textContent).toContain('Final answer.');
        expect(source.querySelector('strong')?.textContent).toBe('step');
        const diagram = source.querySelector('[data-streamdown="mermaid"] svg');
        expect(diagram).not.toBeNull();
        expect(diagram?.outerHTML).not.toContain('var(--surface-');
        expect(diagram?.outerHTML).not.toContain('var(--primary-base)');
        expect(source.querySelector('[data-streamdown="code-block"] pre code')?.textContent).toContain('const files = 2');
        expect(source.querySelector('pre code span[style*="color"]')).not.toBeNull();
        expect(source.querySelector('table a')?.getAttribute('href')).toBe('https://example.com/docs');
        expect(source.querySelector('details summary')?.textContent).toBe('More');
        expect(source.querySelector('details')?.textContent).toContain('Hidden answer.');
        expect(Boolean(source.querySelector('[data-oc-media-source="https://example.com/pixel.png"]'))).toBe(true);
        expect(Boolean(source.querySelector('[data-oc-media-source="/project/chart.png"]'))).toBe(true);
        expect(Boolean(source.querySelector('img, video, source, button, [data-export-ignore]'))).toBe(false);
        expect(source.innerHTML).not.toContain('/api/fs/raw');
        expect(source.innerHTML).not.toContain('token=');
        expect(Array.from(source.querySelectorAll<HTMLElement>('[data-markdown-content]'), root => root.style.getPropertyValue('--md-syntax-string'))).toEqual([
            'red', 'red', 'red',
        ]);
        expect(Boolean(document.querySelector('[data-markdown-content]'))).toBe(false);
        expect(requests.filter(url => !bootstrapPaths.has(new URL(url, browser.location.href).pathname))).toEqual([]);
    });

    test('copy rendering preserves Markdown semantics for the shared plain-text serializer', async () => {
        const { renderMarkdownForExport } = await import('../markdown/renderMarkdownForExport');
        const { serializeRenderedMarkdown } = await import('../markdown/selectionMarkdown');
        const root = await renderMarkdownForExport('First **bold** part.\n\n```text\nalpha\n\nbeta\n```\n\n[Docs](https://example.com)\n\n![chart](/project/chart.png)', { purpose: 'copy' });
        const plain = serializeRenderedMarkdown(root, 'plain');
        expect(root.querySelector('strong')?.textContent).toBe('bold');
        expect(plain).toContain('First bold part.');
        expect(plain).toContain('alpha\n\nbeta');
        expect(plain).toContain('Docs');
        expect(plain).not.toContain('**');
        expect(plain).not.toContain('```');
        expect(plain).not.toContain('/api/');
        expect(Boolean(root.querySelector('img, video, source, [data-export-ignore]'))).toBe(false);
    });
});
