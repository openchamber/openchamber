import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
    captureChatQuoteAnchor,
    legacyChatQuoteAnchor,
    locateChatQuote,
    resolveChatQuoteAnchor,
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
});
