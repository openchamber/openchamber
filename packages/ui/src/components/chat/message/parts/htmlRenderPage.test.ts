import { beforeEach, describe, expect, test } from 'bun:test';
import { Window, type Node as HappyNode } from 'happy-dom';

import { captureChatQuoteAnchor } from '@/lib/chatQuoteAnchor';

import {
    buildHtmlRenderDocument,
    htmlRenderClearSelectionMessage,
    htmlRenderMarksMessage,
    htmlRenderRevealMessage,
    readHtmlRenderFrameMessage,
    type HtmlRenderTheme,
} from './htmlRender';

/**
 * Runs the bootstrap a page really gets, in a DOM whose parent is a stub, to
 * check what no string match can: that the page measures anchors the way the
 * chat does, finds them again, and answers the host's messages.
 */

const theme: HtmlRenderTheme = { appearance: 'light', variables: { '--background': '#fff' } };

interface Posted { type: string; [key: string]: unknown }

const BODY = '<p>Use <strong>bold</strong> text here.</p><p>fix it now</p><p>then fix it later</p>';

const mountPage = () => {
    const win = new Window({ url: 'http://localhost' });
    const posted: Posted[] = [];
    const parent = { postMessage: (message: Posted) => { posted.push(message); } };
    Object.defineProperty(win, 'parent', { value: parent, configurable: true });
    // happy-dom has no CSS Custom Highlight API; a recording stand-in.
    const highlights = new Map<string, Range[]>();
    class FakeHighlight extends Set<Range> {
        // The real one takes its ranges as arguments.
        constructor(...ranges: Range[]) { super(ranges); }
    }
    const customHighlights = {
        set: (name: string, highlight: Set<Range>) => { highlights.set(name, [...highlight]); },
        delete: (name: string) => { highlights.delete(name); },
    };
    Object.defineProperty(win, 'Highlight', { value: FakeHighlight, configurable: true });
    Object.defineProperty(win, 'CSS', { value: { highlights: customHighlights }, configurable: true });
    const source = buildHtmlRenderDocument(`<!doctype html><html><head></head><body>${BODY}</body></html>`, theme);
    const script = /<script>([\s\S]*?)<\/script>/.exec(source)?.[1];
    if (!script) throw new Error('no bootstrap');
    win.document.body.innerHTML = BODY;
    win.document.head.innerHTML = '<style id="oc-html-render-theme"></style>';
    // happy-dom does not run a script the test appends, so the bootstrap runs
    // with the page's globals passed in by name.
    const globals = ['window', 'document', 'CSS', 'Highlight', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'URL'] as const;
    const values = globals.map((name) => (name === 'getComputedStyle' || name === 'requestAnimationFrame' || name === 'setTimeout' || name === 'clearTimeout'
        ? (win[name] as (...args: unknown[]) => unknown).bind(win)
        : (win as unknown as Record<string, unknown>)[name]));
    new Function(...globals, script)(...values);
    const send = (data: object) => {
        win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as never }));
    };
    const select = (text: string, occurrence = 0) => {
        const body = win.document.body;
        const stream = body.textContent ?? '';
        let start = -1;
        for (let seen = 0; seen <= occurrence; seen += 1) start = stream.indexOf(text, start + 1);
        const walker = win.document.createTreeWalker(body, 4);
        const range = win.document.createRange();
        let offset = 0;
        let node: HappyNode | null;
        let started = false;
        while ((node = walker.nextNode())) {
            const length = (node as unknown as Text).data.length;
            if (!started && start < offset + length) { range.setStart(node as never, start - offset); started = true; }
            if (started && start + text.length <= offset + length) { range.setEnd(node as never, start + text.length - offset); break; }
            offset += length;
        }
        const selection = win.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range as never);
        win.document.dispatchEvent(new win.Event('selectionchange'));
        return { range, body };
    };
    return { win, posted, highlights, send, select };
};

describe('the page bootstrap', () => {
    let page: ReturnType<typeof mountPage>;
    beforeEach(() => {
        page = mountPage();
    });

    test('reports a selection with the same anchor the chat would measure', async () => {
        const { range, body } = page.select('bold text here.fix');
        await new Promise((resolve) => setTimeout(resolve, 260));

        const report = page.posted.filter((message) => message.type === 'openchamber:html-render:selection').at(-1);
        const read = readHtmlRenderFrameMessage({ data: report });
        expect(read).toMatchObject({ kind: 'selection', text: 'bold text here.fix' });
        const expected = captureChatQuoteAnchor(body as unknown as Element, range as unknown as Range);
        expect(expected).not.toBeNull();
        expect(read && read.kind === 'selection' ? read.anchor : undefined).toEqual(expected);
    });

    test('paints the marks the host posts, finding repeated text by its surroundings', () => {
        const anchor = { text: 'fix it', prefix: 'fix it now' + 'then ', suffix: ' later', start: 0 };
        const stream = page.win.document.body.textContent ?? '';
        const start = stream.indexOf('then fix it') + 'then '.length;
        const marks = [
            { id: 'a', anchor: { ...anchor, prefix: stream.slice(Math.max(0, start - 32), start), suffix: stream.slice(start + 6, start + 38), start }, focused: false },
            { id: 'b', anchor: { text: 'not on the page', prefix: '', suffix: '', start: 0 }, focused: true },
        ];

        page.send(htmlRenderMarksMessage(marks));

        const painted = page.highlights.get('oc-chat-quote') ?? [];
        expect(painted).toHaveLength(1);
        expect(painted[0]!.toString()).toBe('fix it');
        // It is the second occurrence, the one in "then fix it later".
        const before = page.win.document.createRange();
        before.setStart(page.win.document.body as never, 0);
        before.setEnd(painted[0]!.startContainer as never, painted[0]!.startOffset);
        expect(before.toString().length).toBe(start);
        // The unresolvable mark paints nothing, and nothing is drawn stronger.
        expect(page.highlights.get('oc-chat-quote-focus')).toBeUndefined();

        page.send(htmlRenderMarksMessage([]));
        expect(page.highlights.get('oc-chat-quote')).toBeUndefined();
    });

    test('flashes a quote the host asks to reveal', () => {
        const stream = page.win.document.body.textContent ?? '';
        const start = stream.indexOf('bold');
        page.send(htmlRenderRevealMessage({ text: 'bold text', prefix: stream.slice(0, start), suffix: stream.slice(start + 9, start + 41), start }));

        expect(page.highlights.get('oc-chat-quote-flash')?.[0]?.toString()).toBe('bold text');
    });

    test('drops its selection when the host clears it, without reporting that back', async () => {
        page.select('fix it now');
        await new Promise((resolve) => setTimeout(resolve, 260));
        const before = page.posted.length;

        page.send(htmlRenderClearSelectionMessage());
        page.win.document.dispatchEvent(new page.win.Event('selectionchange'));
        await new Promise((resolve) => setTimeout(resolve, 260));

        expect(page.win.getSelection()?.rangeCount).toBe(0);
        expect(page.posted.slice(before).filter((message) => message.type === 'openchamber:html-render:selection')).toEqual([]);
    });

    test('ignores host messages that do not come from its parent', () => {
        const stream = page.win.document.body.textContent ?? '';
        const start = stream.indexOf('bold');
        page.win.dispatchEvent(new page.win.MessageEvent('message', {
            data: htmlRenderRevealMessage({ text: 'bold', prefix: stream.slice(0, start), suffix: stream.slice(start + 4, start + 36), start }),
            source: {} as never,
        }));

        expect(page.highlights.size).toBe(0);
    });
});
