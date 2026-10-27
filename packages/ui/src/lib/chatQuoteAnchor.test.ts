import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { getMarkdownProcessingOptions } from '@/components/chat/markdown/streamdownPlugins';

import {
    captureChatQuoteAnchor,
    chatQuoteAnchorSchema,
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

    test('an anchor in a shown page can distinguish HtmlViews in one part', () => {
        expect(chatQuoteAnchorSchema.parse({ ...base, page: { partId: 'prt_1', viewId: 'view_1' } })).toEqual({ ...base, page: { partId: 'prt_1', viewId: 'view_1' } });
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
