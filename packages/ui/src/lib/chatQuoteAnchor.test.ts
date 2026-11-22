import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { getMarkdownProcessingOptions } from '@/components/chat/markdown/streamdownPlugins';

import {
    captureChatQuoteAnchor,
    chatQuoteAnchorSchema,
    findChatQuoteRoots,
    findUiRenderQuoteRoot,
    legacyChatQuoteAnchor,
    locateChatQuote,
    resolveChatQuoteAnchor,
    resolveChatQuoteRanges,
} from './chatQuoteAnchor';

const previousDocument = globalThis.document;
beforeEach(() => {
    Object.assign(globalThis, { document: new Window().document });
});
afterEach(() => {
    Object.assign(globalThis, { document: previousDocument });
});

const renderRoot = (html: string): Element => {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
};

const selectText = (root: Element, text: string, occurrence = 0): Range => {
    const stream = root.textContent ?? '';
    let start = -1;
    for (let seen = 0; seen <= occurrence; seen += 1) start = stream.indexOf(text, start + 1);
    const range = resolveChatQuoteAnchor(root, { text, prefix: stream.slice(0, start), suffix: '', start });
    if (!range) throw new Error(`"${text}" not found`);
    return range;
};

describe('chat quote anchors', () => {
    test('a quote on a hoisted UI page follows that page into the final answer', () => {
        const oldCSS = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
        Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value } });
        try {
            const scope = renderRoot('<div data-message-id="source"><div data-ui-render-message="source" data-ui-render-part="first">the same text</div><div data-ui-render-message="source" data-ui-render-part="second">the same text</div></div>');
            const first = findUiRenderQuoteRoot(scope, 'source', 'first')!;
            const second = findUiRenderQuoteRoot(scope, 'source', 'second')!;
            const anchor = chatQuoteAnchorSchema.parse({ ...captureChatQuoteAnchor(second, selectText(second, 'same text'))!, page: { partId: 'second', kind: 'ui' } });

            scope.innerHTML = '<div data-message-id="final"><div data-chat-quote-root></div></div>';
            const finalRoot = scope.querySelector('[data-chat-quote-root]')!;
            finalRoot.append(first, second);
            const moved = findUiRenderQuoteRoot(scope, 'source', anchor.page!.partId)!;
            expect(resolveChatQuoteAnchor(moved, anchor)?.startContainer.parentElement).toBe(second);

            const ordinary = captureChatQuoteAnchor(finalRoot, selectText(second, 'same text'))!;
            expect(resolveChatQuoteRanges(findChatQuoteRoots(scope, 'final'), ordinary)?.[0].startContainer.parentElement).toBe(second);
        } finally {
            if (oldCSS) Object.defineProperty(globalThis, 'CSS', oldCSS);
            else Reflect.deleteProperty(globalThis, 'CSS');
        }
    });

    test('a fragment spanning markdown elements is captured and found again', () => {
        const root = renderRoot('<p>Use <strong>bold</strong> text here.</p><p>Second paragraph.</p>');
        const anchor = captureChatQuoteAnchor(root, selectText(root, 'bold text here.Second'));
        expect(anchor).toEqual({ text: 'bold text here.Second', prefix: 'Use ', suffix: ' paragraph.', start: 4 });

        const rerendered = renderRoot('<p>Use <strong>bold</strong> text here.</p><p>Second paragraph.</p>');
        expect(resolveChatQuoteAnchor(rerendered, anchor!)?.toString()).toBe('bold text here.Second');
    });

    test('repeated text is told apart by its surroundings', () => {
        const root = renderRoot('<p>fix it now</p><p>then fix it later</p>');
        const anchor = captureChatQuoteAnchor(root, selectText(root, 'fix it', 1))!;
        expect(anchor.suffix.startsWith(' later')).toBe(true);

        // Content inserted above shifts every offset; the context still wins.
        const shifted = renderRoot('<p>Intro.</p><p>fix it now</p><p>then fix it later</p>');
        const range = resolveChatQuoteAnchor(shifted, anchor)!;
        const stream = shifted.textContent ?? '';
        const found = stream.indexOf(range.toString(), stream.indexOf('then'));
        expect(locateChatQuote(stream, anchor)).toBe(found);
    });

    test('a quote that no longer appears, or is ambiguous without context, resolves to nothing', () => {
        const root = renderRoot('<p>alpha beta</p>');
        expect(resolveChatQuoteAnchor(root, legacyChatQuoteAnchor('gamma'))).toBeNull();
        expect(locateChatQuote('same and same', legacyChatQuoteAnchor('same'))).toBeNull();
        expect(locateChatQuote('only once here', legacyChatQuoteAnchor(' once '))).toBe(5);
    });

    test('an empty selection has no anchor', () => {
        const root = renderRoot('<p>text</p>');
        const range = selectText(root, 'text');
        range.collapse(true);
        expect(captureChatQuoteAnchor(root, range)).toBeNull();
    });

    test('legacy Markdown quotes match rendered bold, lists and inline code', () => {
        const root = renderRoot(renderToStaticMarkup(React.createElement(Streamdown, {
            mode: 'static', children: 'Use **bold** text and `some_code()`.\n\n- First item\n- Second item',
        })));
        for (const quote of ['**bold** text', '`some_code()`', '- First item\n- Second item']) {
            const anchor = legacyChatQuoteAnchor(quote);
            expect(resolveChatQuoteAnchor(root, anchor)?.toString()).toBe(anchor.text);
        }
    });

    test('legacy formatting does not disambiguate repeated visible text or alter modern anchors', () => {
        const root = renderRoot('<p><strong>same</strong></p><p>same</p><p>Literal **bold**</p>');
        expect(resolveChatQuoteAnchor(root, legacyChatQuoteAnchor('**same**'))).toBeNull();
        const modern = { text: '**bold**', prefix: 'Literal ', suffix: '', start: 16 };
        expect(resolveChatQuoteAnchor(root, modern)?.toString()).toBe('**bold**');
    });

    test('legacy list text matches the Markdown renderer text stream', () => {
        const markdown = '- First item\n- Second item';
        const root = renderRoot(renderToStaticMarkup(React.createElement(Streamdown, { mode: 'static', children: markdown })));
        expect(resolveChatQuoteAnchor(root, legacyChatQuoteAnchor(markdown))?.toString()).toBe('First item\nSecond item');
    });

    for (const markdown of ['- First\n  - Nested\n- Second', 'line 1  \nline 2', '~~deleted~~ text', '- First\n\n- Second', '5~20s', '~literal~', 'Before\n\n```js\nconst x=1;\n```\n\nAfter']) {
        test(`legacy quote matches renderer: ${JSON.stringify(markdown)}`, () => {
            const root = renderRoot(renderToStaticMarkup(React.createElement(Streamdown, { ...getMarkdownProcessingOptions(false, false), mode: 'static', children: markdown })));
            const anchor = legacyChatQuoteAnchor(markdown);
            expect(anchor.text).toBe(root.textContent?.trim() ?? '');
            expect(resolveChatQuoteAnchor(root, anchor)?.toString()).toBe(anchor.text);
        });
    }
});

