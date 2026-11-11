import { beforeEach, describe, expect, test } from 'bun:test';
import { Window, type Event as HappyEvent, type Node as HappyNode, type Range as HappyRange } from 'happy-dom';

import { locateChatQuote } from '@/lib/chatQuoteAnchor';

import {
    buildHtmlRenderDocument,
    htmlRenderAnswerStateMessage,
    htmlRenderClearSelectionMessage,
    htmlRenderMarksMessage,
    htmlRenderPointerMessage,
    htmlRenderRevealMessage,
    htmlRenderSubmitReply,
    readHtmlRenderFrameMessage,
    type HtmlRenderAnswerState,
    type HtmlRenderTheme,
} from './htmlRender';

/**
 * Runs the bootstrap a page really gets, in a DOM whose parent is a stub, to
 * check what no string match can: that the page measures anchors the way the
 * chat does, finds them again, and answers the host's messages.
 */

const theme: HtmlRenderTheme = { appearance: 'light', variables: { '--background': '#fff' } };

type FrameReport = ReturnType<typeof readHtmlRenderFrameMessage>;

const BODY = '<p>Use <strong>bold</strong> text here.</p><p>fix it now</p><p>then fix it later</p>';

const settle = () => new Promise((resolve) => setTimeout(resolve, 260));

const mountPage = (answerState?: HtmlRenderAnswerState, body = BODY) => {
    const win = new Window({ url: 'http://localhost' });
    // What the page posted, as the host reads it, and as JSON.
    const reports: FrameReport[] = [];
    const sent: string[] = [];
    const parent = new Window({ url: 'http://localhost' });
    parent.postMessage = (data: MessageEvent['data']) => {
        sent.push(JSON.stringify(data));
        reports.push(readHtmlRenderFrameMessage({ data }));
    };
    Object.defineProperty(win, 'parent', { value: parent, configurable: true });
    // happy-dom has no CSS Custom Highlight API; a recording stand-in.
    const highlights = new Map<string, HappyRange[]>();
    class FakeHighlight extends Set<HappyRange> {
        // The real one takes its ranges as arguments.
        constructor(...ranges: HappyRange[]) { super(ranges); }
    }
    const customHighlights = {
        set: (name: string, highlight: Set<HappyRange>) => { highlights.set(name, [...highlight]); },
        delete: (name: string) => { highlights.delete(name); },
    };
    const css = { highlights: customHighlights };
    Object.defineProperty(win, 'Highlight', { value: FakeHighlight, configurable: true });
    Object.defineProperty(win, 'CSS', { value: css, configurable: true });
    const source = buildHtmlRenderDocument(`<!doctype html><html><head></head><body>${BODY}</body></html>`, theme, { answerState });
    // The bootstrap and the answer script, in the order the page runs them.
    const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join(';');
    if (!script) throw new Error('no bootstrap');
    const answerJson = /<script type="application\/json" id="oc-html-render-answer">[\s\S]*?<\/script>/.exec(source)?.[0] ?? '';
    win.document.body.innerHTML = body;
    win.document.head.innerHTML = `<style id="oc-html-render-theme"></style>${answerJson}`;
    // happy-dom does not run a script the test appends, so the scripts run
    // with the page's globals passed in by name.
    const globals = {
        window: win,
        document: win.document,
        navigator: win.navigator,
        CSS: css,
        Highlight: FakeHighlight,
        MutationObserver: win.MutationObserver,
        ResizeObserver: win.ResizeObserver,
        getComputedStyle: win.getComputedStyle.bind(win),
        requestAnimationFrame: win.requestAnimationFrame.bind(win),
        setTimeout: win.setTimeout.bind(win),
        clearTimeout: win.clearTimeout.bind(win),
        URL: win.URL,
    };
    const run = (code: string) => new Function(...Object.keys(globals), code)(...Object.values(globals));
    run(script);
    const send = (data: MessageEvent['data']) => {
        win.dispatchEvent(new win.MessageEvent('message', { data, source: parent }));
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
            const length = node.textContent?.length ?? 0;
            if (!started && start < offset + length) { range.setStart(node, start - offset); started = true; }
            if (started && start + text.length <= offset + length) { range.setEnd(node, start + text.length - offset); break; }
            offset += length;
        }
        const selection = win.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        win.document.dispatchEvent(new win.Event('selectionchange'));
        return { stream, start };
    };
    return { win, reports, sent, highlights, send, select, run };
};

