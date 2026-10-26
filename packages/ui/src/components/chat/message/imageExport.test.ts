import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import { buildTurnImageExportSource, cloneMessageImageExportSource, MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE } from './imageExport';

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