describe('chat quote anchor schema', () => {
    const base = { text: 'bold', prefix: 'Use ', suffix: ' text', start: 4 };

    test('an anchor saved before pages could be quoted is still valid, and gains no page', () => {
        const parsed = chatQuoteAnchorSchema.parse(base);
        expect(parsed).toEqual(base);
        expect('page' in parsed).toBe(false);
    });

    test('an anchor in a shown page carries which page', () => {
        expect(chatQuoteAnchorSchema.parse({ ...base, page: { partId: 'prt_1' } })).toEqual({ ...base, page: { partId: 'prt_1' } });
    });

    test('a malformed page is rejected rather than read as a message anchor', () => {
        expect(chatQuoteAnchorSchema.safeParse({ ...base, page: {} }).success).toBe(false);
        expect(chatQuoteAnchorSchema.safeParse({ ...base, page: 'prt_1' }).success).toBe(false);
    });
});

describe('quotes across the rows of a long answer', () => {
    test('a quote crossing two rows is taken and found as one text, a range per row', () => {
        const first = renderRoot('<p>The first row ends here.</p>');
        const second = renderRoot('<p>The second row starts here.</p>');
        const range = document.createRange();
        range.setStart(first.querySelector('p')!.firstChild!, 14);
        range.setEnd(second.querySelector('p')!.firstChild!, 10);
        const anchor = captureChatQuoteAnchor([first, second], range);
        expect(anchor?.text).toBe('ends here.The second');
        const parts = resolveChatQuoteRanges([first, second], anchor!);
        expect(parts?.map((part) => part.toString())).toEqual(['ends here.', 'The second']);
    });

    test('tells apart the same sentence in two rows by what surrounds it', () => {
        const first = renderRoot('<p>Before. The same sentence. After one.</p>');
        const second = renderRoot('<p>Earlier. The same sentence. After two.</p>');
        const range = document.createRange();
        const text = second.querySelector('p')!.firstChild!;
        range.setStart(text, 9);
        range.setEnd(text, 27);
        const anchor = captureChatQuoteAnchor([first, second], range)!;
        expect(anchor.text).toBe('The same sentence.');
        const parts = resolveChatQuoteRanges([first, second], anchor);
        expect(parts?.[0]?.startContainer).toBe(text);
    });

    test('compares context only as far as the mounted rows reach', () => {
        // The rows around this one are not mounted: its context runs past the stream.
        const row = renderRoot('<p>The quoted start of a row, and more. Later, The quoted start again.</p>');
        const anchor = { text: 'The quoted start', prefix: 'end of the previous row. ', suffix: ' of a row, and more. Later', start: 120 };
        expect(resolveChatQuoteAnchor(row, anchor)?.startOffset).toBe(0);
        expect(resolveChatQuoteAnchor(row, { ...anchor, suffix: ' of a column' })).toBeNull();
    });

    // Rows of one message: `index/count` on the message element around each root.
    const messageRow = (html: string, row: string) => {
        const message = document.createElement('div');
        message.setAttribute('data-message-id', 'message');
        message.setAttribute('data-message-row', row);
        const root = document.createElement('div');
        root.setAttribute('data-chat-quote-root', '');
        root.innerHTML = html;
        message.appendChild(root);
        document.body.appendChild(message);
        return root;
    };

    test('with rows not mounted, a lone copy is taken only in its context', () => {
        // The quote was taken in row 3; row 1 has the same words elsewhere.
        const anchor = { text: 'the same words', prefix: 'Row three has ', suffix: ' at its start.', start: 900 };
        const first = messageRow('<p>Row one repeats the same words later on.</p>', '0/3');
        expect(resolveChatQuoteRanges([first], anchor)).toBeNull();
        const third = messageRow('<p>Row three has the same words at its start.</p>', '2/3');
        expect(resolveChatQuoteRanges([third], anchor)?.[0]?.toString()).toBe('the same words');
    });

    test('finds the part of a quote longer than the rows on the page', () => {
        const quote = 'A quote that starts in this row and runs on through the next rows, which are not mounted yet.';
        const anchor = { text: quote, prefix: 'Before it. ', suffix: ' After it.', start: 10 };
        const row = messageRow('<p>Before it. A quote that starts in this row and runs on</p>', '0/3');
        expect(resolveChatQuoteRanges([row], anchor)?.map((part) => part.toString())).toEqual(['A quote that starts in this row and runs on']);
        const tail = messageRow('<p>through the next rows, which are not mounted yet. After it.</p>', '2/3');
        expect(resolveChatQuoteRanges([tail], anchor)?.map((part) => part.toString())).toEqual(['through the next rows, which are not mounted yet.']);
        // Sent before anchors existed: no context, found while it is the one match on the page.
        const legacy = { text: quote, prefix: '', suffix: '', start: 0 };
        expect(resolveChatQuoteRanges([row], legacy)?.map((part) => part.toString())).toEqual(['A quote that starts in this row and runs on']);
        // A row holding nothing but the quote's start matches it as a head and as a stretch inside it: one match.
        const onlyStart = messageRow('<p>A quote that starts in this row and runs on</p>', '0/3');
        expect(resolveChatQuoteRanges([onlyStart], legacy)?.map((part) => part.toString())).toEqual(['A quote that starts in this row and runs on']);
    });
});