describe('the page bootstrap', () => {
    let page: ReturnType<typeof mountPage>;
    beforeEach(() => {
        page = mountPage();
    });

    test('reports a selection with the anchor the chat would measure', async () => {
        const text = 'bold text here.fix';
        const { stream, start } = page.select(text);
        await settle();

        const report = page.reports.filter((message) => message?.kind === 'selection').at(-1);
        // The chat's own capture (lib/chatQuoteAnchor.ts): 32 characters of
        // context either side and the start offset, in the same text stream.
        expect(report).toEqual({
            kind: 'selection',
            text,
            rect: { top: 0, left: 0, width: 0, height: 0 },
            anchor: { text, prefix: stream.slice(Math.max(0, start - 32), start), suffix: stream.slice(start + text.length, start + text.length + 32), start },
        });
        expect(report?.kind === 'selection' && report.anchor ? locateChatQuote(stream, report.anchor) : null).toBe(start);
    });

    test('paints the marks the host posts, finding repeated text by its surroundings', () => {
        const stream = page.win.document.body.textContent ?? '';
        const start = stream.indexOf('then fix it') + 'then '.length;
        const marks = [
            { id: 'a', anchor: { text: 'fix it', prefix: stream.slice(Math.max(0, start - 32), start), suffix: stream.slice(start + 6, start + 38), start }, focused: false },
            { id: 'b', anchor: { text: 'not on the page', prefix: '', suffix: '', start: 0 }, focused: true },
        ];

        page.send(htmlRenderMarksMessage(marks));

        const painted = page.highlights.get('oc-chat-quote') ?? [];
        expect(painted).toHaveLength(1);
        expect(painted[0]?.toString()).toBe('fix it');
        // It is the second occurrence, the one in "then fix it later".
        const before = page.win.document.createRange();
        before.setStart(page.win.document.body, 0);
        if (painted[0]) before.setEnd(painted[0].startContainer, painted[0].startOffset);
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
        await settle();
        const before = page.reports.length;

        page.send(htmlRenderClearSelectionMessage());
        page.win.document.dispatchEvent(new page.win.Event('selectionchange'));
        await settle();

        expect(page.win.getSelection().rangeCount).toBe(0);
        expect(page.reports.slice(before).filter((message) => message?.kind === 'selection')).toEqual([]);
    });

    test('passes Escape on only while a reported selection stands and the page left the key alone', async () => {
        const press = () => {
            const event = new page.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            // A key the user pressed; the bootstrap ignores synthetic ones.
            Object.defineProperty(event, 'isTrusted', { value: true });
            page.win.document.body.dispatchEvent(event);
        };
        const escapes = () => page.reports.filter((message) => message?.kind === 'selection-escape').length;

        // No selection: Escape is the page's own.
        press();
        expect(escapes()).toBe(0);

        page.select('fix it now');
        await settle();
        press();
        expect(escapes()).toBe(1);

        // The page's own script took the key.
        const takeIt = (event: HappyEvent) => event.preventDefault();
        page.win.document.addEventListener('keydown', takeIt);
        press();
        expect(escapes()).toBe(1);
        page.win.document.removeEventListener('keydown', takeIt);

        // Once the host clears the selection, Escape is the page's own again.
        page.send(htmlRenderClearSelectionMessage());
        press();
        expect(escapes()).toBe(1);
    });

    test('reports a wheel up and a vertical swipe the page left alone, for the chat around it', () => {
        const { win } = page;
        const user = <T extends HappyEvent>(event: T): T => {
            // A gesture the user made; the bootstrap ignores synthetic ones.
            Object.defineProperty(event, 'isTrusted', { value: true });
            return event;
        };
        const wheel = (target: HappyNode, deltaY: number) => target.dispatchEvent(user(new win.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })));
        const touch = (type: string, x: number, y: number) => {
            const event = user(new win.Event(type, { bubbles: true, cancelable: true }));
            Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
            win.document.body.dispatchEvent(event);
        };
        const scrolls = () => page.reports.flatMap((report) => (report?.kind === 'scroll' ? [report.direction] : []));

        wheel(win.document.body, -40);
        wheel(win.document.body, 40);
        expect(scrolls()).toEqual(['up']);

        // A box in the page with room above takes the wheel itself.
        win.document.body.insertAdjacentHTML('beforeend', '<div id="box" style="overflow-y:auto"><p id="inner">rows</p></div>');
        const box = win.document.getElementById('box');
        const inner = win.document.getElementById('inner');
        if (!box || !inner) throw new Error('no box');
        Object.defineProperty(box, 'scrollTop', { value: 30, configurable: true });
        wheel(inner, -40);
        expect(scrolls()).toEqual(['up']);

        // The page's own script took the wheel.
        const takeIt = (event: HappyEvent) => event.preventDefault();
        win.document.addEventListener('wheel', takeIt);
        wheel(win.document.body, -40);
        win.document.removeEventListener('wheel', takeIt);
        expect(scrolls()).toEqual(['up']);

        // A finger dragging down moves toward older content, up toward newer;
        // a sideways swipe is no scroll.
        touch('touchstart', 100, 100);
        touch('touchmove', 101, 130);
        touch('touchmove', 102, 90);
        touch('touchmove', 140, 92);
        expect(scrolls()).toEqual(['up', 'up', 'down']);
    });

    test('ignores host messages that do not come from its parent', () => {
        const stream = page.win.document.body.textContent ?? '';
        const start = stream.indexOf('bold');
        page.win.dispatchEvent(new page.win.MessageEvent('message', {
            data: htmlRenderRevealMessage({ text: 'bold', prefix: stream.slice(0, start), suffix: stream.slice(start + 4, start + 36), start }),
            source: new Window(),
        }));

        expect(page.highlights.size).toBe(0);
    });
});

describe('the page height', () => {
    test('settles on one height with a tooltip parked below the page\'s last block', () => {
        // The page from #4940: its tooltip, hidden and positioned absolutely
        // with no offsets, sits at the end of the page and reaches past the
        // root's box. happy-dom has no layout, so the boxes are given: the
        // root is 492 px tall, the tooltip ends at 509 px, and like a real
        // root the scroll height never drops below the frame's own height.
        // The tooltip is the body's child: happy-dom computes no `overflow`,
        // so a wrapper around it would count as a box that clips.
        const page = mountPage(undefined, '<p>Chart and table</p><div id="tip" style="position:absolute"></div>');
        const { win } = page;
        const root = win.document.documentElement;
        let frameHeight = 48;
        const box = (top: number, height: number) => new win.DOMRect(0, top, 600, height);
        Object.defineProperty(win, 'innerHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'clientHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'scrollHeight', { get: () => Math.max(frameHeight, 509), configurable: true });
        root.getBoundingClientRect = () => box(0, 492);
        const tip = win.document.getElementById('tip');
        if (!tip) throw new Error('no tooltip');
        tip.getBoundingClientRect = () => box(491, 18);

        // The host gives the frame each height the page reports, and the
        // page measures again when its frame resizes.
        const sizes = () => page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []));
        for (let round = 0; round < 6; round += 1) {
            frameHeight = sizes().at(-1) ?? frameHeight;
            win.dispatchEvent(new win.Event('resize'));
        }

        expect(sizes()).toEqual([509]);
    });

    test('settles on one height with a block taller than the box it sits in', () => {
        // A sketch from a real session: a 16:9 picture 237 px tall inside a
        // 200 px box ran 4 px past the root's 300 px box. The body's own
        // scroll height reaches the picture's end whatever the frame's height.
        const page = mountPage(undefined, '<div style="height:200px"><div style="height:237px"></div></div>');
        const { win } = page;
        const root = win.document.documentElement;
        const body = win.document.body;
        let frameHeight = 48;
        Object.defineProperty(win, 'innerHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'clientHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'scrollHeight', { get: () => Math.max(frameHeight, 304), configurable: true });
        Object.defineProperty(body, 'scrollHeight', { get: () => 304, configurable: true });
        root.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, 300);
        body.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, 300);

        const sizes = () => page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []));
        for (let round = 0; round < 6; round += 1) {
            frameHeight = sizes().at(-1) ?? frameHeight;
            win.dispatchEvent(new win.Event('resize'));
        }

        expect(sizes()).toEqual([304]);
    });

    test('counts the body\'s scroll height at the page\'s own zoom', () => {
        // `body{zoom:.5}` around a 400 px block: the body is drawn 200 px
        // tall, while its layout and scroll heights stay at 400.
        const page = mountPage(undefined, '<div style="height:400px"></div>');
        const { win } = page;
        const root = win.document.documentElement;
        const body = win.document.body;
        let frameHeight = 48;
        Object.defineProperty(win, 'innerHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'clientHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'scrollHeight', { get: () => Math.max(frameHeight, 200), configurable: true });
        Object.defineProperty(body, 'scrollHeight', { get: () => 400, configurable: true });
        Object.defineProperty(body, 'offsetHeight', { get: () => 400, configurable: true });
        root.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, 200);
        body.getBoundingClientRect = () => new win.DOMRect(0, 0, 300, 200);

        const sizes = () => page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []));
        for (let round = 0; round < 6; round += 1) {
            frameHeight = sizes().at(-1) ?? frameHeight;
            win.dispatchEvent(new win.Event('resize'));
        }

        expect(sizes()).toEqual([200]);
    });

    test('adds the horizontal scrollbar\'s height under a page wider than its frame', () => {
        // A 300 px page wider than its frame: the bar takes 10 px off the
        // root's client height whatever the frame's height.
        const page = mountPage(undefined, '<div style="width:1100px;height:300px"></div>');
        const { win } = page;
        const root = win.document.documentElement;
        let frameHeight = 48;
        Object.defineProperty(win, 'innerHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'clientHeight', { get: () => frameHeight - 10, configurable: true });
        Object.defineProperty(root, 'scrollHeight', { get: () => Math.max(frameHeight - 10, 300), configurable: true });
        root.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, 300);

        const sizes = () => page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []));
        for (let round = 0; round < 6; round += 1) {
            frameHeight = sizes().at(-1) ?? frameHeight;
            win.dispatchEvent(new win.Event('resize'));
        }

        expect(sizes()).toEqual([310]);
        expect(root.style.overflowY).toBe('hidden');
    });

    test('settles on one height with a wide page sized to its frame', () => {
        // `body{min-height:100vh}` around 80 px of content wider than the
        // frame: the body is as tall as the frame, scrollbar room included,
        // so each bar height added under it grew the page by as much.
        const page = mountPage(undefined, '<div style="width:1100px;height:80px"></div>');
        const { win } = page;
        const root = win.document.documentElement;
        let frameHeight = 48;
        const pageHeight = () => Math.max(frameHeight, 80);
        Object.defineProperty(win, 'innerHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'clientHeight', { get: () => frameHeight - 10, configurable: true });
        Object.defineProperty(root, 'scrollHeight', { get: () => pageHeight(), configurable: true });
        root.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, pageHeight());

        const sizes = () => page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []));
        for (let round = 0; round < 6; round += 1) {
            frameHeight = sizes().at(-1) ?? frameHeight;
            win.dispatchEvent(new win.Event('resize'));
        }

        expect(sizes()).toEqual([90]);
    });

    const barRoundingCases: Array<[number, number[]]> = [[48, [515]], [49, [514, 515]]];
    for (const [startHeight, expected] of barRoundingCases) {
        test(`settles on one height when rounding changes the scrollbar's height with the frame (from ${startHeight} px)`, () => {
            // A 505 px page wider than its frame at 175%: the window's and the
            // root's heights are rounded, so the 10 px bar reads 9 at odd frame
            // heights and 10 at even ones.
            const page = mountPage(undefined, '<div style="width:1100px;height:505px"></div>');
            const { win } = page;
            const root = win.document.documentElement;
            let frameHeight = startHeight;
            Object.defineProperty(win, 'innerHeight', { get: () => frameHeight, configurable: true });
            Object.defineProperty(root, 'clientHeight', { get: () => frameHeight - (frameHeight % 2 ? 9 : 10), configurable: true });
            Object.defineProperty(root, 'scrollHeight', { get: () => Math.max(frameHeight - (frameHeight % 2 ? 9 : 10), 505), configurable: true });
            root.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, 505);

            const sizes = () => page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []));
            for (let round = 0; round < 6; round += 1) {
                frameHeight = sizes().at(-1) ?? frameHeight;
                win.dispatchEvent(new win.Event('resize'));
            }

            expect(sizes()).toEqual(expected);
        });
    }

    test('sizes again when the scrollbar appears without the root resizing', async () => {
        const page = mountPage(undefined, '<div id="row" style="height:300px"></div>');
        const { win } = page;
        // Let the page finish loading first, as it does in a browser before its
        // own script changes anything; its load handler measures too.
        await settle();
        page.reports.length = 0;
        const root = win.document.documentElement;
        let bar = 0;
        Object.defineProperty(win, 'innerHeight', { get: () => 300, configurable: true });
        Object.defineProperty(root, 'clientHeight', { get: () => 300 - bar, configurable: true });
        Object.defineProperty(root, 'scrollHeight', { get: () => 300, configurable: true });
        root.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, 300);
        win.dispatchEvent(new win.Event('resize'));

        // The page's script makes a row wider than the frame.
        bar = 10;
        win.document.getElementById('row')?.setAttribute('style', 'width:1100px;height:300px');
        await settle();

        const sizes = page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []));
        expect(sizes).toEqual([300, 310]);
    });

    // A box as tall as the frame (`height:100vh;overflow:auto`) holding 349 px
    // of content, or one of a fixed 200 px height around the same content.
    const mountScroller = (fixedHeight?: number) => {
        const page = mountPage(undefined, '<div id="screen" style="overflow-y:auto"><div style="height:349px"></div></div>');
        const { win } = page;
        const root = win.document.documentElement;
        const screen = win.document.getElementById('screen');
        if (!screen) throw new Error('no scroller');
        let frameHeight = 48;
        const boxHeight = () => fixedHeight ?? frameHeight;
        Object.defineProperty(win, 'innerHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'clientHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'scrollHeight', { get: () => Math.max(frameHeight, boxHeight()), configurable: true });
        root.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, boxHeight());
        Object.defineProperty(screen, 'clientHeight', { get: () => boxHeight(), configurable: true });
        Object.defineProperty(screen, 'scrollHeight', { get: () => Math.max(boxHeight(), 349), configurable: true });
        screen.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, boxHeight());

        const sizes = () => page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []));
        win.dispatchEvent(new win.Event('resize'));
        for (let round = 0; round < 6; round += 1) {
            frameHeight = sizes().at(-1) ?? frameHeight;
            win.dispatchEvent(new win.Event('resize'));
        }
        return { sizes: sizes(), root };
    };

    test('grows to the content of a box that scrolls the whole frame', () => {
        const { sizes, root } = mountScroller();
        expect(sizes).toEqual([349]);
        expect(root.style.overflowY).toBe('hidden');
    });

    test('keeps a fixed-height scroll box at its own height', () => {
        const { sizes } = mountScroller(200);
        // The box spans the frame once the frame fits it; grown past that
        // once, it does not follow, and the frame goes back for good.
        expect(sizes).toEqual([200, 349, 200]);
    });

    for (const bar of [0, 10]) {
        test(`keeps a grown box's height when measured again before the frame resizes (${bar}px scrollbar)`, () => {
            const page = mountPage(undefined, '<div id="screen" style="overflow-y:auto"><div style="height:349px"></div></div>');
            const { win } = page;
            const root = win.document.documentElement;
            const screen = win.document.getElementById('screen');
            if (!screen) throw new Error('no scroller');
            Object.defineProperty(win, 'innerHeight', { get: () => 48, configurable: true });
            Object.defineProperty(root, 'clientHeight', { get: () => 48 - bar, configurable: true });
            Object.defineProperty(root, 'scrollHeight', { get: () => 48 - bar, configurable: true });
            root.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, 48);
            Object.defineProperty(screen, 'clientHeight', { get: () => 48, configurable: true });
            Object.defineProperty(screen, 'scrollHeight', { get: () => 349, configurable: true });
            screen.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, 48);

            // The page's load measures it again while the host has not yet
            // given the frame the height it reported.
            win.dispatchEvent(new win.Event('resize'));
            win.dispatchEvent(new win.Event('load'));

            expect(page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []))).toEqual([349 + bar]);
        });
    }

    test('settles on one height with content sized to the frame at a fractional display scale', () => {
        // `body{min-height:100vh}` at 175%: the frame snaps to device pixels,
        // so the page measures a fraction above whatever height it is given.
        const page = mountPage(undefined, '<p>Sized to the frame</p>');
        const { win } = page;
        const root = win.document.documentElement;
        let frameHeight = 387;
        const pageHeight = () => frameHeight + 0.43;
        Object.defineProperty(win, 'innerHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'clientHeight', { get: () => frameHeight, configurable: true });
        Object.defineProperty(root, 'scrollHeight', { get: () => frameHeight, configurable: true });
        root.getBoundingClientRect = () => new win.DOMRect(0, 0, 600, pageHeight());

        const sizes = () => page.reports.flatMap((report) => (report?.kind === 'size' ? [report.height] : []));
        for (let round = 0; round < 6; round += 1) {
            frameHeight = sizes().at(-1) ?? frameHeight;
            win.dispatchEvent(new win.Event('resize'));
        }

        expect(sizes()).toEqual([387]);
    });
});