describe('quotes on text kept outside the step that wrote it', () => {
    let oldCSS: PropertyDescriptor | undefined;
    beforeEach(() => {
        oldCSS = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
        Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value } });
    });
    afterEach(() => {
        if (oldCSS) Object.defineProperty(globalThis, 'CSS', oldCSS);
        else Reflect.deleteProperty(globalThis, 'CSS');
    });

    // Two notes of one step drawn above the answer under a closed Activity, and
    // the same step drawn in place, with its tool row between them, once it opens.
    const kept = (id: string, note: string) => `<div data-message-id="step" data-message-hoisted="${id}"><div data-chat-quote-root><p>${note}</p></div></div>`;
    const closed = () => renderRoot(`<div data-message-id="answer"><div data-chat-quote-root>${kept('one', 'Check the parser first')}${kept('two', 'Check the lexer next')}<p>The answer names the lexer.</p></div></div>`);
    const opened = () => renderRoot('<div data-message-id="step"><div data-chat-quote-root><p>Check the parser first</p><div>Read src/lexer.ts</div><p>Check the lexer next</p></div></div><div data-message-id="answer"><div data-chat-quote-root><p>The answer names the lexer.</p></div></div>');
    const select = (scope: Element, messageId: string, paragraph: number, text: string): Range => {
        const node = findChatQuoteRoots(scope, messageId)
            .flatMap((root) => [...root.querySelectorAll('p')].filter((p) => p.closest('[data-chat-quote-root]') === root))[paragraph]!.firstChild!;
        const range = document.createRange();
        const start = node.textContent!.indexOf(text);
        range.setStart(node, start);
        range.setEnd(node, start + text.length);
        return range;
    };
    const quoted = (scope: Element, messageId: string, anchor: ReturnType<typeof captureChatQuoteAnchor>) => {
        const range = resolveChatQuoteRanges(findChatQuoteRoots(scope, messageId), anchor!)?.[0];
        return range ? `${range.startContainer.textContent}@${range.startOffset}` : null;
    };

    test('a comment on a repeated word in the second note resolves in both layouts', () => {
        let scope = closed();
        const fromClosed = captureChatQuoteAnchor(findChatQuoteRoots(scope, 'step'), select(scope, 'step', 1, 'the'));
        expect(quoted(scope, 'step', fromClosed)).toBe('Check the lexer next@6');
        scope.remove();
        scope = opened();
        expect(quoted(scope, 'step', fromClosed)).toBe('Check the lexer next@6');
        const fromOpened = captureChatQuoteAnchor(findChatQuoteRoots(scope, 'step'), select(scope, 'step', 1, 'the'));
        scope.remove();
        scope = closed();
        expect(quoted(scope, 'step', fromOpened)).toBe('Check the lexer next@6');
    });

    test('a quote on the second of two identical notes stays on the second when Activity closes', () => {
        let scope = renderRoot('<div data-message-id="step"><div data-chat-quote-root><p>Run tests.</p><div>Ran bun test</div><p>Run tests.</p></div></div>');
        const fromOpened = captureChatQuoteAnchor(findChatQuoteRoots(scope, 'step'), select(scope, 'step', 1, 'Run'));
        scope.remove();
        scope = renderRoot(`<div data-message-id="answer"><div data-chat-quote-root>${kept('one', 'Run tests.')}${kept('two', 'Run tests.')}</div></div>`);
        const range = resolveChatQuoteRanges(findChatQuoteRoots(scope, 'step'), fromOpened!)?.[0];
        expect(range?.startContainer.parentElement?.closest('[data-message-hoisted]')?.getAttribute('data-message-hoisted')).toBe('two');
    });

    test('a selection across two kept notes takes no anchor: the step\'s tool rows sit between them', () => {
        const scope = closed();
        const [first, second] = findChatQuoteRoots(scope, 'step').map((root) => root.querySelector('p')!.firstChild!);
        const range = document.createRange();
        range.setStart(first!, 6);
        range.setEnd(second!, 9);
        expect(captureChatQuoteAnchor(findChatQuoteRoots(scope, 'step'), range)).toBeNull();
    });

    test('the answer\'s stream leaves out the notes drawn inside it', () => {
        let scope = closed();
        const fromClosed = captureChatQuoteAnchor(findChatQuoteRoots(scope, 'answer'), select(scope, 'answer', 0, 'lexer'));
        scope.remove();
        scope = opened();
        expect(captureChatQuoteAnchor(findChatQuoteRoots(scope, 'answer'), select(scope, 'answer', 0, 'lexer'))).toEqual(fromClosed);
    });
});