describe('the page scrollbar', () => {
    test('is marked shown while the host says the pointer is over the frame', () => {
        const page = mountPage();
        const root = page.win.document.documentElement;

        page.send(htmlRenderPointerMessage(true));
        expect(root.hasAttribute('data-oc-pointer')).toBe(true);
        page.send(htmlRenderPointerMessage(false));
        expect(root.hasAttribute('data-oc-pointer')).toBe(false);
    });
});

describe('a page that waits for an answer', () => {
    test('still submits beside the selection bootstrap, and settles on the host\'s reply', async () => {
        const page = mountPage({ waiting: true, answer: null });

        // The page's own script, as an option's click handler would run it.
        page.run('window.openchamber.submit({layout:"b"},"Layout B").then(function(){window.parent.postMessage({type:"test:sent",answer:window.openchamber.answer},"*");});');
        expect(page.reports.at(-1)).toEqual({ kind: 'submit', id: 1, submission: { summary: 'Layout B', data: { layout: 'b' } } });

        page.send(htmlRenderSubmitReply(1));
        await settle();
        expect(page.sent).toContain(JSON.stringify({ type: 'test:sent', answer: { layout: 'b' } }));
    });

    test('puts Decline beside its last button, sends it on a click, and drops it once the page stops waiting', () => {
        const page = mountPage({ waiting: true, answer: null }, '<p>Pick one</p><div><button class="oc-button">A</button><button class="oc-button">B</button></div><p>Why</p>');
        const decline = page.win.document.querySelector('[data-oc-decline]');

        expect(decline?.textContent).toBe('Decline');
        expect(decline?.previousElementSibling?.textContent).toBe('B');
        expect(page.reports.some((report) => report?.kind === 'decline-placed' && report.placed)).toBe(true);

        decline?.dispatchEvent(new page.win.MouseEvent('click'));
        expect(page.reports.at(-1)).toEqual({ kind: 'decline' });
        expect(decline?.hasAttribute('disabled')).toBe(true);

        page.send(htmlRenderAnswerStateMessage({ waiting: false, answer: null }));
        expect(page.win.document.querySelector('[data-oc-decline]')).toBeNull();
    });

    test('turns Decline off while its answer is on its way', () => {
        const page = mountPage({ waiting: true, answer: null }, '<button class="oc-button">Send</button>');
        page.run('window.openchamber.submit({},"Send");');
        expect(page.win.document.querySelector('[data-oc-decline]')?.hasAttribute('disabled')).toBe(true);
    });

    test('tells the host it found no button, so the host draws Decline under the page', () => {
        const page = mountPage({ waiting: true, answer: null });
        expect(page.win.document.querySelector('[data-oc-decline]')).toBeNull();
        expect(page.reports.some((report) => report?.kind === 'decline-placed' && !report.placed)).toBe(true);
    });
});
